import { v } from 'convex/values'
import {
  query,
  mutation,
  internalMutation,
} from './_generated/server'
import { internal } from './_generated/api'
import { requireWorkspace } from './auth'
import { canReadAtom, canWriteInFolder } from './atomAccess'
import { scheduleMapRegen } from './loop'
import { recordTrash } from './trash'
import { snapshotAtomBodyCoalesced } from './atoms'
import { applyAtomCapture } from './atomCapture'
import { clearAtomCaptures } from './captures'
import { isSafeAtomPath } from './inlineAtom'
import { deriveSearchFields } from './searchText'
import {
  SystemLockError,
  UserLockError,
  normalizeFolderPath,
  validateFolderPath,
  isFolderColor,
  isFolderIcon,
} from './atomLocks'
// R5 fold (Codex full-app FAIL-1 + FAIL-2): folders.move + remove
// MUST maintain the Track-1 atomId invariant — every atom-write
// (move = insert+delete; remove = delete) must reconcile or
// tombstone the rename-proof index, exactly like atoms.move +
// removeAtomImpl already do.
import {
  reconcileAtomIdIndex,
  releaseAtomIdOnDelete,
  collectConcreteRefs,
  extractFrontmatterId,
} from './atomId'
import { cascadeDeleteSharesForFileId } from './atomShares'

// Obsidian-style explicit folders. Each folder is a path string without
// a trailing slash. A folder "team" can sit empty and still appear in
// the file tree; creating "team/anna.md" doesn't auto-create the folder
// row (it's inferred from the path), but the user can create empty
// folders via the UI and they persist.

export const list = query({
  // Phase B (org-plan §5): optional `activeWorkspaceId` — defaults to
  // personal; membership-gated when an org id is supplied.
  args: { activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const [folderRows, metaRows] = await Promise.all([
      ctx.db
        .query('folders')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
        .collect(),
      ctx.db
        .query('folderMetadata')
        .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
        .collect(),
    ])
    // file-org-v1 §3.1 (Track-4 D4.1a). UNION the two sources by
    // path so:
    //   1) Decorated EMPTY folder (metadata row only, no folder row)
    //      still appears in the tree (the user's icon/color persists
    //      after the last atom is deleted out of an "empty-folder"
    //      shell — and the next atom recreates the folder row, not
    //      the metadata).
    //   2) Plain folder rows project default-undefined cosmetics.
    // The shape is ADDITIVE on top of the pre-D4.1a `{_id, path}`:
    // existing callers reading {_id, path} keep working; new callers
    // can read {icon, color, starred}.
    const metaByPath = new Map<string, (typeof metaRows)[number]>()
    for (const m of metaRows) metaByPath.set(m.path, m)

    const seen = new Set<string>()
    const out: {
      _id: string
      path: string
      icon: string | null
      color: string | null
      starred: boolean
    }[] = []
    for (const f of folderRows) {
      seen.add(f.path)
      const m = metaByPath.get(f.path)
      out.push({
        _id: f._id,
        path: f.path,
        icon: m?.icon ?? null,
        color: m?.color ?? null,
        starred: m?.starred ?? false,
      })
    }
    // Decorated-empty-folder rows: include even if no `folders` row.
    // We synthesize a stable client id by prefixing with the metadata
    // row's own _id (the caller never edits via this id; it goes to
    // React keys / sort only).
    for (const m of metaRows) {
      if (seen.has(m.path)) continue
      out.push({
        _id: m._id,
        path: m.path,
        icon: m.icon ?? null,
        color: m.color ?? null,
        starred: m.starred ?? false,
      })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  },
})

export const create = mutation({
  args: { path: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { path, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    // P1 (multiplayer-and-h-followups §6.5) — creating a folder
    // inside a private/restricted parent must obey the folder
    // cascade (otherwise a teammate could mkdir inside your private
    // `alice/` and start dropping docs in it). canWriteInFolder
    // walks bottom-up from the target path; org-default allows.
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    if (!(await canWriteInFolder(ctx, workspaceId, path, viewerSubject))) {
      throw new Error('You do not have access to create folders here.')
    }
    const id = await createImpl(ctx, workspaceId, path)
    // Phase C — debounced _map.md regen (new folder appears in the map).
    await scheduleMapRegen(ctx, workspaceId)
    return id
  },
})

// Internal version for the agent's create_folder tool. P1: same
// optional `viewerSubject` pattern as `_upsertInternal` — the agent
// callers pass it; system callers omit it (back-compat). When
// passed, run the folder-cascade write gate before creating.
export const _createInternal = internalMutation({
  args: {
    workspaceId: v.string(),
    path: v.string(),
    viewerSubject: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId, path, viewerSubject }) => {
    if (
      viewerSubject &&
      !(await canWriteInFolder(ctx, workspaceId, path, viewerSubject))
    ) {
      throw new Error('You do not have access to create folders here.')
    }
    return await createImpl(ctx, workspaceId, path)
  },
})

async function createImpl(ctx: any, workspaceId: string, path: string) {
  // file-org-v1 §2.3 — ONE folder-path policy (normalize+validate)
  // shared with move/remove/setMeta so a misspelled-rules-here can't
  // diverge from rules-there.
  const check = validateFolderPath(path)
  if (!check.ok) throw new Error(check.reason)
  const clean = check.path
  const existing = await ctx.db
    .query('folders')
    .withIndex('by_workspace_path', (q: any) =>
      q.eq('workspaceId', workspaceId).eq('path', clean),
    )
    .unique()
  if (existing) return existing._id
  return await ctx.db.insert('folders', {
    workspaceId,
    path: clean,
    createdAt: Date.now(),
  })
}

// Rename a folder. Atomic across:
//   1. every atom whose path starts with `<from>/` is moved to the
//      equivalent path under `<to>/`
//   2. every nested folder row (including the parent `<from>` row itself
//      if it exists) is moved to its equivalent path under `<to>`
//   3. wikilinks in the rest of the vault that reference any of the moved
//      atom paths are rewritten to point at the new paths
// Throws on conflict (destination already exists) or when the destination
// is inside the source (would create an unreachable cycle).
export const move = mutation({
  args: {
    fromPath: v.string(),
    toPath: v.string(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { fromPath, toPath, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    // P1 (multiplayer-and-h-followups §6.5) — folder rename is two
    // recursive write operations rolled into one: it touches every
    // atom in the source subtree (so the viewer must be allowed to
    // WRITE each of them) and it lands them under the destination
    // (so the destination folder cascade must allow). Same all-or-
    // nothing posture as folders.remove. Plumbed in via viewerSubject
    // — undefined ⇒ no gate (system caller back-compat).
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    const out = await moveImpl(ctx, workspaceId, fromPath, toPath, viewerSubject)
    // Phase C — debounced _map.md regen (folder rename moves children).
    await scheduleMapRegen(ctx, workspaceId)
    return out
  },
})

async function moveImpl(
  ctx: any,
  workspaceId: string,
  fromPath: string,
  toPath: string,
  // P1 — undefined ⇒ system caller (no gate).
  viewerSubject: string | undefined,
) {
  // file-org-v1 §2.3 — shared policy (the source need only normalize;
  // empty source is the older "source folder path required" error).
  const from = normalizeFolderPath(fromPath)
  if (!from) throw new Error('source folder path required')
  const toCheck = validateFolderPath(toPath)
  if (!toCheck.ok) throw new Error(toCheck.reason)
  const to = toCheck.path
  if (from === to)
    return {
      atomsMoved: 0,
      foldersMoved: 0,
      linkUpdates: 0,
      skippedLockedCount: 0,
      skippedLockedSample: [] as string[],
    }
  if (to === from || to.startsWith(`${from}/`)) {
    throw new Error("can't move a folder into itself")
  }

  const fromPrefix = `${from}/`
  const toPrefix = `${to}/`

  // 1. Collect atoms under the source folder + plan their destinations.
  const allAtoms = await ctx.db
    .query('atoms')
    .withIndex('by_workspace', (q: any) => q.eq('workspaceId', workspaceId))
    .collect()
  const atomPathMap = new Map<string, string>()
  const movedAtoms: typeof allAtoms = []
  for (const a of allAtoms) {
    if (a.path.startsWith(fromPrefix)) {
      const newPath = toPrefix + a.path.slice(fromPrefix.length)
      atomPathMap.set(a.path, newPath)
      movedAtoms.push(a)
    }
  }
  // D4.1a R1-fold (indep MINOR-1) — lock pre-scan FIRST so a user
  // hitting both a destination conflict and a locked child sees the
  // structural error (lock) rather than the conflict-around-able one.
  // file-org-v1 §2.3 (Track-4 D4.1a) — lock-guard chokepoint #4.
  // Subtree pre-scan: refuse the whole move if ANY moved atom is
  // locked. systemLocked beats userLocked in the error taxonomy.
  for (const a of movedAtoms) {
    if (a.systemLocked) throw new SystemLockError(a.path, 'rename')
    if (a.userLocked) throw new UserLockError(a.path, 'rename')
    // P1 — same all-or-nothing posture as the lock check above:
    // refuse the WHOLE move if ANY atom in the source subtree is
    // unreadable to the viewer. A partial move (leave the private
    // ones, move the rest) would split the subtree across two
    // folders with no record of the split — confusing and unsafe.
    if (
      viewerSubject !== undefined &&
      !(await canReadAtom(ctx, a._id, viewerSubject))
    ) {
      throw new Error(
        'You do not have access to move this folder — it contains atoms you cannot read.',
      )
    }
  }
  // P1 — destination cascade: even if the source is fully writable,
  // the destination folder might be a teammate's private folder.
  // Check the destination root the same way create_folder does.
  if (
    viewerSubject !== undefined &&
    !(await canWriteInFolder(ctx, workspaceId, to, viewerSubject))
  ) {
    throw new Error(
      'You do not have access to move into this destination folder.',
    )
  }

  // Atom destination conflicts.
  for (const newPath of atomPathMap.values()) {
    if (allAtoms.some((a: any) => a.path === newPath)) {
      throw new Error(`destination already exists: ${newPath}`)
    }
    // R3 §8 (Codex holistic LOW): NUL reject is a WRITE-surface
    // guarantee — a folder move must not synthesize a NUL dest path.
    if (!isSafeAtomPath(newPath)) {
      throw new Error(`invalid atom path (contains U+0000): ${JSON.stringify(newPath)}`)
    }
  }

  // 2. Collect folder rows under the source (and the source row itself).
  const allFolders = await ctx.db
    .query('folders')
    .withIndex('by_workspace', (q: any) => q.eq('workspaceId', workspaceId))
    .collect()
  const folderPathMap = new Map<string, string>()
  const movedFolders: typeof allFolders = []
  for (const f of allFolders) {
    if (f.path === from) {
      folderPathMap.set(f.path, to)
      movedFolders.push(f)
    } else if (f.path.startsWith(fromPrefix)) {
      folderPathMap.set(f.path, toPrefix + f.path.slice(fromPrefix.length))
      movedFolders.push(f)
    }
  }
  for (const newPath of folderPathMap.values()) {
    if (allFolders.some((f: any) => f.path === newPath)) {
      throw new Error(`destination folder already exists: ${newPath}`)
    }
  }

  // file-org-v1 §2.6 (Track-4 D4.1a) — folderMetadata follow (Option B
   //   recursive). Collect rows whose path is == from or starts with
   //   `${from}/`; plan their new paths by reusing the same prefix swap.
  const allFolderMeta = await ctx.db
    .query('folderMetadata')
    .withIndex('by_workspace', (q: any) => q.eq('workspaceId', workspaceId))
    .collect()
  const metaPathMap = new Map<string, string>()
  const movedMeta: typeof allFolderMeta = []
  for (const m of allFolderMeta) {
    if (m.path === from) {
      metaPathMap.set(m.path, to)
      movedMeta.push(m)
    } else if (m.path.startsWith(fromPrefix)) {
      metaPathMap.set(m.path, toPrefix + m.path.slice(fromPrefix.length))
      movedMeta.push(m)
    }
  }
  // metaDest conflicts: if a destination folderMetadata already exists
  // for one of the planned new paths, the move can't atomically
  // complete (two rows at one path). Cheap refuse — the user must
  // resolve manually.
  for (const newPath of metaPathMap.values()) {
    if (allFolderMeta.some((m: any) => m.path === newPath)) {
      throw new Error(`destination folder metadata already exists: ${newPath}`)
    }
  }

  // file-org-v1 §2.4 — pre-plan TOTAL primary writes so we never
  // enter a partial move. Primary writes (per-move-side): each moved
  // atom = 2 (insert + delete) ignoring derivative trash/capture;
  // each moved folder = 2; each moved metadata = 2; PLUS the
  // wikilink-rewrite cascade upper-bound = bystander matches × 1.
  //
  // D4.1a R1-fold (Codex FAIL-2 + indep FAIL-2): the original
  // pre-plan undercounted by omitting bystander cascade, which can
  // patch up to remaining-atoms-with-matches. Now we precompute the
  // bystander match count cheaply (a regex test, no body write) so
  // the cap accurately bounds total primary writes.
  const FOLDER_MOVE_WRITE_CAP = 4000
  let bystanderUpperBound = 0
  if (movedAtoms.length > 0) {
    const movedPaths = new Set(movedAtoms.map((a: any) => a.path))
    const movedReplacements = movedAtoms.map((a: any) => {
      const noExt = a.path.replace(/\.md$/i, '')
      // D4.7d — match BOTH `[[...]]` and `\[\[...]]` (a legacy editor escaped
      // opening brackets on save). Same regex shape as the cascade
      // loop below; identical handling in atoms.move.
      return new RegExp(
        `\\\\?\\[\\\\?\\[(!?)(${escapeRegex(a.path)}|${escapeRegex(noExt)})\\\\?\\]\\\\?\\]`,
      )
    })
    for (const a of allAtoms) {
      if (movedPaths.has(a.path)) continue
      for (const re of movedReplacements) {
        if (re.test(a.body)) {
          bystanderUpperBound++
          break
        }
      }
    }
  }
  const planned =
    movedAtoms.length * 2 +
    movedFolders.length * 2 +
    movedMeta.length * 2 +
    bystanderUpperBound
  if (planned > FOLDER_MOVE_WRITE_CAP) {
    throw new Error(
      `folder move too large: ${planned} primary writes (incl. ${bystanderUpperBound} bystander rewrites) exceeds cap ${FOLDER_MOVE_WRITE_CAP}`,
    )
  }

  const now = Date.now()

  // 3. Move atoms (insert + delete; no in-place patch because path is part
  //    of the unique index and Convex doesn't expose a key rewrite).
  for (const a of movedAtoms) {
    const newPath = atomPathMap.get(a.path)!
    const access = await ctx.db
      .query('atomAccess')
      .withIndex('by_atom', (q: any) => q.eq('atomId', a._id))
      .unique()
    const movedId = await ctx.db.insert('atoms', {
      workspaceId,
      path: newPath,
      body: a.body,
      updatedAt: now,
      source: a.source,
      // file-org-v1 §2.4 — carry cosmetic+user-lock flags through a
      // folder rename (same invariant as atoms.move). The pre-scan
      // above already refused any systemLocked/userLocked moved atom,
      // so userLocked here is moot but harmless to forward (defensive).
      ...(a.starred ? { starred: true } : {}),
      ...(a.userLocked ? { userLocked: true } : {}),
      // path changed in the folder rename → recompute search fields.
      ...deriveSearchFields(newPath, a.body),
    })
    if (access) {
      await ctx.db.insert('atomAccess', {
        atomId: movedId,
        mode: access.mode,
        ownerUserId: access.ownerUserId,
        allowedUserIds: access.allowedUserIds,
        setAt: access.setAt,
        setByUserId: access.setByUserId,
      })
      await ctx.db.delete(access._id)
    }
    await ctx.db.delete(a._id)
    // R3 §1 — folder move = per-atom move: drop old-path captures,
    // fresh withhold at the new path (a moved value is re-withheld
    // until re-confirmed; not a strict bypass).
    await clearAtomCaptures(ctx, workspaceId, a.path)
    await applyAtomCapture(ctx, workspaceId, newPath, null, a.body)
    // R5 fold (Codex full-app FAIL-1) — Track-1 atomId invariant.
    // The atomIds row's fileId → path mapping MUST follow the move
    // so formula `{=…id…}` resolution stays correct. Without this
    // call, a folder rename silently breaks every reference. The
    // call runs AFTER the delete of the old row (mirroring
    // atoms.move's contract: the heuristic classifies a rename
    // correctly only when the old path is already gone).
    await reconcileAtomIdIndex(ctx, workspaceId, newPath, a.body, {
      isRestore: false,
    })
  }

  // 4. Move folder rows.
  for (const f of movedFolders) {
    const newPath = folderPathMap.get(f.path)!
    await ctx.db.insert('folders', {
      workspaceId,
      path: newPath,
      createdAt: now,
    })
    await ctx.db.delete(f._id)
  }

  // 4b. Move folderMetadata rows — preserves icon/color/starred
  // through a rename WITHOUT introducing "decoration zombies"
  // (a renamed source loses its row; the destination gains it).
  for (const m of movedMeta) {
    const newPath = metaPathMap.get(m.path)!
    await ctx.db.insert('folderMetadata', {
      workspaceId,
      path: newPath,
      icon: m.icon,
      color: m.color,
      starred: m.starred,
      updatedAt: now,
    })
    await ctx.db.delete(m._id)
  }

  // 5. Wikilink cascade — rewrite [[oldPath]] and [[oldNoExt]] for every
  //    moved atom path across every atom in the vault (including the
  //    just-moved ones, in case they reference siblings that also moved).
  let linkUpdates = 0
  let skippedLockedCount = 0
  const skippedLockedSample: string[] = []
  if (atomPathMap.size > 0) {
    const replacements = Array.from(atomPathMap.entries()).map(
      ([oldPath, newPath]) => {
        const oldNoExt = oldPath.replace(/\.md$/i, '')
        const newNoExt = newPath.replace(/\.md$/i, '')
        // D4.7d — escape-tolerant wikilink match. See atoms.move for
        // rationale: a legacy editor escaped opening `[`s.
        const re = new RegExp(
          `\\\\?\\[\\\\?\\[(!?)(${escapeRegex(oldPath)}|${escapeRegex(oldNoExt)})\\\\?\\]\\\\?\\]`,
          'g',
        )
        return { re, newNoExt }
      },
    )

    const remaining = await ctx.db
      .query('atoms')
      .withIndex('by_workspace', (q: any) => q.eq('workspaceId', workspaceId))
      .collect()
    for (const a of remaining) {
      let rewritten = a.body
      for (const { re, newNoExt } of replacements) {
        re.lastIndex = 0
        rewritten = rewritten.replace(
          re,
          (_match: string, bang: string) => `[[${bang}${newNoExt}]]`,
        )
      }
      if (rewritten !== a.body) {
        // file-org-v1 §2.5 — SKIP-REWRITE-ON-LOCKED for folder move
        // too. A locked atom's body is frozen; another file's folder
        // rename must not silently mutate it. Counted + sampled to
        // surface a non-blocking "still points at the old path" UI.
        if (a.userLocked || a.systemLocked) {
          skippedLockedCount++
          if (skippedLockedSample.length < 20) skippedLockedSample.push(a.path)
          continue
        }
        // recoverability for the in-place body rewrite (the genuine
        // loss in a folder move — coalesced so it can't flood)
        await snapshotAtomBodyCoalesced(
          ctx,
          workspaceId,
          a.path,
          a.body,
          a.source ?? 'agent',
        )
        await ctx.db.patch(a._id, {
          body: rewritten,
          updatedAt: now,
          ...deriveSearchFields(a.path, rewritten),
        })
        // R3 §1 — link-only rewrite ⇒ value diff empty (no-op); routed
        // through the contract so a value change can never bypass it.
        await applyAtomCapture(ctx, workspaceId, a.path, a.body, rewritten)
        linkUpdates++
      }
    }
  }

  return {
    atomsMoved: movedAtoms.length,
    foldersMoved: movedFolders.length,
    linkUpdates,
    skippedLockedCount,
    skippedLockedSample,
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Remove a folder. Cascades: deletes every atom whose path starts with
// `<path>/` AND any nested folder rows. The parent folder row itself
// is also deleted. Returns counts for the caller's confirmation toast.
export const remove = mutation({
  args: { path: v.string(), activeWorkspaceId: v.optional(v.string()) },
  handler: async (ctx, { path, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    // P1 (multiplayer-and-h-followups §6.5) — recursive delete is
    // the most dangerous P1 surface: a teammate could erase a
    // private folder's contents in one shot. Pre-scan the WHOLE
    // subtree and refuse the delete if ANY atom is unreadable to
    // the viewer (same all-or-nothing posture as the lock pre-scan
    // already used here — partial-deletes are the wrong fail mode).
    const identity = await ctx.auth.getUserIdentity()
    const viewerSubject = identity?.subject ?? ''
    const out = await removeImpl(ctx, workspaceId, path, true, viewerSubject)
    // Phase C — debounced _map.md regen (folder deletion drops subtree).
    await scheduleMapRegen(ctx, workspaceId)
    return out
  },
})

// Internal version called by the agent's delete_folder tool. P1:
// optional viewerSubject — agent passes it, system callers omit it
// (back-compat; system path is unconstrained as in `_upsertInternal`).
export const _removeInternal = internalMutation({
  args: {
    workspaceId: v.string(),
    path: v.string(),
    viewerSubject: v.optional(v.string()),
  },
  handler: async (ctx, { workspaceId, path, viewerSubject }) => {
    return await removeImpl(ctx, workspaceId, path, true, viewerSubject)
  },
})

// Continuation for a large recursive delete (batched so a huge folder
// can't blow the Convex per-mutation write limit — same pattern as
// trash._purgeExpired).
//
// file-org-v1 §2.3 — continuation passes `isFirstInvocation: false`
// so the lock pre-scan does NOT run again. The first pass already
// proved no locks; subsequent passes are pure batched deletes of
// the proven-safe subtree. P1 access check ALSO runs only on the
// first pass — subsequent passes inherit its proof.
export const _removeContinue = internalMutation({
  args: { workspaceId: v.string(), path: v.string() },
  handler: async (ctx, { workspaceId, path }) => {
    return await removeImpl(ctx, workspaceId, path, false, undefined)
  },
})

// Per-invocation write budget. Each deleted row = 2 writes (trash
// snapshot + delete); 400 ⇒ ~800 writes, well under the limit with
// headroom. If a pass exhausts the budget, more may remain → it
// reschedules itself.
const DELETE_BATCH = 400
const SCAN_CAP = 8000

async function removeImpl(
  ctx: any,
  workspaceId: string,
  path: string,
  isFirstInvocation: boolean,
  // P1 — first-invocation only; continuations inherit the proof.
  // undefined ⇒ no access gate (system caller back-compat).
  viewerSubject: string | undefined,
) {
  const clean = path.replace(/^\/+|\/+$/g, '')
  const prefix = `${clean}/`
  // Re-review fix: scan via the PATH-ORDERED index with a string-range
  // bound `[clean, clean+￿)` so the prefix subset is contiguous
  // and the scan is independent of total-vault size + creation order.
  // (Old code did `.take(8000)` over by_workspace in creation order,
  // which silently skipped matches in the tail of large vaults →
  // a folder delete that no-ops while reporting success.) The string
  // range over-captures path-prefix siblings (e.g. "projector" for
  // "proj"); the exact `=== clean || startsWith(clean+'/')` filter
  // keeps it correct.
  const hi = `${clean}￿`
  let budget = DELETE_BATCH
  let atomCount = 0
  let folderCount = 0

  // D4.1a R1-fold (Codex FAIL-1): take SCAN_CAP+1 so we can DETECT
  // overflow. If the subtree's matching atom count exceeds SCAN_CAP,
  // we cannot prove "no locked atom anywhere in subtree" — refuse
  // the delete. Restores the "prove no locks before destructive
  // work" contract that v10 design promised.
  const atoms = await ctx.db
    .query('atoms')
    .withIndex('by_workspace_path', (q: any) =>
      q.eq('workspaceId', workspaceId).gte('path', clean).lt('path', hi),
    )
    .take(SCAN_CAP + 1)

  // file-org-v1 §2.3 (Track-4 D4.1a) — lock-guard chokepoint #5.
  // FIRST-INVOCATION pre-scan: refuse the WHOLE delete if (a) the
  // subtree exceeds the scan cap, or (b) ANY locked atom is found.
  // Continuations skip this (the first pass already proved both
  // conditions safe; the subtree has only ever shrunk since).
  if (isFirstInvocation) {
    let subtreeCount = 0
    for (const a of atoms) {
      if (a.path === clean || a.path.startsWith(prefix)) {
        subtreeCount++
        if (a.systemLocked) throw new SystemLockError(a.path, 'delete')
        if (a.userLocked) throw new UserLockError(a.path, 'delete')
        // P1 — refuse the WHOLE delete if ANY atom in the subtree
        // is unreadable to the viewer. Same all-or-nothing posture
        // as the lock pre-scan above: a partial-delete (skip the
        // unreadable ones, take the rest) would leave a teammate's
        // private subtree intact but its enclosing folder gone —
        // a confusing, unsafe outcome. Fail loud instead.
        if (
          viewerSubject !== undefined &&
          !(await canReadAtom(ctx, a._id, viewerSubject))
        ) {
          throw new Error(
            'You do not have access to delete this folder — it contains atoms you cannot read.',
          )
        }
      }
    }
    if (subtreeCount > SCAN_CAP) {
      // The over-the-cap atoms past index SCAN_CAP could include a
      // locked row we haven't read. Refuse loudly with an
      // actionable message rather than risk deleting past a lock.
      throw new Error(
        `folder too large to safely delete: ${subtreeCount}+ atoms exceeds scan cap ${SCAN_CAP}. Split into smaller subfolders or lock specific subtrees and delete piecewise.`,
      )
    }
  }

  // D4.25 — collect the concrete-reference set ONCE (excluding the
  // whole deleted subtree, whose own formulas don't count) so the
  // per-atom release-or-tombstone decision is O(1) — no O(n²) rescan.
  const deletedPaths = new Set<string>(
    atoms
      .filter(
        (a: { path: string }) =>
          a.path === clean || a.path.startsWith(prefix),
      )
      .map((a: { path: string }) => a.path),
  )
  const concreteRefs = await collectConcreteRefs(
    ctx,
    workspaceId,
    deletedPaths,
  )

  for (const a of atoms) {
    if (budget <= 0) break
    if (a.path === clean || a.path.startsWith(prefix)) {
      await recordTrash(ctx, {
        workspaceId,
        kind: 'atom',
        ref: a.path,
        payload: {
          path: a.path,
          body: a.body,
          source: a.source ?? 'agent',
          // file-org-v1 §2.4 — carry the cosmetic+lock+notice flags
          // through trash so a restore brings them back.
          systemLocked: a.systemLocked ?? false,
          userLocked: a.userLocked ?? false,
          starred: a.starred ?? false,
          migrationNotice: a.migrationNotice,
        },
      })
      await ctx.db.delete(a._id)
      // R3 §1/M6 — clear this atom's captures (incl. sentinel) within
      // the same batch/reschedule budget loop, per contained atom.
      await clearAtomCaptures(ctx, workspaceId, a.path)
      // R5 fold (Codex full-app FAIL-2) — Track-1 atomId invariant.
      // D4.14/D4.25: free this atom's id (reusable) UNLESS a formula
      // concretely references it, in which case tombstone (no silent
      // hijack). Mirrors removeAtomImpl. Trash-restore re-inserts
      // from the original body (carries the frozen id).
      await releaseAtomIdOnDelete(
        ctx,
        workspaceId,
        a.body,
        a.path,
        concreteRefs,
      )
      // sharing-v1 1a (codex+security review P1): folder bulk-delete
      // MUST cascade share revocation too — mirrors removeAtomImpl.
      // Without this, deleting a FOLDER of shared files left stale
      // grants that could silently re-grant access to a recreated /
      // restored same-id atom. Delete revokes; restore re-shares.
      const deletedFileId = extractFrontmatterId(a.body)
      if (deletedFileId) {
        await cascadeDeleteSharesForFileId(ctx, workspaceId, deletedFileId)
      }
      atomCount++
      budget--
    }
  }
  if (budget > 0) {
    const folders = await ctx.db
      .query('folders')
      .withIndex('by_workspace_path', (q: any) =>
        q.eq('workspaceId', workspaceId).gte('path', clean).lt('path', hi),
      )
      .take(SCAN_CAP)
    for (const f of folders) {
      if (budget <= 0) break
      if (f.path === clean || f.path.startsWith(prefix)) {
        // file-org-v1 §2.4 — if a folderMetadata row exists for this
        // path, snapshot it INTO the folder trash payload so a folder
        // restore brings the icon/color/star back atomically.
        const meta = await ctx.db
          .query('folderMetadata')
          .withIndex('by_workspace_path', (q: any) =>
            q.eq('workspaceId', workspaceId).eq('path', f.path),
          )
          .unique()
        await recordTrash(ctx, {
          workspaceId,
          kind: 'folder',
          ref: f.path,
          payload: {
            path: f.path,
            icon: meta?.icon,
            color: meta?.color,
            starred: meta?.starred ?? false,
          },
        })
        await ctx.db.delete(f._id)
        // GC the cosmetic row in the same write — a deleted folder
        // doesn't keep zombie decoration metadata.
        if (meta) await ctx.db.delete(meta._id)
        folderCount++
        budget--
      }
    }
  }

  // file-org-v1 §2.6 — also clean any folderMetadata rows whose
  // folder row is GONE but the metadata row alone was decorating an
  // empty folder (decorated-empty-folder case). The companion-meta
  // case is handled inline above (next to each folder row delete);
  // this pass catches metadata-only.
  //
  // D4.1a R1-fold (indep FAIL-1): the original code gated this
  // sweep on `isFirstInvocation`, which would orphan metadata rows
  // if the budget exhausted before the sweep ran on pass 1 (the
  // continuation, with isFirstInvocation:false, would never sweep).
  // Now we run on EVERY pass; it's bounded by `budget` so the loop
  // can't blow the per-mutation write limit, and the operation
  // strictly shrinks the matching set so it terminates.
  if (budget > 0) {
    const metaRows = await ctx.db
      .query('folderMetadata')
      .withIndex('by_workspace_path', (q: any) =>
        q.eq('workspaceId', workspaceId).gte('path', clean).lt('path', hi),
      )
      .take(SCAN_CAP)
    for (const m of metaRows) {
      if (budget <= 0) break
      if (m.path === clean || m.path.startsWith(prefix)) {
        await recordTrash(ctx, {
          workspaceId,
          kind: 'folder',
          ref: m.path,
          payload: {
            path: m.path,
            icon: m.icon,
            color: m.color,
            starred: m.starred ?? false,
            // R4 fold (Codex FAIL-4) — marker so restoreRow knows
            // to recreate ONLY folderMetadata, not a phantom
            // folders row that wasn't there pre-delete.
            metaOnly: true,
          },
        })
        await ctx.db.delete(m._id)
        folderCount++
        budget--
      }
    }
  }

  // budget > 0 ⇒ we scanned everything and processed every match
  // (fewer than a full batch) ⇒ done. budget exhausted ⇒ maybe more
  // ⇒ reschedule a continuation. Each pass strictly shrinks the match
  // set, so this terminates.
  const done = budget > 0
  if (!done) {
    await ctx.scheduler.runAfter(0, internal.folders._removeContinue, {
      workspaceId,
      path,
    })
  }
  return { atomCount, folderCount, done }
}

// file-org-v1 §3.2 (Track-4 D4.1a) — public cosmetic mutations for
// folders. setMeta is the canonical entry; setFolderStar is sugar.
// Validate against the constant allowlists so a misspelled icon/color
// is a loud reject (not silent acceptance into the database).
//
// GC contract: a folderMetadata row with NO decorations + starred=false
// is deleted by the same mutation that emptied it. The folder-row
// itself remains untouched (its presence/absence is the user's,
// independent of decoration).

export const setMeta = mutation({
  args: {
    path: v.string(),
    icon: v.optional(v.union(v.string(), v.null())),
    color: v.optional(v.union(v.string(), v.null())),
    starred: v.optional(v.boolean()),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { path, icon, color, starred, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const check = validateFolderPath(path)
    if (!check.ok) throw new Error(check.reason)
    const clean = check.path

    // icon may be a legacy lucide token (FOLDER_ICONS) OR a chosen
    // emoji (emoji-icons). Accept either; only reject absurdly long
    // strings (emoji + ZWJ sequences stay well under 16).
    if (icon != null && !isFolderIcon(icon) && icon.length > 16) {
      throw new Error(`invalid folder icon: ${JSON.stringify(icon)}`)
    }
    if (color != null && !isFolderColor(color)) {
      throw new Error(`invalid folder color: ${JSON.stringify(color)}`)
    }

    const existing = await ctx.db
      .query('folderMetadata')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', clean),
      )
      .unique()

    // Compute the next shape. Each field uses tri-valued logic:
    //   undefined ⇒ leave at current; null ⇒ clear; value ⇒ set.
    const nextIcon = icon === undefined ? existing?.icon : icon ?? undefined
    const nextColor = color === undefined ? existing?.color : color ?? undefined
    const nextStarred =
      starred === undefined ? existing?.starred ?? false : starred

    // GC: nothing decorated AND not starred ⇒ delete the row.
    const isEmpty = !nextIcon && !nextColor && !nextStarred
    if (existing) {
      if (isEmpty) {
        // R4 fold (Codex FAIL-4) — snapshot decoration to trash
        // BEFORE GC so the user can undelete via /trash. Uses
        // `metaOnly: true` marker so the restore path skips
        // creating a `folders` row (the GC didn't remove one).
        await recordTrash(ctx, {
          workspaceId,
          kind: 'folder',
          ref: clean,
          payload: {
            path: clean,
            icon: existing.icon,
            color: existing.color,
            starred: existing.starred ?? false,
            metaOnly: true,
          },
        })
        await ctx.db.delete(existing._id)
        return { ok: true as const, removed: true as const }
      }
      await ctx.db.patch(existing._id, {
        icon: nextIcon,
        color: nextColor,
        starred: nextStarred || undefined,
        updatedAt: Date.now(),
      })
      return { ok: true as const, removed: false as const }
    }
    if (isEmpty) return { ok: true as const, removed: false as const }
    await ctx.db.insert('folderMetadata', {
      workspaceId,
      path: clean,
      icon: nextIcon,
      color: nextColor,
      starred: nextStarred || undefined,
      updatedAt: Date.now(),
    })
    return { ok: true as const, removed: false as const }
  },
})

// Sugar over setMeta for the common "favorite a folder" path.
export const setStar = mutation({
  args: {
    path: v.string(),
    starred: v.boolean(),
    activeWorkspaceId: v.optional(v.string()),
  },
  handler: async (ctx, { path, starred, activeWorkspaceId }) => {
    const workspaceId = await requireWorkspace(ctx, activeWorkspaceId)
    const check = validateFolderPath(path)
    if (!check.ok) throw new Error(check.reason)
    const clean = check.path

    const existing = await ctx.db
      .query('folderMetadata')
      .withIndex('by_workspace_path', (q) =>
        q.eq('workspaceId', workspaceId).eq('path', clean),
      )
      .unique()

    const nextStarred = starred || undefined
    const isEmpty =
      !existing?.icon && !existing?.color && !nextStarred
    if (existing) {
      if (isEmpty) {
        // R5 fold (Codex full-app FAIL-3) — symmetric with setMeta
        // GC path: snapshot the row to trash BEFORE delete so the
        // un-star can be undone via /trash. `metaOnly:true` marker
        // tells restoreRow to skip the `folders` row insert (none
        // existed for a decorated-empty path).
        await recordTrash(ctx, {
          workspaceId,
          kind: 'folder',
          ref: clean,
          payload: {
            path: clean,
            icon: existing.icon,
            color: existing.color,
            starred: existing.starred ?? false,
            metaOnly: true,
          },
        })
        await ctx.db.delete(existing._id)
        return { ok: true as const, removed: true as const }
      }
      if ((existing.starred ?? false) === Boolean(nextStarred)) {
        return { ok: true as const, removed: false as const }
      }
      await ctx.db.patch(existing._id, {
        starred: nextStarred,
        updatedAt: Date.now(),
      })
      return { ok: true as const, removed: false as const }
    }
    if (!nextStarred) return { ok: true as const, removed: false as const }
    await ctx.db.insert('folderMetadata', {
      workspaceId,
      path: clean,
      starred: nextStarred,
      updatedAt: Date.now(),
    })
    return { ok: true as const, removed: false as const }
  },
})
