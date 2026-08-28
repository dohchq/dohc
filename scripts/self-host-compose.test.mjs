import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function mappingValueAtPath(source, expectedPath) {
  const path = []

  for (const line of source.split(/\r?\n/)) {
    const match = /^( *)([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line)
    if (!match) continue

    const [, spaces, key, value] = match
    while (path.at(-1)?.indent >= spaces.length) path.pop()
    path.push({ indent: spaces.length, key })

    if (
      value !== undefined &&
      path.map((part) => part.key).join('.') === expectedPath.join('.')
    ) {
      return value
    }
  }

  return undefined
}

function mappingBlockAtPath(source, expectedPath) {
  const lines = source.split(/\r?\n/)
  const path = []

  for (const [index, line] of lines.entries()) {
    const match = /^( *)([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line)
    if (!match) continue

    const [, spaces, key] = match
    while (path.at(-1)?.indent >= spaces.length) path.pop()
    path.push({ indent: spaces.length, key })

    if (path.map((part) => part.key).join('.') !== expectedPath.join('.')) {
      continue
    }

    const block = [line]
    for (const candidate of lines.slice(index + 1)) {
      const indent = candidate.length - candidate.trimStart().length
      if (candidate.trim() !== '' && indent <= spaces.length) {
        break
      }
      block.push(candidate)
    }
    return block.join('\n')
  }

  return undefined
}

test('self-host sync relay requires the link grant key', () => {
  const compose = readFileSync('docker-compose.self-host.yml', 'utf8')

  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'sync-relay',
      'environment',
      'DOHC_RELAY_LINK_KEY',
    ]),
    '${DOHC_RELAY_LINK_KEY:?Set DOHC_RELAY_LINK_KEY in .env.self-host}',
  )
})

test('self-host sync relay requires and documents the relay exchange key', () => {
  const compose = readFileSync('docker-compose.self-host.yml', 'utf8')
  const envExample = readFileSync('.env.self-host.example', 'utf8')

  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'sync-relay',
      'environment',
      'DOHC_RELAY_EXCHANGE_KEY',
    ]),
    '${DOHC_RELAY_EXCHANGE_KEY:?Set DOHC_RELAY_EXCHANGE_KEY in .env.self-host}',
  )
  assert.match(
    envExample,
    /^DOHC_RELAY_EXCHANGE_KEY=change-me-with-at-least-32-random-bytes$/m,
  )
})

test('self-host share viewer waits for relay HTTP readiness', () => {
  const compose = readFileSync('docker-compose.self-host.yml', 'utf8')
  const shareWebDependsOn = mappingBlockAtPath(compose, [
    'services',
    'share-web',
    'depends_on',
  ])

  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'sync-relay',
      'healthcheck',
      'test',
    ]),
    `["CMD", "node", "-e", "fetch('http://127.0.0.1:1788/').then(() => process.exit(0)).catch(() => process.exit(1))"]`,
  )
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'sync-relay',
      'healthcheck',
      'interval',
    ]),
    '5s',
  )
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'sync-relay',
      'healthcheck',
      'timeout',
    ]),
    '5s',
  )
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'sync-relay',
      'healthcheck',
      'retries',
    ]),
    '20',
  )
  assert.equal(
    shareWebDependsOn,
    '    depends_on:\n      sync-relay:\n        condition: service_healthy',
  )
})

test('self-host compose starts the public share viewer with one external origin', () => {
  const compose = readFileSync('docker-compose.self-host.yml', 'utf8')
  const envExample = readFileSync('.env.self-host.example', 'utf8')
  const shareWebService = mappingBlockAtPath(compose, ['services', 'share-web'])
  const shareWebCommand = mappingBlockAtPath(compose, [
    'services',
    'share-web',
    'command',
  ])
  const shareWebPorts = mappingBlockAtPath(compose, [
    'services',
    'share-web',
    'ports',
  ])

  assert.ok(shareWebService, 'compose must define the share-web service')
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'sync-relay',
      'environment',
      'DOHC_RELAY_SHARE_WEB_ORIGIN',
    ]),
    '${DOHC_SHARE_WEB_PUBLIC_ORIGIN:?Set DOHC_SHARE_WEB_PUBLIC_ORIGIN in .env.self-host}',
  )
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'share-web',
      'environment',
      'DOHC_SHARE_WEB_RELAY_URL',
    ]),
    'http://sync-relay:1788',
  )
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'share-web',
      'environment',
      'DOHC_SHARE_WEB_PUBLIC_HOSTS',
    ]),
    '${DOHC_SHARE_WEB_PUBLIC_HOST:?Set DOHC_SHARE_WEB_PUBLIC_HOST in .env.self-host}',
  )
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'share-web',
      'environment',
      'DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY',
    ]),
    '${DOHC_RELAY_EXCHANGE_KEY:?Set DOHC_RELAY_EXCHANGE_KEY in .env.self-host}',
  )
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'share-web',
      'environment',
      'DOHC_SHARE_WEB_BIND',
    ]),
    '"0.0.0.0"',
  )
  assert.equal(
    mappingValueAtPath(compose, [
      'services',
      'share-web',
      'environment',
      'DOHC_SHARE_WEB_PORT',
    ]),
    '"1790"',
  )
  assert.match(
    shareWebPorts ?? '',
    /^    ports:\n      - "\$\{DOHC_SHARE_WEB_BIND:-127\.0\.0\.1\}:\$\{DOHC_SHARE_WEB_PORT:-1790\}:1790"$/m,
  )
  assert.match(
    shareWebCommand ?? '',
    /pnpm --filter @dohc\/share-web build &&\n      pnpm --filter @dohc\/share-web start"/,
  )
  assert.match(
    envExample,
    /^DOHC_SHARE_WEB_PUBLIC_ORIGIN=https:\/\/share\.example\.com$/m,
  )
  assert.match(envExample, /^DOHC_SHARE_WEB_PUBLIC_HOST=share\.example\.com$/m)
  assert.match(envExample, /^DOHC_SHARE_WEB_PORT=1790$/m)
})
