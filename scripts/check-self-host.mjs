import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const COMPOSE_FILE = 'docker-compose.self-host.yml'
const ENV_FILE = '.env.self-host.example'
const REQUIRED_SERVICES = [
  'workspace-api',
  'sync-relay',
  'postgres',
  'sqlite-worker',
  'agent-sandbox',
]
// A one-shot init container (runs to completion, then exits) — verified for
// presence but never expected to stay running, so it is not in
// REQUIRED_SERVICES (which drives the "still running" assertions).
const MIGRATION_SERVICE = 'postgres-migrate'

const startRequested =
  process.argv.includes('--start') || process.env.DOHC_SELF_HOST_START === '1'

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const marker = ok ? 'ok' : 'missing'
  console.log(`[${marker}] ${name}${detail ? ` - ${detail}` : ''}`)
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function requireCommand(command, args, label) {
  const result = run(command, args)
  if (result.status === 0) {
    record(label, true, (result.stdout || result.stderr).trim().split(/\r?\n/)[0])
    return true
  }
  record(label, false, `${command} ${args.join(' ')} failed or is unavailable`)
  return false
}

function composeArgs(...args) {
  return ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args]
}

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function checkServiceScripts() {
  const root = readPackageJson('package.json')
  record(
    'root check:self-host script',
    root.scripts?.['check:self-host'] === 'node scripts/check-self-host.mjs',
    'package.json exposes pnpm check:self-host',
  )
  record(
    'root migrate script',
    root.scripts?.['migrate'] === 'node scripts/migrate-postgres.mjs',
    'package.json exposes pnpm migrate (Postgres schema bootstrap)',
  )
  record(
    'migrate script file',
    existsSync('scripts/migrate-postgres.mjs') &&
      existsSync('scripts/lib/apply-migrations.mjs'),
    'scripts/migrate-postgres.mjs + scripts/lib/apply-migrations.mjs',
  )
  for (const [label, path] of [
    ['workspace API package', 'services/workspace-api/package.json'],
    ['sync relay package', 'services/sync-relay/package.json'],
    ['sqlite worker package', 'services/sqlite-worker/package.json'],
    ['agent sandbox package', 'services/agent-sandbox/package.json'],
  ]) {
    record(label, existsSync(path), path)
  }
}

// MU-C5 self-host proof: the WHOLE multi-user chat surface (presence,
// reactions, shares, shared channels, DMs) must run on the services this script
// already validates — sync-relay + Better Auth over Postgres — with NO new
// service and nothing cloud-locked. Purely static (reads source + package.json),
// so it is deterministic and needs neither Docker nor --start.
function checkChatSurfaceSelfHostable() {
  const relaySource = 'services/sync-relay/src/server.ts'
  if (!existsSync(relaySource)) {
    record('chat surface: relay source present', false, relaySource)
    return
  }
  const source = readFileSync(relaySource, 'utf8')

  // (a) The relay must serve every route the multi-user chat surface needs.
  // Inspect the handler's canonical `SyncRelayRoute` dispatch union rather than
  // line-grepping the file: parsing the route-kind literals out of the union
  // survives reordering, added routes, and whitespace churn, and trips ONLY
  // when a served route is renamed or removed — exactly when it should.
  const unionMatch = source.match(/type SyncRelayRoute =([\s\S]*?);\n/)
  const routeKinds = new Set(
    unionMatch
      ? [...unionMatch[1].matchAll(/route:\s*"([^"]+)"/g)].map((match) => match[1])
      : [],
  )
  const REQUIRED_CHAT_ROUTES = [
    'presence', // /sync/:ws/presence — owner + shared-channel presence
    'share-presence', // /sync/shares/:id/presence — recipient/DM presence
    'shares-create', // POST /sync/:ws/shares — path / channel / DM grants
    'shares-list', // GET /sync/shares
    'share', // GET /sync/shares/:id — grant metadata
    'share-revoke', // POST /sync/shares/:id/revoke
    'share-log', // GET read-view + POST member-append
    'share-blob', // GET /sync/shares/:id/blobs/:sha
  ]
  const missingRoutes = REQUIRED_CHAT_ROUTES.filter((route) => !routeKinds.has(route))
  record(
    'chat surface: sync-relay serves every multi-user route',
    missingRoutes.length === 0 && routeKinds.size > 0,
    missingRoutes.length === 0 && routeKinds.size > 0
      ? 'presence, share-presence, shares-create/list, share, share-revoke, share-log (member-append), share-blob'
      : `missing served route kind(s): ${missingRoutes.join(', ') || 'route union not found'}`,
  )

  // (b) No chat/presence/DM feature may pull in a service outside
  // REQUIRED_SERVICES. The relay's runtime dependencies must resolve entirely to
  // the self-host matrix: the in-repo workspace packages, plus better-auth + pg
  // (which ride the `postgres` + `workspace-api` auth core). Anything else would
  // be a new service the compose stack does not run.
  const relayPkg = readPackageJson('services/sync-relay/package.json')
  const deps = Object.keys(relayPkg.dependencies ?? {})
  const ALLOWED_RUNTIME_DEPS = new Set([
    '@dohc/workspace-auth', // Better Auth session verification (workspace-api core)
    '@dohc/workspace-core',
    '@dohc/workspace-engine',
    'better-auth', // rides the `postgres` auth core
    'pg', // rides the `postgres` auth core
  ])
  const foreignDeps = deps.filter((dep) => !ALLOWED_RUNTIME_DEPS.has(dep))
  record(
    'chat surface: relay runtime deps stay within the self-host matrix',
    foreignDeps.length === 0,
    foreignDeps.length === 0
      ? deps.join(', ') || 'no runtime deps'
      : `unexpected runtime dep(s) imply a service outside REQUIRED_SERVICES: ${foreignDeps.join(', ')}`,
  )

  // Defense in depth: no chat/presence/DM source references a retired or
  // cloud-locked collaboration service (Hocuspocus / Convex).
  const CHAT_SOURCES = [
    'services/sync-relay/src/server.ts',
    'services/sync-relay/src/presence.ts',
    'services/sync-relay/src/shareFilter.ts',
    'services/sync-relay/src/storage.ts',
    'services/sync-relay/src/main.ts',
  ]
  const FORBIDDEN = /hocuspocus|convex/i
  const offenders = CHAT_SOURCES.filter(
    (path) => existsSync(path) && FORBIDDEN.test(readFileSync(path, 'utf8')),
  )
  record(
    'chat surface: no cloud-locked collaboration service referenced',
    offenders.length === 0,
    offenders.length === 0
      ? 'no hocuspocus/convex references in the chat/presence/DM sources'
      : `cloud-locked service referenced in: ${offenders.join(', ')}`,
  )
}

function checkComposeConfig() {
  if (!existsSync(COMPOSE_FILE)) {
    record('self-host compose file', false, COMPOSE_FILE)
    return false
  }
  if (!existsSync(ENV_FILE)) {
    record('self-host env example', false, ENV_FILE)
    return false
  }
  const config = run('docker', composeArgs('config', '--services'))
  if (config.status !== 0) {
    record(
      'docker compose config',
      false,
      (config.stderr || config.stdout).trim() || 'compose config failed',
    )
    return false
  }
  const services = new Set(config.stdout.trim().split(/\r?\n/).filter(Boolean))
  for (const service of REQUIRED_SERVICES) {
    record(`compose service:${service}`, services.has(service), service)
  }
  record(
    `compose service:${MIGRATION_SERVICE}`,
    services.has(MIGRATION_SERVICE),
    'one-shot Postgres migration init container (applies 0001..000N incl. Better Auth)',
  )
  return (
    REQUIRED_SERVICES.every((service) => services.has(service)) &&
    services.has(MIGRATION_SERVICE)
  )
}

function startComposeStack() {
  const up = spawnSync('docker', composeArgs('up', '-d', ...REQUIRED_SERVICES), {
    stdio: 'inherit',
  })
  if (up.status !== 0) {
    record('compose up', false, 'docker compose up failed')
    return
  }
  const ps = run('docker', composeArgs('ps', '--services', '--filter', 'status=running'))
  if (ps.status !== 0) {
    record('compose ps', false, (ps.stderr || ps.stdout).trim())
    return
  }
  const running = new Set(ps.stdout.trim().split(/\r?\n/).filter(Boolean))
  for (const service of REQUIRED_SERVICES) {
    record(`running service:${service}`, running.has(service), service)
  }
}

requireCommand('docker', ['--version'], 'Docker CLI')
requireCommand('docker', ['compose', 'version'], 'Docker Compose')
checkServiceScripts()
// Static self-host proof for the multi-user chat surface (no Docker needed).
checkChatSurfaceSelfHostable()
const composeOk = checkComposeConfig()

if (startRequested && composeOk) {
  startComposeStack()
} else if (composeOk) {
  console.log(
    'Self-host preflight passed. To start the stack, run: pnpm check:self-host -- --start',
  )
}

const passed = results.filter((result) => result.ok).length
console.log(`Self-host check summary: ${passed}/${results.length} checks passed.`)

if (results.some((result) => !result.ok)) {
  console.error('Self-host check failed. Missing dependencies are listed above.')
  process.exit(1)
}
