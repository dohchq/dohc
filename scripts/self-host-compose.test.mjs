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
