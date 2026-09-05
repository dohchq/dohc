import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { load } from 'js-yaml'

const compose = load(readFileSync('docker-compose.self-host.yml', 'utf8'))
const envExample = Object.fromEntries(
  readFileSync('.env.self-host.example', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=', 2)),
)

const relay = compose.services['sync-relay']
const shareWeb = compose.services['share-web']

/** A `${NAME:?message}` interpolation refuses to start without NAME set. */
const required = (name) => new RegExp(`^\\$\\{${name}:\\?`)

test('the relay refuses to start without its secrets', () => {
  assert.match(relay.environment.DOHC_RELAY_LINK_KEY, required('DOHC_RELAY_LINK_KEY'))
  assert.match(relay.environment.DOHC_RELAY_EXCHANGE_KEY, required('DOHC_RELAY_EXCHANGE_KEY'))
  assert.match(
    relay.environment.DOHC_RELAY_SHARE_WEB_ORIGIN,
    required('DOHC_SHARE_WEB_PUBLIC_ORIGIN'),
  )
})

test('share-web and the relay read the same exchange key', () => {
  assert.equal(
    shareWeb.environment.DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY,
    relay.environment.DOHC_RELAY_EXCHANGE_KEY,
  )
})

test('share-web waits for the relay to answer HTTP, not only to start', () => {
  assert.equal(shareWeb.depends_on['sync-relay'].condition, 'service_healthy')
  assert.ok(relay.healthcheck?.test, 'the relay declares a healthcheck')
})

test('share-web reaches the relay over the compose network and publishes one origin', () => {
  assert.equal(shareWeb.environment.DOHC_SHARE_WEB_RELAY_URL, 'http://sync-relay:1788')
  assert.match(
    shareWeb.environment.DOHC_SHARE_WEB_PUBLIC_RELAY_URL,
    required('DOHC_SHARE_WEB_PUBLIC_RELAY_URL'),
  )
  assert.match(
    shareWeb.environment.DOHC_SHARE_WEB_PUBLIC_HOSTS,
    required('DOHC_SHARE_WEB_PUBLIC_HOST'),
  )
})

test('the example env names every variable compose requires', () => {
  const interpolations = readFileSync('docker-compose.self-host.yml', 'utf8').matchAll(
    /\$\{([A-Z_]+):\?/g,
  )
  for (const [, name] of interpolations) {
    assert.ok(name in envExample, `.env.self-host.example must define ${name}`)
  }
})

test('the example env keeps the public relay URL distinct from the compose-internal one', () => {
  assert.notEqual(envExample.DOHC_SHARE_WEB_PUBLIC_RELAY_URL, 'http://sync-relay:1788')
  assert.equal(
    envExample.DOHC_SHARE_WEB_PUBLIC_HOST,
    new URL(envExample.DOHC_SHARE_WEB_PUBLIC_ORIGIN).hostname,
  )
})
