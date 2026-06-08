#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIRMATION = 'WIPE_DEV_DATA'
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const appRoot = resolve(repoRoot, 'apps/app')
let localEnvCache

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto
}

function parseArgs(argv) {
  const args = {
    emails: [],
    emailDomains: [],
    workosUserIds: [],
    convexOnly: false,
    workosOnly: false,
    deleteWorkosOrgs: false,
    dryRun: false,
    forceProductionReset: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`)
      }
      return value
    }
    switch (arg) {
      case '--confirm':
        args.confirm = next()
        break
      case '--email':
        args.emails.push(next().toLowerCase())
        break
      case '--email-domain':
        args.emailDomains.push(normalizeDomain(next()))
        break
      case '--workos-user-id':
        args.workosUserIds.push(next())
        break
      case '--convex-only':
        args.convexOnly = true
        break
      case '--workos-only':
        args.workosOnly = true
        break
      case '--delete-workos-orgs':
        args.deleteWorkosOrgs = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--force-production-reset':
        args.forceProductionReset = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }
  return args
}

function printUsage() {
  console.log(`Usage:
  pnpm reset:dev -- --confirm ${CONFIRMATION} --email you@example.com
  pnpm reset:dev -- --confirm ${CONFIRMATION} --email-domain example.test --delete-workos-orgs
  pnpm reset:dev -- --confirm ${CONFIRMATION} --convex-only

This deletes development Convex app data and matching WorkOS identities.
WorkOS cleanup requires at least one selector: --email, --email-domain, or --workos-user-id.
Add --dry-run to preview WorkOS matches without deleting them.`)
}

function normalizeDomain(value) {
  return value.trim().toLowerCase().replace(/^@/, '')
}

function assertSafe(args) {
  if (args.confirm !== CONFIRMATION) {
    throw new Error(`Refusing to reset without --confirm ${CONFIRMATION}`)
  }
  if (args.convexOnly && args.workosOnly) {
    throw new Error('--convex-only and --workos-only cannot be combined')
  }
  if (!args.convexOnly && !hasWorkosSelector(args)) {
    throw new Error(
      'At least one WorkOS identity selector is required: --email, --email-domain, or --workos-user-id',
    )
  }
  if (!args.forceProductionReset && looksProductionLike()) {
    throw new Error(
      'Refusing to run against a production-looking Convex environment. Set --force-production-reset only if this is truly a disposable development deployment.',
    )
  }
}

function hasWorkosSelector(args) {
  return (
    args.emails.length > 0 ||
    args.emailDomains.length > 0 ||
    args.workosUserIds.length > 0
  )
}

function looksProductionLike() {
  const values = [
    envValue('CONVEX_DEPLOYMENT'),
    envValue('NEXT_PUBLIC_CONVEX_URL'),
    envValue('VITE_CONVEX_URL'),
  ]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .toLowerCase()
  return /\bprod(uction)?\b/.test(values) || values.includes('dohc.com')
}

function envValue(key) {
  return process.env[key] ?? localEnv()[key]
}

function localEnv() {
  if (!localEnvCache) localEnvCache = readLocalEnvFiles()
  return localEnvCache
}

function readLocalEnvFiles() {
  const files = [
    resolve(repoRoot, '.env'),
    resolve(repoRoot, '.env.local'),
    resolve(appRoot, '.env'),
    resolve(appRoot, '.env.local'),
  ]
  const values = {}
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/)
      if (match && !values[match[1]]) {
        values[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
      }
    }
  }
  return values
}

function runConvexReset({ dryRun }) {
  if (dryRun) {
    console.log('[dry-run] Would run Convex internal.devReset.wipeAllData')
    return
  }
  if (!existsSync(resolve(appRoot, 'convex/devReset.ts'))) {
    throw new Error(`Cannot find app Convex directory at ${appRoot}`)
  }
  let pass = 1
  while (true) {
    const result = runConvexMutation()
    console.log(
      `[convex] pass ${pass}: deleted ${result.total ?? 0} rows` +
        (result.deletedStorage ? ` and ${result.deletedStorage} storage blobs` : ''),
    )
    if (result.done === false) {
      pass++
      continue
    }
    break
  }
}

function runConvexMutation() {
  const payload = JSON.stringify({ confirm: CONFIRMATION })
  const result = spawnSync(
    'npx',
    ['convex', 'run', 'internal.devReset.wipeAllData', payload],
    {
      cwd: appRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  )
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`Convex reset failed:\n${output}`)
  }
  const output = result.stdout.trim()
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not parse Convex reset output:\n${output}`)
  }
  return JSON.parse(output.slice(start, end + 1))
}

async function runWorkosReset(args) {
  const apiKey = envValue('WORKOS_API_KEY')
  const clientId = envValue('WORKOS_CLIENT_ID')
  if (!apiKey || !clientId) {
    throw new Error('WORKOS_API_KEY and WORKOS_CLIENT_ID are required for WorkOS cleanup')
  }

  const { WorkOS } = await import('@workos-inc/node')
  const workos = new WorkOS(apiKey, { clientId })
  const selectedOrganizationIds = new Set()
  const users = (await listAll((opts) => workos.userManagement.listUsers(opts))).filter(
    (user) => matchesUser(args, user),
  )

  if (users.length === 0) {
    console.log('[workos] No matching users found')
  }

  for (const user of users) {
    const memberships = await listAll((opts) =>
      workos.userManagement.listOrganizationMemberships({
        ...opts,
        userId: user.id,
      }),
    )
    console.log(
      `[workos] ${args.dryRun ? 'Would delete' : 'Deleting'} ${user.email ?? user.id}` +
        ` (${memberships.length} memberships)`,
    )
    for (const membership of memberships) {
      if (membership.organizationId) selectedOrganizationIds.add(membership.organizationId)
    }
    if (args.dryRun) continue
    for (const membership of memberships) {
      await workos.userManagement.deleteOrganizationMembership(membership.id)
    }
    await workos.userManagement.deleteUser(user.id)
  }

  if (args.deleteWorkosOrgs) {
    const orgs = (await listAll((opts) => workos.organizations.listOrganizations(opts))).filter(
      (org) =>
        selectedOrganizationIds.has(org.id) &&
        typeof org.externalId === 'string' &&
        org.externalId.length > 0,
    )
    for (const org of orgs) {
      console.log(
        `[workos] ${args.dryRun ? 'Would delete' : 'Deleting'} organization ${org.id}` +
          (org.name ? ` (${org.name})` : ''),
      )
      if (!args.dryRun) await workos.organizations.deleteOrganization(org.id)
    }
  } else {
    console.log('[workos] Skipped organization deletion; pass --delete-workos-orgs to remove dohc-linked orgs too')
  }
}

async function listAll(fetchPage) {
  const data = []
  let after
  while (true) {
    const page = await fetchPage({ limit: 100, after })
    data.push(...(page.data ?? []))
    const metadata = page.listMetadata ?? page.metadata ?? {}
    after = metadata.after ?? metadata.nextCursor
    if (!after) break
  }
  return data
}

function matchesUser(args, user) {
  if (args.workosUserIds.includes(user.id)) return true
  const email = String(user.email ?? '').toLowerCase()
  if (email && args.emails.includes(email)) return true
  return args.emailDomains.some((domain) => email.endsWith(`@${domain}`))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  assertSafe(args)
  if (!args.workosOnly) runConvexReset(args)
  if (!args.convexOnly) await runWorkosReset(args)
  console.log('[reset:dev] Done')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
