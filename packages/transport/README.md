# @fastrd/harness-transport

Node ESM JSONL RPC transport. The host provides the command, arguments, environment,
permissions and server-request handling. This package does not select an agent or
grant tools, sandbox access or approvals.

```js
import { JsonlRpcClient } from '@fastrd/harness-transport'
const rpc = new JsonlRpcClient({ commandFactory: () => ({
  command: 'your-cli', args: ['app-server', '--stdio'], cwd: process.cwd(),
}) })
rpc.onMessage(message => { /* host-owned notifications and reverse RPC */ })
rpc.start()
try { await rpc.request('initialize', { clientInfo: { name: 'host' } }) }
finally { await rpc.stop() }
```

`request` accepts timeoutMs and AbortSignal; abort rejects only that request.
The host owns remote cancellation. Invalid JSON, non-object or malformed RPC
frames and records above maxRecordBytes (default 2,000,000 UTF-8 bytes) report
onProtocolError, reject pending requests and stop the child. Newline-free final
records are parsed on stdout end. Errors use RpcError.code/details.
Hosts must pass their existing response capacity as maxRecordBytes when adopting
this transport; the conservative default is not a session-history truncation policy.
A former Node readline host without an application byte cap can preserve its
runtime string envelope with `3 * buffer.constants.MAX_STRING_LENGTH`: each UTF-16
code unit requires at most three UTF-8 bytes. This is a finite wire bound derived
from the runtime, not a guarantee of available heap or successful parsing at that size.
stop rejects pending requests immediately and awaits process exit, escalating
SIGTERM to SIGKILL after stopTimeoutMs. onExit reports unexpected termination.
stderr retains at most maxStderrLines (default 100); hosts decide its visibility.

Build: npm install; npm test; npm pack. Runtime dependencies: none.
