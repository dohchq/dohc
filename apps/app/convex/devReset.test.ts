/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from './schema'
import { internal } from './_generated/api'
import { DEV_RESET_TABLES, WIPE_DEV_DATA_CONFIRMATION } from './devReset'

const modules = import.meta.glob('./**/*.ts')

const EXPECTED_RESET_TABLES = [
  'atoms',
  'skillTurnState',
  'atomIds',
  'atomShares',
  'userProfiles',
  'workspaceAddressRoutes',
  'workspaceSlugs',
  'pendingAtomShares',
  'orgs',
  'entities',
  'folders',
  'folderMetadata',
  'threadRefs',
  'agentApprovals',
  'agentApprovalPolicies',
  'workspaceAssets',
  'databaseFiles',
  'databaseOps',
  'appTrust',
  'appProvenance',
  'appTestResults',
  'onboarding',
  'trash',
  'captures',
  'sourceAtoms',
  'workspaceSettings',
  'memberships',
  'atomAccess',
  'folderAccess',
  'atomTombstones',
  'windows',
  'windowGrants',
  'rollups',
  'atomSuggestions',
]

describe('dev reset', () => {
  it('tracks every app schema table for full development wipes', () => {
    expect([...DEV_RESET_TABLES].sort()).toEqual([...EXPECTED_RESET_TABLES].sort())
  })

  it('requires the full development wipe confirmation token', async () => {
    const t = convexTest(schema, modules)

    await expect(
      t.mutation((internal as any).devReset.wipeAllData, { confirm: 'WIPE' }),
    ).rejects.toThrow()
  })

  it('deletes all app-schema rows so onboarding starts from zero', async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const now = Date.now()
      const storageId = await ctx.storage.store(new Blob(['dev reset blob']))
      const atomId = await ctx.db.insert('atoms', {
        workspaceId: 'ws_reset_alice',
        path: 'finance/ledger.md',
        body: '# Ledger',
        updatedAt: now,
      })
      await ctx.db.insert('skillTurnState', {
        threadId: 'thread_reset',
        promptMessageId: 'msg_reset',
        depth: 0,
        startedAt: now,
      })
      await ctx.db.insert('atomIds', {
        workspaceId: 'ws_reset_alice',
        fileId: 'finance.ledger',
        path: 'finance/ledger.md',
        state: 'bound',
      })
      await ctx.db.insert('atomShares', {
        ownerWorkspaceId: 'ws_reset_alice',
        fileId: 'finance.ledger',
        granteeWorkspaceId: 'ws_reset_bob',
        permission: 'view',
        createdBy: 'ws_reset_alice',
        createdAt: now,
      })
      await ctx.db.insert('userProfiles', {
        workspaceId: 'ws_reset_alice',
        email: 'alice@example.test',
        normalizedEmail: 'alice@example.test',
        updatedAt: now,
      })
      await ctx.db.insert('workspaceAddressRoutes', {
        accountWorkspaceId: 'ws_reset_alice',
        targetWorkspaceId: 'ws_reset_alice',
        email: 'alice@example.test',
        normalizedEmail: 'alice@example.test',
        status: 'verified',
        createdAt: now,
        updatedAt: now,
      })
      await ctx.db.insert('workspaceSlugs', {
        workspaceId: 'ws_reset_alice',
        slug: 'alice',
        createdAt: now,
        updatedAt: now,
      })
      await ctx.db.insert('pendingAtomShares', {
        ownerWorkspaceId: 'ws_reset_alice',
        fileId: 'finance.ledger',
        email: 'bob@example.test',
        normalizedEmail: 'bob@example.test',
        permission: 'edit',
        status: 'pending',
        createdBy: 'ws_reset_alice',
        createdAt: now,
        updatedAt: now,
      })
      const orgId = await ctx.db.insert('orgs', {
        name: 'Reset Org',
        inviteCode: 'reset-code',
        createdBy: 'ws_reset_alice',
        createdAt: now,
      })
      await ctx.db.insert('entities', {
        workspaceId: 'ws_reset_alice',
        type: 'transaction',
        slug: 'tx_1',
        data: { amount: 12 },
        updatedAt: now,
      })
      await ctx.db.insert('folders', {
        workspaceId: 'ws_reset_alice',
        path: 'finance',
        createdAt: now,
      })
      await ctx.db.insert('folderMetadata', {
        workspaceId: 'ws_reset_alice',
        path: 'finance',
        starred: true,
        updatedAt: now,
      })
      await ctx.db.insert('threadRefs', {
        workspaceId: 'ws_reset_alice',
        threadId: 'thread_reset',
        title: 'Reset thread',
        updatedAt: now,
      })
      await ctx.db.insert('agentApprovals', {
        workspaceId: 'ws_reset_alice',
        threadId: 'thread_reset',
        createdByUserId: 'ws_reset_alice',
        operation: 'delete_atom',
        title: 'Delete old setup',
        detail: 'Delete .runs/setup.md',
        targetPaths: ['.runs/setup.md'],
        targetKey: '.runs/setup.md',
        args: { path: '.runs/setup.md' },
        status: 'pending',
        createdAt: now,
      })
      await ctx.db.insert('agentApprovalPolicies', {
        workspaceId: 'ws_reset_alice',
        createdByUserId: 'ws_reset_alice',
        threadId: 'thread_reset',
        operation: 'delete_atom',
        targetKey: '.runs/setup.md',
        createdAt: now,
        updatedAt: now,
      })
      await ctx.db.insert('workspaceAssets', {
        workspaceId: 'ws_reset_alice',
        storageId,
        filename: 'wallet.csv',
        mediaType: 'text/csv',
        kind: 'file',
        size: 14,
        purpose: 'chat',
        createdByUserId: 'ws_reset_alice',
        createdAt: now,
      })
      await ctx.db.insert('databaseFiles', {
        workspaceId: 'ws_reset_alice',
        path: 'finance/ledger.sqlite',
        storageId,
        filename: 'ledger.sqlite',
        size: 14,
        version: 1,
        tables: { transactions: { columns: [], rows: [] } },
        createdByUserId: 'ws_reset_alice',
        createdAt: now,
        updatedAt: now,
      })
      await ctx.db.insert('databaseOps', {
        workspaceId: 'ws_reset_alice',
        databasePath: 'finance/ledger.sqlite',
        operationId: 'op_reset',
        actorUserId: 'ws_reset_alice',
        op: 'insert',
        table: 'transactions',
        payload: { id: 'tx_1' },
        version: 1,
        appliedAt: now,
      })
      await ctx.db.insert('appTrust', {
        workspaceId: 'ws_reset_alice',
        userId: 'ws_reset_alice',
        packageRoot: 'finance/.apps/wallet',
        trustKey: 'trust-key',
        grantedAt: now,
      })
      await ctx.db.insert('appProvenance', {
        workspaceId: 'ws_reset_alice',
        actorUserId: 'ws_reset_alice',
        packageRoot: 'finance/.apps/wallet',
        operation: 'dohc.collection.update',
        targetPath: 'finance/ledger.md',
        clientMutationId: 'mutation_reset',
        createdAt: now,
      })
      await ctx.db.insert('appTestResults', {
        workspaceId: 'ws_reset_alice',
        actorUserId: 'ws_reset_alice',
        packageRoot: 'finance/.apps/wallet',
        mode: 'test_app',
        ok: true,
        result: { ok: true },
        createdAt: now,
      })
      await ctx.db.insert('onboarding', {
        workspaceId: 'ws_reset_alice',
        completedAt: now,
      })
      await ctx.db.insert('trash', {
        workspaceId: 'ws_reset_alice',
        kind: 'atom',
        ref: 'old.md',
        payload: { path: 'old.md' },
        deletedAt: now,
      })
      await ctx.db.insert('captures', {
        workspaceId: 'ws_reset_alice',
        kind: 'entity',
        ref: 'transaction/tx_1',
        summary: 'Imported transaction',
        tier: 'digest',
        status: 'pending',
        createdAt: now,
      })
      await ctx.db.insert('sourceAtoms', {
        workspaceId: 'ws_reset_alice',
        source: 'github',
        kind: 'issue',
        externalId: '1',
        path: 'sources/github/1.md',
        data: {},
        body: '# Issue',
        fetchedAt: now,
      })
      await ctx.db.insert('workspaceSettings', {
        workspaceId: 'ws_reset_alice',
        agentProviderId: 'anthropic',
      })
      await ctx.db.insert('memberships', {
        orgId,
        workspaceId: 'ws_reset_alice',
        role: 'owner',
        status: 'active',
      })
      await ctx.db.insert('atomAccess', {
        atomId,
        mode: 'private',
        ownerUserId: 'ws_reset_alice',
        allowedUserIds: [],
        setAt: now,
        setByUserId: 'ws_reset_alice',
      })
      await ctx.db.insert('folderAccess', {
        workspaceId: 'ws_reset_alice',
        folderPath: 'finance',
        mode: 'restricted',
        ownerUserId: 'ws_reset_alice',
        allowedUserIds: ['ws_reset_bob'],
        setAt: now,
        setByUserId: 'ws_reset_alice',
      })
      await ctx.db.insert('atomTombstones', {
        atomId,
        workspaceId: 'ws_reset_alice',
        reason: 'member-departed',
        tombstonedAt: now,
        originalOwnerUserId: 'ws_reset_alice',
      })
      const windowId = await ctx.db.insert('windows', {
        ownerWorkspaceId: 'ws_reset_alice',
        name: 'Finance window',
        selector: { type: 'transaction' },
        shape: { fields: ['amount'] },
        audience: { kind: 'private' },
      })
      await ctx.db.insert('windowGrants', {
        windowId,
        viewerWorkspaceId: 'ws_reset_bob',
      })
      await ctx.db.insert('rollups', {
        workspaceId: 'ws_reset_alice',
        identifier: 'spend',
        spec: { kind: 'window', windowId },
      })
      await ctx.db.insert('atomSuggestions', {
        atomId,
        workspaceId: 'ws_reset_alice',
        proposedText: 'Updated text',
        instruction: 'Improve the ledger',
        authorIsAgent: true,
        authorUserId: 'ws_reset_alice',
        status: 'pending',
        createdAt: now,
      })
    })

    const result = await t.mutation((internal as any).devReset.wipeAllData, {
      confirm: WIPE_DEV_DATA_CONFIRMATION,
    })

    expect(result.done).toBe(true)
    expect(result.total).toBe(EXPECTED_RESET_TABLES.length)

    const remaining = await t.run(async (ctx) => {
      const counts: Record<string, number> = {}
      for (const table of DEV_RESET_TABLES) {
        counts[table] = await ctx.db
          .query(table as any)
          .collect()
          .then((rows) => rows.length)
      }
      return counts
    })
    expect(remaining).toEqual(
      Object.fromEntries(EXPECTED_RESET_TABLES.map((table) => [table, 0])),
    )
  })
})
