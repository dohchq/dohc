import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { load } from 'js-yaml'

const composeText = readFileSync('docker-compose.self-host.yml', 'utf8')
const compose = load(composeText)
const envExample = Object.fromEntries(
  readFileSync('.env.self-host.example', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const eq = line.indexOf('=')
      assert.notEqual(eq, -1, `.env.self-host.example line has no value: ${line}`)
      return [line.slice(0, eq), line.slice(eq + 1)]
    }),
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

test('browser sign-in uses the shared auth base and exact viewer origin', () => {
  const api = compose.services['workspace-api']
  assert.match(api.environment.WORKSPACE_API_BASE_URL, required('WORKSPACE_API_BASE_URL'))
  assert.equal(relay.environment.SYNC_RELAY_AUTH_BASE_URL, api.environment.WORKSPACE_API_BASE_URL)
  assert.equal(api.environment.DOHC_WEB_ORIGIN, shareWeb.environment.DOHC_SHARE_WEB_PUBLIC_ORIGIN)
  assert.match(api.environment.DOHC_WEB_ORIGIN, required('DOHC_SHARE_WEB_PUBLIC_ORIGIN'))
  assert.equal(shareWeb.environment.DOHC_SHARE_WEB_AUTH_URL, 'http://workspace-api:1786')
  assert.equal(shareWeb.depends_on['workspace-api'].condition, 'service_healthy')
  assert.ok(api.healthcheck?.test, 'the auth service declares a healthcheck')
  assert.equal(new URL(envExample.WORKSPACE_API_BASE_URL).protocol, 'https:')
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

test('the relay keeps its database on a named volume', () => {
  assert.ok(relay.volumes.includes('dohc_self_host_sync_relay:/data'))
  assert.ok('dohc_self_host_sync_relay' in compose.volumes)
})

test('share-web binds every interface so its published port is reachable', () => {
  assert.equal(shareWeb.environment.DOHC_SHARE_WEB_BIND, '0.0.0.0')
})

test('the example env names every variable compose requires', () => {
  const interpolations = composeText.matchAll(/\$\{([A-Z0-9_]+):\?/g)
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
