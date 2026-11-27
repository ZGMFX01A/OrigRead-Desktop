const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')

const parentPid = Number(process.argv[2])
const command = process.argv[3] || ''
const args = process.argv.slice(4)

if (!Number.isInteger(parentPid) || parentPid <= 0 || !command) {
  process.stderr.write('OrigRead MCP guardian received invalid launch parameters.\n')
  process.exit(64)
}

const childEnv = { ...process.env }
const childEnvironmentJson = process.env.ORIGREAD_MCP_CHILD_ENV_JSON
delete childEnv.ELECTRON_RUN_AS_NODE
delete childEnv.ORIGREAD_MCP_CHILD_ELECTRON_RUN_AS_NODE
delete childEnv.ORIGREAD_MCP_CHILD_ENV_JSON

// 与 Repository 的拒绝规则一致；系统定位变量只允许继承，不能被用户 JSON 覆盖。
for (const name of Object.keys(childEnv)) {
  if (isBlockedEnvironmentName(name) && !['PATH', 'SYSTEMROOT', 'WINDIR'].includes(name.toUpperCase())) delete childEnv[name]
}
if (childEnvironmentJson) {
  try {
    const values = JSON.parse(childEnvironmentJson)
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('expected an environment object')
    for (const [name, value] of Object.entries(values)) {
      if (!isBlockedEnvironmentName(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === 'string' && !value.includes('\0')) childEnv[name] = value
    }
  } catch (error) {
    process.stderr.write(`OrigRead MCP guardian rejected child environment: ${String(error)}\n`)
    process.exit(64)
  }
}

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
  try { process.stdin.unpipe(child.stdin) } catch (error) { reportCleanupError(error) }
  try { child.stdin.end() } catch (error) { reportCleanupError(error) }
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
    try { spawnSync(resolveWindowsTaskkillPath(), taskkillArgs, { windowsHide: true, stdio: 'ignore' }) } catch (error) { reportCleanupError(error) }
    return
  }
  try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM') } catch {
    try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM') } catch (error) { reportCleanupError(error) }
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


function isBlockedEnvironmentName(name) {
  const upper = name.toUpperCase()
  return new Set([
    'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH', 'NODE_REDIRECT_WARNINGS',
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH', 'DYLD_FORCE_FLAT_NAMESPACE', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
    'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'PERL5OPT', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'IFS',
    'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'COMSPEC', 'PATHEXT', 'PATH', 'SYSTEMROOT', 'WINDIR'
  ]).has(upper) || ['ORIGREAD_MCP_', 'LD_', 'DYLD_', 'ELECTRON_'].some((prefix) => upper.startsWith(prefix))
}

function resolveWindowsTaskkillPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || ''
  return path.win32.join(path.win32.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows', 'System32', 'taskkill.exe')
}

function reportCleanupError(error) {
  if (error && error.code === 'ESRCH') return
  process.stderr.write(`OrigRead MCP guardian cleanup failed: ${String(error)}\n`)
}
