import { spawnSync } from 'node:child_process'
import net from 'node:net'

const STATE_URL =
  'http://127.0.0.1:1234/document-state?documentName=workspace%2Fdev-smoke%2Fatom%2Fdev-smoke'

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
