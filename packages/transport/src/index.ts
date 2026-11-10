import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createInterface } from 'node:readline'

export interface RpcCommand {
  command: string
  args: readonly string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}
export interface JsonlRpcClientOptions {
  commandFactory: () => RpcCommand
  requestTimeoutMs?: number
  stopTimeoutMs?: number
  maxStderrLines?: number
  /** Host's UTF-8 frame budget; defaults to 2,000,000 bytes, not a history limit. */
  maxRecordBytes?: number
  onStderrLine?: (line: string) => void
}
export interface RpcMessage {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}
export class RpcError extends Error {
  constructor(message: string, public readonly code: string, public readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RpcError'
  }
}
interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}
interface ProcessState {
  child: ChildProcessWithoutNullStreams
  failed: boolean
  stopping?: Promise<void>
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

function parseMessage(line: string): RpcMessage {
  let value: unknown
  try { value = JSON.parse(line) }
  catch { throw new RpcError('Invalid JSONL JSON', 'INVALID_JSON') }
  if (!record(value) ||
      ('id' in value && !validId(value.id)) ||
      ('method' in value && (typeof value.method !== 'string' || !value.method)) ||
      (!('method' in value) && !validId(value.id)) ||
      ('method' in value && ('result' in value || 'error' in value)) ||
      (!('method' in value) && ('result' in value) === ('error' in value)) ||
      ('error' in value && (!record(value.error) ||
        ('message' in value.error && typeof value.error.message !== 'string') ||
        ('code' in value.error && (typeof value.error.code !== 'number' || !Number.isFinite(value.error.code))))))
    throw new RpcError('Invalid JSONL RPC frame', 'INVALID_MESSAGE')
  return value as RpcMessage
}

export class JsonlRpcClient {
  readonly #options: Required<Omit<JsonlRpcClientOptions, 'onStderrLine'>> & Pick<JsonlRpcClientOptions, 'onStderrLine'>
  readonly #pending = new Map<string | number, PendingRequest>()
  readonly #messages = new Set<(message: RpcMessage) => void>()
  readonly #exits = new Set<(error: RpcError) => void>()
  readonly #protocolErrors = new Set<(error: RpcError) => void>()
  readonly #stderr: string[] = []
  #state?: ProcessState
  #nextId = 1

  constructor(options: JsonlRpcClientOptions) {
    this.#options = { requestTimeoutMs: 30_000, stopTimeoutMs: 5_000,
      maxStderrLines: 100, maxRecordBytes: 2_000_000, ...options }
  }
  get running(): boolean {
    const state = this.#state
    return !!state && !state.failed && !state.stopping && state.child.exitCode === null && state.child.signalCode === null
  }
  get processId(): number | undefined { return this.#state?.child.pid }
  get stderr(): readonly string[] { return this.#stderr }
  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.#messages.add(listener); return () => { this.#messages.delete(listener) }
  }
  onExit(listener: (error: RpcError) => void): () => void {
    this.#exits.add(listener); return () => { this.#exits.delete(listener) }
  }
  onProtocolError(listener: (error: RpcError) => void): () => void {
    this.#protocolErrors.add(listener); return () => { this.#protocolErrors.delete(listener) }
  }
  start(): void {
    if (this.running) return
    if (this.#state) throw new RpcError('Await stop before restarting', 'PROCESS_STOPPING')
    const command = this.#options.commandFactory()
    const child = spawn(command.command, [...command.args], {
      cwd: command.cwd, env: command.env, shell: false, windowsHide: true, stdio: 'pipe',
    })
    const state: ProcessState = { child, failed: false }
    this.#state = state
    this.#stderr.length = 0
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    const receive = (chunk: string, final = false): void => {
      if (state.failed || state.stopping) return
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!frame(line)) return
      }
      if (Buffer.byteLength(buffer) > this.#options.maxRecordBytes) { oversized(); return }
      if (final && buffer.trim()) frame(buffer)
    }
    const oversized = (): void => protocol(new RpcError('JSONL record exceeds byte limit', 'RECORD_TOO_LARGE'))
    const protocol = (error: RpcError): void => {
      this.#fail(state, error)
      // Stop is owned here; a concurrent host stop awaits the same promise.
      void this.stop().catch(() => { /* stop failure is reported via onExit */ })
      for (const listener of this.#protocolErrors) listener(error)
    }
    const frame = (line: string): boolean => {
      if (Buffer.byteLength(line) > this.#options.maxRecordBytes) { oversized(); return false }
      if (!line.trim()) return true
      let message: RpcMessage
      try { message = parseMessage(line) }
      catch (error) { protocol(error as RpcError); return false }
      this.#receive(message)
      return !state.failed && !state.stopping
    }
    child.stdout.on('data', (chunk: Buffer) => receive(decoder.write(chunk)))
    child.stdout.once('end', () => receive(decoder.end(), true))
    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', line => {
      if (this.#state !== state || !line.trim()) return
      this.#stderr.push(line.trim())
      this.#stderr.splice(0, Math.max(0, this.#stderr.length - this.#options.maxStderrLines))
      this.#options.onStderrLine?.(line.trim())
    })
    child.stdin.on('error', cause => {
      if (this.#state !== state || state.stopping) return
      this.#fail(state, new RpcError(cause.message, 'STDIN_CLOSED'))
      void this.stop().catch(() => {})
    })
    child.once('error', cause => this.#fail(state, new RpcError(cause.message, 'PROCESS_EXITED')))
    child.once('close', (code, signal) => {
      stderr.close()
      if (!state.stopping) this.#fail(state, new RpcError(`RPC process exited (${signal ?? code})`, 'PROCESS_EXITED', { stderr: [...this.#stderr] }))
      if (this.#state === state) this.#state = undefined
    })
  }
  async request<T>(method: string, params: unknown = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    this.#assertRunning()
    if (options.signal?.aborted) throw new RpcError(`RPC aborted: ${method}`, 'REQUEST_ABORTED')
    const id = this.#nextId++
    return await new Promise<T>((resolve, reject) => {
      const finish = (error: Error): void => { this.#take(id)?.reject(error) }
      const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs
      const timer = setTimeout(() => finish(new RpcError(`RPC timed out: ${method}`, 'REQUEST_TIMEOUT', { method, timeoutMs })), timeoutMs)
      const pending: PendingRequest = { method, resolve: value => resolve(value as T), reject, timer }
      const abort = (): void => finish(new RpcError(`RPC aborted: ${method}`, 'REQUEST_ABORTED'))
      if (options.signal) {
        options.signal.addEventListener('abort', abort, { once: true })
        pending.removeAbort = () => options.signal?.removeEventListener('abort', abort)
      }
      this.#pending.set(id, pending)
      try { this.#write({ id, method, params }) }
      catch (error) { finish(error as Error) }
    })
  }
  notify(method: string, params: unknown = {}): void { this.#write({ method, params }) }
  respond(id: string | number, result: unknown): void { this.#write({ id, result: result === undefined ? null : result }) }
  respondError(id: string | number, code: number, message: string, data?: unknown): void {
    this.#write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }
  async stop(): Promise<void> {
    const state = this.#state
    if (!state) return
    if (state.stopping) return await state.stopping
    this.#rejectPending(new RpcError('RPC process was stopped', 'PROCESS_STOPPED'))
    state.stopping = (async () => {
      const child = state.child
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        child.kill('SIGTERM')
        if (!await this.#waitForExit(child)) {
          child.kill('SIGKILL')
          if (!await this.#waitForExit(child)) {
            const error = new RpcError('RPC process did not stop', 'PROCESS_STOP_FAILED', { pid: child.pid })
            for (const listener of this.#exits) listener(error)
            throw error
          }
        }
      }
      if (this.#state === state) this.#state = undefined
    })()
    return await state.stopping
  }
  async #waitForExit(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true
    return await new Promise<boolean>(resolve => {
      const finish = (exited: boolean): void => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited) }
      const onExit = (): void => finish(true)
      const timer = setTimeout(() => finish(false), this.#options.stopTimeoutMs)
      child.once('exit', onExit)
    })
  }
  #assertRunning(): void {
    if (!this.running) throw new RpcError('RPC process is not running', 'PROCESS_NOT_RUNNING')
  }
  #write(message: RpcMessage): void {
    this.#assertRunning()
    const input = this.#state!.child.stdin
    if (!input.writable) throw new RpcError('RPC stdin is closed', 'STDIN_CLOSED')
    input.write(`${JSON.stringify(message)}\n`)
  }
  #take(id: string | number): PendingRequest | undefined {
    const pending = this.#pending.get(id)
    if (pending) { this.#pending.delete(id); clearTimeout(pending.timer); pending.removeAbort?.() }
    return pending
  }
  #receive(message: RpcMessage): void {
    if (message.method === undefined && message.id !== undefined) {
      const pending = this.#take(message.id)
      if (pending) {
        if (message.error) pending.reject(new RpcError(message.error.message ?? `RPC failed: ${pending.method}`, 'REMOTE_ERROR', {
          method: pending.method, remoteCode: message.error.code, data: message.error.data,
        }))
        else pending.resolve(message.result)
        return
      }
    }
    for (const listener of this.#messages) listener(message)
  }
  #fail(state: ProcessState, error: RpcError): void {
    if (this.#state !== state || state.failed) return
    state.failed = true
    this.#rejectPending(error)
    for (const listener of this.#exits) listener(error)
  }
  #rejectPending(error: RpcError): void {
    for (const id of this.#pending.keys()) this.#take(id)?.reject(error)
  }
}
