import net from 'node:net'

const POLL_DEADLINE_MS = 30_000
const POLL_INTERVAL_MS = 1_000

const CHECKS = [
  {
    name: 'postgres (127.0.0.1:54329)',
    probe: () => tcpOpen('127.0.0.1', 54329),
    remediation: 'pnpm dev:postgres',
  },
  {
    name: 'minio (http://127.0.0.1:9000)',
    probe: () => httpOk('http://127.0.0.1:9000/minio/health/live'),
    remediation: 'pnpm dev:postgres',
  },
  {
    name: 'workspace-api (http://localhost:1786)',
    probe: () => workspaceApiHealthy(),
    remediation: 'pnpm dev:cloud (then inspect: tail .dohc-dev/workspace-api.log)',
  },
]

function tcpOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(POLL_INTERVAL_MS, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function httpOk(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(POLL_INTERVAL_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

async function workspaceApiHealthy() {
  try {
    const response = await fetch('http://localhost:1786/health', {
      signal: AbortSignal.timeout(POLL_INTERVAL_MS),
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => null)
    return body?.ok === true
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const pending = new Set(CHECKS)
const deadline = Date.now() + POLL_DEADLINE_MS
while (pending.size > 0) {
  for (const check of [...pending]) {
    if (await check.probe()) pending.delete(check)
  }
  if (pending.size === 0 || Date.now() >= deadline) break
  await sleep(POLL_INTERVAL_MS)
}

if (pending.size === 0) {
  console.log('Cloud dev stack ready: postgres, minio, workspace-api')
} else {
  for (const check of pending) {
    console.error(`[down] ${check.name} - fix with: ${check.remediation}`)
  }
  process.exit(1)
}
