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
  for (const [label, path] of [
    ['workspace API package', 'services/workspace-api/package.json'],
    ['sync relay package', 'services/sync-relay/package.json'],
    ['sqlite worker package', 'services/sqlite-worker/package.json'],
    ['agent sandbox package', 'services/agent-sandbox/package.json'],
  ]) {
    record(label, existsSync(path), path)
  }
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
  return REQUIRED_SERVICES.every((service) => services.has(service))
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
const composeOk = checkComposeConfig()

if (startRequested && composeOk) {
  startComposeStack()
} else if (composeOk) {
  console.log(
    'Self-host preflight passed. To start the stack, run: pnpm check:self-host -- --start',
  )
}

if (results.some((result) => !result.ok)) {
  console.error('Self-host check failed. Missing dependencies are listed above.')
  process.exit(1)
}
