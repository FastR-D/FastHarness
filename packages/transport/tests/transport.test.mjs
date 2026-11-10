import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { JsonlRpcClient } from '../dist/index.js'

const fixture = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
let approval
rl.on('line', line => {
  const m = JSON.parse(line)
  if (!m.method) { send({id: approval, ...('error' in m ? {error:m.error} : {result:m.result})}); return }
  if (m.method === 'ready') send({id:m.id,result:process.pid})
  if (m.method === 'echo') send({id:m.id,result:m.params})
  if (m.method === 'slow') setTimeout(()=>send({id:m.id,result:'slow'}),50)
  if (m.method === 'remote') send({id:m.id,error:{code:-1,message:'rejected',data:{reason:'fixture'}}})
  if (m.method === 'exit') process.exit(17)
  if (m.method === 'invalid') process.stdout.write(m.params + '\n')
  if (m.method === 'approval') { approval=m.id; send({id:'server-1',method:'host/requestApproval',params:{scope:'fixture'}}) }
  if (m.method === 'batch') process.stdout.write(Array.from({length:20},(_,i)=>JSON.stringify({method:'tick',params:i})+'\n').join('')+JSON.stringify({id:m.id,result:true})+'\n')
  if (m.method === 'split') {
    const bytes=Buffer.from(JSON.stringify({id:m.id,result:'中文🙂'})+'\n')
    for(let i=0;i<bytes.length;i++) process.stdout.write(bytes.subarray(i,i+1))
  }
  if (m.method === 'tail') { process.stdout.write(JSON.stringify({id:m.id,result:'tail'})); process.exitCode=0; rl.close(); process.stdin.destroy() }
  if (m.method === 'pause-input') { rl.pause(); process.stdin.pause(); setInterval(()=>{},1000); send({id:m.id,result:true}) }
  if (m.method === 'close-input') { rl.close(); require('node:fs').closeSync(0); setInterval(()=>{},1000); send({id:m.id,result:true}) }
  if (m.method === 'stderr') { process.stderr.write('first\nsecond\nthird\n'); send({id:m.id,result:true}) }
})
`
function client(options = {}) {
  const rpc = new JsonlRpcClient({ commandFactory: () => ({command:process.execPath,args:['-e',fixture],cwd:process.cwd()}), requestTimeoutMs:2000,stopTimeoutMs:200,...options })
  rpc.start()
  return rpc
}
function alive(pid) { try { process.kill(pid,0); return true } catch { return false } }

test('real process: response routing, null, remote errors, reverse approval, UTF-8 chunks and EOF', async t => {
  const rpc = client({maxRecordBytes:128})
  t.after(()=>rpc.stop())
  const pid=await rpc.request('ready')
  rpc.onMessage(m=>{ if(m.id==='server-1') rpc.respond(m.id,{decision:'accept'}) })
  const slow=rpc.request('slow')
  assert.equal(await rpc.request('echo',null),null)
  assert.equal(await slow,'slow')
  await assert.rejects(rpc.request('remote'),{code:'REMOTE_ERROR',details:{method:'remote',remoteCode:-1,data:{reason:'fixture'}}})
  assert.deepEqual(await rpc.request('approval'),{decision:'accept'})
  let ticks=0
  rpc.onMessage(m=>{if(m.method==='tick')ticks++})
  assert.equal(await rpc.request('batch'),true)
  assert.equal(ticks,20)
  assert.equal(await rpc.request('split'),'中文🙂')
  assert.equal(await rpc.request('tail'),'tail')
  await rpc.stop()
  assert.equal(alive(pid),false)
})

for (const [frame,code] of [
  ['null','INVALID_MESSAGE'], ['[]','INVALID_MESSAGE'], ['42','INVALID_MESSAGE'],
  ['{bad','INVALID_JSON'], ['{}','INVALID_MESSAGE'], ['{"method":4}','INVALID_MESSAGE'],
  ['{"method":"notify","id":null}','INVALID_MESSAGE'],
  ['{"id":1,"error":null}','INVALID_MESSAGE'], ['{"id":1,"error":{"message":4}}','INVALID_MESSAGE'],
  ['{"id":1,"result":0,"error":{}}','INVALID_MESSAGE'], ['{"id":1}','INVALID_MESSAGE'],
  [JSON.stringify({method:'x',params:'中'.repeat(100)}),'RECORD_TOO_LARGE'],
]) test(`real process rejects all pending and cleans up on ${frame.slice(0,50)}`, async t => {
  const rpc=client({maxRecordBytes:128})
  t.after(()=>rpc.stop())
  const pid=await rpc.request('ready')
  const errors=[]; rpc.onProtocolError(e=>errors.push(e.code))
  const pending=assert.rejects(rpc.request('hang'),{code})
  const invalid=assert.rejects(rpc.request('invalid',frame),{code})
  await Promise.all([pending,invalid])
  await rpc.stop()
  assert.deepEqual(errors,[code])
  assert.equal(rpc.running,false)
  assert.equal(alive(pid),false)
})

test('abort, timeout, serialization failure and stop settle requests; restart is isolated', async t => {
  const rpc=client()
  t.after(()=>rpc.stop())
  const pid=await rpc.request('ready')
  const pre=new AbortController(); pre.abort()
  await assert.rejects(rpc.request('echo',null,{signal:pre.signal}),{code:'REQUEST_ABORTED'})
  const active=new AbortController()
  const cancelled=assert.rejects(rpc.request('hang',{}, {signal:active.signal}),{code:'REQUEST_ABORTED'})
  active.abort(); await cancelled
  assert.equal(getEventListeners(active.signal,'abort').length,0)
  const timeout=new AbortController()
  await assert.rejects(rpc.request('hang',{}, {timeoutMs:5,signal:timeout.signal}),{code:'REQUEST_TIMEOUT'})
  assert.equal(getEventListeners(timeout.signal,'abort').length,0)
  const success=new AbortController()
  await rpc.request('echo',null,{signal:success.signal})
  assert.equal(getEventListeners(success.signal,'abort').length,0)
  const circular={}; circular.self=circular
  await assert.rejects(rpc.request('echo',circular),TypeError)
  assert.equal(await rpc.request('echo','still alive'),'still alive')
  const stopped=assert.rejects(rpc.request('hang'),{code:'PROCESS_STOPPED'})
  await Promise.all([rpc.stop(),rpc.stop(),stopped])
  assert.equal(alive(pid),false)
  rpc.start()
  assert.equal(await rpc.request('echo','restarted'),'restarted')
})

test('default frame budget still rejects a valid 2.1MB response', async t => {
  const rpc=client();t.after(()=>rpc.stop())
  const pid=await rpc.request('ready')
  await assert.rejects(rpc.request('echo','x'.repeat(2_100_000)),{code:'RECORD_TOO_LARGE'})
  await rpc.stop();assert.equal(alive(pid),false)
})

test('unexpected exit and spawn failure reject pending exactly once', async t => {
  const rpc=client();t.after(()=>rpc.stop())
  const pid=await rpc.request('ready'), exits=[]
  rpc.onExit(e=>exits.push(e.code))
  await Promise.all([assert.rejects(rpc.request('hang'),{code:'PROCESS_EXITED'}),assert.rejects(rpc.request('exit'),{code:'PROCESS_EXITED'})])
  await rpc.stop()
  assert.deepEqual(exits,['PROCESS_EXITED']);assert.equal(alive(pid),false)
  const missing=client({commandFactory:()=>({command:'nonexistent-fastrd-cli',args:[],cwd:process.cwd()})})
  t.after(()=>missing.stop())
  await assert.rejects(missing.request('hang'),{code:'PROCESS_EXITED'})
  await missing.stop()
})

test('peer that stops reading times out pending work and is cleaned by stop', async t => {
  const rpc=client();t.after(()=>rpc.stop())
  const pid=await rpc.request('ready')
  await rpc.request('pause-input')
  const error=await rpc.request('echo','x'.repeat(1_000_000)).catch(error=>error)
  assert.equal(error.code,'REQUEST_TIMEOUT')
  await rpc.stop();assert.equal(alive(pid),false)
})

test('stop cleans a child with a SIGTERM handler (POSIX requires escalation)',async t=>{
  const rpc=client({commandFactory:()=>({command:process.execPath,args:['-e',`process.on('SIGTERM',()=>{});${fixture}`],cwd:process.cwd()})})
  t.after(()=>rpc.stop())
  const pid=await rpc.request('ready')
  await rpc.stop();assert.equal(alive(pid),false)
})

test('reverse RPC encodes undefined as null and preserves host errors', async t => {
  const rpc=client();t.after(()=>rpc.stop())
  const off=rpc.onMessage(m=>{if(m.id==='server-1')rpc.respond(m.id,undefined)})
  assert.equal(await rpc.request('approval'),null)
  off()
  rpc.onMessage(m=>{if(m.id==='server-1')rpc.respondError(m.id,-32601,'unsupported',{host:true})})
  await assert.rejects(rpc.request('approval'),{code:'REMOTE_ERROR',details:{method:'approval',remoteCode:-32601,data:{host:true}}})
})

test('stderr is bounded independently of RPC and remains host-only', async t => {
  const lines=[]
  let complete
  const received=new Promise(resolve=>{complete=resolve})
  const rpc=client({maxStderrLines:2,onStderrLine:line=>{lines.push(line);if(lines.length===3)complete()}})
  t.after(()=>rpc.stop())
  await rpc.request('stderr');await received
  assert.deepEqual(lines,['first','second','third'])
  assert.deepEqual(rpc.stderr,['second','third'])
})

// Node's Windows stdio retains a duplicated pipe handle after closeSync(0).
// Run the OS-level broken-pipe case on POSIX; the non-reading peer case runs everywhere.
test('broken child stdin rejects pending requests and stops the process', {skip:process.platform==='win32'}, async t => {
  const rpc=client();t.after(()=>rpc.stop())
  const pid=await rpc.request('ready')
  await rpc.request('close-input')
  await assert.rejects(rpc.request('echo','x'.repeat(1_000_000)),{code:'STDIN_CLOSED'})
  await rpc.stop();assert.equal(alive(pid),false)
})
