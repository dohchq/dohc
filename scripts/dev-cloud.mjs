import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEV_DIR = join(ROOT, '.dohc-dev')
const LOG_FILE = join(DEV_DIR, 'workspace-api.log')
const PID_FILE = join(DEV_DIR, 'workspace-api.pid')
const HEALTH_URL = 'http://localhost:1786/health'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.error?.code === 'ENOENT') {
    console.error(`${command} is not installed or not on PATH; install it and retry.`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed.`)
    process.exit(result.status ?? 1)
  }
}

async function workspaceApiHealthy() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1_000) })
    if (!response.ok) return false
    const body = await response.json().catch(() => null)
    return body?.ok === true
  } catch {
    return false
  }
}

function startWorkspaceApi() {
  mkdirSync(DEV_DIR, { recursive: true })
  const log = openSync(LOG_FILE, 'a')
  // Detached with a pidfile so the only stop path is kill -TERM on the
  // recorded pid -- never a pattern kill, which on WSL matches VS Code
  // Server and every other node process.
  const child = spawn(
    'corepack',
    ['pnpm', '--filter', '@dohc/workspace-api', 'exec', 'tsx', 'src/main.ts'],
    {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/share/nvm/v22.13.0/bin:${process.env.PATH}`,
        COREPACK_INTEGRITY_KEYS: '0',
        DOHC_TEST_AUTH: '1',
        WORKSPACE_API_PORT: '1786',
      },
    },
  )
  writeFileSync(PID_FILE, `${child.pid}\n`)
  child.unref()
  console.log(`workspace-api starting detached (pid ${child.pid})`)
  console.log(`  log:  ${LOG_FILE}`)
  console.log(`  pid:  ${PID_FILE}`)
  console.log('  stop: kill -TERM $(cat .dohc-dev/workspace-api.pid)')
}

run('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d', 'postgres', 'minio'])

if (await workspaceApiHealthy()) {
  console.log(`workspace-api already healthy at ${HEALTH_URL}; leaving it running.`)
} else {
  startWorkspaceApi()
}

const ready = spawnSync('node', [join(ROOT, 'scripts', 'check-cloud-ready.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
})
process.exit(ready.status ?? 1)
