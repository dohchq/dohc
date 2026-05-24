/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'
import { parseDocId, atomDocId, shareDocId } from './prosemirror'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

const ALICE = 'ws_alice_m1pm'
const BOB = 'ws_bob_m1pm'

async function seedOrgWithMembers(t: ReturnType<typeof convexTest>) {
  const { orgId, inviteCode } = await t
    .withIdentity({ subject: ALICE })
    .mutation(api.orgs.createOrg, { name: 'Acme' })
  await t.withIdentity({ subject: BOB }).mutation(api.orgs.joinOrg, { inviteCode })
  return orgId
}

// M1 (multiplayer-and-h-followups §8) — prosemirror-sync auth gate
// foundations. The component exposes 5 query/mutation endpoints
// (getSnapshot / submitSnapshot / latestVersion / getSteps /
// submitSteps) that all flow through checkRead/checkWrite. We test
// the doc-id parser + the kind discriminator directly (the component
// gate fires structurally; convex-test doesn't carry the registered
// component, so end-to-end snapshot read/write is out of scope until
// we have a Convex dev deploy — but the parser + auth helpers can
// be exercised in isolation, which catches the wiring bugs that
// would block the integration).

describe('M1 — parseDocId / atomDocId / shareDocId', () => {
  it('round-trips atom ids', () => {
    const ws = 'ws_acme_demo'
    const atomId = 'k0000000000000000000000000000' as Id<'atoms'>
    const id = atomDocId(ws, atomId)
    expect(id).toBe(`atom:${ws}:${atomId}`)
    const parsed = parseDocId(id)
    expect(parsed.kind).toBe('atom')
    if (parsed.kind === 'atom') {
      expect(parsed.workspaceId).toBe(ws)
      expect(parsed.atomId).toBe(atomId)
    }
  })

  it('round-trips share ids', () => {
    const shareId = 'k0000000000000000000000000001' as Id<'atomShares'>
    const id = shareDocId(shareId)
    expect(id).toBe(`share:${shareId}`)
    const parsed = parseDocId(id)
    expect(parsed.kind).toBe('share')
    if (parsed.kind === 'share') {
      expect(parsed.shareId).toBe(shareId)
    }
  })

  it('rejects malformed ids cleanly (kind=invalid, never throws)', () => {
    // No prefix
    expect(parseDocId('').kind).toBe('invalid')
    expect(parseDocId('plain_string').kind).toBe('invalid')
    expect(parseDocId('user:k0').kind).toBe('invalid')
    // atom: prefix but missing segments
    expect(parseDocId('atom:').kind).toBe('invalid')
    expect(parseDocId('atom:ws_only').kind).toBe('invalid')
    expect(parseDocId('atom:ws_only:').kind).toBe('invalid')
    // share: prefix but missing the share segment
    expect(parseDocId('share:').kind).toBe('invalid')
  })

  it('atom-id-with-colons-in-workspaceId: first colon wins (workspaceIds are k-format, no colon)', () => {
    // Convex Ids are k-prefix base32, no colons. So splitting on the
    // FIRST colon after `atom:` is unambiguous. We don't currently
    // need to handle colon-bearing workspace ids; this test pins
    // the contract.
    const parsed = parseDocId('atom:k_ws:k_atom')
    expect(parsed.kind).toBe('atom')
    if (parsed.kind === 'atom') {
      expect(parsed.workspaceId).toBe('k_ws')
      expect(parsed.atomId).toBe('k_atom')
    }
  })
})

describe('M1 — auth-gate integration smoke (component endpoints export)', () => {
  it('the 5 syncApi endpoints exist on api.prosemirror', () => {
    // The package exports these names from prosemirror.ts; the
    // Convex codegen generates the API for them under
    // api.prosemirror.{name}. If any name is missing here, the
    // syncApi destructure is wrong.
    expect(api.prosemirror.getSnapshot).toBeDefined()
    expect(api.prosemirror.submitSnapshot).toBeDefined()
    expect(api.prosemirror.latestVersion).toBeDefined()
    expect(api.prosemirror.getSteps).toBeDefined()
    expect(api.prosemirror.submitSteps).toBeDefined()
  })

  it('checkRead/checkWrite/onSnapshot are wired (structural — grep)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const SRC = readFileSync(resolve(__dirname, './prosemirror.ts'), 'utf8')

    // The auth gates MUST be wired to P1 + workspace + share-access.
    // Grep is the right level here: convex-test doesn't carry the
    // component, but the wiring is what we'd break on a refactor.
    expect(SRC).toMatch(/checkRead\(ctx: QueryCtx,/)
    expect(SRC).toMatch(/checkWrite\(ctx: MutationCtx,/)
    expect(SRC).toMatch(/onSnapshot\(/)
    // Must call requireWorkspace (membership), canReadAtom (P1
    // read), canWriteAtomPath (P1 write), and resolveShareAccess
    // (cross-workspace share path).
    expect(SRC).toContain('requireWorkspace(ctx, parsed.workspaceId)')
    expect(SRC).toContain('canReadAtom(ctx, parsed.atomId, viewerSubject)')
    expect(SRC).toContain('canWriteAtomPath(ctx, parsed.workspaceId,')
    expect(SRC).toContain('resolveShareAccess(ctx, parsed.shareId)')
    // The share branch must enforce permission==='edit' on writes.
    expect(SRC).toMatch(/access\.permission !==? 'edit'/)
  })
})
