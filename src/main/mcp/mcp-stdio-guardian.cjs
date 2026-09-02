const { spawn, spawnSync } = require('node:child_process')

const parentPid = Number(process.argv[2])
const command = process.argv[3] || ''
const args = process.argv.slice(4)

if (!Number.isInteger(parentPid) || parentPid <= 0 || !command) {
  process.stderr.write('OrigRead MCP guardian received invalid launch parameters.\n')
  process.exit(64)
}

const childEnv = { ...process.env }
// The guardian itself runs through Electron in Node mode. Restore the user's
// original value before starting the actual MCP server so this internal flag
// never changes the server runtime unexpectedly.
const childElectronRunAsNode = childEnv.ORIGREAD_MCP_CHILD_ELECTRON_RUN_AS_NODE || ''
delete childEnv.ORIGREAD_MCP_CHILD_ELECTRON_RUN_AS_NODE
if (childElectronRunAsNode) childEnv.ELECTRON_RUN_AS_NODE = childElectronRunAsNode
else delete childEnv.ELECTRON_RUN_AS_NODE

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: false,
  windowsHide: true,
  // On Unix this also gives us a process group for descendant cleanup.
  detached: process.platform !== 'win32'
})

let shuttingDown = false
let parentWatch = null

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)

child.on('error', (error) => {
  process.stderr.write(`OrigRead MCP guardian failed to start server: ${error instanceof Error ? error.message : String(error)}\n`)
  shutdown(127)
})

child.on('exit', (code, signal) => {
  if (shuttingDown) return
  shuttingDown = true
  stopParentWatch()
  process.exit(typeof code === 'number' ? code : signal ? 1 : 0)
})

// Losing the Main-owned control pipe means nobody can consume MCP output or
// issue further requests. Reap the whole server tree instead of leaving a
// half-detached process behind.
process.stdin.on('end', () => shutdown(0))

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => shutdown(0))
}

parentWatch = setInterval(() => {
  if (!isProcessAlive(parentPid)) shutdown(0)
}, 250)
parentWatch.unref()

function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  stopParentWatch()
  try { process.stdin.unpipe(child.stdin) } catch {}
  try { child.stdin.end() } catch {}
  terminateProcessTree(child.pid)
  const timer = setTimeout(() => {
    terminateProcessTree(child.pid, true)
    process.exit(exitCode)
  }, 800)
  timer.unref()
  child.once('exit', () => process.exit(exitCode))
}

function stopParentWatch() {
  if (!parentWatch) return
  clearInterval(parentWatch)
  parentWatch = null
}

function terminateProcessTree(pid, force = false) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    const taskkillArgs = ['/PID', String(pid), '/T']
    if (force) taskkillArgs.push('/F')
    try { spawnSync('taskkill.exe', taskkillArgs, { windowsHide: true, stdio: 'ignore' }) } catch {}
    return
  }
  try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM') } catch {
    try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM') } catch {}
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && error.code === 'EPERM')
  }
}
