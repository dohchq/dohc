# v2 Offline-First Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan phase-by-phase. Before starting each phase, split that phase into checkbox (`- [ ]`) steps with exact tests, commands, and rollback notes.

**Goal:** Ship dohc v2 as an offline-first collaborative knowledge app where Y.Doc is canonical, markdown is a rebuildable projection, and humans plus the AI agent can edit without parser-drift or offline-merge failures.

**Architecture:** A dedicated Hocuspocus service owns live Y.Doc sync, update durability, awareness, and semantic edit application. Convex remains the metadata, auth bridge, search/cache, file-tree, and agent orchestration backend, with Postgres storing durable Y.Doc state.

**Tech Stack:** React, Tiptap OSS-only, Y.js, `y-indexeddb`, Hocuspocus OSS/self-hosted, Convex, WorkOS, Postgres, Vitest, Playwright.

**Date:** 2026-05-25
**Owner:** Ice
**Status:** Plan v1.19 — Phase 1.8 semantic write path and Phase 1.9 v1 cleanup implemented on `codex/v2-offline-first-on-multiplayer`: Hocuspocus owns semantic Y.Doc mutation, suggestion accept routes through Hocuspocus, agent edit tools no longer overwrite full markdown bodies, and the old Milkdown/Crepe/prosemirror-sync collaboration stack has been removed. The remaining ship gate is production-equivalent QA plus the one-week dogfood window in §16.
**Predecessor:** `docs/development/tiptap-hocuspocus-evaluation.md`
**Estimated total scope:** ~6-8 months focused work (Phase 1: ~14-17 weeks, Phase 2: ~4-6 weeks, Phase 3: ~6-8 weeks)
**Codex output archived at:** `/home/ice/dev/dohc/.context/codex-outputs/v2-pivot-consult-20260525-170821.md`

## 1. Vision in one paragraph

dohc becomes an offline-first collaborative knowledge management app. The user can edit on a plane and resume on reconnect with clean CRDT merge. Multiple humans collaborate in real time with native cursor/awareness presence. An AI agent can read, write, and suggest changes to atoms as a first-class collaborator. The app is self-hostable for privacy-conscious users. Power users can opt into local markdown file sync so their atoms also live as plain `.md` files on their disk — Obsidian-style data ownership without losing the cloud features.

## 2. Why pivot now

The M1 multiplayer arc (50+ commits) hardened a stack with two architectural ceilings that cannot be patched away:

1. **`@convex-dev/prosemirror-sync` is delta sync, not a CRDT.** Every keystroke is a server round-trip. Offline-first merge is structurally impossible.
2. **`atoms.body` as canonical markdown forces two serializers.** The Milkdown/Crepe parser and the server-side remark parser disagree about canonical form for `[[wikilinks]]`, frontmatter, escape rules, etc. Every parser-drift bug we fought (pm-body-mismatch, body-changed loop) traces to this. The bug class is structural, not incidental.

Both ceilings disappear under the v2 stack (Y.Doc canonical + Hocuspocus + Tiptap). The lessons from M1 carry forward (see §11), but the code below the lessons does not.

The user has no external users yet. Every commit on the current stack is debt the v2 rewrite will throw away. The cost of waiting strictly exceeds the cost of pivoting.

## 3. Target architecture

```
CLIENT (browser, eventually Tauri-wrapped for Phase 3)
├── React app
├── Tiptap editor
│   ├── @tiptap/extension-collaboration (Y.js integration)
│   ├── @tiptap/extension-collaboration-caret (Y.Awareness cursors)
│   └── custom dohc extensions: wikilink, inlineAtom, formula,
│                              queryBlock, math, frontmatter
├── Y.js (Y.Doc as canonical document state)
├── y-indexeddb (local persistence — offline-first)
├── @hocuspocus/provider (sync transport)
└── Convex client (reactive queries for file tree, search, AI, metadata)

SERVER
├── Hocuspocus (Node.js WebSocket server, dedicated process)
│   ├── onAuthenticate: verify Convex-minted JWT
│   ├── onLoadDocument: load Y.Doc binary from storage
│   ├── update log: eagerly persist Y.js updates for crash recovery
│   ├── snapshot store: periodically persist compact Y.Doc binary
│   ├── onChange: enqueue markdown projection write back to Convex
│   └── per-doc room: cursors, awareness, suggestions overlay
├── Convex (existing, less responsibility)
│   ├── Auth (WorkOS bridge — minted JWT for Hocuspocus)
│   ├── Org/workspace metadata + memberships + shares
│   ├── File tree (atoms list, folders, paths, atomIds)
│   ├── Search index (over atoms.body cache)
│   ├── AI agent (Anthropic in Convex actions, calls Hocuspocus
│   │             semantic API to apply edits)
│   ├── Suggestions CRUD (anchor positions stored as Y.RelativePositions)
│   ├── atomIds (rename-proof addressing — survives unchanged)
│   ├── Captures, trash, proposals, plugin settings (unchanged)
│   └── atomAccess + folderAccess (still enforced; Hocuspocus consults
│        Convex/cache for per-doc auth on load/write)
└── Postgres (Y.Doc update log + compacted snapshots)

OPTIONAL (Phase 3)
├── Tauri desktop wrapper (native file system access)
├── File watcher → Y.Doc applyUpdate (external markdown edit → editor)
└── Y.Doc onChange → markdown serializer → write file (editor edit → disk)
```

## 4. Architectural decisions (locked + open)

### Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Y.Doc is canonical.** `atoms.body` markdown becomes a derived projection/cache. | Eliminates parser-drift bug class (root cause of pm-body-mismatch). |
| D2 | **Tiptap replaces Milkdown/Crepe.** | Both are ProseMirror-based. Tiptap has first-class Y.js integration (`@tiptap/extension-collaboration`) and per-extension markdown contracts (`parseMarkdown`/`renderMarkdown`), which is the cleanest API for keeping atoms.body cache in agreement. |
| D3 | **Hocuspocus replaces `@convex-dev/prosemirror-sync`.** | Required for Y.js CRDT transport. Mature, MIT-licensed, self-hostable. |
| D4 | **Convex stays for everything except document state.** | Convex is uniquely good at reactive queries (file tree, search), auth bridging, and running the AI agent in long-lived actions. Replacing it would multiply scope and lose those wins. |
| D5 | **`atoms.body` becomes a derived cache, not eliminated.** | Search index reads it; agent fast reads read it; backwards-compatible with Phase 3 file sync (markdown file IS the projection). Eliminating it forces every consumer to load Y.Doc. |
| D6 | **Y.js Awareness replaces homegrown presence.** | `@tiptap/extension-collaboration-caret` + `useHocuspocusAwareness` replace most custom cursor plumbing. Drop `collabSessions` table. |
| D7 | **M3 suggestion anchors migrate to Y.RelativePosition.** | Character offsets in `atomSuggestions.rangeFrom/rangeTo` desync under concurrent edits. RelativePosition is the Y.js primitive for stable references that survive remote mutations. |
| D8 | **Pivot now, not after multi-browser QA.** | User has no external users. Validation provides no signal that informs v2 design; every v1 commit is debt. |
| D9 | **`atomIds` (fileId) survives unchanged.** | The rename-proof addressing model is orthogonal to the editor/transport. Y.Docs are keyed by `fileId`, not `path`. |
| D10 | **Access control still enforced via Convex.** | Hocuspocus verifies Convex-minted identity and checks per-doc ACL on auth/load/token refresh/sync. Phase 1.4 keeps `authzVersion` as constant `1`; bumped workspace versions are a later ACL-cache optimization. Never embed allowed atom IDs in JWTs. |
| D11 | **Tiptap is allowed only as OSS editor infrastructure.** | Core v2 must not depend on Tiptap Cloud, Tiptap AI Toolkit, Comments, Tracked Changes, or any closed/pro paid extension. dohc's AI-native layer lives in our semantic tools, markdown/Y.Doc projection, and Hocuspocus server APIs. |
| D12 | **Lexical is the escape hatch, not the default.** | Lexical is philosophically aligned with custom text-first AI surfaces, but switching now adds more glue risk. Phase 0/1.1 must prove Tiptap's OSS markdown and extension APIs are enough; if not, pause and switch before editor implementation starts. |

### Decisions closed after codex consult (see §15 for reasoning)

| # | Decision | Resolved | Codex concurred? |
|---|----------|----------|------------------|
| O1 | Y.Doc binary persistence | (a) Postgres-backed snapshots + an eager update log. CRITICAL: verify the Hocuspocus hook/extension point that lets us durably record updates before treating them as stored; do not rely only on debounced full-state store. | ✅ Yes (with crash-safety addition) |
| O2 | Agent → Y.Doc edit path | **(c) Hocuspocus exposes server-side semantic API** (`applySuggestion`, `replaceRange`, `insertText`, `insertAfterHeading`). Convex agent calls this API. NOT a fake WebSocket client (my original recommendation was wrong). | ❌ Disagreed — see §15.2 |
| O3 | Auth token TTL | **5 minutes** + workspace `authzVersion` claim + Hocuspocus rechecks ACL on document join/write. Anything longer makes revocation fake. (My original 15min was too lenient.) | ❌ Disagreed — see §15.3 |
| O4 | Per-atom access in JWT vs queried | (b) — JWT carries identity + `authzVersion` only; per-atom checked at document join via Convex (or Hocuspocus-side cache with version match). NEVER embed allowed atomIds in JWT. | ✅ Yes |
| O5 | Phase sequencing | **(d) Big-bang on `v2-offline-first` branch with disciplined sub-phases.** NOT editor-first. Half-pivot (Tiptap with prosemirror-sync) preserves the markdown-canonical bug class. My original (a) was wrong. | ❌ Disagreed — see §15.5 + §10 |
| O6 | atoms.body cache write trigger | (a) Hocuspocus `onChange` server-side projection. Name it honestly: cache, not canonical. Never written directly for document edits except import/admin escape hatch. | ✅ Yes |
| O7 | M3 suggestion CAS | **Drop `baseBodyHash`** (whole-doc CAS — Y.js makes it pointless). **Keep `expectedText` + optional surrounding context** (semantic intent witness — Y.RelativePosition preserves position, NOT meaning). | ✅ Yes (with `baseBodyHash` removal) |

### New decisions surfaced by codex

| # | Decision | Resolution |
|---|----------|-----------|
| O8 | Agent tool API surface | Semantic tools ONLY (`propose_replace_text`, `insert_after_heading`, `rewrite_section`, `create_atom`). LLM is bad at raw Y.js updates. Tools sit in Convex; map intent → Hocuspocus semantic API call. |
| O9 | Operational tooling from day 1 | Build alongside Phase 1: `inspect-doc`, `decode-update`, `compact-doc`, `export-doc`, `rebuild-projection`, `corruption-quarantine` CLI/admin tools. Not deferred. |
| O10 | Awareness leak prevention | Revoked users must be DISCONNECTED, not waited-out. Hocuspocus needs `disconnect-by-{workspaceId, userId}` admin hook called from Convex on access revocation. Unauthorized users receive no awareness; read-only cursor publishing is disabled unless explicitly chosen. |
| O11 | Disaster recovery | Y.Doc binary export + markdown projection export must work from day 1. Markdown alone loses any non-markdown-expressible rich state (so constrain Tiptap schema accordingly). |

## 5. What carries forward from M1

Specific lessons + code that survive the pivot:

### Main-branch reality check

Phase 0 started from `main` at `103a46ff9ef746bc4c82fbcb00bfd07a80c7bae8`. That branch does **not** contain active `@convex-dev/prosemirror-sync`, Hocuspocus, Yjs, or Tiptap code. The active editor stack on `main` is Milkdown/Crepe + full-body Convex `atoms.body` writes. References below to `collabBootstrap`, `collabPresence`, `collabDocs`, or `prosemirror-sync` are inherited from the predecessor multiplayer branch and should be treated as "delete/avoid if present" items, not required cleanup on clean `main`.

### Lessons (must inform v2 design)
- **Parser drift is structural.** Y.Doc canonical eliminates it for the editor↔storage path, but the Y.Doc → markdown projection (for `atoms.body` cache) still has serializer choice. Pick ONE serializer (Tiptap's per-extension `renderMarkdown`) and use it consistently for both directions.
- **CAS witnesses are cheap insurance.** M3's `expectedText` validation caught document drift in suggestion accept. Keep equivalent checks in v2 (compare cached markdown slice against what the agent thought it was editing).
- **Bootstrap is a hard prerequisite, not soft.** v1 wasted weeks on "what if bootstrap fails partially." Y.Docs are atomic — they exist or don't. Use this simplicity.
- **Heartbeat/cleanup races bite.** Y.Awareness handles this natively (Y.js disconnects propagate within ~1s). One less thing to write.
- **Agent author distinction matters.** `authorIsAgent` flag, display names, signed agent token (3.9.6) — all carry forward conceptually; Convex calls Hocuspocus semantic APIs with a signed actor identity identifying the agent role.
- **Behavior-migration flags exist (Decision K').** New defaults need a one-way migration switch for the early user. v2 should preserve this discipline.

### Code that carries forward
| Source | Use in v2 |
|--------|-----------|
| Tiptap extension `parseMarkdown`/`renderMarkdown` for wikilinks | New extension wraps the wikilink encode/decode logic from `markdownRoundtrip.ts` |
| `atomIds.ts` (rename-proof fileId) | Unchanged — Y.Doc room name = `fileId` |
| `atomShares.ts`, `atomAccess.ts`, `folderAccess.ts` | Unchanged — Hocuspocus auth queries these |
| `agent.ts` tool schemas | `read_atom` stays as cache read; `write_atom`/`suggest_in_doc` are retired; semantic tools call Hocuspocus |
| `atomSuggestions.ts` CRUD shape | Schema field rename (`rangeFrom/rangeTo` → `relAnchorFrom/relAnchorTo` as Y.RelativePosition byte arrays); CRUD logic mostly preserved |
| Display name caching (3.9.18) | Same approach in Y.Awareness user object |
| Captures, trash, proposals, plugin settings, captures, file tree | Untouched |

### Code that gets deleted
| File | Why |
|------|-----|
| `apps/app/convex/collabBootstrap.ts` | Y.Doc IS the bootstrap; no client/server reconcile needed |
| `apps/app/convex/collabProjectionSerializer.ts` | Replaced by Tiptap's renderMarkdown per-extension contracts |
| `apps/app/convex/collabProjection.ts` | Replaced by Hocuspocus onChange hook |
| `apps/app/convex/collabPresence.ts` | Replaced by Y.Awareness |
| `apps/app/src/lib/collab/` (cursor + selection plugins) | Replaced by `@tiptap/extension-collaboration-caret` |
| `collabDocs` schema table | No per-doc projection state needed — Y.Doc IS the state |
| `collabSessions` schema table | Y.Awareness replaces presence storage |
| Bootstrap retry + error overlay logic in `AtomEditor.tsx` | Y.js reconnect is native |
| `prosemirror-sync` Convex component config | Removed from `convex.config.ts` |
| `splitFrontmatter`/`joinFrontmatter` coordinate-system code | Frontmatter is a separate Y.Map in the Y.Doc, not a string slice |

### Tests that survive
- `m1AtomSuggestions.test.ts` (3.9.14) — CRUD behavioral coverage, mostly applies post-anchor migration
- `markdownRoundtrip` corpus tests — applied to Tiptap renderer output instead of remark
- `atomAccess` access control tests — unchanged
- `atomShares` test — unchanged

### Tests that get deleted/rewritten
- `m1FixPack395.test.ts` — bootstrap-specific; deleted
- `atomEditorMultiplayer.test.ts` — rewritten against Tiptap+Hocuspocus

## 6. Phase 1 — Offline-first cloud (~14-17 weeks)

The base. Ships Y.Doc canonical + Hocuspocus + IndexedDB + Tiptap.

**Sequencing per codex (REVISED from v1.0 of this doc): model → import/export → infrastructure → editor → presence → projection → suggestions → agent → cleanup.** NOT editor-first. See §10 for the reversal rationale. Key principle: do not run Tiptap + prosemirror-sync side-by-side. The half-pivot preserves the parser-drift bug class.

### Cross-phase execution guardrails

These rules apply to every Phase 1 sub-phase:

1. **Split before building.** Before starting a sub-phase, create a short implementation plan with checkbox steps, exact file paths, test commands, and expected failures/passes. Keep those phase plans under `docs/development/v2-phase-plans/`.
2. **TDD where behavior changes.** New parser, persistence, auth, projection, suggestion, and agent behavior starts with a failing unit/integration test or an explicit spike result documenting why a test cannot exist yet.
3. **No new markdown authority.** Any new code that writes document content must write Y.Doc state or call the Hocuspocus semantic API. Direct `atoms.body` writes are limited to import/admin projection rebuild escape hatches.
4. **No paid editor lock-in.** Any dependency on a Tiptap paid/pro/private package is a stop/go failure unless Ice explicitly approves it after seeing the OSS alternative and migration cost. Hocuspocus must remain self-hosted.
5. **Every phase ends with a gate.** A phase is not done until its tests pass, docs are updated, rollback/export notes are current, and no temporary dual-write or compatibility shim is left undocumented.
6. **Main stays conservative.** Do not merge `v2-offline-first` to `main` until Phase 1.9 passes and the one-week dogfood gate in §16 is satisfied.

### Superpowers operating model

Use the Superpowers plugin as the execution harness for this pivot, not as a decorative process note.

**Required workflow:**
1. **Branch/worktree isolation:** before Phase 0 implementation, use `superpowers:using-git-worktrees` or equivalent branch isolation to create/verify `v2-offline-first`. Never start v2 implementation directly on `main`.
2. **Design before implementation:** if a phase changes product behavior or architecture beyond the current plan, use `superpowers:brainstorming` to turn that change into a short spec before coding.
3. **Phase plans:** before each phase, use `superpowers:writing-plans` to create `docs/development/v2-phase-plans/phase-N.md` with bite-sized checkbox steps, exact files, tests, and expected outputs.
4. **Execution mode:** execute phase plans with `superpowers:subagent-driven-development` when tasks can be split cleanly; use `superpowers:executing-plans` for tightly coupled phases where one controller should do the work inline.
5. **TDD/debugging:** use `superpowers:test-driven-development` for feature/bug implementation and `superpowers:systematic-debugging` for unexpected failures, crash recovery issues, sync bugs, or flaky tests.
6. **Review gates:** use `superpowers:requesting-code-review` after each phase and before merging. For review feedback, use `superpowers:receiving-code-review` so fixes are verified, not applied blindly.
7. **Completion gate:** use `superpowers:verification-before-completion` before claiming a phase is done, then `superpowers:finishing-a-development-branch` before merge/PR decisions.

**Parallel agent policy:**
- Use parallel explorer agents for independent research questions, especially before Phase 1.1-1.3. Good examples:
  - Hocuspocus durability hooks and update-log feasibility
  - all current `atoms.body` writers and cache consumers
  - Milkdown/Crepe/prosemirror-sync dependency deletion map
  - Tiptap markdown extension/import-export APIs
  - Convex self-host feature constraints
- Use parallel worker agents only when write sets are disjoint. Good examples:
  - `services/hocuspocus/` server work
  - `apps/app/src/editor-v2/` import/export work
  - Convex projection metadata and cache mutations
  - `tools/yjs/` CLI/admin tooling
- Do not parallelize workers across shared files such as `apps/app/convex/schema.ts`, `apps/app/src/components/AtomEditor.tsx`, or cross-cutting package manifests unless one controller owns the final integration.
- The controller agent must review every subagent result, reconcile conflicts, run the full relevant test suite, and update the phase checklist. Subagent success is evidence, not acceptance.

### Planned repository map

| Path | Responsibility | First touched |
|------|----------------|---------------|
| `docs/development/v2-schema-spec.md` | Canonical schema, Y.Doc shape, extension contracts, migration rules | Phase 1.1 |
| `docs/development/v2-phase-plans/` | Per-phase execution checklists with tests and rollback notes | Phase 0 |
| `tests/fixtures/markdown-corpus/` | Hostile hand-authored markdown fixtures | Phase 0 |
| `tests/fixtures/user-corpus-backup/` | Exported user notes for migration/round-trip testing | Phase 0 |
| `apps/app/src/editor-v2/` | Tiptap extensions, markdown import/export, editor adapter | Phase 1.1 |
| `apps/app/src/components/AtomEditor.tsx` | Current editor shell; becomes thin wrapper around v2 editor adapter | Phase 1.4 |
| `apps/app/src/lib/collab-sync.ts` | v1 prosemirror-sync adapter; deleted/replaced after v2 editor lands | Phase 1.9 |
| `apps/app/convex/schema.ts` | Metadata schema, `atomSuggestions` anchor migration, `atoms.body` cache metadata | Phase 1.6/1.7 |
| `apps/app/convex/atoms.ts` | Import/admin body-cache escape hatches and search cache updates | Phase 1.6 |
| `apps/app/convex/atomSuggestions.ts` | Suggestion CRUD migrated from markdown offsets to Y.RelativePosition | Phase 1.7 |
| `apps/app/convex/agent.ts` | Agent tools rewritten to semantic Y.Doc operations | Phase 1.8 |
| `services/hocuspocus/` | WebSocket service, auth bridge, update durability, semantic API, admin tools | Phase 1.3 |
| `tools/yjs/` | `inspect-doc`, `decode-update`, `compact-doc`, `export-doc`, `rebuild-projection`, quarantine CLI | Phase 1.2/1.3 |
| `docker-compose.dev.yml` | Local Postgres + Hocuspocus dependencies for v2 development | Phase 0/1.3 |

### Phase 0 — Decisions + extraction (~1 week)

Goal: lock open decisions, extract user's notes + nasty markdown fixtures, cut v2 branch. Do NOT spend weeks polishing v1.

**Deliverables:**
- Codex open decisions resolved (DONE — see §4 + §15)
- Export user's atom corpus to disk as markdown backup (procedure documented; real private export requires deployment/local env and is ignored by git by default)
- Record 10-20 nasty markdown fixtures that exercise: wikilinks (escaped + bare), nested lists, tables, math (inline + block), code fences with language tags, fenced query blocks, inline atoms, formulas, frontmatter edge cases, HTML passthrough
- Document current custom editor behaviors (any Crepe-specific UX worth preserving)
- Cut `v2-offline-first`/`codex/v2-offline-first-phase-0` branch from main; lock main to v1 maintenance only
- Complete the editor-choice spike: prove Tiptap OSS markdown/import/export and extension APIs can preserve dohc's text-first model without Tiptap AI Toolkit or paid/pro extensions; keep Lexical as a documented switch path if the spike fails

**Definition of done:** branch cut, corpus exported, fixture set committed under `tests/fixtures/markdown-corpus/`, and `docs/development/v2-editor-choice.md` records the Tiptap OSS-only decision or the Lexical switch trigger.

### Phase 1.1 — Tiptap schema + custom extension design (~1.5 weeks)

Goal: Define the canonical document model. NO editor swap yet. Pure schema design + extension contracts.

This is the most important phase. Get it wrong and every later phase suffers.

**Sub-tasks:**
1. Tiptap node schema definitions for every dohc construct:
   - Standard: paragraph, heading, lists, code block, table (from StarterKit)
   - Custom: `Wikilink` (atomic inline), `InlineAtom`, `Formula`, `QueryBlock` (atomic block), `Math` (inline + block)
   - Decide: `Frontmatter` as separate Y.Map vs leading node in doc → Y.Map (cleaner separation)
2. Y.Doc shape per atom:
   - Root: Y.Doc
   - `body`: Y.XmlFragment (Tiptap's collab extension target)
   - `frontmatter`: Y.Map (key/value, type-loose)
   - `meta`: Y.Map (lastEditedByUserId, lastEditedAt, schemaVersion)
3. Doc ID strategy: room name = `fileId` (rename-proof via existing `atomIds` table)
4. Extension contracts written as TypeScript interfaces:
   - `parseMarkdown(token, helpers): ProseMirrorNode | null`
   - `renderMarkdown(node, helpers): string`
   - `toJSON(node)` for inspection tooling
5. Schema versioning: include `schemaVersion: number` in Y.Map.meta; upgrade path documented
6. Decision: which existing markdown constructs are FIRST-CLASS Y.Doc nodes vs preserved-as-text:
   - First-class: wikilinks, inline atoms, formulas (need stable identity under collab)
   - As-text: math (round-trips via `$...$` markdown), HTML (passthrough only)

**Definition of done:** schema specification document + TypeScript interfaces compiled. No implementation yet.

**Stop/go gate:** if any dohc construct cannot be represented as a markdown-expressible Tiptap node with a deterministic renderer, pause and either simplify that construct or mark it explicitly out of scope for Phase 1. Do not invent hidden rich state that markdown export cannot preserve.

### Phase 1.2 — Markdown ↔ Y.Doc import/export with hostile corpus (~2 weeks)

Goal: Bulletproof bidirectional conversion. This is THE correctness milestone — fail here and `atoms.body` cache becomes a lie.

**Sub-tasks:**
1. Implement `markdownToYDoc(md: string): Y.Doc` using Tiptap parser + custom extension `parseMarkdown` handlers
2. Implement `yDocToMarkdown(doc: Y.Doc): string` using Tiptap serializer + custom extension `renderMarkdown` handlers
3. Idempotency test against fixture corpus:
   - `roundtrip(md) === roundtrip(roundtrip(md))` for every fixture
   - `markdownEquivalent(md1, md2) === true` where equivalence ignores whitespace-only formatting drift
4. Round-trip test against user's full atom corpus (from Phase 0 export):
   - Convert every atom: markdown → Y.Doc → markdown → assert equivalent (or document acceptable drift)
5. Projection checksum:
   - Store/print `{ schemaVersion, markdownHash, ydocStateVector, projectionHash }` in tooling output so projection drift is observable and comparable.
6. Operational tooling (per O9): `export-doc --md|--ybin`, `rebuild-projection <atomId>`, first pass of `inspect-doc <atomId>`
7. Drift catalog: any fixture that doesn't round-trip cleanly is logged as either (a) acceptable formatting drift, (b) schema gap to fix in Phase 1.1, or (c) extension bug to fix here

**Definition of done:** ≥95% of user's atom corpus round-trips byte-equivalent; remaining <5% documented as acceptable drift with examples. Operational tooling shippable.

**Stop/go gate:** no Phase 1.3 infrastructure work starts until the hostile fixture corpus is 100% passing or each failing fixture is explicitly removed from v2 scope with a migration/export note. The user corpus can tolerate documented formatting drift; the hostile corpus cannot.

### Phase 1.3 — Hocuspocus server: auth, persistence, projection, crash safety (~2-3 weeks)

Goal: Production-grade Hocuspocus before any client touches it.

**Sub-tasks:**
1. `services/hocuspocus/` Node.js server:
   - `@hocuspocus/server` + custom Postgres update-log/snapshot persistence
   - Logging, health endpoint, graceful shutdown, env-driven config
   - Production Dockerfile plus local compose service for Hocuspocus + Postgres
2. **Crash-safety persistence** (codex critical risk R-new):
   - First write `docs/development/v2-hocuspocus-persistence.md` documenting the exact Hocuspocus hook/extension point used for durable update capture and what "ack" means in that path
   - Use a Postgres append-only update log (`docName`, monotonic `seq`, `updateBytes`, `actorId`, `receivedAt`, `snapshotId?`) plus periodic compacted snapshots
   - The server must not advertise a document update as durably stored until its update bytes are written, or the spike must explicitly prove Hocuspocus cannot provide that boundary and propose an alternate durability design
   - On boot: load latest snapshot, replay newer update-log rows in sequence, then compact
   - Trade-off: minor write amplification vs ack'd-edit-loss-on-crash risk
3. Convex action `auth.getCollabToken`:
   - Mints JWT with payload `{ sub, ws, actorKind: 'user'|'agent', authzVersion, exp }`
   - For shared docs, `sub` stays the caller and `ws` can target the owner workspace; Hocuspocus still asks Convex ACL before granting read/write.
   - **5-minute TTL** (per O3); short refresh, but rotation must be cheap
   - Signed with shared secret in env (`HOCUSPOCUS_JWT_SECRET`)
4. Hocuspocus `onAuthenticate`:
   - Verify JWT signature + exp
   - Compare `authzVersion` against cached Convex workspace version (refresh cache on miss)
5. Hocuspocus `onLoadDocument`:
   - Fetch atom ACL from Convex (or local cache keyed by `authzVersion`)
   - 403 if user can't read this atom
   - Load Y.Doc binary from Postgres (or initialize from `atoms.body` markdown if first load — uses Phase 1.2 import)
6. Hocuspocus `beforeSync` (per codex O3):
   - Recheck ACL on every replayable Yjs sync payload, not just on connect
   - Persist SyncStep2/YjsUpdate payload bytes before Hocuspocus applies them
   - Do not use `beforeHandleMessage` as the update log boundary; it receives the raw Hocuspocus transport envelope
   - Disconnect on revocation event
7. `onChange` hook: prepared for Phase 1.6's atoms.body projection (initially just logs)
8. Hocuspocus admin API: `disconnect-by-{workspaceId, userId}` for revocation propagation (per O10)
9. Crash/restart tests:
   - Kill Hocuspocus mid-edit, restart, verify no edit loss
   - Restart while clients connected, verify graceful reconnect
   - Persistence write fail-loud (Postgres outage) — Hocuspocus refuses writes, returns error to client

**Definition of done:** Hocuspocus accepts auth'd connections, persists Y.Docs durably, survives restart with no data loss, enforces per-atom ACL. No client integration yet — tested via raw `@hocuspocus/provider` script.

**Stop/go gate:** deliberately kill the process after a client receives an accepted edit but before the next full snapshot. If that edit does not recover from the update log, Phase 1.3 is not done.

### Phase 1.4 — Port editor UI: Milkdown → Tiptap (Y.Doc-backed) (~2 weeks)

Goal: Replace Milkdown/Crepe with Tiptap as the editor. Y.Doc via Hocuspocus. NO agent suggestions, NO awareness yet.

**Sub-tasks:**
1. Install Tiptap + StarterKit + extensions for custom nodes (Phase 1.1 work)
2. New `AtomEditor.tsx` that:
   - Mounts Tiptap editor with `@tiptap/extension-collaboration` pointed at Y.XmlFragment from Hocuspocus provider
   - Provider config lives in a small adapter (`apps/app/src/editor-v2/hocuspocusProvider.ts`): WS URL + JWT from Convex action; auto-refresh JWT before 5min expiry
   - Frontmatter UI writes visible metadata changes into the canonical `frontmatter` Y.Map while collaborative editing is mounted; Phase 1.6 moves all projection/cache writes fully server-side
3. Toolbar/menus port to Tiptap command API
4. y-indexeddb local persistence (offline-first capability lands here)
5. Loading states: show spinner until Hocuspocus sync complete; local IndexedDB content can render before remote sync, but editing starts only after provider/auth/storage readiness is known, or a verified local cache exists for offline resume (lesson from M1)
6. Remove Milkdown/Crepe imports
7. Tests: raw-provider crash/replay, unit/editor lifecycle guards, markdown corpus, and server auth/persistence tests are in place now; full mounted browser two-tab/offline E2E remains in the Phase 1.9 QA matrix unless added earlier

**Definition of done:** type into Tiptap, Y.Doc syncs via Hocuspocus, edits persist locally + remotely, and raw-provider crash/restart recovery passes. Full browser two-tab/offline replay is still required before calling Phase 1 shipped. NO suggestion bubbles, NO cursors yet.

**This is the first offline-first milestone.** Worth a small celebration.

### Phase 1.5 — Y.Awareness presence (~1 week)

Goal: Cursor + selection presence via Y.Awareness.

**Sub-tasks:**
1. Add `@tiptap/extension-collaboration-caret` (or equivalent) configured with user color + display name
2. File-tree "who's editing what" indicator: query Hocuspocus connection state via admin endpoint (or expose via Convex query that proxies to Hocuspocus)
3. **Awareness leak prevention (codex O10):** users without current read access must receive no awareness for the atom. Read-only users may see allowed collaborator presence, but their own cursor/selection publishing is disabled unless product explicitly wants read-only focus sharing. Hocuspocus filters outgoing awareness updates by viewer's ACL. (Default Y.Awareness broadcasts to all room members; needs server-side gating for restricted atoms.)
4. **Revocation → disconnect:** when Convex revokes a user's atom access, call Hocuspocus admin API to forcibly close their socket. Don't wait for token expiry.

**Definition of done:** cursors visible with display names + colors. Revoked users disconnected within seconds. Unauthorized awareness is not broadcast, and the read-only cursor publishing policy is enforced.

### Phase 1.6 — atoms.body as derived projection (~1 week)

Goal: Move markdown projection write to Hocuspocus `onChange`. Name `atoms.body` honestly as a cache.

**Sub-tasks:**
1. Hocuspocus `onChange` hook: debounce 500ms, then `yDocToMarkdown` (from Phase 1.2 lib) → enqueue projection job with `{ atomId, schemaVersion, ydocStateVector, markdown, projectionHash, lastEditedByUserId }`
2. Convex `_setBodyCache` mutation: updates `atoms.body`, `searchText`, `updatedAt`, `lastEditedByUserId`, plus projection metadata fields needed for drift checks (`bodyProjectionHash`, `bodyProjectionVersion`, `bodyProjectedAt`)
3. Queue behavior: if Convex is unavailable, Hocuspocus keeps retryable projection jobs in Postgres and marks projection lag unhealthy; editing may continue, but cache consumers see stale data until recovery
4. Document the contract: `atoms.body` is NOT canonical; consumers tolerate ≤2s normal lag and can detect stale projection metadata
5. Update agent `read_atom`: read `atoms.body` (cache) for context purposes; document the lag tolerance and add an explicit "force fresh read" path for edits that need current state
6. Update search: no change in query shape, but add stale-cache diagnostics to admin tooling
7. Update formula/query block evaluation: same (reads `atoms.body`), with docs that formulas are projection-lag tolerant
8. Update map regen, capture, atom locks: same; all are cache-tolerant
9. Admin tool: `rebuild-projection <atomId>` forces Y.Doc → markdown re-derivation if cache drifts

**Definition of done:** `atoms.body` updates ≤2s after editor change. Search finds new content. All consumers see consistent (if slightly lagged) state.

**Stop/go gate:** simulate Convex outage while editing, then recover. The Y.Doc must retain all edits, queued projections must flush in order, and `bodyProjectionHash` must match a fresh `yDocToMarkdown` rebuild.

### Phase 1.7 — Rebuild suggestions with Y.RelativePosition (~1.5-2 weeks)

Goal: M3 suggestions on Y.Doc-canonical atoms. Drop `baseBodyHash`. Keep semantic intent witness.

**Sub-tasks:**
1. Schema migration:
   - Add `anchorStart: v.string()` (base64 of `Y.encodeRelativePosition`)
   - Add `anchorEnd: v.string()`
   - Keep `expectedText` (RENAMED conceptually: "semantic intent witness")
   - Add optional `expectedPrefix`, `expectedSuffix`, and `createdFromProjectionHash` for diagnostics and better stale-intent messages
   - DROP `baseBodyHash` from accept logic
   - Old `rangeFrom`/`rangeTo` columns marked deprecated; existing suggestions migrated or invalidated (user has none in flight — invalidate is fine)
2. Suggestion creation flow:
   - Agent computes intended range in current Y.Doc state
   - Server creates `Y.RelativePosition` from current Y.XmlFragment + absolute position
   - Encodes to base64, stores in `atomSuggestions`
3. Suggestion accept flow:
   - Introduce the minimal Hocuspocus server-side `applySuggestion`/`replaceRange` operation needed for accept; Phase 1.8 expands the same API for agent tools
   - Load atom Y.Doc through that operation
   - Decode anchors → resolve to current absolute positions
   - Compare current text at resolved range vs `expectedText` → if drift, mark suggestion stale, ask user to retry
   - If exact text fails but prefix/suffix still match, return a structured "needs-review" result instead of silently applying
   - Apply replacement via Y.XmlFragment transaction
   - Hocuspocus broadcasts to connected clients
4. Suggestion decoration plugin in Tiptap: subscribes to `atomSuggestions` Convex query, renders bubbles at resolved RelativePosition
5. Tests:
   - Create suggestion, apply 100 random edits, assert anchor still resolves to intended text
   - Accept stale suggestion (text changed at anchor) → returns ok:false, reason:'stale-intent'
   - Multi-client: suggestion created in tab A, accepted in tab B, tab C sees applied text

**Definition of done:** suggestions survive concurrent edits without drifting. Stale suggestions detected. Accept/reject atomic. Multi-tab convergence.

**Stop/go gate:** create a suggestion, mutate the same paragraph in a way that preserves anchor position but changes meaning, then accept. The system must refuse or require review; CRDT position stability alone is not enough.

### Phase 1.8 — Agent write path via Hocuspocus semantic API (~1-2 weeks)

Goal: Convex agent tools call Hocuspocus semantic API. Drop direct markdown writes for edit operations.

**Sub-tasks:**
1. Hocuspocus expands the HTTP/internal API for server-side edits (per O2):
   - `POST /apply/replaceRange { atomId, anchorStart, anchorEnd, replacement, expectedText? }`
   - `POST /apply/insertText { atomId, anchor, text }`
   - `POST /apply/insertAfterHeading { atomId, headingText, content }`
   - `POST /apply/createAtom { workspaceId, path, content }` (delegates to Convex for atom row create, then initializes Y.Doc)
   - Auth: internal-only route + admin token shared between Convex and Hocuspocus; per-request user identity in payload (for ACL recheck + attribution)
   - Idempotency: every request carries `operationId`; Hocuspocus records applied operation IDs per atom to make Convex action retries safe
   - Audit: every accepted semantic operation writes `{ operationId, atomId, actorId, toolName, anchorSummary, appliedAt }` to an audit log
2. Convex agent tools rewritten as semantic tools (per O8):
   - `propose_replace_text(atomId, anchorText, surrounding, newText)` — creates suggestion
   - `insert_after_heading(atomId, heading, content)` — direct apply (no suggestion needed for additive edits)
   - `rewrite_section(atomId, headingText, newContent)` — creates a reviewed replacement suggestion for substantial rewrites
   - `create_atom(path, content)` — direct apply
   - **NO** `write_atom(atomId, fullBody)` — this primitive is dropped; replace via semantic tools
3. Tool descriptions updated; agent system prompt updated to use new tool surface
4. Tests:
   - Agent suggests rewrite of paragraph; human types in adjacent text; verify both land correctly
   - Agent insert_after_heading concurrent with human editing same atom; verify Hocuspocus merge handles it
   - Agent edits offline atom (user offline); reconnect; verify agent edit applies on top of human's reconnect-merge
   - Convex retries the same semantic API call after timeout; verify idempotency prevents duplicate insert/rewrite

**Definition of done:** agent operates entirely through semantic API; no markdown blob writes. Concurrent human + agent edits converge.

**Stop/go gate:** remove or hard-disable any agent tool that can still overwrite a full markdown body. The model must not have a `write_atom(atomId, fullBody)` escape hatch.

### Phase 1.9 — Delete v1 code + final QA matrix (~1-2 weeks)

Goal: v1 is gone. Production-ready confidence.

**Sub-tasks:**
1. Delete files per §5 deletion list:
   - `apps/app/convex/collabBootstrap.ts`
   - `apps/app/convex/collabProjectionSerializer.ts`
   - `apps/app/convex/collabProjection.ts`
   - `apps/app/convex/collabPresence.ts`
   - `apps/app/src/lib/collab/` (cursor + selection plugins)
   - `collabDocs` and `collabSessions` schema tables
   - Bootstrap retry / error overlay logic
   - `splitFrontmatter` / `joinFrontmatter` coordinate code
2. Remove `@convex-dev/prosemirror-sync` from `convex.config.ts` and package.json
3. Remove Milkdown/Crepe packages
4. Update tests
5. Take final pre-merge exports:
   - full markdown projection export
   - full Y.Doc binary export
   - Postgres logical backup for Hocuspocus tables
   - Convex metadata export if supported by current environment
6. **Final QA matrix:**
   - 3 browsers, same doc, concurrent typing: convergence
   - Browser A offline 10min, reconnect: merge with B's edits
   - Browser A accepts suggestion while B types in same paragraph: both land
   - Network flap mid-edit: no data loss
   - Hocuspocus server restart with active editors: graceful reconnect, no edit loss (validates Phase 1.3 crash safety)
   - Convex outage (Hocuspocus up): editing continues, cache writes queue, recover when Convex returns
   - Access revocation mid-session: revoked user disconnected, awareness suppressed
   - 1000-edit stress test: typing 1k characters, latency < 50ms p99
   - Fixture corpus round-trip (Phase 1.2 corpus + user's full corpus): no regressions
   - Suggestion anchor stability under 100 concurrent edits between create and accept
   - Agent + human concurrent edits across all semantic tool types
   - Projection rebuild from Y.Doc restores `atoms.body` and search for a sampled workspace
   - Restore drill from exported Y.Doc + Convex metadata on a clean local stack

**Definition of done:** all 13 cases pass. v1 collab code is gone. Backup/restore drill succeeds. Doc updated to reflect as-built architecture.

## 7. Phase 2 — Self-hostable (~4-6 weeks, after Phase 1 ships)

Goal: dohc can be deployed entirely on user's own infrastructure with no SaaS dependencies (except optional Anthropic for AI).

**Sub-tasks:**
1. **Auth abstraction.** Introduce `apps/app/convex/authProvider.ts` interface; implement `WorkOSProvider` + `SelfHostProvider` (Better-Auth or Lucia). Config-driven via env var.
2. **Verify Convex self-hosted backend.** Run dohc against Convex OSS. Check Convex Agent component compatibility, scheduled functions, blob storage, WebSocket connections. Identify deal-breakers.
3. **Docker Compose stack.** `docker-compose.yml` with: Postgres + Hocuspocus + Convex self-hosted + dohc app + reverse proxy. One-command bring-up.
4. **Bring-your-own LLM.** Config option to point at Anthropic, OpenAI, or Ollama (local). Agent code uses the same tool-call API.
5. **Documentation.** `docs/self-hosting.md` with deploy guide, secret management, backup/restore for Postgres + Convex data.
6. **CI test for self-host.** Spin up the full stack in CI, run a smoke test (login, create atom, edit, AI suggest, accept).

**Risk:** Convex self-hosted may not cover everything we use. If it fails, fork (a) replace Convex with Postgres + a thin reactive layer, or (b) ship SaaS-only with "self-host coming later." Decide at Phase 2 start based on Convex OSS feature matrix.

## 8. Phase 3 — Optional local file sync (~6-8 weeks, after Phase 2 ships)

Goal: power users get Obsidian-style local markdown files that round-trip with the editor.

**Sub-tasks:**
1. **Tauri desktop app wrapper.** dohc as a native app with file system access. (Browser File System Access API is Chrome-only and limited.)
2. **User-selectable sync folder.** Per workspace, optional. Defaults to off; user opts in.
3. **Initial sync.** Walk Y.Docs in workspace, render to markdown, write to disk. Walk disk, parse markdown, create Y.Docs for files that don't exist in dohc yet.
4. **File watcher → Y.Doc.** `notify` (Tauri's filesystem watcher) detects external markdown changes; parse markdown → apply Y.Doc update.
5. **Y.Doc → file.** On Y.Doc change (via Hocuspocus onChange or local), render markdown → write file.
6. **Conflict resolution.**
   - Easy: file changed externally while editor not focused → silently update Y.Doc.
   - Hard: file changed externally while user typing → show "external change" diff banner with merge/discard options.
   - Easiest: editor-wins by default; external edits surface as "suggestions" the user accepts. Aligns with M3 suggestion UX.
7. **Conflict UI.** A small diff viewer for the "external change happened" case.
8. **Tests.** Edit in app + edit on disk + reconnect: verify both merge correctly.

**Risk:** file sync is notorious for edge cases (rename, delete, move, permission errors, partial writes, OS-specific quirks). Budget 50% of phase scope for edge-case bugs found in dogfooding.

## 9. Risk register

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | Tiptap custom extensions (inlineAtom, formula, queryBlock) are nontrivial to build | Sequence by complexity in Phase 1.1; fixture-based round-trip tests from day 1 (Phase 1.2) |
| R2 | Markdown round-trip in Tiptap renderer drifts from atoms.body cache | Phase 1.2 corpus regression test against user's full atom corpus; ≥95% byte-equivalent gate before proceeding |
| R3 | Hocuspocus auth bridge security bug (JWT validation, atom permission check) | Code review with security focus; integration test that asserts denied users get 403; recheck ACL on every doc operation, not just connect |
| R4 | Hocuspocus + Convex coupling failure modes (Convex down → Hocuspocus stuck) | Hocuspocus retries with backoff; degrade gracefully (edit continues, cache lags); alert on sustained failure |
| R5 | Agent + human concurrent edit produces unexpected results | Phase 1.8 explicit test cases; semantic intent witness on suggestion accept; conflict UX for concurrent rewrite of same section |
| R6 | Y.RelativePosition migration loses existing suggestions | User has few/no in-flight suggestions; invalidate on migration; document the breaking change |
| R7 | Convex self-hosted missing features blocks Phase 2 | Spike Convex OSS in Phase 2 week 1 before committing; fallback plan: replace Convex with Postgres + thin reactive layer |
| R8 | Phase 3 file conflicts produce data loss | Conservative default: editor-wins, external changes as suggestions; never silently overwrite editor content |
| R9 | Y.Doc binary size grows over time (CRDT history accumulates) | Implement snapshot pruning + compaction policy from Phase 1.3; periodic Y.Doc.gc() pass; `compact-doc` admin tool |
| R10 | Performance wall under high collaborator count | Stress-test in Phase 1.9; if Hocuspocus single-process is the bottleneck, plan horizontal scaling via Redis pub/sub (Redis ext; deferred until needed). NOTE: Hocuspocus Redis extension does NOT persist — Database extension still required. |
| R11 | **Acknowledged edit loss on Hocuspocus crash** (codex new) — debounced full-state storage can lose accepted edits if process dies before the next flush | Phase 1.3: verify exact Hocuspocus durability boundary, persist an append-only update log before considering updates stored, and replay newer updates on top of latest snapshot on boot. |
| R12 | **Awareness leaks** (codex new) — revoked users still publishing presence into docs they lost access to | Phase 1.5: Hocuspocus filters outgoing awareness updates by viewer's ACL; revocation triggers forced disconnect; presence cleared on disconnect. |
| R13 | **Concurrent agent + human rewrite of same section** (codex new) — Y.js merges character-by-character, but semantic intent is destroyed | Product UX: detect overlapping concurrent edits in same range; prompt user to choose. Don't pretend "Y.js has no conflicts" means "the product has no conflicts." |
| R14 | **RelativePosition semantic drift** (codex new) — anchor stays attached to structure, but text meaning has changed | Keep `expectedText` semantic witness on suggestions; stale-intent check on accept; surface to user before applying |
| R15 | **Extension schema drift over time** (codex new) — adding/removing Tiptap node types invalidates older Y.Docs | Schema versioning in Y.Map.meta; documented migration procedure per schema bump; never silently drop unknown node types |
| R16 | **Search staleness from atoms.body cache lag** (codex new) — search/agent reads may be stale up to 2s | Document the contract explicitly; store projection hash/version/timestamp; offer `forceProjectNow` admin escape hatch; consider live Y.Doc read for critical queries |
| R17 | **Disaster recovery: markdown-only export loses rich state** (codex new) — non-markdown-expressible Y.Doc state (collab metadata, unknown nodes) is lost in markdown export | Constrain Tiptap schema to markdown-expressible nodes only; Y.Doc binary export + markdown export both supported; document the lossy-vs-lossless guarantee |
| R18 | **LLM authoring raw Y.js updates** (codex new) — models are bad at CRDT updates; raw Y.js exposure produces incoherent edits | Phase 1.8: agent tools are SEMANTIC ONLY (`propose_replace_text`, `insert_after_heading`, `rewrite_section`, `create_atom`); never expose `applyUpdate` to the model |
| R19 | **Operational blind spots** (codex new) — without inspection tooling, debugging Y.Doc corruption is impossible | Phase 1.2 + 1.3 ship admin CLI: `inspect-doc`, `decode-update`, `compact-doc`, `export-doc`, `rebuild-projection`, `corruption-quarantine`. Not deferred. |
| R20 | **Duplicate agent edits on retry** — Convex action timeout/retry repeats a semantic operation after Hocuspocus already applied it | Phase 1.8: every semantic API call carries `operationId`; Hocuspocus records applied IDs and returns the original result for duplicates. |
| R21 | **Tiptap paid-feature creep** — Tiptap's paid AI/Comments/Tracked Changes features look tempting and accidentally define dohc's roadmap | Phase 0/1.1: document OSS-only package list, forbid paid/pro/private Tiptap packages in core, and implement dohc AI editing as semantic Hocuspocus operations owned by this repo. |

## 10. Sequencing rationale (REVISED per codex)

**Original draft chose editor-first. Codex disagreed and was right.** Recorded here so the reversal logic is preserved.

### Why model-first now (codex's argument, accepted)

> "Tiptap does not remove the markdown/Y.Doc fork by itself. The eval already said this: parser drift only disappears when Y.Doc/editor state becomes canonical."

The flaw in editor-first: it puts Tiptap on top of prosemirror-sync as an intermediate state. In that intermediate state, atoms.body is still canonical, prosemirror-sync is still the transport, but the editor has changed. **The parser-drift bug class is fully preserved.** All the M1 hardening commits would replay against a half-pivoted stack. Worst-of-both-worlds.

The pivot is "only defensible if you fully accept Y.Doc canonical." A half-pivot (Tiptap editor + markdown canonical) is strictly worse than either side of the fork.

### Codex's order (10 steps, mapped to Phase 1.1-1.9 + Phase 0):

1. **Define canonical document model** (Phase 1.1) — Tiptap schema, custom extensions, Y.Doc field names, doc IDs
2. **Build import/export** (Phase 1.2) — markdown ↔ Y.Doc with hostile corpus regression tests
3. **Stand up Hocuspocus** (Phase 1.3) — auth, persistence (crash-safe), projection hooks, crash/restart tests
4. **Port editor UI** (Phase 1.4) — Milkdown → Tiptap, NO suggestions/awareness yet
5. **Wire awareness/carets** (Phase 1.5) — Y.Awareness with ACL filtering
6. **Make atoms.body projection-only** (Phase 1.6) — update consumers consciously
7. **Rebuild suggestions** (Phase 1.7) — with Y.RelativePositions, drop baseBodyHash
8. **Move agent write path** (Phase 1.8) — semantic API in Hocuspocus
9. **Delete v1 code** (Phase 1.9) — collabBootstrap, Crepe, prosemirror-sync, the lot
10. **Import notes once** (folded into Phase 1.4 lazy migration + Phase 1.9 cleanup)

### Trade-offs this order accepts

**You don't see Tiptap running until Phase 1.4** (~6-7 weeks in). The previous draft front-loaded the visible win; this order front-loads the correctness foundation. Codex's argument: dogfooding a half-pivoted state is fake validation, because the parser-drift bugs you'd find don't represent the real architecture you're building.

**Big-bang risk: any single phase blocking delays the whole rewrite.** Counter-argument: there's no production to keep running. The user is solo. The "incremental ship" benefit is small; the "avoid dual-state trap" benefit is large.

### What was rejected (and why)

- **Editor-first (my original O5 (a)):** preserves parser-drift bug class during the intermediate state. Half-pivot is worse than either pure option.
- **Transport-first (O5 (b)):** dual-write between Convex sync and Hocuspocus is brittle and rarely worth it.
- **Storage-first (O5 (c)):** changing atoms.body semantics without a Y.Doc to back it adds risk for no benefit.

## 11. Testing strategy per phase

| Phase | Test approach |
|-------|---------------|
| 1.1 | Type/interface compilation; schema spec review against every dohc construct; no runtime editor test yet |
| 1.2 | Markdown fixtures + user corpus: parse `atoms.body` → Y.Doc → serialize → assert equivalent markdown; projection checksum tests |
| 1.3 | Raw Hocuspocus provider integration tests: auth accepted/denied, ACL recheck, crash/restart replay, Postgres outage fail-loud |
| 1.4 | Editor integration tests: open atom, type, refresh, local IndexedDB persistence, offline edit + reconnect merge, 2-3 tab convergence |
| 1.5 | Awareness tests: cursor display, read-only publishing disabled, ACL-filtered awareness, forced disconnect on revocation |
| 1.6 | Cache lag test: edit → assert `atoms.body` updates within ≤2s normal path; Convex outage queues projection and flushes in order on recovery |
| 1.7 | Suggestion anchor stability test: create suggestion, apply 100 random edits, assert anchor still points to intended text; stale-intent and needs-review cases |
| 1.8 | Agent semantic API tests: concurrent human/agent edits, offline user merge, idempotent retry, no direct markdown body overwrite |
| 1.9 | Full final QA matrix from §6 Phase 1.9, plus backup/restore drill |
| 2 | Self-host smoke test: Docker compose up → login → edit → AI → accept |
| 3 | File round-trip test: edit in app, see file change; edit file, see app change; conflict UI |

## 12. Migration of user data (own notes)

User has no external users. Their own daily-use atoms need to migrate cleanly.

**Approach:**
1. Phase 0 exports the full markdown corpus before any v2 writes happen
2. Phase 1.2 introduces Y.Doc conversion, but `atoms.body` is still authority for bootstrap; existing atoms work unchanged
3. Phase 1.4 first time an atom is opened with Hocuspocus, server creates Y.Doc from current `atoms.body`; persists to Postgres; subsequent opens load Y.Doc
4. Phase 1.6 Hocuspocus is now authority; `atoms.body` becomes derived cache with projection hash/version/timestamp metadata
5. No explicit migration script needed for daily use — atoms migrate lazily on first open/edit post-Phase-1.4
6. A bulk migration command is still required before merge to main so unopened atoms are converted and included in the final Y.Doc export

**Rollback:**
Before Phase 1.6, `atoms.body` is still the last-known-good canonical markdown. After Phase 1.6, rollback requires exporting current Y.Docs back to markdown first; otherwise the projection cache may lag the latest accepted edits. The rollback drill in Phase 1.9 must prove that v1 can be restored from the latest markdown export, with Y.Doc-only state intentionally discarded.

## 13. The v1 → v2 cutover

- v2 branch (`v2-offline-first`) cut from main at Phase 0
- v1 stays on `main` for whatever ad-hoc daily use needs continuity
- Once v2 Phase 1.9 passes, backup/restore drill succeeds, and §16's one-week dogfood gate is satisfied, merge `v2-offline-first` → `main`; v1 becomes history
- v1 documentation moves to `docs/history/v1-prosemirror-sync-multiplayer.md` (kept for archaeology)

No support window for v1 needed (no external users).

## 14. Open product questions (need answers before Phase 0 ends)

| Q | Answer needed by |
|---|------------------|
| Confirm Phase 2 + 3 are still on the roadmap (or just Phase 1 for now) | End of Phase 0 — informs Tiptap extension API decisions |
| Phase 3: Tauri OR Electron OR PWA-only with File System Access API? | Start of Phase 3 |
| Per-workspace OR per-user opt-in for local file sync? | Start of Phase 3 |
| Convex self-hosted is sufficient OR do we plan to migrate off Convex eventually? | Start of Phase 2 |
| Self-host auth: Better-Auth vs Lucia vs Keycloak vs roll-our-own? | Start of Phase 2 |

## 15. Codex consult — synthesis

Codex consult completed 2026-05-25. Full output at `/home/ice/dev/dohc/.context/codex-outputs/v2-pivot-consult-20260525-170821.md`. Token cost: 426k.

**Bottom line:** "The pivot is defensible only if you fully accept Y.Doc canonical. A half-pivot is worse than the current stack."

### 15.1 — Y.Doc persistence (O1): Postgres with crash safety

Codex confirms (a) Postgres-backed persistence. Adds critical risk: default debounced full-state storage can lose accepted edits on process crash if there is no durable update log. Mitigation: verify the exact Hocuspocus durability boundary, persist update bytes eagerly through that path, and keep periodic full-state snapshots for compaction/recovery. Trade-off: minor write amplification. Accepted.

Rejected: Convex blob storage (wrong canonical owner, bad self-host independence), S3 as primary write path (OK for snapshots/backups), custom Hocuspocus-to-Convex-tables persistence (makes durability dependent on Convex function latency — "Convex-sync with extra steps").

### 15.2 — Agent integration (O2): Hocuspocus SEMANTIC API, not WebSocket client

**My original recommendation (Convex action as Hocuspocus WS client) was wrong.** Codex's analysis:

> A Convex action pretending to be a long-lived Hocuspocus provider is brittle: connection lifecycle, sync wait, action timeout, auth refresh, retry semantics. It is the wrong side of the boundary.

Correct design: Hocuspocus exposes server-side semantic API (`replaceRange`, `insertText`, `insertAfterHeading`, `applySuggestion`). Convex agent calls this API via HTTP. Hocuspocus applies the transaction to the live Y.Doc in-process. Live clients receive it through normal Y.js ordering.

Also rejected: direct Y.Doc binary edit from Convex action (races live editors), agent-edits-stay-in-Convex-then-forwarded (recreates the dual-write trap that caused acceptSuggestion's baseBodyHash patch in M1).

### 15.3 — Auth TTL (O3): 5 minutes + authzVersion + recheck

My original 15min was too lenient. Codex:

> Anything longer makes revocation fake.

Correct target design: JWT 5min TTL + JWT claim `authzVersion` (workspace-scoped int that bumps on any ACL change) + Hocuspocus recheck on EVERY document operation (not just connect). Phase 1.4 implements the TTL, token-refresh reauth, expiry rejection on later sync messages, and per-operation ACL rechecks; `authzVersion` is currently constant `1` until an ACL cache exists.

Mid-session revocation paths: (a) Hocuspocus rechecks in `beforeSync` before replayable Yjs payloads are applied, (b) Convex schedules Hocuspocus admin disconnect for affected sockets on share/org revocation, (c) presence/awareness cleared on disconnect.

JWT payload should be IDENTITY ONLY: `{ sub, ws, actorKind: 'user'|'agent', authzVersion, exp, sessionId? }`. **Never** embed allowed atomIds — doesn't scale, goes stale instantly.

### 15.4 — atoms.body cache (O4, O6): keep, but stop pretending it's canonical

Codex confirms cache approach. Adds discipline:

> Make the rule:
> - Canonical: Y.Doc.
> - Projection: atoms.body.
> - Consumers that need current editor state use Hocuspocus/Y.Doc.
> - Consumers that can tolerate projection lag use atoms.body.
> - Projection drift is observable, checksummed, and rebuildable.

`atoms.body` writes happen ONLY via Hocuspocus `onChange` hook + admin import/rebuild escape hatches. Never client-direct.

### 15.5 — Phase sequencing (O5): big-bang on branch, NOT editor-first

**My original (a) editor-first was wrong.** Codex's correction is the most consequential change to this plan. See §10 for full rationale. New phase order is documented in §6.

### 15.6 — Suggestion CAS (O7): drop baseBodyHash, keep expectedText

Codex confirms.

> Y.js removes the need for whole-document markdown CAS, not semantic intent validation.

Anchor witness: original selected text + optional surrounding prefix/suffix + `createdFromProjectionHash` for diagnostics. On accept: resolve RelativePositions, if text at resolved range ≠ expectedText → stale-intent. CRDTs preserve POSITION, not MEANING.

Storage: `anchorStart: v.string()` + `anchorEnd: v.string()` (base64-encoded `Y.encodeRelativePosition`). Base64 vs raw bytes: codex slightly prefers base64 for tooling/inspection safety.

### 15.7 — Agent tool API surface (codex new — O8)

LLMs are bad at raw Y.js updates. Do NOT expose `applyUpdate` to the model. Semantic tools only:

- `propose_replace_text(atomId, anchorText, surrounding, newText)` → creates suggestion
- `insert_after_heading(atomId, heading, content)` → direct apply
- `rewrite_section(atomId, headingText, newContent)` → reviewed replacement suggestion
- `create_atom(path, content)` → direct apply

`write_atom(atomId, fullBody)` as today's primitive is DROPPED. Replace via the semantic surface above.

### 15.8 — Operational tooling from day 1 (codex new — O9)

Build alongside Phase 1, not deferred:

- `inspect-doc <atomId>` — pretty-print Y.Doc structure
- `decode-update <bytes>` — decode a Y.js update for debugging
- `compact-doc <atomId>` — run Y.Doc.gc() + snapshot
- `export-doc <atomId> [--md|--ybin]` — export as markdown or Y.Doc binary
- `rebuild-projection <atomId>` — force atoms.body cache re-derivation
- `corruption-quarantine <atomId>` — isolate a possibly-corrupted Y.Doc

These ship with Phase 1.2 (export-doc, rebuild-projection) and Phase 1.3 (the rest). Without them, debugging Y.Doc corruption is impossible.

### 15.9 — Awareness leak prevention (codex new — O10)

Default Y.Awareness broadcasts to all room members. dohc has per-atom ACL with `private`/`restricted` modes. Server must filter outgoing awareness updates by viewer's ACL. Users without read access must receive no presence for that atom; read-only users should not publish cursor/selection focus unless the product explicitly chooses that behavior.

Revocation → forced disconnect (not waited-out). Hocuspocus admin endpoint `disconnect-by-{workspaceId, userId}` called from Convex on access revocation.

### 15.10 — Disaster recovery (codex new — O11)

Y.Doc binary export + markdown projection export both supported from day 1 (Phase 1.2). Markdown alone loses any non-markdown-expressible rich state — so constrain Tiptap schema to markdown-expressible nodes only. Don't add Tiptap extensions that produce node types with no markdown serialization.

### 15.11 — Convex Agent compatibility (per codex's #8)

`@convex-dev/agent` itself is fine as orchestration. The **tool layer** must change. Today's tools are markdown-string IO; v2 tools are semantic operations against Y.Doc. The integration challenge is tool design, not Convex Agent component compatibility.

### 15.12 — Convex self-host viability (per codex's #10)

Viable for metadata + agent threads + scheduled functions. Codex notes self-hosting is "not for everyone" per Convex docs, some runtime configuration not supported under self-host. Plan to test, not assume. No deal-breaker for keeping Convex as metadata backend. Isolate Convex behind app services so a later Postgres/Drizzle migration is possible.

### 15.13 — Pivot now (codex confirms with extraction-pass caveat)

> The current stack is already packed with architecture-specific compensations: bootstrap CAS, projection conflict handling, presence table, cursor position approximations, suggestion accept rebootstrap, markdown body hash baselines. You are solo, no external users, and the v2 target invalidates the core storage model. More hardening now mostly creates throwaway confidence.

Short extraction pass before pivot (folded into Phase 0):
1. Export your notes
2. Record 10-20 nasty markdown fixtures
3. Write down current custom editor behaviors
4. Stop

### 15.14 — Codex's final cautions

Quoted directly:
1. Tiptap/Hocuspocus does not save you from schema design — pain moves into custom extensions and projection.
2. Do not let the model author raw Y.js — semantic tools only.
3. Do not use markdown offsets anywhere new.
4. Do not let Convex and Hocuspocus both believe they own document content.
5. Do not treat "Y.js has no conflicts" as "the product has no conflicts" — concurrent rewrites still need UX.
6. Do not underbuild operational tooling.

Bottom line: the pivot is defensible only if you fully accept Y.Doc canonical. A half-pivot is worse than the current stack.

## 16. Definition of "v2 ready to call shipped"

- All Phase 1.9 final QA cases pass on production-equivalent staging
- User (you) has been using v2 daily for ≥1 week without falling back to v1
- Documentation updated:
  - `docs/development/v2-architecture.md` (the as-built architecture doc)
  - repo agent instructions updated with new patterns if such a file exists (`AGENTS.md`, `CLAUDE.md`, or equivalent)
  - `README.md` reflects offline-first capability
- v1 code deleted from main
- Performance: typing latency < 50ms p99 with 3 collaborators on a doc

## 17. Estimated timeline summary (REVISED per §6 restructure)

| Phase | Scope | Weeks | Running total |
|-------|-------|-------|---------------|
| Phase 0 | Decisions + extraction | 1 | 1 |
| 1.1 | Tiptap schema + extension design (no code) | 1.5 | 2.5 |
| 1.2 | Markdown ↔ Y.Doc import/export + corpus tests + tooling | 2 | 4.5 |
| 1.3 | Hocuspocus server (auth + crash-safe persistence + ACL) | 2-3 | 6.5-7.5 |
| 1.4 | Port editor: Milkdown → Tiptap (Y.Doc + IndexedDB) | 2 | 8.5-9.5 |
| 1.5 | Y.Awareness presence + leak prevention | 1 | 9.5-10.5 |
| 1.6 | atoms.body as derived projection | 1 | 10.5-11.5 |
| 1.7 | Rebuild suggestions with Y.RelativePosition | 1.5-2 | 12-13.5 |
| 1.8 | Agent semantic API via Hocuspocus | 1-2 | 13-15.5 |
| 1.9 | Delete v1 code + final QA matrix | 1-2 | 14-17.5 |
| **Phase 1 ship** | | **~14-17 weeks (3.5-4.5 months)** | |
| Phase 2 | Self-hostable | 4-6 | 18-23.5 |
| Phase 3 | Local file sync | 6-8 | 24-31.5 |
| **Full vision** | | **~6-8 months focused work** | |

Compared to the v1.0 draft, this is ~1-4 weeks longer because the model + correctness + infrastructure work is front-loaded instead of overlapping with editor development. Codex's argument: front-loading correctness reduces total work by avoiding redo.

AI-assisted (Claude Code) will compress per-phase implementation but NOT QA/integration time. Estimates assume AI-assist; without it, double the implementation portion.

## 18. Next concrete actions

1. [ ] Add mounted browser lifecycle tests for Phase 1.4: sync-unavailable read-only state, first remote bootstrap, local IndexedDB resume, and two-tab convergence.
2. [ ] Start Phase 1.5 presence/awareness only after the browser lifecycle tests above pass.
3. [x] Start Phase 1.6 server-owned `atoms.body` projection so legacy client autosave can be fully removed from collaborative markdown paths.
4. [x] Start Phase 1.7 RelativePosition-backed suggestions.
5. [x] Start Phase 1.8 Hocuspocus semantic API for suggestion accept and agent tools.
6. [x] Start Phase 1.9 v1 collaboration cleanup and final verification pass.
7. [ ] Decide §14 product questions before Phase 2 starts: self-host auth choice, desktop wrapper, and local file sync scope.
8. [ ] Run the §16 one-week dogfood/staging ship gate before merging v2 to `main`.
