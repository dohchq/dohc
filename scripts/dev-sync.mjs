import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_DEV_JWT_SECRET =
  'dev-jwt-secret-change-me-with-at-least-32-bytes'
export const DEFAULT_DEV_ADMIN_URL = 'http://127.0.0.1:1234'
export const DEFAULT_DEV_ADMIN_TOKEN = 'dev-admin-token-change-me'
export const DEFAULT_DEV_CONVEX_SERVER_TOKEN =
  'dev-convex-server-token-change-me-with-at-least-32-bytes'

function devJwtSecret(env = process.env) {
  return env.HOCUSPOCUS_JWT_SECRET ?? DEFAULT_DEV_JWT_SECRET
}

function devAdminUrl(env = process.env) {
  return env.HOCUSPOCUS_ADMIN_URL ?? DEFAULT_DEV_ADMIN_URL
}

function devAdminToken(env = process.env) {
  return env.HOCUSPOCUS_ADMIN_TOKEN ?? DEFAULT_DEV_ADMIN_TOKEN
}

function adminEndpoint(pathname, env = process.env) {
  return new URL(pathname, devAdminUrl(env)).toString()
}

function devConvexServerToken(env = process.env) {
  return env.HOCUSPOCUS_CONVEX_SERVER_TOKEN ?? DEFAULT_DEV_CONVEX_SERVER_TOKEN
}

function readDotEnvFile(path) {
  if (!existsSync(path)) return {}
  const values = {}
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

function hydrateAppEnv(env = process.env) {
  const files = [
    resolve('apps/app/.env.local'),
    resolve('apps/app/.env'),
  ]
  for (const file of files) {
    const values = readDotEnvFile(file)
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) env[key] = value
    }
  }
}

function devConvexUrl(env = process.env) {
  return env.HOCUSPOCUS_CONVEX_URL ?? env.VITE_CONVEX_URL ?? env.CONVEX_URL
}

export async function hocuspocusReady(env = process.env) {
  try {
    const health = await fetch(adminEndpoint('/healthz', env))
    if (!health.ok) return false
    const capabilities = await fetch(adminEndpoint('/capabilities', env))
    const capabilitiesBody = await capabilities.json().catch(() => null)
    if (
      !capabilities.ok ||
      capabilitiesBody?.capabilities?.atomBootstrap !== true
    ) {
      return false
    }
    const preflight = await fetch(adminEndpoint('/apply/preflight', env), {
      headers: { authorization: `Bearer ${devAdminToken(env)}` },
    })
    const body = await preflight.json().catch(() => null)
    return (
      preflight.ok &&
      body?.ok === true &&
      body?.semanticWrites === true &&
      body?.createAtom === true
    )
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

export function ensureConvexEnvValue(name, value, label, runConvexEnv = convexEnv) {
  const convexEnvFn = runConvexEnv
  const current = convexEnvFn('get', [name])
  const output = `${current.stdout ?? ''}${current.stderr ?? ''}`
  const currentValue = (current.stdout ?? '').trim()
  if (current.status === 0 && currentValue === value) return

  if (current.status === 0 && !output.includes('not found')) {
    console.log(
      currentValue
        ? `Updating Convex dev ${name} to match local Hocuspocus`
        : `Setting Convex dev ${name} for local ${label}`,
    )
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
  const convexEnvFn = options.runConvexEnv ?? options.convexEnv ?? convexEnv
  if (!options.env) hydrateAppEnv(env)
  const convexUrl = devConvexUrl(env)
  if (convexUrl && !env.HOCUSPOCUS_CONVEX_URL) {
    env.HOCUSPOCUS_CONVEX_URL = convexUrl
  }
  if (!env.HOCUSPOCUS_CONVEX_SERVER_TOKEN) {
    env.HOCUSPOCUS_CONVEX_SERVER_TOKEN = DEFAULT_DEV_CONVEX_SERVER_TOKEN
  }
  if (env.DOHC_SKIP_CONVEX_ENV_SYNC) return

  ensureConvexEnvValue(
    'HOCUSPOCUS_JWT_SECRET',
    devJwtSecret(env),
    'collaboration token minting',
    convexEnvFn,
  )
  ensureConvexEnvValue(
    'HOCUSPOCUS_ADMIN_URL',
    devAdminUrl(env),
    'agent semantic writes',
    convexEnvFn,
  )
  ensureConvexEnvValue(
    'HOCUSPOCUS_ADMIN_TOKEN',
    devAdminToken(env),
    'agent semantic writes',
    convexEnvFn,
  )
  ensureConvexEnvValue(
    'HOCUSPOCUS_CONVEX_SERVER_TOKEN',
    devConvexServerToken(env),
    'Hocuspocus Convex bootstrap',
    convexEnvFn,
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
