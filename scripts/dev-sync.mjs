import { spawnSync } from 'node:child_process'
import net from 'node:net'

const STATE_URL =
  'http://127.0.0.1:1234/document-state?documentName=workspace%2Fdev-smoke%2Fatom%2Fdev-smoke'
const DEV_JWT_SECRET =
  process.env.HOCUSPOCUS_JWT_SECRET ??
  'dev-jwt-secret-change-me-with-at-least-32-bytes'

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

function ensureConvexJwtSecret() {
  if (process.env.DOHC_SKIP_CONVEX_ENV_SYNC === '1') return

  const current = convexEnv('get', ['HOCUSPOCUS_JWT_SECRET'])
  const output = `${current.stdout ?? ''}${current.stderr ?? ''}`
  const value = (current.stdout ?? '').trim()
  if (current.status === 0 && value === DEV_JWT_SECRET) return

  if (current.status === 0 && value && !output.includes('not found')) {
    console.log(
      'Updating Convex dev HOCUSPOCUS_JWT_SECRET to match local Hocuspocus',
    )
  } else if (output.includes('not found')) {
    console.log(
      'Setting Convex dev HOCUSPOCUS_JWT_SECRET for local collaboration',
    )
  } else {
    console.warn(
      'Could not read Convex dev HOCUSPOCUS_JWT_SECRET; local collaboration token minting may fail.',
    )
    return
  }

  const updated = convexEnv('set', ['HOCUSPOCUS_JWT_SECRET', DEV_JWT_SECRET], {
    stdio: 'inherit',
  })
  if (updated.status !== 0) {
    console.warn(
      'Could not set Convex dev HOCUSPOCUS_JWT_SECRET; local collaboration token minting may fail.',
    )
  }
}

ensureConvexJwtSecret()

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
