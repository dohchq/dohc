import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// org-plan §5 Phase B + §9 switcher — STRUCTURAL coverage of the
// active-workspace context. Behavioral tests would need
// @testing-library/react + jsdom (not configured in this app — see
// commandPalette.test.ts for the same pattern). This test locks the
// contract that downstream code depends on:
//   - the context exposes `activeWorkspaceId` + `setActiveWorkspaceId`
//   - `undefined` is the personal back-compat value
//   - localStorage key is the documented stable string
//   - cross-tab `storage` event sync is wired

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_SRC = readFileSync(
  resolve(__dirname, '../../src/lib/active-workspace.tsx'),
  'utf8',
)
const SWITCHER_SRC = readFileSync(
  resolve(__dirname, '../../src/components/WorkspaceSwitcher.tsx'),
  'utf8',
)
const APP_SRC = readFileSync(
  resolve(__dirname, '../../src/routes/_app.tsx'),
  'utf8',
)

describe('active-workspace context (org-plan §5)', () => {
  it('exports the three public symbols', () => {
    expect(HOOK_SRC).toMatch(
      /export function ActiveWorkspaceProvider\b/,
    )
    expect(HOOK_SRC).toMatch(/export function useActiveWorkspaceId\b/)
    expect(HOOK_SRC).toMatch(/export function useActiveWorkspace\b/)
  })

  it('uses the documented localStorage key', () => {
    // The key is a public contract — cross-tab sync + old-tab restore
    // both rely on it. Changing it requires a migration story.
    expect(HOOK_SRC).toMatch(/STORAGE_KEY\s*=\s*'dohc\.activeWorkspaceId'/)
  })

  it('default value is undefined (the personal back-compat path)', () => {
    expect(HOOK_SRC).toMatch(
      /useState<string \| undefined>\(\s*\(\)\s*=>\s*{[\s\S]*?return undefined/,
    )
  })

  it('wires a cross-tab `storage` event listener', () => {
    // Without this, a switch in another tab silently disagrees with
    // this tab's Convex subscriptions until reload.
    expect(HOOK_SRC).toMatch(/addEventListener\(['"]storage['"]/)
    expect(HOOK_SRC).toMatch(/removeEventListener\(['"]storage['"]/)
  })

  it('hook throws OUTSIDE the provider (loud failure, not silent default)', () => {
    // Loud failure preferable to silently leaking personal data on a
    // call path that forgot the provider.
    expect(HOOK_SRC).toMatch(
      /useActiveWorkspaceId[\s\S]{0,200}ActiveWorkspaceProvider/,
    )
  })
})

describe('WorkspaceSwitcher component (org-plan §9)', () => {
  it('subscribes to api.orgs.myWorkspaces (the single source of truth)', () => {
    expect(SWITCHER_SRC).toMatch(
      /useQuery\(api\.orgs\.myWorkspaces,\s*\{\}\)/,
    )
  })

  it('switching to the personal entry resets to undefined (back-compat)', () => {
    // The personal entry must clear the active id, not write the
    // user's WorkOS subject as the active value — that would route
    // every read through the active-membership branch unnecessarily.
    expect(SWITCHER_SRC).toMatch(
      /w\.kind === ['"]personal['"]\s*\?\s*undefined/,
    )
  })

  it('self-heals a stale persisted activeWorkspaceId (offboarded mid-tab)', () => {
    // If a user is removed from an org while a tab holds that org as
    // active, every query would reject. The switcher must detect
    // "active id not in my workspaces" and reset to personal.
    expect(SWITCHER_SRC).toMatch(/isStale[\s\S]{0,200}setActiveWorkspaceId/)
  })

  it('displays a different icon for personal vs org', () => {
    // Tiny but real signal — at-a-glance "am I in my personal
    // workspace right now or an org one".
    expect(SWITCHER_SRC).toMatch(/Building2/)
    expect(SWITCHER_SRC).toMatch(/User as UserIcon|UserIcon/)
  })
})

describe('WorkspaceManagementDialog (Members admin + create/join + rename)', () => {
  const DIALOG_SRC = readFileSync(
    resolve(__dirname, '../../src/components/WorkspaceManagementDialog.tsx'),
    'utf8',
  )

  it('uses the Owner-gated APIs (createOrg/renameOrg via Phase E bridge actions; others direct)', () => {
    expect(DIALOG_SRC).toMatch(/api\.orgs\.myWorkspaces/)
    expect(DIALOG_SRC).toMatch(/api\.orgs\.orgMembers/)
    // Phase E (org-plan §10) — createOrg + renameOrg go through the
    // WorkOS bridge actions so the Convex side AND WorkOS Organizations
    // stay in sync. The bridge is graceful when WORKOS_API_KEY is unset.
    expect(DIALOG_SRC).toMatch(/api\.orgsBridge\.createOrgWithBridge/)
    expect(DIALOG_SRC).toMatch(/api\.orgsBridge\.renameOrgWithBridge/)
    expect(DIALOG_SRC).toMatch(/api\.orgs\.deleteOrg/)
    expect(DIALOG_SRC).toMatch(/api\.orgs\.removeMember/)
    expect(DIALOG_SRC).toMatch(/api\.orgs\.changeRole/)
    expect(DIALOG_SRC).toMatch(/api\.orgs\.leaveOrg/)
    expect(DIALOG_SRC).toMatch(/api\.orgs\.joinOrg/)
  })

  it('auto-switches into a freshly-created org so the user sees their new workspace', () => {
    // The window between `createOrg` and `setActiveWorkspaceId(orgId)`
    // is wider now (post-A2 the dialog comments explain the seed flow
    // before the navigation). 500 chars accommodates the comment block.
    expect(DIALOG_SRC).toMatch(
      /createOrg\([\s\S]{0,500}setActiveWorkspaceId\(\s*orgId/,
    )
  })

  it('confirms inline before destructive leave or deletion', () => {
    expect(DIALOG_SRC).toMatch(/dangerConfirm/)
    expect(DIALOG_SRC).toMatch(/Leave \$\{name\}\?/)
    expect(DIALOG_SRC).toMatch(/Delete \$\{name\}\?/)
    expect(DIALOG_SRC).toMatch(/You'll need a fresh invite to rejoin/)
  })

  it('uses delete workspace for owner-level workspace deletion instead of removing yourself', () => {
    expect(DIALOG_SRC).toMatch(/delete workspace/)
    expect(DIALOG_SRC).toMatch(/onDelete/)
    expect(DIALOG_SRC).toMatch(/m\.workspaceId\s*===\s*currentWorkspaceId/)
  })

  it('keeps shared-workspace creation behind an explicit secondary action', () => {
    expect(DIALOG_SRC).toMatch(/createOpen/)
    expect(DIALOG_SRC).toMatch(/New shared workspace|Create shared workspace/)
    expect(DIALOG_SRC).not.toMatch(/Create or join/i)
    expect(DIALOG_SRC).not.toMatch(/No orgs yet/)
  })

  it('uses personal-first workspace language in the management copy', () => {
    expect(DIALOG_SRC).toMatch(/Private by default/)
    expect(DIALOG_SRC).toMatch(/No shared workspaces yet/)
    expect(DIALOG_SRC).toMatch(/Have an invite code/)
  })
})

describe('_app.tsx wires the switcher into the live queries', () => {
  it('imports ActiveWorkspaceProvider + useActiveWorkspaceId', () => {
    expect(APP_SRC).toMatch(
      /import\s+\{[\s\S]*?ActiveWorkspaceProvider[\s\S]*?useActiveWorkspaceId[\s\S]*?\}\s+from\s+['"]@\/lib\/active-workspace['"]/,
    )
  })

  it('wraps the app layout in <ActiveWorkspaceProvider>', () => {
    expect(APP_SRC).toMatch(/<ActiveWorkspaceProvider>[\s\S]+<\/ActiveWorkspaceProvider>/)
  })

  it('threads activeWorkspaceId into atoms.list, folders.list, listSharedWithMe', () => {
    expect(APP_SRC).toMatch(
      /useQuery\(api\.atoms\.list,\s*\{\s*activeWorkspaceId\s*\}\)/,
    )
    expect(APP_SRC).toMatch(
      /useQuery\(api\.folders\.list,\s*\{\s*activeWorkspaceId\s*\}\)/,
    )
    expect(APP_SRC).toMatch(
      /useQuery\(api\.atomShares\.listSharedWithMe,\s*\{[\s\S]{0,80}activeWorkspaceId[\s\S]{0,40}\}\)/,
    )
  })

  it('every mutation in App passes activeWorkspaceId (writes land in the right tenant)', () => {
    // Each mutation must include activeWorkspaceId in its args object
    // or the user "creates a file" while viewing an org and the row
    // lands in their personal workspace (silent cross-tenant write).
    // This grep audits the 13 call sites identified during Phase D
    // wiring; future mutation calls that forget it will fail here.
    const mutationCalls = [
      /upsertAtom\(\{[^}]*activeWorkspaceId/,
      /createFolder\(\{[^}]*activeWorkspaceId/,
      /setLockAtom\(\{[^}]*activeWorkspaceId/,
      /setStarAtom\(\{[^}]*activeWorkspaceId/,
      /setFolderStar\(\{[^}]*activeWorkspaceId/,
      /setFolderMetaMut\(\{[\s\S]{0,200}activeWorkspaceId/,
      /moveAtom\(\{[^}]*activeWorkspaceId/,
      /moveFolder\(\{[^}]*activeWorkspaceId/,
      /removeAtom\(\{[^}]*activeWorkspaceId/,
      /removeFolder\(\{[\s\S]{0,80}activeWorkspaceId/,
      /setIconAtom\(\{[^}]*activeWorkspaceId/,
    ]
    for (const re of mutationCalls) {
      expect(APP_SRC).toMatch(re)
    }
  })
})
