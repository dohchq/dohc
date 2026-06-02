import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

const STATE_URL =
  'http://127.0.0.1:1234/document-state?documentName=workspace%2Fdev-smoke%2Fatom%2Fdev-smoke'
const DEFAULT_DEV_JWT_SECRET =
  'dev-jwt-secret-change-me-with-at-least-32-bytes'
export const DEFAULT_DEV_ADMIN_URL = 'http://127.0.0.1:1234'
export const DEFAULT_DEV_ADMIN_TOKEN = 'dev-admin-token-change-me'

function devJwtSecret(env = process.env) {
  return env.HOCUSPOCUS_JWT_SECRET ?? DEFAULT_DEV_JWT_SECRET
}

function devAdminUrl(env = process.env) {
  return env.HOCUSPOCUS_ADMIN_URL ?? DEFAULT_DEV_ADMIN_URL
}

function devAdminToken(env = process.env) {
  return env.HOCUSPOCUS_ADMIN_TOKEN ?? DEFAULT_DEV_ADMIN_TOKEN
}

async function hocuspocusReady() {
  try {
    const response = await fetch(STATE_URL)
    return response.ok
  } catch {
    return false
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(750, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHocuspocusReady(timeoutMs = 30_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await hocuspocusReady()) return true
    await sleep(500)
  }
  return false
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function convexEnv(command, args, options = {}) {
  return spawnSync(
    'pnpm',
    ['--filter', '@dohc/app', 'exec', 'convex', 'env', command, ...args],
    {
      encoding: 'utf8',
      stdio: options.stdio ?? 'pipe',
    },
  )
}

function ensureConvexEnvValue(name, value, label, options = {}) {
  const convexEnvFn = options.convexEnv ?? convexEnv
  const current = convexEnvFn('get', [name])
  const output = `${current.stdout ?? ''}${current.stderr ?? ''}`
  const currentValue = (current.stdout ?? '').trim()
  if (current.status === 0 && currentValue === value) return

  if (current.status === 0 && currentValue && !output.includes('not found')) {
    console.log(`Updating Convex dev ${name} to match local Hocuspocus`)
  } else if (output.includes('not found')) {
    console.log(`Setting Convex dev ${name} for local ${label}`)
  } else {
    console.warn(
      `Could not read Convex dev ${name}; local ${label} may fail.`,
    )
    return
  }

  const updated = convexEnvFn('set', [name, value], {
    stdio: 'inherit',
  })
  if (updated.status !== 0) {
    console.warn(`Could not set Convex dev ${name}; local ${label} may fail.`)
  }
}

export function ensureConvexHocuspocusEnv(options = {}) {
  const env = options.env ?? process.env
  const convexEnvFn = options.convexEnv ?? convexEnv
  if (env.DOHC_SKIP_CONVEX_ENV_SYNC) return

  ensureConvexEnvValue(
    'HOCUSPOCUS_JWT_SECRET',
    devJwtSecret(env),
    'collaboration token minting',
    { convexEnv: convexEnvFn },
  )
  ensureConvexEnvValue(
    'HOCUSPOCUS_ADMIN_URL',
    devAdminUrl(env),
    'agent semantic writes',
    { convexEnv: convexEnvFn },
  )
  ensureConvexEnvValue(
    'HOCUSPOCUS_ADMIN_TOKEN',
    devAdminToken(env),
    'agent semantic writes',
    { convexEnv: convexEnvFn },
  )
}

export async function main() {
  ensureConvexHocuspocusEnv()

  if (await hocuspocusReady()) {
    process.exit(0)
  }

  // A stale pre-compose Hocuspocus container can keep the fixed local name while
  // serving old code. It has no durable data; Postgres owns the data volume.
  spawnSync('docker', ['rm', '-f', 'dohc-v2-hocuspocus'], { stdio: 'ignore' })

  const compose = ['compose', '-f', 'docker-compose.dev.yml']
  if (await portOpen(54329)) {
    run('docker', [...compose, 'up', '-d', '--build', '--no-deps', 'hocuspocus'])
  } else {
    spawnSync('docker', ['rm', '-f', 'dohc-v2-postgres'], { stdio: 'ignore' })
    run('docker', [...compose, 'up', '-d', '--build', 'postgres', 'hocuspocus'])
  }

  if (!(await waitForHocuspocusReady())) {
    console.error('Hocuspocus did not become ready on http://127.0.0.1:1234')
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
