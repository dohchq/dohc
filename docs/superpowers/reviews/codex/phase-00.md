OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 019eb094-40f3-7341-a0ba-9fd096d7a154
--------
user
commit 7df1553
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git show --stat --oneline --decorate --no-renames 7df1553' in /home/ice/dev/dohc
 succeeded in 0ms:
 M docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md
?? docs/superpowers/reviews/codex/
/home/ice/dev/dohc
7df1553 (HEAD -> claude/desktop-local-first-cloud-sync) phase0: Inventory old plan for desktop local-first pivot
 AGENTS.md                                          |  47 +-
 ...desktop-local-first-cloud-sync.execution-log.md | 100 ++++
 ...26-06-10-dohc-desktop-local-first-cloud-sync.md | 539 ++++++++++++++++++---
 ...10-desktop-local-first-cloud-sync-plan-audit.md | 138 ++++++
 .../2026-06-10-old-plan-port-delete-inventory.md   |  67 +++
 package.json                                       |   1 +
 scripts/check-desktop-local-first-baseline.mjs     |  30 ++
 7 files changed, 855 insertions(+), 67 deletions(-)

exec
/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 7df1553 -- package.json scripts/check-desktop-local-first-baseline.mjs AGENTS.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md docs/superpowers/reviews/2026-06-10-desktop-local-first-cloud-sync-plan-audit.md docs/superpowers/plans/2026-06-10-old-plan-port-delete-inventory.md' in /home/ice/dev/dohc
 succeeded in 0ms:
commit 7df1553c81278a4970a97c27bc2d666e9a56b71c
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 16:07:17 2026 +0800

    phase0: Inventory old plan for desktop local-first pivot
    
    Baseline recorded (all package suites green; 4 pre-existing web test
    failures on main documented), Node 22.13 toolchain freeze, Codex
    capability preflight, port/delete inventory, execution log with
    resume snapshot and reference digests, product thesis in AGENTS.md.
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/AGENTS.md b/AGENTS.md
index 01f832c..ff8b474 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1,132 +1,175 @@
 # dohc
 
 This is the repository for dohc, the easiest way for agents to build and maintain the workspace around your real work.
 
 The goal is a full end-to-end AI operating system for documents, data, dashboards, workflows, and decisions. The user stays in control, while agents do the heavy lifting of organizing, updating, and making the work ready.
 
 dohc is basically rethinking notion, obsidian, google docs, spreadsheets, jira, and other operations tools and packaging it into an obvious AI-native workspace by having text as the primitive for binding input/output communication methods between the agent and human/s. Hence, at its core dohc is a really powerful tool capable of turning many kinds of work into obvious inspectable systems- similar to what spreadsheets were like when it first came out.
 
 ## Current status
 
-We are currently building the MVP for dohc and haven't launched with users yet.
+We are currently building the MVP for dohc and haven't launched with users yet. We are pivoting dohc to be desktop-first and local-file-first: workspaces are real folders on the user's disk, agents work directly in them, and dohc Cloud is the collaboration engine on top. See `docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md`.
 
 ## Some thoughts from the author (Ice)
 
 The following is a letter from me to you, the agent. We are building this together, but to be frank, I'm building this for you. I want you to be have the proper context about me and/or my team and the text primitives you need to build the proper solutions for me. dohc is the tooling that will power it. We are building a communication layer for humans and AI.
 
 This is meant to be a bold project. Going with the flow and using existing solutions will not get us where we want to be.
 
 Quick gloassary of relevant parties in this document:
 
 - _you_ - the agent reading this document and working on dohc directly.
 - _me_/_we_/_us_ - the humans contributing to dohc. This is the party talking to you as we build
 - _users_ - these are our users. We are assuming they won't need to program or be expert at prompting like someone technical would, rather they will have their own agents to build things using dohc.
 
 Here's some philosophical things to consider as we build and work together:
 
 ### Boil the ocean
 
-This project would have been way too bold beforer agents existed. We effectively have to build an entire AI OS from scratch and rebuild Notion, Text editors, docs, spreadsheets, dashboards, and perhaps even text/markdown itself for it to work as we want long term.
+This project would have been way too bold before agents existed. We effectively have to build an entire AI OS from scratch and rebuild Notion, Text editors, docs, spreadsheets, dashboards, and perhaps even text/markdown itself for it to work as we want long term.
 
 When planning, do not be afraid to suggest seeminlgy insane solutions. For example, creating our own implementation of markdown better suited for AI. Seems insane, but it's absolutely doable with modern tools.
 
 What we're doing here is fundamentally different so treat it that way. Being that you are an agent, you're prediction model will likely want to steer towards conformity. That's okay and even preferred in most scenarios, but there will be times where we need to think outside the box. Literally (since you're in a box) so think outside of it. Transcend. Transcend. Ascend.
 
 ### Let their agents shape the workspace they need
 
 We should avoid feature creep, and assume our users can use their agents to create the specific workspace they need. This may seem to counter "boil the ocean", but it does not. We are not hand-building every possible app. We are building the primitives for a new era of work.
 
 As an example, let's discuss CRM.
 
 Should dohc have first-class documents, entities, links, formulas, permissions, source-backed apps, search, provenance, and agent-safe edits? Absolutely. No user or agent should have to invent the basic substrate that makes work inspectable, durable, and owned.
 
 Should dohc ship a hardcoded CRM for every possible team? Probably not. A user's agent should be able to build a CRM, project tracker, client dashboard, hiring pipeline, or personal operating system out of dohc's primitives.
 
 ### Fight for the obvious workspace
 
 We should avoid being clever and doing things because it feels smart. We want everything we build to be so obvious it feels kind of stupid.
 
 When one of us prompts you, never hesitate to push back and suggest ways we could make things more obvious. Note that "simple" and "obvious" are not always the same. Sometimes the obvious solution is more complex.
 
 "Obvious" solutions are the defaults that agents would assume are the case.
 
 ### Don't be afraid to lie (to agents) if it makes working easier
 
 This might seem counter-intuitive, so hear me out.
 
 Agents need tools and instructions. They don't need accurate implementation details of those tools. They don't need real environments.
 
 Tools like shell access, file systems, source views, diffs, logs, and document primitives should always be top of mind. Agents like working a certain way, and we should provide them with that way to work. If they want file systems, they should get them. If they want source-backed documents, they should get them. The implementation can be a mirage, as long as the agent gets what it expects and we get outputs that work.
 
 Simulate familiar affordances freely, but do not lie about contracts: durability, isolation, security, permissions, persistence, provenance, and production readiness must be explicit.
 
 ### Text is the primitive
 
 At its core, dohc is text-based.
 
 If a user had a folder of well-structured text files on their computer and a capable agent managing those files, they could recreate a surprising amount of what dohc does: documents, notes, plans, dashboards, CRM, project trackers, logs, decisions, and workflows.
 
 dohc exists to make that easy, reliable, and powerful.
 
 We provide the structure, conventions, UI, permissions, sync, organization management, source-backed apps, agent tools, review gates, etc and boilerplate that make a text-based workspace manageable for normal users/teams/orgs and efficient for agents.
 
 The magic is not hidden state. The magic is giving agents and humans a shared text substrate they can both inspect, edit, and trust.
 
 ### dohc and the AI company playbook
 
 dohc exists to make the AI-native company/person possible.
 
 The goal is not to add AI as a feature inside old software. The goal is to make AI the building layer for work itself.
 
 That means every useful artifact should become part of the workspace: documents, chats, meeting notes, decisions, workflows, dashboards, entities, skills, and agent actions. The more work is recorded in an inspectable text-based form, the more capable the user's agents become.
 
 A folder of well-structured text files plus a capable agent can approximate this. dohc makes it practical: it provides the structure, tools, permissions, views, sync, review gates, and agent affordances that make the text workspace reliable for real people and efficient for agents.
 
 ### Individual first
 
 We should focus on doch being magical and obvious for one person first before it is for a team. This might seem counter-intuitive as the benefit of dohc grows as more teammates adopt it, but without one person using it first and finding value in it on its own, then no one will use it and we won't even get to teams using it.
 
 A single user should be able to use dohc for personal life, work, projects, research, planning, finances, health, writing, learning, or anything else they want to organize with an agent.
 
 Teams and companies matter, but they are not the starting point. The starting point is one person with a workspace that understands them, remembers their context, helps them think, and turns messy work into clear, inspectable structure.
 
 If dohc only works after a whole company adopts it, we built the wrong thing.
 
 The product should feel valuable even when the entire "organization" is just one human and their agents.
 
+### Three legs, one moat
+
+Local files, markdown, speed, and a command palette are table stakes. We adopt them from tools like Obsidian, but they are not why dohc exists. If we ship only those, we built a worse Obsidian.
+
+What separates dohc is three legs:
+
+1. **Agents are first-class workers, not plugins.** Anyone can point an agent at a folder. dohc gives agent work *infrastructure*: change sets, provenance, attribution, review gates at real boundaries, workspace-aware tools, and testing that catches fake or broken output. Access is cheap; accountability is the product.
+2. **Work primitives beyond notes.** Real databases, data imports, and source-backed apps that an agent can build and dohc can test. A second brain stores what you know; dohc runs what you do.
+3. **Building together** — git-grade collaboration (next section).
+
+Each leg alone is copyable. The combination forces every competitor to abandon their own architecture: Obsidian can't grow servers and agent infrastructure without betraying what it is; Notion and Google Docs can't hand you local files you own without rebuilding their foundations. We stand in the structural gap between them.
+
+When evaluating any feature, ask which leg it strengthens. If the answer is none, question the feature.
+
+### Git for everyday people
+
+Imagine software engineers without git: no history, no merge, no blame, no working in parallel. Everyone emails final files around. That is how everyday people still build in Obsidian, Google Docs, and Notion — they build alone and share end products.
+
+dohc brings building-collaboration to everyone. Change sets are commits. Provenance is blame. AI-assisted conflict resolution is merge. Shared workspaces are repos. AI is what finally makes this possible for normal people: the agent explains what changed, proposes merges, and summarizes in plain language — the parts of git that were too hard for non-engineers simply dissolve.
+
+The agent era makes this urgent, not just nice. When your agent and my agent both worked in our shared workspace overnight, ad-hoc sync is chaos. "Here is the change set your agent produced; review it" is the killer flow.
+
+Two rules keep this honest:
+
+- The semantics must be useful solo, with no account: history, undo, and agent change review work offline. By the time someone shares a workspace, sharing adds zero new concepts. That funnel is the business: local-first accountless use is the free trust wedge; dohc Cloud is the paid collaboration engine.
+- Emphasis flows into *visibility* — timelines, attribution, catch-up summaries — never into approval ceremonies. Git won because committing is frictionless. Review happens at real boundaries only.
+
+### Fast is a feature
+
+dohc is the antithesis of bloated workspace software. Slowness is a bug, not polish debt.
+
+The bar is native: instant launch, instant typing, instant file trees, instant search. Performance budgets are tests that fail builds, not aspirations in a doc. Every dependency must justify its weight. The renderer renders; heavy work happens elsewhere.
+
+People feel speed before they can name any feature. A workspace tool that hesitates teaches the user to keep their thoughts somewhere else.
+
+### Less code is more product
+
+Deletion is valued work. The fewer lines we deliver, the better.
+
+Reuse before you write. Build the smallest implementation that passes the tests. No speculative abstraction, no options nobody asked for, no wrappers around single call sites. When a replacement lands with tests, the replaced path dies in the same change.
+
+We are a small team building something enormous. The only way that math works is if the codebase stays lean enough that any agent or human can hold a subsystem in their head.
+
 ### Product invariants
 
 Do not weaken authorization, ownership, or review gates for convenience.
 
 - Authorization is derived server-side. Browser/client callers must not be trusted to provide user identity.
 - Every atom, folder, entity, share, and capture is scoped to a workspace.
 - Agent writes must respect user locks, folder/atom access, sharing boundaries, and skill-turn gates.
 - HTML atoms are sandboxed and sanitized.
 - `atoms.body` is becoming a derived markdown cache from the canonical Y.Doc. Do not build new behavior that depends on raw full-body markdown patching as the source of truth.
 
 ### Repeated work should become skills
 
 When a user likes how an agent handled something, dohc should make it easy to turn that process into a reusable skill, workflow, or playbook.
 
 The best version of dohc does not just complete tasks. It helps users and teams compound how they work. Every repeated process is a candidate to become clearer, more inspectable, and easier for agents to run next time.
 
 ### Agents wrap tools, not the other way around
 
 dohc should feel like an agent operating a set of reliable tools, not old software with a little AI sprinkled inside.
 
 Deterministic software should provide the sturdy pieces: permissions, storage, sync, rendering, search, diffs, logs, provenance, and review gates. The agent should use those pieces to build the user's actual workspace around their intent.
 
 ### Open when shared, private when personal
 
 dohc should encourage visibility where work is intentionally shared, because people learn from seeing how agents and teammates work.
 
 But personal workspaces are personal. Transparency must come from explicit workspace boundaries, sharing, provenance, and consent — not accidental leakage.
 
 ## Some general rules
 
 These are meant to steer us in the right direction. They are not hard-set, but we should default to following them. If you think one should be ignored, be very loud and cear about that and get approval from us before doing it.
 
 - Brand identity is final: lowercase `dohc`, the drop-lobe mark, warm
   paper + graphite. There must be no legacy product identity in shipping
   source — `src/__tests__/brandNoLegacy.test.ts` enforces this.
 - When working inside `apps/app`, also read `apps/app/AGENTS.md`. When touching Convex code, read `apps/app/convex/_generated/ai/guidelines.md` before editing.
diff --git a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
new file mode 100644
index 0000000..d0eaec1
--- /dev/null
+++ b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
@@ -0,0 +1,100 @@
+# Desktop Local-First Cloud Sync Execution Log
+
+## Resume Snapshot (overwrite in place — the ONLY mutable section)
+
+- Phase/Step + TDD position: Phase 0 COMPLETE pending commit + codex review; Phase 1 next
+- Expected test state: baseline recorded — all package suites green; @dohc/web 1618/1623 (4 pre-existing main failures, see Gotchas); check:debt green
+- Dirty files and intent: Phase 0 commit staging everything (AGENTS.md, plan, package.json, baseline script, this log, inventory, team audit doc)
+- Exact next action: `git add` Phase 0 files → commit "Inventory old plan for desktop local-first pivot" → launch codex review (high tier, background) → Phase 1 read-only prep (workspace-core test design) while review runs
+- Active background tasks: none at snapshot time
+- Open worktrees: none
+- Pending reviews: Phase 0 codex review launches post-commit
+
+## Environment (append-only)
+
+- Toolchain freeze: tests run under Node v22.13.0 via PATH prefix `/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH`. Shell default is Node v25.2.1 — Node 25 breaks 17 @dohc/web tests (verified 2026-06-10: AtomEditor.lifecycle suite 13/13 fail on 25, 13/13 pass on 22.13). Never run `nvm use`.
+- pnpm 10.24.0 (packageManager pin).
+- Codex: `/home/ice/.local/share/nvm/v25.2.1/bin/codex` (codex-cli 0.130.0, ChatGPT auth). Verified: `exec` read-only sandbox + `-m gpt-5.5 -c model_reasoning_effort="xhigh"` works (2026-06-10, 15.2K tokens). `gpt-5.5-fast` NOT available on this auth. Second install exists at `/mnt/c/Users/ice/.codex/bin/wsl/81645c5d269e0fb2/codex` (0.137.0-alpha.4, found by team audit) — using the verified 0.130.0; revisit only if review subcommand misbehaves.
+- Display: WSL2 + WSLg (DISPLAY=:0, WAYLAND=wayland-0); xvfb-run available as fallback.
+- Docker 29.5.2. Services healthy: dohc-v2-postgres, dohc-v2-minio, dohc-v2-hocuspocus (compose: docker-compose.dev.yml).
+- WSL safety: never pattern-kill node/pnpm/vite/etc.; servers always background tasks; kill only tracked task ids.
+
+### Codex Calls ledger (date | purpose | effort | duration | outcome)
+
+- 2026-06-10 | preflight exec read-only smoke ("OK") | xhigh | ~1min | success
+- 2026-06-10 | preflight gpt-5.5-fast probe | xhigh | ~10s | model rejected on ChatGPT auth (expected)
+- 2026-06-10 | preflight -i image (arg-prompt form) | low | ~5s | FAILED: positional prompt not parsed with -i in detached-stdin context
+- 2026-06-10 | preflight -i image (stdin `-` form) | low | ~1min | success — correctly described dohc avatar; -i capability VERIFIED
+
+## Decision Ledger (append-only)
+
+- D-01 | Better Auth inside workspace-api (Drizzle/pg, organization + deviceAuthorization plugins); WorkOS deferred as enterprise SSO path behind Better Auth | self-host needs vendor-free auth; WorkOS bridge stays open | pre-phase
+- D-02 | Live co-editing (Yjs/Hocuspocus) in scope; hocuspocus convex-acl → postgres-acl | user decision | pre-phase
+- D-03 | Single mega-branch `claude/desktop-local-first-cloud-sync`, green-milestone commits `phaseN(step M):`, no squash | user decision + resumability | pre-phase
+- D-04 | Native orchestration replaces superpowers skill (lanes, judge panels, verifier fan-outs, checkpoint recipe) | skill unavailable; codified in plan | pre-phase
+- D-05 | Codex = independent third-party reviewer with effort tiering, budget ledger, fallback chain; NEVER authors code/tests/designs | independence is the value; panel + team audit | pre-phase
+- D-06 | Node 22.13.0 frozen for tests; codex by absolute path | Node 25 breaks 17 web tests; PATH drift | pre-phase
+- D-07 | CRDT canonical while shared file open, filesystem canonical while closed; 6 named data-loss cases must be tested | team audit + plan amendment | pre-phase
+- D-08 | dual-backend code lives in main at bc62bd2; stale local branch of same name must never be used | recon | pre-phase
+
+## Reference Digests (append-only)
+
+### Dual-backend branch digest (source: 2026-06-09 execution log + readiness review + tech-debt audit; digested 2026-06-10)
+
+- All 9 packages/services mature and tested: workspace-contracts (conformance harness, 8 tests), workspace-postgres (Drizzle schema/migrations/repos/services, 12 tests, dev-ready, zero Convex coupling), workspace-fs (materialize/scan/diff/apply/syncClient/watch — watch is POLLING, 6 tests), workspace-api (HTTP handler + ResolveActor at src/auth/session.ts, 1 test, no production listener), agent-sandbox (allowlist shell, diff capture, 2+4 tests), sqlite-worker (11 tests; needs node:sqlite ⇒ Node 22.13+), app-tester (25 tests, backend matrix), hocuspocus (78 tests, Convex-coupled ACL), workspace-convex-compat (conformance-only consumer: workspace-contracts tests).
+- Final sweep: 1619 web tests passed under Node 22.13. Postgres pkg tests need `--no-file-parallelism` (shared DB fixture).
+- Production gates NOT done (this plan's work): hosted auth, live Yjs over Postgres, migration, deployment, observability.
+- Known debt w/ deletion conditions: .views compat (until indexed discovery + regression tests), confirmTier/views/entities mode comments, dual-backend switch (until Postgres default), convex-compat (until Convex off production).
+- Gotchas: pnpm install required after adding new packages (symlinks); MinIO image pinned; sync apply sequential (no idempotency keys yet); approval surfacing partial (errors not cards); upsertAtomImpl adds frontmatter — corrupts non-markdown bodies (use deriveSearchFields for text files); sandbox guards are arg-level, not namespace isolation.
+
+### Convex usage map digest (source: apps/app/convex + repo grep; digested 2026-06-10)
+
+- Auth: WorkOS AuthKit via `@convex-dev/workos-authkit`; client bridge apps/app/src/lib/use-auth-bridge.ts + ConvexProviderWithAuth in routes/__root.tsx; server auth.config.ts (WorkOS RS256 issuer, env WORKOS_CLIENT_ID); actor = ctx.auth.getUserIdentity() {subject, email, name, tokenIdentifier}; requireWorkspace(ctx, activeWorkspaceId) checks memberships.
+- Convex function surface: ~40 modules — auth, schema (atoms/atomShares/atomLocks/memberships/orgs/workspaceAssets/databaseFiles/...), agent.ts (@convex-dev/agent tools), hocuspocusAuth.ts (ACL queries: checkAtomAccess/loadAtomBootstrap/setBodyCache/createAtom), atoms/atomAccess/atomShares, assets (storage upload URLs), databaseFiles/databaseOps, apps/appAgent/appTesting/appTrust, views/windows, trash, captures, crons (purges), search.
+- Non-convex importers: apps/app/src/lib/convex-client.ts, use-auth-bridge.ts, routes/__root.tsx, components/Chat.tsx (+chat-optimistic), routes/r/$atomId.tsx (share SSR); services/hocuspocus/src/convex-acl.ts + server.ts (env HOCUSPOCUS_CONVEX_URL + HOCUSPOCUS_CONVEX_SERVER_TOKEN); packages/workspace-convex-compat/testAdapter.ts.
+- convex-acl.ts exports createConvexAcl(): getWorkspaceAuthzVersion/canReadAtom/canWriteAtom/loadAtomBootstrap/setAtomBodyCache/createAtom — Postgres port must replicate these against workspace-postgres grants + Better Auth sessions.
+- Env to delete in P13: CONVEX_DEPLOYMENT, VITE_CONVEX_URL, VITE_CONVEX_SITE_URL, WORKOS_*, HOCUSPOCUS_CONVEX_*; scripts: dev-sync.mjs convex parts, reset:dev.
+- Convex guidelines key porting rules: server-derived identity only (never trust client identity args); index-based queries (no .filter); storage = Blob + signed URLs; crons via crons.interval/cron; validators on every function.
+
+### Port-source file paths (verified present 2026-06-10)
+
+- File-type views: apps/app/src/components/FileTypeView.tsx; Database Studio: DatabaseStudio.tsx, DatabaseTableGrid.tsx; tree: FileTree.tsx; upload: UploadFileButton.tsx; agent activity: AgentActivityTimeline.tsx, AgentRunRail.tsx (+ AgentChatSidebar.tsx).
+
+## Gotchas (append-only)
+
+- Node 25 breaks 17 @dohc/web tests; pin 22.13.0 via PATH (see Environment).
+- workspace-postgres tests: shared local DB fixture, not file-parallel.
+- pnpm 10 ignores postinstall — Electron needs onlyBuiltDependencies in pnpm-workspace.yaml BEFORE install (Phase 2).
+- Root playwright.config.ts is web-only (testDir apps/app/e2e + webServer); desktop gets own config.
+- check:debt bans the literal deferred-work marker tokens it scans for, in any file including docs — never write them, even when describing the rule itself (this line was rewritten once for exactly that reason).
+- Package named @dohc/web already, but lives at apps/app (Phase 12 renames path).
+- ECONNREFUSED from :5432/:9000/:1234 = environment failure, never a test failure.
+- codex exec with `-i`: pass the prompt via stdin pipe + `-` arg (`echo "prompt" | codex exec -i img.png -`); positional prompt is silently dropped when stdin is detached.
+- Pre-existing failures on main @ e2de7a3 (fail under BOTH Node 22.13 and 25; broke between dual-backend sweep and merge): apps/app/convex/agentSandboxIntegration.test.ts ("teaches the model when to use shell" — AGENT_SRC prompt strings), src/__tests__/agentApprovalResume.test.tsx ("returns explicit scoped approval decisions"), src/__tests__/searchWriteAudit.test.ts ("no atom-inserting convex file outside the known set"), src/__tests__/uploadFiles.test.tsx ("exposes an upload button in the file sidebar area"). 4 tests / 1618 passed. NOT fixed in Phase 0 — these are main's bugs; several die with Convex in Phase 13 anyway.
+
+## Phase Logs
+
+### Phase 0: Baseline, Tooling, And Old-Plan Inventory
+
+- Status: in progress
+- Execution map: env preflight (done: services healthy, node/codex/display recorded) → execution log (this file) → baseline script Node-pinned → baseline background run → inventory doc from recon digests → commit → codex review (high tier, background)
+- Resume notes: baseline launching; inventory doc next; commit after baseline result recorded.
+- Files changed: AGENTS.md (product philosophy: three legs, git-for-everyday-people, fast-is-a-feature, less-code; pivot note), plan (all pre-execution amendments), package.json (+check:desktop-local-first-baseline), scripts/check-desktop-local-first-baseline.mjs (new, Node-pinned), this log (new), inventory doc (new), team audit doc (committed as-is)
+- Code deleted or consolidated: none (docs/tooling phase)
+- Net LOC delta (`git diff --shortstat`): recorded at commit
+- Old paths retained and why: all — inventory classifies, later phases delete
+- Dependencies added (name, size, justification): none
+- Decisions made (D-NN ids): D-01..D-08 (pre-execution, recorded above)
+- Tests added: none (baseline phase)
+- Commands run: docker compose ps (healthy); node path checks; component path verification; `pnpm check:desktop-local-first-baseline` (Node-pinned, background) — @dohc/web typecheck PASS, web tests 1618/1623 PASS (4 pre-existing, recorded in Gotchas); continue-on-error sweep of remaining suites — workspace-contracts 10/10, workspace-postgres 14/14, workspace-fs 8/8, workspace-api 3/3, app-tester 25/25, sqlite-worker 11/11, agent-sandbox 3/3, check:debt PASS (after rewording two self-tripping doc lines), web typecheck PASS
+- Failing tests fixed: n/a — 4 web failures are pre-existing on main @ e2de7a3, recorded not fixed (several die with Convex in Phase 13)
+- Electron E2E/manual smoke: n/a (no desktop app yet)
+- UI/UX screenshot/design review: n/a
+- Performance measurements: n/a
+- Security/collaboration regressions: n/a
+- Reviewer/subagent findings: recon digests above; 4-lens plan panel + Codex-utilization panel + 2 team audits all folded into plan pre-execution
+- Codex third-party review findings: pending (post-commit)
+- Relevant findings fixed: all plan-level findings fixed pre-execution
+- Deferred findings with reason: none
+- Remaining risk: baseline may surface pre-existing failures beyond the known Node issue — will be recorded verbatim, not fixed here
+- Next phase: 1
diff --git a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md
index e079140..b883a73 100644
--- a/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md
+++ b/docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md
@@ -1,1692 +1,2085 @@
 # dohc Desktop Local-First Cloud Sync Implementation Plan
 
-> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
+> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. If those skills are unavailable, use native orchestration instead: a lead agent implements phases sequentially, fans out parallel subagent review workflows at every major checkpoint (security, UX/screenshot, performance, deletion-safety), runs long test suites in the background, and self-paces with scheduled wakeups so execution continues unattended. Steps use checkbox (`- [ ]`) syntax for tracking.
 
 **Goal:** Pivot dohc from a web-first Convex workspace into an Electron-first, local-file-first workspace that syncs to dohc Cloud or self-hosted Postgres, lets local Codex/Claude Code work directly on files, and preserves dohc's collaboration, apps, SQLite, provenance, and agent-testing strengths.
 
+**Product thesis:** Files are local and owned, but they are not *just* local files — they are building blocks people share and build on together. dohc brings git-grade building-collaboration (change sets, history, attribution, review at real boundaries, AI-assisted merge) to everyday people, the way git brought it to engineers. Local-first accountless use is the free trust wedge; dohc Cloud is the paid collaboration engine. Without the collaboration layer, dohc is arguably an Obsidian clone — with it, it is a new category. Collaboration surfaces are first-class product, never sync plumbing.
+
+What separates dohc from Obsidian-class tools is three legs, and the combination is the moat: (1) agents are first-class workers with infrastructure — change sets, provenance, attribution, review gates, MCP tools, tested apps — not bolted-on plugins with folder access; (2) work primitives beyond notes — real SQLite databases, data imports, and source-backed apps a user's agent can build and dohc can test; (3) git-grade collaboration. Local files, markdown, speed, and a command palette are table stakes adopted from Obsidian, not differentiation — every phase should protect all three legs, and users' agents (not a plugin marketplace) are dohc's ecosystem.
+
 **Architecture:** Workspaces are real folders on disk. The desktop app is the primary product surface and runs a local dohc core that watches folders, batches changes, maintains `.dohc/` metadata, serves the React renderer, exposes MCP/tools to local agents, and syncs with dohc Cloud/self-hosted Postgres when enabled. The existing dual-backend branch is treated as a completed prototype: keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, and AppTester pieces; delete Convex and web-first compatibility paths once equivalent local-first tests prove the replacement.
 
-**Tech Stack:** Electron, React/TanStack Start renderer, TypeScript, Vite/electron-vite or equivalent Electron Vite build tooling, Playwright Electron automation, Vitest, Postgres, Drizzle ORM, Hocuspocus/Yjs where collaborative text needs CRDTs, local filesystem storage, S3-compatible object storage for cloud/self-host, SQLite worker/AppTester services, MCP server for Codex/Claude integration, Docker Compose for self-host/dev.
+**Tech Stack:** Electron, React/TanStack Start renderer, TypeScript, Vite/electron-vite or equivalent Electron Vite build tooling, Playwright Electron automation, Vitest, Postgres, Drizzle ORM, Better Auth (inside workspace-api, Drizzle adapter on the same Postgres) for cloud/self-host authentication, Hocuspocus/Yjs for live collaborative text in shared workspaces, local filesystem storage, S3-compatible object storage for cloud/self-host, SQLite worker/AppTester services, MCP server for Codex/Claude integration, Docker Compose for self-host/dev.
 
 ---
 
 ## Research Basis
 
 Use these references while implementing:
 
 - Electron security checklist and context isolation: `https://www.electronjs.org/docs/latest/tutorial/security`
 - Electron context isolation: `https://www.electronjs.org/docs/latest/tutorial/context-isolation`
 - Electron sandboxing: `https://www.electronjs.org/docs/latest/tutorial/sandbox`
 - Electron fuses: `https://www.electronjs.org/docs/tutorial/fuses`
 - Electron IPC: `https://www.electronjs.org/docs/latest/tutorial/ipc`
 - Playwright Electron automation: `https://playwright.dev/docs/api/class-electron`
 - electron-vite guide and CLI: `https://electron-vite.org/guide/`, `https://electron-vite.org/guide/cli`
 - Electron Forge Vite plugin if the implementer chooses Forge instead of electron-vite: `https://www.electronforge.io/config/plugins/vite`
 - electron-builder signing and updates: `https://www.electron.build/docs/features/code-signing/`, `https://www.electron.build/docs/features/auto-update/`
 - Chromium performance APIs for renderer marks/measures: `https://developer.mozilla.org/docs/Web/API/Performance`
 - React profiler for targeted render-cost investigation: `https://react.dev/reference/react/Profiler`
 - Local reference implementation: `/home/ice/dev/oss-repos/t3code/apps/desktop`
+- Better Auth docs (Drizzle adapter, organization plugin, device authorization, SSO): `https://www.better-auth.com/docs`
+- Hocuspocus server/provider docs: `https://tiptap.dev/docs/hocuspocus`
+- Yjs docs: `https://docs.yjs.dev`
 
 Important lessons from the references:
 
 - Keep `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.
 - Expose only narrow, validated preload APIs through `contextBridge`.
 - Treat IPC as an untrusted boundary; validate every payload and sender.
 - Use Playwright's Electron launcher to drive real desktop E2E tests.
 - For packaging, signed/notarized builds and update metadata matter; unsigned dev builds are fine, unsigned release builds are not.
 - `electron-vite` is a good fit for a Vite/React codebase, but Electron Forge + Vite is acceptable if it better fits repo conventions.
 - t3code's desktop package is a useful pattern: explicit desktop package, main/preload separation, desktop bridge contract, desktop auth/bootstrap, update tests, smoke tests, and release artifact scripts.
 - Desktop performance must be measured inside the real Electron app, not inferred from unit tests.
 - Native-feeling performance requires startup, first paint, file-tree rendering, search, sync, app open, and database operations to have explicit budgets.
 
 ## Strategic Decisions Already Made
 
 - Cut Convex in the new architecture.
 - Use Postgres for dohc Cloud and self-hosted sync/collaboration.
+- Use Better Auth (running inside workspace-api on the Drizzle/Postgres stack) for dohc Cloud and self-host authentication: email/password plus the device authorization flow for desktop login and the organization plugin for teams. Self-hosters get working auth with no external vendor account. WorkOS is deferred as an optional enterprise SSO/SCIM provider plugged in behind Better Auth when a business customer requires it.
+- Live real-time co-editing (Yjs/Hocuspocus) for markdown/text in shared workspaces is in scope for this plan. Raw SQLite bytes and binary assets are still never CRDT-synced. Hocuspocus ACL must be ported off Convex to Postgres.
+- Collaboration is the business model: local-first accountless use is the free wedge; dohc Cloud monetizes shared building — team workspaces, sync, live co-editing, change-set history, attribution, and AI-assisted merge. The history/attribution/catch-up surfaces are user-facing product, required even in local-only mode so sharing adds zero new concepts.
 - Build Electron desktop first.
 - Keep web, but make it secondary: cloud access, shared links, mobile-friendly access, and users without desktop.
 - Local-only use works with no account.
 - dohc Cloud login is required only for cloud sync, hosted agents, sharing, backups, teams, and multi-device cloud features.
 - Personal workspaces default to local-first.
 - Shared/team workspaces default to cloud-first with an always-available local working copy.
 - Cloud-only workspaces remain optional for web/mobile/shared-link use.
 - Sync is automatic but settled/batched, not immediate per filesystem event.
 - dohc builds its own AI-native sync/history/change-set model instead of using Git as the default.
 - Git integration may be added later as optional export/mirror/integration.
 - Apps are visible source folders under `.apps/<name>/`, with internal build/cache.
 - User-meaningful SQLite databases can be visible `.sqlite` files; hidden managed databases are allowed only for internal cache/app internals.
 - Collaboration is liberal by default: if the user has edit access, they and their agent can edit. Interrupt only on real boundary crossings.
 - Federation between dohc Cloud and separate self-hosted instances is deferred.
 - License choice is deferred, but the architecture must be open-source/self-host ready.
 
 ## What The Completed Old Plan Gives Us
 
 The completed `2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md` branch provides useful substrate:
 
 - `packages/workspace-contracts`
 - `packages/workspace-postgres`
 - `packages/workspace-fs`
 - `services/workspace-api`
 - `services/agent-sandbox`
 - uploads and file-type views
 - AppTester and app quality gates
 - app/SQLite runtime and operation-log ideas
 - agent output/activity separation
 - backend matrix patterns
 - tech debt/deletion audit patterns
 
 This plan should port, promote, or reuse those pieces where they fit.
 
 This plan should delete:
 
 - Convex backend support.
 - `packages/workspace-convex-compat`.
 - dual-backend switching that exists only to compare Convex and Postgres.
 - web-first atom/tool paths that duplicate local-file-first behavior.
 - `.views` product-language paths once `.apps` compatibility/migration tests prove safe deletion.
 - stale onboarding and agent prompt fragments that assume dohc is a cloud notes app.
 
 ## Non-Negotiables
 
 - Do not weaken authorization, ownership, sharing boundaries, locks, review gates, app trust, provenance, or workspace scoping.
 - Do not make local sync an unmanaged overwrite path.
 - Do not turn shared/team collaboration into a restrictive permission maze. If a user has edit access, normal edits sync automatically.
 - Boundary crossings still need guardrails: public publishing, external sharing, permission changes, bulk deletes, app trust/install, private-to-shared moves, and unmergeable overwrites.
 - Renderer code must never get raw Node/Electron access.
 - Preload APIs must be narrow and validated.
 - Desktop shell/MCP capabilities must be powerful but workspace-scoped by default.
 - Local-only personal workspace edits should not require approval.
 - Shared/team normal edits should not require approval if the user has edit access.
 - Do not CRDT-sync raw SQLite bytes.
 - Do not store generated binary assets as markdown text.
 - User-meaningful work must remain inspectable as files, assets, apps, or databases.
 - Reduce tech debt while implementing. Delete obsolete code when tests prove it is safe.
 - Performance is a product invariant. The desktop app must feel native and fast; do not accept slow startup, janky typing, sluggish file trees, expensive sync loops, or slow agent/app/database flows as "good enough."
 
+## UI/UX Direction
+
+dohc Desktop should preserve the current dohc feel: simple, clean, muted, warm, and work-focused. The evolution should make it feel more native and capable, not louder.
+
+Take inspiration from:
+
+- Obsidian: local files, calm sidebar, fast command palette, keyboard-first navigation, no heavy chrome.
+- Codex/Claude Code: agent work feels active, inspectable, and powerful without decorative UI.
+- t3code: desktop-first shell, local agent/runtime affordances, useful status surfaces, app-like polish.
+- Linear/Raycast-level restraint: dense but readable controls, crisp typography, responsive interactions.
+
+Do:
+
+- keep warm paper + graphite as the product base.
+- keep spacing compact and calm.
+- make the file tree, command palette, editor, app runtime, sync status, and agent activity feel like native desktop surfaces.
+- use subtle dividers, hover states, and active states.
+- prefer icons plus short labels for commands.
+- preserve keyboard shortcuts and quick switching.
+- make local/cloud/sync state obvious without banners everywhere.
+- make first launch immediately usable: create/open a workspace, not a marketing page.
+- use screenshots and E2E checks to verify layout, text fit, and nonblank rendering.
+
+Do not:
+
+- add marketing-style hero sections to the desktop app.
+- add gradient/orb decoration.
+- make card-heavy dashboards for core workspace UI.
+- make one-note purple/blue/dark-slate palettes.
+- hide real files behind abstract product terms.
+- ship a web page inside Electron without desktop affordances.
+- make agent progress one giant paragraph.
+- let text overflow, wrap badly, or occlude controls.
+
+UI quality bar:
+
+- default desktop shell should feel boring in the best way: obvious, fast, and trustworthy.
+- every primary screen should be usable at 1280x800 and 1536x960.
+- empty states should offer the next real action, not explain the product.
+- file/app/database/media views should feel like different file types, not markdown with costumes.
+- sync/conflict/agent activity should be inspectable but not noisy.
+
+Native app feel requirements (what separates a legit desktop app from a website in a frame):
+
+- custom titlebar integrated with the shell: draggable regions, platform-correct window controls, no default browser chrome.
+- window state persists across launches: size, position, maximized state, last workspace.
+- real menus: application menu and right-click context menus on files, folders, tabs, and editor selections — not web dropdowns pretending.
+- keyboard-first everywhere: every primary action reachable without the mouse; platform-correct modifiers; visible focus states for keyboard users only.
+- no web artifacts: no text-selection cursor on chrome, no image/link dragging, no pull-to-refresh or rubber-band on static surfaces, no FOUC or white flash on launch (background color set before first paint), no browser zoom on ctrl+scroll unless intentional.
+- typography tuned for UI density: UI font stack for chrome, content font for documents; crisp rendering; no document-scale headings inside tool surfaces.
+- one spacing grid (4px base) and one restrained token set: current dohc warm paper + graphite, one accent, subtle radii, shadows only for true elevation (menus, palette, dialogs).
+- system theme (light/dark) followed without flashing or interrupting running work.
+- resize behaves natively: panels reflow without jank, sidebar widths persist, no layout shift on font load.
+- interactions acknowledge instantly: hover/active states under 50ms, skeletons only where real latency exists.
+
+### Design Review Loop (required for every UI phase)
+
+Phases 3, 6, 7 (app runtime UI), 9 (login UI), 10 (collab/conflict UI), 11 (settings/agent UI), and 18 must run this loop before their phase commit:
+
+1. Before first implementation in Phase 3: recon the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`) and record which layout, titlebar, panel, and status-surface patterns to adopt or reject.
+2. Capture screenshots of every new/changed surface at 1280x800 and 1536x960, light and dark, via the Playwright Electron tests.
+3. Run a dedicated design-review subagent over the screenshots with this rubric, each item scored pass/fail:
+   - looks like a native desktop app, not a web page in Electron.
+   - clean, professional, calm: would not look out of place next to Obsidian, Linear, or Raycast.
+   - consistent with dohc's warm paper + graphite identity; no palette drift.
+   - spacing, alignment, and type hierarchy are deliberate; nothing cramped, floating, or misaligned.
+   - no text overflow, truncation surprises, or occluded controls.
+   - empty/loading/error states designed, not defaulted.
+   - no marketing chrome, gradients/orbs, or card-heavy dashboard syndrome.
+4. Fix every fail and re-run the loop. Maximum 3 iterations per UI phase. Hard items (text overflow, occluded controls, blank render, marketing chrome, palette drift from tokens) block the phase unconditionally. Soft aesthetic items still failing after 3 iterations become explicit deferred findings with screenshots in the execution log, re-judged at the Phase 18 readiness review.
+5. A UI phase is not complete while any hard rubric item fails.
+6. Screenshot convention (established by the Phase 2 launch E2E): tests write to `test-results/screenshots/phase-<NN>/<surface>--<width>x<height>--<light|dark>.png`. The design-review brief is fixed: "Review every PNG under `test-results/screenshots/phase-<NN>/` against the rubric; output per-file, per-item pass/fail with the failing region described." Include 2-3 reference screenshots from earlier passing phases to anchor consistency across fresh-context judges.
+
 ## Performance Budgets
 
 These budgets are initial targets for the implementation. If a target is impossible in CI due to hardware/display limitations, the agent must record the local measured number, explain the environment, and keep a tighter relative regression budget.
 
 Desktop UX budgets:
 
 - cold desktop launch to first visible shell: under 2.0s on the local dev machine.
 - warm launch to first visible shell: under 1.0s.
 - first local workspace creation: under 1.0s for an empty workspace.
 - open existing workspace with 1,000 files: under 1.5s to interactive file tree.
 - file tree filter/search over 10,000 paths: under 100ms for the query operation and under 200ms to visible result.
 - open markdown file under 250KB: under 150ms after click.
 - typing latency in markdown editor: no sustained frame over 16ms during normal typing; no long task over 50ms.
 - file watcher settle and detect single markdown save: under 2.0s.
 - batch 100 changed files into one change set: under 3.0s without blocking the renderer.
 - open `.apps/<name>` runtime after build cache warm: under 1.0s.
 - run AppTester static+browser smoke for a small app: under 15s in CI/dev.
 - open SQLite table with 10,000 rows: under 1.0s to first page.
 - import 10,000-row CSV to SQLite: under 5.0s in local dev.
 
 Resource budgets:
 
-- renderer idle CPU should return near idle after sync/app/test operations finish.
+- renderer idle CPU should return near idle (~0%) after sync/app/test operations finish.
 - no unbounded polling loops.
 - large file indexing must be incremental or worker-backed.
 - sync, import, AppTester, and SQLite work must not block the Electron renderer.
-- desktop memory after opening a 1,000-file workspace should be measured and recorded; regressions over 20% require investigation.
+- desktop memory after opening a 1,000-file workspace: initial target under 400MB working set, measured and recorded; regressions over 20% require investigation.
+- initial renderer JS loaded before first shell paint: initial target under 3MB; the build must print bundle size, and unexplained growth over 10% between phases fails the performance check.
+- no memory growth across repeated workspace open/close cycles (leak check).
+
+Performance engineering rules (anti-bloat):
+
+dohc Desktop is the antithesis of Notion-class bloated Electron apps. Slowness is a bug, not polish debt. These rules apply to every phase, not just Phase 16:
+
+- dependency discipline: every new dependency is justified in the execution log — what it does, its size and transitive cost, and the alternative considered. Prefer the platform/stdlib. No kitchen-sink UI kits.
+- first-paint discipline: only code needed to paint the shell loads at startup. Everything else is lazy-loaded or deferred to idle. No blocking IPC round trips before first paint. Window background color is set before first paint (no white flash).
+- the renderer renders; it does not compute: parsing, scanning, hashing, indexing, imports, SQLite, and app builds run in main-process services or workers. A renderer long task over 50ms on a hot path is a bug.
+- virtualize every unbounded surface: file tree, tables, search results, history, agent activity.
+- IPC is batched and coalesced: no per-keystroke or per-file-event round trips.
+- animations use transform/opacity only; nothing that forces layout on a hot path.
+- React hot paths are profiled: no full-tree re-renders on keystroke, file event, or sync tick.
+- measure first, optimize second: every optimization records before/after numbers in the execution log.
+
+Continuous enforcement (do not defer performance to Phase 16):
+
+- Phase 2 ships the minimal measurement harness with the scaffold: launch/first-paint marks and a measurements JSON written by the Playwright Electron tests.
+- Every subsequent phase that adds a measurable surface (file tree, editor, sync, apps, SQLite, imports, agents) adds its marks and measurements in that phase and records the numbers in the execution log.
+- Phase 16 formalizes budgets into the hard `check:performance` gate and ratchets existing measurements — it must not be the first time a number is seen.
+- A phase that makes a previously recorded measurement materially worse must fix it in that phase, not defer it.
 
 Every phase touching UI, filesystem watching, sync, database import, app runtime, or agent tooling must add or update a performance check.
 
+## Code Size And Deletion Rules
+
+The fewer lines delivered, the better. This pivot must shrink the codebase, not grow a second product beside the old one. Code deletion is highly valued work.
+
+- Deletion is part of every phase's definition of done, not a Phase 17 sweep. When a replacement lands with passing tests, the replaced path dies in the same phase. Phase 17 is the final audit, not where deletion starts.
+- Reuse before write: before creating any new helper, module, or component, search for an existing one to promote or extend — the dual-backend substrate and current app are large. Duplication discovered later is a phase bug, not acceptable drift.
+- Smallest implementation that passes the tests: no speculative abstraction, no config options nobody asked for, no wrapper layers around single call sites, no manager/factory/registry indirection without at least two real consumers today.
+- Track net LOC per phase: record `git diff --shortstat` for every phase commit in the execution log. Product-surface phases may be net-positive; integration, repositioning, and deletion phases (12, 13, 17) must be strongly net-negative. Unexplained growth is a review finding to fix.
+- Track branch-total LOC versus main at every major checkpoint. Deleting Convex, the compat package, dual-backend switching, and web-first duplicates should offset much of the new desktop/sync/auth code; record the honest number and justify the trend.
+- Codex per-phase reviews must be prompted to flag over-engineering, orphaned/unreachable code, and simplification opportunities — not just bugs.
+- Never record deferred work as code comments — the debt gate (`check:debt`) fails on the literal deferred-work marker tokens it scans for, and the failure surfaces phases later, far from its cause. Deferred work goes in the execution log's deferred-findings list with a completion condition. Adding entries to the check-tech-debt or knip allowlists for code this branch authored is forbidden; allowlists are for pre-existing/historical paths only, and every addition must be named in that phase's Codex review prompt.
+
 ## AI Agent Execution Contract
 
 The implementing agent should assume the user is AFK and keep going until completion or a real blocker.
 
-### Required Read Order
+### Required Read Order (Tiered For Finite Context)
 
-Before editing code, read:
+The lead reads inline, once per fresh context:
 
-1. `AGENTS.md`
-2. `apps/app/AGENTS.md` if touching current app code
-3. `apps/app/convex/_generated/ai/guidelines.md` before deleting or porting Convex code
-4. `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md`
-5. `docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md`
-6. `docs/superpowers/reviews/2026-06-09-dual-backend-tech-debt-audit.md`
-7. this plan from top to bottom
+1. `AGENTS.md` (auto-injected) and `apps/app/AGENTS.md` (short)
+2. `docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md` and `...-tech-debt-audit.md` (short)
+3. This plan's front matter (top through "Planned Repository Shape") and ONLY the current phase's section
+
+The lead delegates to read-only digest subagents (Phase 0, digests stored in the execution log's Reference Digests section, ≤25 lines each):
+
+- `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md` (95KB)
+- `apps/app/convex/_generated/ai/guidelines.md` (20KB) — required before deleting or porting Convex code
+- the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`)
+- external reference URLs (Electron security/fuses, Better Auth, Hocuspocus, Yjs)
+
+Resumed contexts read digests, never sources; go to a source only when the digest is demonstrably insufficient for the immediate task, and update the digest afterward. The lead never WebFetches or bulk-reads reference material inline.
+
+Governance exception (hard rule): digests may summarize historical plans, reviews, and reference repos. They may NOT replace direct reading of active governance files before editing code under those rules — `AGENTS.md`, `apps/app/AGENTS.md`, and `apps/app/convex/_generated/ai/guidelines.md` (before any Convex edit/port/deletion) are read directly by whoever edits the governed code, lead or lane.
 
 ### Continuous TDD Loop
 
 For every phase:
 
 1. inspect existing implementation.
 2. write the smallest execution map into this plan's execution log.
 3. write or update failing tests first.
 4. run the tests and record the failure.
 5. implement the smallest production change.
 6. run targeted tests and record the pass.
 7. run relevant regression/security/collaboration/Electron E2E tests.
 8. perform a delete-or-justify pass.
 9. inspect `git diff --stat` and security-sensitive diffs.
 10. run a user-level smoke for the phase where applicable.
 11. update the execution log.
 12. commit the phase.
+13. run independent third-party review of the phase commit (`codex exec review -m gpt-5.5 --commit <phase-sha>` at the effort tier specified in the Codex third-party review section: xhigh for high-risk phases 2, 4, 5, 9, 10, 11, 13, 16, 17, 18; high for low-risk phases 0, 1, 12, 14, 15); record findings in the execution log; fix or explicitly reject every finding; land fixes as follow-up commits.
 
 If a named test/helper does not exist, create it.
 
 Do not stop because:
 
 - the work is long.
 - the context is large.
 - tests are slow.
 - implementation is hard.
 - code deletion is uncomfortable.
 - the current slice is "mostly working."
 
 ### Per-Phase Self-Review Loop
 
 After every phase, the agent must answer in the execution log:
 
 - What user-visible flow works now?
 - What did I test at unit/integration/E2E level?
 - What did I delete or consolidate?
 - What old code did I keep and why?
+- Could this phase have shipped with less code? What did I deliberately not build?
 - What could still regress?
 - Which command proves this phase is safe?
 
 If any answer is weak, fix before moving on.
 
+### Orchestration, Loops, And Third-Party Review
+
+Execution uses native multi-agent orchestration. This is required, not optional:
+
+- A lead agent implements phases sequentially (phases are dependency-ordered) and owns the execution log and all commits.
+- Recon fan-out: before heavy phases (0, 5, 9, 10, 16), the lead fans out parallel read-only subagents to digest prior art, reference repos, and current docs instead of reading everything inline.
+- Design judge panels: before implementing the sync protocol (Phase 9) and the conflict/co-editing model (Phase 10), generate at least 3 independent designs and score them with parallel judges against concrete failure scenarios: concurrent edit, offline rename, half-written file, watcher storm, clock skew, partial upload, reconnect-after-divergence. Each candidate is a doc with fixed sections: data model, message/protocol flow, behavior under each named failure scenario, estimated LOC and new dependencies, what it deletes. Judges receive identical briefs (candidate docs + Non-Negotiables + sync payload list + settle windows + perf budgets) and output a scored matrix (scenario × design, 0-2) plus a one-paragraph verdict. The winning design goes to `docs/architecture/` (losing designs and fatal flaws included); the Decision Ledger gets a one-line entry.
+- Per-phase verification workflow: after the lead believes a phase is complete, fan out parallel verifier subagents before the phase commit: claimed-vs-actual completion check, test-quality check (do the tests actually fail without the implementation?), and UI screenshot review for UI phases.
+- Checkpoint review workflows: at each major checkpoint below, run a multi-agent adversarial review with distinct lenses (security, collaboration/authz, performance, deletion-safety, data-loss) where each finding is independently verified before being accepted as real.
+- Loops: the lead self-paces with scheduled wakeups and keeps executing while the user is AFK. Long test suites, builds, and dev servers run in the background; the lead never blocks the session foreground on a slow suite.
+
+Codex third-party review (required):
+
+- Tool: `codex exec review` (Codex CLI, verified installed and authenticated in this environment).
+- Model: always pass `-m gpt-5.5` (verified working on this account; `gpt-5.5-fast` is not available under ChatGPT-account auth and adds output speed, not review depth). Do not modify the user's global `~/.codex/config.toml`.
+- Effort tiering: checkpoint `--base main` reviews, per-phase reviews for security/sync/data-loss/deletion phases (2, 4, 5, 9, 10, 11, 13), design red-teams, the Phase 13 pre-deletion audit, and recovery consults run at `model_reasoning_effort="xhigh"`. Per-phase reviews for low-risk phases (0, 1, 12, 14, 15), adversarial scenario consults, and screenshot judging run at `"high"`. Remaining phases default to xhigh.
+- For Phases 5, 8, and 10, the review prompt must additionally ask: "name any silent-data-loss scenario the tests do not cover" — scenario-completeness is a different question than code correctness.
+- After every phase commit: run `codex exec review -m gpt-5.5 --commit <phase-sha>` at the phase's effort tier (see Effort tiering below) with a short prompt naming the phase's risk areas and explicitly asking for over-engineering, dead-code, and simplification findings alongside bugs. Record findings in the execution log.
+- At every major checkpoint: run `codex exec review -m gpt-5.5 -c model_reasoning_effort="xhigh" --base main` (checkpoints are always xhigh) over the cumulative branch diff with targeted questions for that checkpoint's risk area (e.g., IPC validation at Phase 4, merge/data-loss at Phase 10, deletion completeness at Phase 13).
+- Accountability: every Codex finding is either fixed (with a test where applicable) or explicitly rejected with reasoning in the execution log. Fixes land as follow-up commits in the same phase; do not amend or squash.
+- Codex runs read-only as a reviewer; it must not edit the repo. The lead implements fixes.
+- Pipelining: Codex reviews ALWAYS run as background tasks with stdout redirected to `docs/superpowers/reviews/codex/phase-NN.md`, launched immediately after the phase commit. While a review runs, the lead performs only read-only next-phase work (recon fan-outs, execution-map drafting, failing-test design — no commits, no shared-file mutation). A triage subagent reads the output file, dedupes, verifies each finding against actual code, and returns ≤15 numbered one-line actionable findings; the lead reads the raw transcript only when a triaged finding is ambiguous. Findings are triaged before the next phase's first commit.
+- Re-review cap: follow-up fix commits get at most ONE targeted re-review per phase; residue rolls into the next checkpoint's cumulative `--base main` review.
+- Invoke codex by the absolute path recorded in the execution log Environment section (PATH drift in fresh shells must not break the gate). If codex is temporarily unavailable, mark the phase "codex review pending," continue, and retry via self-paced wakeups (~10/30/60 min, max 3); a pending review is never silently dropped — the acceptance criteria remain the backstop.
+- The gate is "independent third-party review," not one vendor binary. Phase 0 preflight verifies `codex` + `gpt-5.5` availability and records the result. If the exact tool/model is unavailable to the runner (different machine, CI, auth limits), the gate is satisfied by the first available fallback, recorded per phase in the execution log: (1) another available Codex model at the highest reasoning effort, (2) CodeRabbit review, (3) an independent adversarial verifier-subagent panel using the Checkpoint Review Recipe plus manual reviewer signoff. A runner without the preferred tool can therefore still complete every phase and the acceptance criteria.
+
+Codex hard rules (independence and budget):
+
+- Independence rule: Codex never reviews an artifact Codex authored or materially shaped. Codex authors no code, no tests, and no candidate designs in this repo — its only write target is its own transcript under `docs/superpowers/reviews/codex/`. Codex is never assigned an implementation lane, utility module, script, or migration, in any worktree or phase: commit-scoped reviews must never audit their own author, and ChatGPT usage limits are reserved for judgment, not keystrokes. Where Codex consults influence landed work (adversarial scenarios, recovery diagnoses, design-review findings), the phase log records provenance in one line each; the Phase 18 readiness review audits that no phase-commit review covered Codex-originated artifacts beyond triaged review findings.
+- Budget rule: mandatory calls (phase-commit reviews, the single re-review, checkpoint reviews) have absolute priority. Discretionary calls (design red-teams, adversarial scenario consults, recovery consults, pre-deletion audit, screenshot passes) are capped at ONE per phase, must not launch while a mandatory review is pending or deferred for cap reasons, get zero retries, and are always skippable — nothing in the acceptance criteria depends on them. If any call hits a usage limit, all discretionary use suspends until the next mandatory call succeeds (recorded in the Resume Snapshot). Degradation order when limits bite, cut from the top: screenshot judging → adversarial scenario consults → pre-deletion audit → design red-teams → recovery consults → low-risk phase reviews (fallback chain) → never the high-risk phase or checkpoint reviews.
+- Call ledger: the execution log Environment section gains an append-only Codex Calls table (date | purpose | effort | duration | outcome). Every codex invocation of any kind is logged.
+- Discretionary-call hardening: same invocation discipline as the mandatory gate — absolute codex path, background task registered in the Resume Snapshot, stdout to `docs/superpowers/reviews/codex/`, hard timebox stated at launch (20 min recovery consult, 30 min screenshot pass, 45 min design red-team), terminated via the tracked task id on timeout, never pattern kills. Flag experiments (`--output-schema`, `-i`, session resume) happen on discretionary calls only — never change the mandatory review invocation mid-run.
+
+Discretionary Codex uses (adopted set — nothing else without a Decision Ledger entry):
+
+1. Design red-team (Phases 9 and 10; 2 calls, xhigh, 45-min timebox): after the judges select a winning design and BEFORE implementation lanes launch, run `codex exec` (read-only sandbox) over the winning doc in `docs/architecture/` plus the Non-Negotiables and the named failure scenarios, prompted for data-loss holes, ordering/idempotency flaws, hand-waved failure scenarios, and simpler alternatives. Findings go through the standard triage→verify→fix-or-reject pipeline before lane briefs are issued; the design doc gains a Red-team Findings section. While it runs the lead does only read-only phase prep. On failure/timeout, fold the design questions into that phase's commit-review prompt and proceed. Codex never authors judge-panel candidates — all candidates are Claude subagents; cross-model input enters only here, post-verdict.
+2. Adversarial scenario consult (post-Phase-4 checkpoint: IPC validation; Phase 10: the six data-loss cases; post-Phase-11 checkpoint: MCP path scoping; 3 calls, high effort): `codex exec` read-only, prompted to ENUMERATE concrete attack/loss scenarios (inputs, sequence, expected invariant violation) — output is scenario descriptions, never test files or repo writes. The lead transcribes chosen scenarios into owned tests under normal TDD (recorded RED required), discards duplicates per the code-size rules, and logs which landed scenarios were Codex-origin. A scenario asserting behavior that contradicts the plan's contracts is rejected with reasoning, never satisfied by weakening the implementation.
+3. Recovery consult (rare; see Recovery Protocol): one bounded fresh-model diagnosis before any blocked declaration or Phase 16 deferral.
+4. Pre-deletion audit (Phase 13, 1 call, xhigh): see Phase 13 Step 2.5.
+5. Advisory screenshot pass (Phases 3 and 18 only; 2 calls, high effort, via `-i` attachments; conditional on the Phase 0 `-i` preflight): score ≤8 representative PNGs against the Design Review Loop rubric verbatim. Strictly advisory — the Claude design-review subagent remains the sole gating judge. Hard-item disagreements are re-examined once by the lead against the actual pixels before the phase commit; soft-item disagreements become deferred findings for the Phase 18 re-judge. On `-i` error or timeout, skip silently.
+
+### Parallel Lane Contract
+
+Intra-phase implementation fan-outs are allowed only under these rules:
+
+- Only the lead runs `pnpm add`/`pnpm install` and touches `pnpm-lock.yaml`/root `package.json`. Before fanning out, the lead scaffolds new package stubs and installs declared dependencies once; lanes never modify the lockfile.
+- Lanes never write the execution log or this plan. Each lane returns a structured report (files changed, tests added, RED output, GREEN output, deletions, open questions) that the lead merges into the log.
+- Every lane brief is self-contained (lanes share no conversation memory): phase goal, exact files owned, the TDD requirement (failing test recorded before implementation), file-ownership boundary, exact test commands, relevant Non-Negotiables. Never reference "as discussed above."
+- File-mutating lanes are worktree-isolated. The lead merges lanes, regenerates the lockfile once if needed, runs the phase's combined test commands, then commits.
+
+Per-phase parallelism map:
+
+```txt
+Phase 0:  fan out read-only explorers (one per required digest + one per existing package classification); baseline runs in background.
+Phase 1:  none — single lead lane (tiny phase, shared scaffolding).
+Phase 2:  none — single lead lane (coupled security posture). t3code recon fan-out may start here.
+Phase 3:  implementation single-lane (shared shell/CSS). Fan out only read-only work: t3code recon, screenshot capture, design judges.
+Phase 5:  lead defines watcher-event/change-set contracts first, then 3 worktree TDD lanes: A=workspace-fs watch/scan/diff, B=workspace-sync batchedSync, C=workspace-history changeSetStore. Lead-owned tail: shell wiring (shared DesktopWorkspaceShell.tsx).
+Phase 6:  lead writes failing fileTypes E2E + scaffolds FileInspector as dispatch table with one file per view; optional 2-4 lanes by affinity (text/data, media, SQLite studio, app affordance). Skip fan-out if moving fast single-lane.
+Phase 9:  start `pnpm dev:postgres` in background at phase start. After judge panel: Lane A=Better Auth (services/workspace-api), Lane B=sync protocol+backend (workspace-sync, workspace-postgres; stub actor shape from fixed ResolveActor contract), Lane C=compose/docs. Lane D (CloudLogin + E2E) starts after Lane A lands — dependency-ordered. cloudSync E2E runs last against background dev server.
+Phase 10: after judge panel: Lane A=collaborationPolicy (workspace-sync), Lane B=conflictResolution (workspace-history), Lane C=postgres-acl (hocuspocus). Lead-owned tail: useCollabDoc, sync UI, both E2E specs (two-client E2E in background).
+Phase 12: none — global rename is single-agent by nature.
+Phase 13: Step 1 fans out one read-only verifier per ported-test-map row (locate test, run it, confirm it fails when implementation is stubbed). Steps 3-5 deletion is explicitly single-agent (global lockfile/import surgery). Post-deletion battery in background.
+Phase 14: optional 2 lanes: A=update state machine, B=builder config+smoke+docs. Packaging build in background.
+Phase 15: fan out one doc-writer per document (5 lanes, self-contained briefs incl. product-shape bullets + thesis + phase outcomes). Lead writes the check script; smokes in background.
+Phase 16: measurement runs require quiescence (below). Optimization fixes MAY lane per disjoint target; authoritative re-measure on merged tree, quiesced.
+Phase 17: discovery findings partitioned across read-only classifiers; consolidation rows lane per owner package when duplicate sites are disjoint. Verification battery sequential-in-background.
+Phase 18: none — the readiness E2E is one intentionally sequential flow.
+```
+
+### Background/Foreground Rules
+
+ALWAYS background (registered in Resume Snapshot, with completion notification): docker compose stacks; workspace-api/hocuspocus/web dev servers (never foreground — WSL safety); the baseline script; full `pnpm -r` test/typecheck; full `pnpm test:desktop:e2e`; electron-builder packaging; `pnpm check:self-host`; Phase 17/18 verification batteries; all `codex exec review` runs; the two-client liveCoEditing E2E.
+
+ALWAYS foreground: the TDD inner loop's targeted commands — single-package vitest runs, single-spec Playwright runs, single-package typechecks. The red/green cycle needs immediate feedback.
+
+Phase-end full regression goes background while the lead does the delete-or-justify pass and log update; the commit waits for the background green.
+
+Measurement quiescence: before any measured performance run (Phase 2 launch marks onward, especially performance.spec.ts), drain or pause all background tasks, parallel subagents, and Codex reviews; verify no docker build/test suite is running; record the quiesced state in the log. Perf measurement owns the machine.
+
+### Checkpoint Review Recipe
+
+1. Lead computes `git diff --stat main...HEAD` and writes a 10-line range summary into the log.
+2. Fan out one read-only finder per relevant lens (security, authz/collab, data-loss/deletion-safety, performance, over-engineering/code-size). Each brief is self-contained: repo path, branch, diff command, lens definition copied from Non-Negotiables, output format per finding: {claim, evidence file:line, severity, repro command, proposed fix}. Cap 10 highest-confidence findings per finder.
+3. Launch the Codex `--base main` review in parallel (background); merge its findings into the same pipeline.
+4. Lead dedupes; one fresh verifier per candidate finding, given ONLY the finding text and repo (not the finder's reasoning), must confirm by repro or exact code citation. Unconfirmed → rejected-with-reason. Verifiers are always Claude subagents; Codex participates in checkpoints only as a finder via the `--base main` review, and Codex findings are verified by non-Codex verifiers like any other finding.
+5. Fix confirmed findings with targeted tests; re-run affected suites.
+6. Stop rule: max 2 rounds, or stop early when a round yields zero new confirmed medium+ findings.
+
+### Verifier Task Contracts (per-phase, before phase-closing commit)
+
+- Claimed-vs-actual: input = phase plan section + commit range + log entry; method = re-run every command the log claims passed, check every checkbox against the diff; output = table of claim / evidence command / verdict (confirmed | unsupported | contradicted).
+- Test-quality: method = disposable `git worktree add`, revert all non-test files in the phase range there, run the phase's test commands, expect failure; output = list of tests that still pass without the implementation (each is a finding). NEVER mutate the lead's checkout.
+- Screenshot review: input = the Design Review Loop rubric + the fixed artifact glob `test-results/screenshots/phase-<NN>/`; output = per-rubric-item pass/fail with offending screenshot path.
+
+### Recovery Protocol
+
+- Flaky test: re-run the single failing spec in isolation once to classify. Pass-on-retry = flake — deflake in the same phase by replacing sleeps/races with event-driven waits (performance marks, IPC signals); max 3 attempts, then quarantine the spec with a log entry and a mandatory item at the next checkpoint. NEVER add Playwright `retries:`, broaden timeouts beyond 2x, or weaken assertions to mask flake.
+- External service down (Postgres, minio, hocuspocus): the lead is authorized to start/restart via the documented compose commands (background, per WSL safety — no pattern kills). Not a blocker. An ECONNREFUSED/timeout from a service port is an environment failure, never a test failure; fix the environment, never the test.
+- Electron launch failure on this machine: the fix is ALWAYS environmental, never webPreferences (see Phase 2).
+- Toolchain freeze: Phase 0 records `node -v`, `pnpm -v`, and `command -v codex` in the Environment section. Tests must run under the Node version that reproduces the dual-backend green sweep (22.13.0 verified — Node 25 breaks 17 web tests); pin via PATH prefix in scripts, do not run `nvm use` mid-run. Codex is invoked by absolute path.
+- Fresh-model consult (required before declaring blocked): when the same blocker survives three concrete attempts, or a Phase 16 metric is still over budget after its 3 optimization attempts, the lead writes a self-contained brief to `docs/superpowers/reviews/codex/blocker-<phase>-<slug>.md` (symptom, exact failing command, path to full output, files inspected, the three attempts and why each failed) and makes ONE `codex exec` consult — read-only sandbox, xhigh, 20-minute timebox, backgrounded — asking for the most likely root cause and the smallest concrete fix or next experiment. Rules: this is attempt 4-of-4, never a counter reset; any proposed diagnosis must be independently confirmed by the lead via repro or exact code citation before any code change; if Codex is unavailable or the timebox expires, proceed directly to the blocked report (zero retries). The diagnosis file is attached to any blocked report. This consult is exempt from the per-phase review budget but logged in the call ledger.
+
 ### Major Review Checkpoints
 
-Use CodeRabbit/subagents/manual review if available:
+Use Codex third-party review plus multi-agent adversarial review workflows (and manual review if the user is present):
 
 - after Phase 4: Electron security and IPC review.
 - after Phase 7: local workspace/sync review.
 - after Phase 9: cloud sync/collaboration review.
+- after Phase 10: merge/data-loss and live co-editing review.
 - after Phase 11: MCP/agent-power review.
 - after Phase 13: Convex deletion review.
 - after Phase 16: performance review.
 - after Phase 17: codebase excellence/deletion review.
 - after Phase 18: full product readiness review.
 
 Fix relevant findings before continuing. If a finding is rejected, record why.
 
 ### Stop Conditions
 
 Stop only if:
 
-- the same blocker remains after three concrete attempts.
+- the same blocker remains after three concrete attempts plus the Recovery Protocol fresh-model consult.
 - a missing external secret/service is genuinely required.
 - a product/security decision is genuinely required from the user.
 - continuing would violate a non-negotiable.
 
 Blocked report must include:
 
 - exact blocker.
 - incomplete phase and step.
 - attempts made.
 - files inspected.
 - commands run.
 - current failing tests.
 - smallest required input.
 
 ## Branch And Execution Strategy
 
-- Start after the completed dual-backend branch is merged or explicitly chosen as base.
-- Suggested branch: `codex/desktop-local-first-cloud-sync`.
+- The dual-backend plan is MERGED into main at bc62bd2 (PR #30). All "old plan" code lives in the current working tree. Never check out, diff against, or port from the stale local branch `codex/dual-backend-filesystem-agent-runtime`.
+- Branch: `claude/desktop-local-first-cloud-sync`.
 - Create an execution log at:
   - `docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md`
-- Commit after every phase.
-- Do not squash phase commits during implementation; traceability matters.
+- Commit at every green-test milestone within a phase, message prefix `phaseN(step M): ...`; the final phase commit closes the phase. Git is the primary resume substrate — never leave hours of work in a dirty tree.
+- Do not amend or squash phase commits during implementation; traceability matters.
 
 Execution log template:
 
 ```md
 # Desktop Local-First Cloud Sync Execution Log
 
-## Baseline
+## Resume Snapshot (overwrite in place — the ONLY mutable section)
 
-- Branch:
-- Base commit:
-- Old dual-backend commit:
-- Current phase:
-- Current step:
-- Last successful commit:
-- Last failing command:
-- Last blocker:
+- Phase/Step + TDD position: (e.g., "Phase 5 Step 3, tests written, expected RED")
+- Expected test state: (exact command + which assertions should currently fail/pass)
+- Dirty files and intent:
+- Exact next action: (one imperative sentence)
+- Active background tasks: (id, command, expected artifact path)
+- Open worktrees: (path, purpose, merged?)
+- Pending reviews: (codex/verifier in flight)
+
+## Environment (append-only)
+
+- Toolchain freeze: node version, pnpm version, absolute codex path
+- Services state, display server, quirks
+
+## Decision Ledger (append-only, one line each)
+
+- D-NN | decision | why | phase
+
+## Reference Digests (append-only, ≤25 lines each, source path + date)
+
+## Gotchas (append-only one-liners, incl. learned file locations)
 
 ## Phase Logs
 
 ### Phase N: Name
 
 - Status: not started | in progress | complete | blocked
 - Execution map:
+- Resume notes: (one sentence: what is half-done, exact next command)
 - Files changed:
 - Code deleted or consolidated:
+- Net LOC delta (`git diff --shortstat`):
 - Old paths retained and why:
+- Dependencies added (name, size, justification):
+- Decisions made (D-NN ids):
 - Tests added:
 - Commands run:
 - Failing tests fixed:
 - Electron E2E/manual smoke:
-- Performance measurements:
+- UI/UX screenshot/design review:
+- Performance measurements: (compact table rows, not prose)
 - Security/collaboration regressions:
-- Reviewer/subagent/CodeRabbit findings:
+- Reviewer/subagent findings: (numbered one-liners, status: fixed @ sha | rejected: reason)
+- Codex third-party review findings: (one-liners + pointer to docs/superpowers/reviews/codex/phase-NN.md)
 - Relevant findings fixed:
 - Deferred findings with reason:
 - Remaining risk:
 - Next phase:
 ```
 
+Log update cadence and hygiene (mandatory):
+
+- Update the Resume Snapshot at every TDD-step transition, before launching anything long-running (codex review, full suite, fan-out, worktree), and immediately after every commit. Register background tasks and worktrees in the snapshot BEFORE launching; clear entries on completion/merge. On resume, reconcile the snapshot against `git status`, `git worktree list`, and on-disk artifacts before doing anything else.
+- The log is append-only except the Resume Snapshot.
+- No raw command output, stack traces, or codex transcripts over ~10 lines — write full output to `test-results/` or `docs/superpowers/reviews/codex/phase-NN.md` and link the path.
+- Soft cap ~80 lines per phase section; overflow goes to a per-phase appendix file.
+- The resume read-set is: Resume Snapshot + Environment + Decision Ledger + Gotchas + Reference Digests + the current phase's section ONLY.
+
 ## Planned Repository Shape
 
 Target shape after this plan:
 
 ```txt
 apps/
   desktop/                  # Electron main/preload/app shell, desktop-first product
   web/                      # Web/cloud/shared-link client; may be renamed from apps/app
   mobile-web/               # optional later; not required in this plan
 
 packages/
   workspace-core/           # local-first workspace model, modes, paths, change sets
   workspace-fs/             # existing package promoted: watch/materialize/scan/diff/apply
   workspace-postgres/       # existing package promoted: cloud/self-host store
   workspace-sync/           # local <-> cloud sync engine
   workspace-history/        # dohc-native change sets/provenance/conflict summaries
   desktop-bridge-contracts/ # typed preload IPC contract and zod schemas
   mcp/                      # dohc MCP server for Codex/Claude Code
 
 services/
   workspace-api/            # cloud/self-host API over Postgres
   hocuspocus/               # collaborative text where needed
   sqlite-worker/            # SQLite import/materialization/query
   app-tester/               # app quality/runtime testing
   agent-sandbox/            # hosted/cloud sandbox; desktop local agents use folder+MCP first
 
 docs/
   architecture/
   self-hosting.md
   desktop.md
 ```
 
 The implementer may keep `apps/app` temporarily, but the plan should end with a clear `apps/desktop` and `apps/web` split or a documented reason why a safe rename must wait.
 
 ---
 
 ## Phase 0: Baseline, Tooling, And Old-Plan Inventory
 
 **Files:**
 
 - Create: `docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md`
 - Create: `docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md`
 - Create: `scripts/check-desktop-local-first-baseline.mjs`
 - Modify: `package.json`
 
 - [ ] **Step 1: Write execution log**
 
 Create the execution log using the template above.
 
 - [ ] **Step 2: Write old-plan inventory**
 
 Create `docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md` with:
 
 ```md
 # Old Plan Port/Delete Inventory
 
 ## Keep And Promote
 
 ## Port With Changes
 
 ## Delete After Replacement
 
 ## Delete Immediately
 
 ## Tests To Preserve
 
 ## Tests To Rewrite
 
 ## Remaining Questions
 ```
 
 Minimum classifications:
 
 - Keep/promote: `workspace-postgres`, `workspace-fs`, `workspace-api`, `agent-sandbox`, `sqlite-worker`, `app-tester`, `workspace-contracts` concepts.
 - Port with changes: uploads/file-type views, app runtime, agent output separation, backend matrix.
 - Delete after replacement: Convex backend, Convex compat package, dual-backend switch, web-first atom tools, `.views` compatibility.
 - Rewrite: backend matrix should become desktop/local/cloud matrix.
 
 - [ ] **Step 3: Add baseline check**
 
 Create `scripts/check-desktop-local-first-baseline.mjs`:
 
 ```js
 import { spawnSync } from "node:child_process";
 
 const env = {
   ...process.env,
   PATH: process.env.PATH ?? "",
 };
 
 const commands = [
   ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
   ["pnpm", ["--filter", "@dohc/web", "test"]],
   ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
   ["pnpm", ["--filter", "@dohc/workspace-postgres", "test"]],
   ["pnpm", ["--filter", "@dohc/workspace-fs", "test"]],
   ["pnpm", ["--filter", "@dohc/workspace-api", "test"]],
   ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
   ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
   ["pnpm", ["--filter", "@dohc/agent-sandbox", "test"]],
   ["pnpm", ["check:debt"]],
 ];
 
 for (const [cmd, args] of commands) {
   console.log(`\n$ ${cmd} ${args.join(" ")}`);
   const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
   if (result.status !== 0) process.exit(result.status ?? 1);
 }
 ```
 
 - [ ] **Step 4: Register script**
 
 Add:
 
 ```json
 "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs"
 ```
 
-- [ ] **Step 5: Run baseline**
+- [ ] **Step 5: Environment preflight, then run baseline**
+
+Preflight first: start `pnpm dev:postgres` as a background task and poll readiness (bounded, ~60s max); record `node -v`, `pnpm -v`, and `command -v codex` in the execution log Environment section (toolchain freeze — tests run under Node 22.13.0 via PATH prefix; Node 25 breaks 17 web tests); record display server state. The baseline script must pin the test Node via PATH.
+
+Codex capability preflight (one cheap call each, recorded in Environment): verify `codex exec review` works; verify plain `codex exec` completes under a read-only sandbox; verify `-i` correctly describes a known test PNG. If optional capabilities (`codex exec`, `-i`) fail, disable only the discretionary uses needing them. If `codex exec review` or the preferred model itself fails, the review gate is NOT disabled — it switches to the independent-review fallback chain from the Codex third-party review section, recorded in the execution log.
 
 ```bash
 pnpm check:desktop-local-first-baseline
 ```
 
-Expected: pass, or execution log records exact pre-existing failures.
+Run as a background task. Expected: pass, or execution log records exact pre-existing failures. An ECONNREFUSED from Postgres is an environment failure — fix services, do not record it as a pre-existing test failure.
+
+The Step 2 inventory may fan out read-only explorer subagents (one per existing package/service, one per digest doc) per the parallelism map; the inventory must record exact file paths for app runtime, upload, and file-type code so later phases cite paths, not memories.
 
 - [ ] **Step 6: Commit**
 
 ```bash
 git add package.json scripts/check-desktop-local-first-baseline.mjs docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md
 git commit -m "Inventory old plan for desktop local-first pivot"
 ```
 
 ---
 
 ## Phase 1: Local-First Workspace Core Contract
 
 **Files:**
 
 - Create: `packages/workspace-core/package.json`
 - Create: `packages/workspace-core/tsconfig.json`
 - Create: `packages/workspace-core/src/workspaceMode.ts`
 - Create: `packages/workspace-core/src/paths.ts`
 - Create: `packages/workspace-core/src/metadata.ts`
 - Create: `packages/workspace-core/src/changeSet.ts`
 - Create: `packages/workspace-core/src/conflicts.ts`
 - Create: `packages/workspace-core/src/index.ts`
 - Create: `packages/workspace-core/src/workspaceMode.test.ts`
 - Create: `packages/workspace-core/src/paths.test.ts`
 - Create: `packages/workspace-core/src/changeSet.test.ts`
 
 - [ ] **Step 1: Write failing workspace mode tests**
 
 Tests must assert:
 
 ```ts
 expect(defaultWorkspaceMode("personal")).toBe("local-first");
 expect(defaultWorkspaceMode("shared")).toBe("cloud-first-local-copy");
 expect(defaultWorkspaceMode("cloud-only")).toBe("cloud-only");
 ```
 
 Also assert workspace mode is per-workspace, not per-file.
 
 - [ ] **Step 2: Write failing path tests**
 
 Tests must assert:
 
 - `~/dohc` is the default root suggestion.
 - attached folders are allowed.
 - `.dohc/manifest.json` is reserved.
 - path traversal is rejected.
 - `.apps/<name>/app.json` is a visible app source path.
 - `.sqlite`, `.sqlite3`, and `.db` are visible database files.
 
 - [ ] **Step 3: Write failing change-set tests**
 
 Tests must assert:
 
 - one agent run editing many files groups into one change set.
 - normal allowed edits do not require approval.
 - boundary crossings require review: public share, permission change, bulk delete, app trust/install, private-to-shared move.
 - conflicts produce human-readable summaries, not Git markers.
 
 - [ ] **Step 4: Implement workspace core**
 
 Implement:
 
 ```ts
 export type WorkspaceMode = "local-first" | "cloud-first-local-copy" | "cloud-only";
 export type WorkspaceKind = "personal" | "shared" | "cloud-only";
 export type ChangeSetKind = "user-edit" | "agent-run" | "import" | "sync" | "app-build";
 export type BoundaryCrossing =
   | "public-share"
   | "external-export"
   | "permission-change"
   | "bulk-delete"
   | "app-trust"
   | "private-to-shared"
   | "unmergeable-overwrite";
 ```
 
 - [ ] **Step 5: Run tests**
 
 ```bash
 pnpm --filter @dohc/workspace-core test
 pnpm --filter @dohc/workspace-core typecheck
 ```
 
 Expected: pass.
 
 - [ ] **Step 6: Delete-or-justify**
 
 Record in the execution log which old workspace contract types move into `workspace-core` and which remain temporarily in `workspace-contracts`.
 
 - [ ] **Step 7: Commit**
 
 ```bash
 git add packages/workspace-core package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Add local-first workspace core contract"
 ```
 
 ---
 
 ## Phase 2: Electron Desktop Scaffold And Test Harness
 
 **Files:**
 
 - Create: `apps/desktop/package.json`
 - Create: `apps/desktop/tsconfig.json`
 - Create: `apps/desktop/electron.vite.config.ts`
 - Create: `apps/desktop/src/main.ts`
 - Create: `apps/desktop/src/preload.ts`
 - Create: `apps/desktop/src/ipc/channels.ts`
 - Create: `apps/desktop/src/ipc/bridgeContract.ts`
 - Create: `apps/desktop/src/window/createMainWindow.ts`
 - Create: `apps/desktop/src/security/electronSecurity.ts`
 - Create: `apps/desktop/src/security/electronSecurity.test.ts`
+- Create: `apps/desktop/src/performance/launchMarks.ts`
 - Create: `apps/desktop/src/smoke/desktopSmoke.test.ts`
 - Create: `apps/desktop/e2e/desktopLaunch.spec.ts`
 - Create: `apps/desktop/scripts/smoke-test.mjs`
+- Create: `apps/desktop/playwright.config.ts`
 - Modify: `package.json`
-- Modify: `playwright.config.ts`
+- Modify: `pnpm-workspace.yaml` (onlyBuiltDependencies allowlist)
+
+Root `playwright.config.ts` is NOT modified in this phase — it stays pointed at the web app so `pnpm test:e2e` keeps working.
 
 - [ ] **Step 1: Install Electron desktop tooling**
 
 Install current packages compatible with the repo's Node/Vite constraints:
 
 ```bash
 pnpm add -D --filter @dohc/desktop electron electron-vite electron-builder @electron/fuses playwright @playwright/test
 ```
 
 If workspace filtering cannot target a new package before creation, create `apps/desktop/package.json` first, then install.
 
 Also add:
 
 ```bash
 pnpm add --filter @dohc/desktop electron-updater zod
 ```
 
 Expected dependency intent:
 
 - `electron`: desktop runtime.
 - `electron-vite`: build/dev main, preload, renderer entries.
 - `electron-builder`: package/sign/update artifacts.
 - `@electron/fuses`: harden packaged app features.
 - `playwright` and `@playwright/test`: launch and test Electron windows.
 - `electron-updater`: future update flow tests.
 - `zod`: validate IPC payloads.
 
+Install preconditions (verified landmines on this repo/host):
+
+- pnpm 10 ignores dependency postinstall scripts by default and the repo has no allowlist. BEFORE installing, add to `pnpm-workspace.yaml`: `onlyBuiltDependencies: [electron, esbuild, electron-winstaller]` (extend for native deps later). After install, verify the Electron binary with `pnpm --filter @dohc/desktop exec electron --version` (under xvfb-run if needed) BEFORE writing any test. If it fails, run `pnpm approve-builds` and record in the log. Same applies in Phase 8 if native SQLite deps are added (plus electron-rebuild for the Electron ABI).
+- Desktop E2E gets its own `apps/desktop/playwright.config.ts` (testDir `./e2e`, `workers: 1` — Electron instances can't parallelize on one display, NO webServer block, ~60s per-test timeout). Root script becomes `"test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts"`. The root `playwright.config.ts` (testDir `./apps/app/e2e`, web dev-server bootstrap) must remain untouched so `pnpm test:e2e` keeps working.
+
 - [ ] **Step 2: Write failing Electron security tests**
 
 `apps/desktop/src/security/electronSecurity.test.ts` must assert:
 
 - `nodeIntegration` is false.
 - `contextIsolation` is true.
 - `sandbox` is true.
 - preload path is absolute.
 - renderer cannot navigate to arbitrary external URLs.
 - `window.open` external targets are denied or opened through safe shell handler.
 
 - [ ] **Step 3: Write failing desktop launch E2E**
 
 `apps/desktop/e2e/desktopLaunch.spec.ts` must launch Electron using Playwright:
 
 ```ts
 import { test, expect } from "@playwright/test";
 import { _electron as electron } from "playwright";
 
 test("launches dohc desktop and renders the first-run shell", async () => {
   const app = await electron.launch({
     args: ["apps/desktop/dist/main.js"],
     cwd: process.cwd(),
     env: { ...process.env, DOHC_DESKTOP_TEST: "1" },
   });
   const page = await app.firstWindow();
   await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
   await page.screenshot({ path: "test-results/desktop-launch.png" });
   await app.close();
 });
 ```
 
 If the build output path differs, update the test after implementing `electron-vite` build. The RED failure should be missing desktop app/build output.
 
 - [ ] **Step 4: Implement minimal Electron main/preload**
 
 Use secure defaults:
 
 ```ts
 new BrowserWindow({
   show: false,
   webPreferences: {
     preload: absolutePreloadPath,
     nodeIntegration: false,
     contextIsolation: true,
     sandbox: true,
   },
 });
 ```
 
 Expose only:
 
 ```ts
 window.dohcDesktop.getVersion()
 window.dohcDesktop.pickWorkspaceRoot()
 window.dohcDesktop.getWorkspaceRegistry()
 ```
 
 through `contextBridge`.
 
+Also ship the minimal performance measurement harness required by the Continuous enforcement rules: marks for app-ready, first window, and first renderer paint in `launchMarks.ts`, exposed through a test-only bridge so the launch E2E writes `test-results/performance/desktop-performance.json` from day one. Later phases append their own marks to the same file; Phase 16 turns it into the hard gate.
+
 - [ ] **Step 5: Add root scripts**
 
 ```json
 "dev:desktop": "pnpm --filter @dohc/desktop dev",
 "build:desktop": "pnpm --filter @dohc/desktop build",
 "test:desktop": "pnpm --filter @dohc/desktop test",
-"test:desktop:e2e": "playwright test apps/desktop/e2e",
+"test:desktop:e2e": "playwright test --config apps/desktop/playwright.config.ts",
 "smoke:desktop": "node apps/desktop/scripts/smoke-test.mjs"
 ```
 
 - [ ] **Step 6: Run tests**
 
 ```bash
 pnpm --filter @dohc/desktop test
 pnpm build:desktop
 pnpm test:desktop:e2e
 ```
 
 Expected: pass. If the environment lacks a display server, run under `xvfb-run` and record that in the execution log.
 
+WSL2 sandbox rule: if Electron fails to launch on this machine, the fix is ALWAYS environmental, never webPreferences. Allowed: install missing system libraries (record them), run under xvfb-run, or pass `--no-sandbox` as a LAUNCH ARGUMENT in the Playwright harness only, gated on `DOHC_E2E_NO_CHROMIUM_SANDBOX=1` and recorded in the log. Forbidden: `sandbox: false`, `contextIsolation: false`, `nodeIntegration: true` in product code, or deleting/weakening the security tests. The security unit test asserts the webPreferences object as configured, so it passes regardless of host sandbox capability.
+
 - [ ] **Step 7: Review against t3code**
 
 Compare against:
 
 ```txt
 /home/ice/dev/oss-repos/t3code/apps/desktop/src/main.ts
 /home/ice/dev/oss-repos/t3code/apps/desktop/src/preload.ts
 /home/ice/dev/oss-repos/t3code/apps/desktop/src/electron
 ```
 
 Record which patterns were reused and which were intentionally avoided.
 
 - [ ] **Step 8: Commit**
 
 ```bash
-git add apps/desktop package.json pnpm-lock.yaml playwright.config.ts docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+git add apps/desktop package.json pnpm-lock.yaml pnpm-workspace.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Scaffold secure Electron desktop app"
 ```
 
 ---
 
 ## Phase 3: Native-Feeling Desktop Shell UX
 
 **Files:**
 
 - Create: `apps/desktop/src/renderer/DesktopRoot.tsx`
 - Create: `apps/desktop/src/renderer/DesktopFirstRun.tsx`
 - Create: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
 - Create: `apps/desktop/src/renderer/nativeChrome.ts`
 - Create: `apps/desktop/src/renderer/desktop.css`
 - Create: `apps/desktop/src/renderer/DesktopFirstRun.test.tsx`
 - Create: `apps/desktop/e2e/firstRunWorkspace.spec.ts`
 - Modify: current React app exports if reused from `apps/app/src`
 
 - [ ] **Step 1: Write failing first-run tests**
 
 Tests must assert first launch:
 
 - suggests `~/dohc`.
 - allows choosing another folder.
 - creates `personal` workspace.
 - does not require login.
 - offers "Enable dohc Cloud sync" but does not force it.
 - looks and behaves like a desktop app, not a web onboarding page.
 
 - [ ] **Step 2: Write failing native UX E2E**
 
 Playwright Electron test must assert:
 
 - app opens with a framelike desktop shell.
 - sidebar/file tree is immediately usable.
 - keyboard shortcuts work: new file, command palette, quick open.
 - theme follows system but does not interrupt running agent/sync work.
 - text does not overflow at 1280x800 and 1536x960.
+- screenshot comparison or screenshot artifact exists for first-run, workspace shell, command palette, and file preview.
+- app chrome uses muted dohc styling and does not render marketing/landing-page UI.
+- agent activity renders as a timeline/panel, not as one giant final paragraph.
 
 - [ ] **Step 3: Implement desktop-first shell**
 
-Reuse current React components where sensible, but change UX that feels web-first.
+Reuse current React components per the component reuse map: the Phase 3 recon must produce `docs/superpowers/reviews/2026-06-10-desktop-component-reuse-map.md`, classifying each candidate in `apps/app/src/components/` as (a) reuse as-is, (b) port with data-layer swap, or (c) rebuild — using the mechanical criterion: a component is reusable only if it has no imports from `convex/react`, `apps/app/convex/_generated`, or web router internals; otherwise its data access must be lifted to props fed by the typed desktop bridge. Implementer briefs cite this artifact, never "where sensible". Change UX that feels web-first.
 
 Desktop shell must include:
 
 - workspace switcher.
 - local sync status.
 - file tree.
 - editor/preview/app area.
 - agent/activity panel.
 - command palette.
 - upload/import action.
 - cloud sync connect button.
 
 Avoid landing-page UI. First screen should be the usable workspace.
 
+Visual style requirements:
+
+- preserve dohc's current simple muted styling.
+- use warm paper/graphite foundations.
+- keep sidebar density close to Obsidian/t3code rather than a SaaS dashboard.
+- use restrained hover/active states.
+- keep cards only for repeated items, modals, and genuinely framed tools.
+- make command palette and file switcher keyboard-first.
+- keep text readable and compact; no hero-sized type inside tool surfaces.
+- no decorative gradients/orbs/bokeh.
+- no AI-generated marketing copy inside the app shell.
+
 - [ ] **Step 4: Run visual smoke**
 
 ```bash
 pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
 ```
 
 Expected:
 
 - screenshot saved.
 - nonblank desktop shell.
 - no overlapping text.
 - first workspace created.
+- first-run and workspace shell screenshots look native, muted, and consistent with dohc.
+- command palette and file tree are visibly usable.
 
 - [ ] **Step 5: Delete-or-justify**
 
 Identify web-only onboarding UI that should not exist in desktop. Delete it if not needed for web/cloud-only; otherwise isolate it under web-only code.
 
 - [ ] **Step 6: Commit**
 
 ```bash
 git add apps/desktop apps/app/src docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Add native desktop workspace shell"
 ```
 
 ---
 
 ## Phase 4: Local Workspace Registry And Folder Creation
 
 **Files:**
 
 - Create: `apps/desktop/src/workspaces/WorkspaceRegistry.ts`
 - Create: `apps/desktop/src/workspaces/WorkspaceRegistry.test.ts`
 - Create: `apps/desktop/src/workspaces/createWorkspaceFolder.ts`
 - Create: `apps/desktop/src/workspaces/createWorkspaceFolder.test.ts`
 - Modify: `apps/desktop/src/ipc/bridgeContract.ts`
 - Modify: `apps/desktop/src/preload.ts`
 - Modify: `apps/desktop/src/renderer/DesktopFirstRun.tsx`
 - Modify: `packages/workspace-core/src/metadata.ts`
 
 - [ ] **Step 1: Write failing registry tests**
 
 Tests must assert:
 
 - default root is suggested as `${home}/dohc`.
 - multiple attached folders are supported.
 - duplicate folder attachment is rejected.
 - local-only workspace does not require account.
 - shared/cloud workspaces record remote identity only after sync is enabled.
 
 - [ ] **Step 2: Write failing folder creation tests**
 
 Tests must assert creating `personal` writes:
 
 ```txt
 ~/dohc/personal/
   .dohc/manifest.json
   .context/me.md
 ```
 
 Manifest includes:
 
 ```json
 {
   "version": 1,
   "workspaceId": "...",
   "mode": "local-first",
   "kind": "personal"
 }
 ```
 
 - [ ] **Step 3: Implement registry and folder creation**
 
 Use Electron safe storage or app user data path for the registry. Visible workspace content lives where the user chose.
 
 - [ ] **Step 4: Wire IPC**
 
 Expose validated desktop bridge methods:
 
 ```ts
 listLocalWorkspaces()
 createLocalWorkspace(input)
 attachWorkspaceFolder(input)
 chooseWorkspaceRoot()
 ```
 
 - [ ] **Step 5: Run tests**
 
 ```bash
 pnpm --filter @dohc/desktop test src/workspaces
 pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
 ```
 
 Expected: pass.
 
 - [ ] **Step 6: Commit**
 
 ```bash
 git add apps/desktop packages/workspace-core docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Add local workspace registry"
 ```
 
 ---
 
 ## Phase 5: File Watcher, Batched Sync, And Local-First History
 
 **Files:**
 
 - Modify: `packages/workspace-fs/src/watch.ts`
 - Modify: `packages/workspace-fs/src/scan.ts`
 - Modify: `packages/workspace-fs/src/diff.ts`
 - Create: `packages/workspace-sync/package.json`
 - Create: `packages/workspace-sync/tsconfig.json`
 - Create: `packages/workspace-sync/src/batchedSync.ts`
 - Create: `packages/workspace-sync/src/batchedSync.test.ts`
 - Create: `packages/workspace-history/package.json`
 - Create: `packages/workspace-history/src/changeSetStore.ts`
 - Create: `packages/workspace-history/src/changeSetStore.test.ts`
 - Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
 
 - [ ] **Step 1: Install watcher dependency**
 
 ```bash
 pnpm add --filter @dohc/workspace-fs chokidar
 ```
 
 - [ ] **Step 2: Write failing batched sync tests**
 
 Tests must assert:
 
 - single markdown save syncs after settle delay.
 - 18 app-file writes group into one change set.
 - temp files are ignored.
 - SQLite WAL/journal writes do not sync raw transient files.
 - generated app build output under `.dohc/cache` does not sync as user content.
 
 - [ ] **Step 3: Write failing history tests**
 
 Tests must assert:
 
 - change set records user/agent/import/sync kind.
 - provenance points to source prompt/import/agent run where available.
 - human summary is generated or stored.
 - no Git conflict markers appear in user files.
+- the history store exposes an ordered change-set timeline queryable by the desktop UI: kind, author (human or agent), plain-language summary, files touched.
 
 - [ ] **Step 4: Implement batched sync**
 
 Use settled windows:
 
 ```txt
 markdown/text: 500ms-2s
 app folders: group until quiet for 2s
 SQLite files: wait for WAL/journal settle or explicit import operation
 bulk changes: group as one change set
 ```
 
 - [ ] **Step 5: Implement local history store**
 
 Store history under:
 
 ```txt
 .dohc/history/
 .dohc/changes/
 ```
 
 Do not require Git.
 
-- [ ] **Step 6: Wire desktop sync status**
+- [ ] **Step 6: Wire desktop sync status and history surface**
 
 Desktop shell shows:
 
 - synced
 - syncing
 - local changes
 - conflict
 - cloud disconnected
 
+Also wire the workspace history surface — the "git log for everyday people":
+
+- a change-set timeline panel showing each change set's kind, author (human or agent), plain-language summary, and files touched.
+- clicking a change set reveals what changed.
+- this surface exists from this phase onward, in local-only mode with no account — so when sharing arrives later, collaboration adds zero new concepts.
+
 - [ ] **Step 7: Run tests**
 
 ```bash
 pnpm --filter @dohc/workspace-fs test
 pnpm --filter @dohc/workspace-sync test
 pnpm --filter @dohc/workspace-history test
 pnpm test:desktop:e2e apps/desktop/e2e/firstRunWorkspace.spec.ts
 ```
 
 Expected: pass.
 
 - [ ] **Step 8: Commit**
 
 ```bash
 git add packages/workspace-fs packages/workspace-sync packages/workspace-history apps/desktop package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Add batched local sync and change history"
 ```
 
 ---
 
 ## Phase 6: Real File UX For Text, Data, Media, Apps, And Databases
 
 **Files:**
 
 - Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
 - Create: `apps/desktop/src/renderer/FileInspector.tsx`
 - Create: `apps/desktop/src/renderer/FileInspector.test.tsx`
 - Create: `apps/desktop/e2e/fileTypes.spec.ts`
 - Modify: existing file-type view code from `apps/app/src/components/FileTypeView.tsx`
 - Modify: app runtime and Database Studio code as needed
 
 - [ ] **Step 1: Write failing file-type E2E**
 
 Create a local workspace with:
 
 ```txt
 notes/today.md
 data/transactions.csv
 data/config.json
 uploads/receipt.png
 uploads/contract.pdf
 uploads/voice.m4a
 finance/wallet.sqlite
 finance/.apps/ledger/app.json
 ```
 
 Test must assert:
 
 - markdown opens as document/editor.
 - CSV opens as data/table view with raw toggle.
 - JSON opens as code/data view.
 - image opens as image preview.
 - PDF opens as file preview/download/open-external.
 - audio opens with audio controls.
 - SQLite opens Database Studio.
 - `.apps/ledger` opens app package/source/runtime affordance.
 
 - [ ] **Step 2: Implement FileInspector**
 
-Port useful file-type view code from the old branch into desktop renderer.
+Port file-type view code from the current working tree (the dual-backend work is merged — never the stale branch): `apps/app/src/components/FileTypeView.tsx`, Database Studio components, and related media views, per the exact paths recorded in the Phase 0 inventory. Porting criterion: strip Convex/web data hooks; data arrives via the typed desktop bridge. FileInspector is a thin dispatch table with one file per view type (keeps later lanes conflict-free).
 
 - [ ] **Step 3: Implement upload/import**
 
 Desktop can add files by:
 
 - drag/drop.
 - file picker.
 - agent-created file.
 - copying into folder externally.
 
 All paths should converge through workspace watcher/history.
 
 - [ ] **Step 4: Run tests**
 
 ```bash
 pnpm --filter @dohc/desktop test src/renderer/FileInspector.test.tsx
 pnpm test:desktop:e2e apps/desktop/e2e/fileTypes.spec.ts
 ```
 
 Expected: pass.
 
 - [ ] **Step 5: Delete-or-justify**
 
 Delete duplicate web-only file-type rendering paths if desktop/web can share `FileInspector`. Otherwise document why web-specific variants remain.
 
 - [ ] **Step 6: Commit**
 
 ```bash
 git add apps/desktop apps/app/src docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Add native file type UX"
 ```
 
 ---
 
 ## Phase 7: Apps As Local Source Folders
 
 **Files:**
 
 - Modify: app runtime packages from old branch
 - Create: `packages/workspace-core/src/apps.ts`
 - Create: `packages/workspace-core/src/apps.test.ts`
 - Create: `apps/desktop/e2e/localApps.spec.ts`
 - Modify: `services/app-tester/src/runAppTest.ts`
 - Modify: `apps/desktop/src/renderer/DesktopWorkspaceShell.tsx`
 
 - [ ] **Step 1: Write failing app source tests**
 
 Tests must assert:
 
 ```txt
 finance/.apps/ledger/
   app.json
   src/App.tsx
   src/style.css
 ```
 
 is discovered as a local app package.
 
 Also assert:
 
 - build output goes to `.dohc/cache/apps/ledger`.
 - app source remains visible/editable.
 - app manifest scopes are maximum scopes, not permissions.
 - app trust is required for broad workspace writes.
 - app tester runs before "ready" state.
 
 - [ ] **Step 2: Write failing desktop app E2E**
 
 Flow:
 
 1. create local app folder.
 2. edit `src/App.tsx`.
 3. run app tester.
 4. open app in desktop.
 5. use a persistent control.
 6. reload and confirm persistence.
 
 - [ ] **Step 3: Implement local app discovery/build cache**
 
 Use old `.apps` work, but pivot source discovery to local filesystem first.
 
 - [ ] **Step 4: Run AppTester**
 
 ```bash
 pnpm --filter @dohc/app-tester test
 pnpm test:desktop:e2e apps/desktop/e2e/localApps.spec.ts
 ```
 
 Expected: pass.
 
 - [ ] **Step 5: Commit**
 
 ```bash
 git add packages/workspace-core apps/desktop services/app-tester docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Run local apps from visible source folders"
 ```
 
 ---
 
 ## Phase 8: Visible SQLite And Data Import
 
 **Files:**
 
 - Modify: `services/sqlite-worker/src/sqliteEngine.ts`
 - Create: `packages/workspace-core/src/databases.ts`
 - Create: `packages/workspace-core/src/databases.test.ts`
 - Create: `apps/desktop/e2e/sqliteImport.spec.ts`
 - Modify: `apps/desktop/src/renderer/FileInspector.tsx`
 - Modify: `services/app-tester` if needed
 
 - [ ] **Step 1: Write failing SQLite import E2E**
 
 Flow:
 
 1. drop `wallet_records.csv` into `imports/`.
 2. agent or import UI creates `finance/wallet.sqlite`.
 3. user opens Database Studio.
 4. app queries transactions.
 5. edit category.
 6. reload desktop.
 7. query persists.
 
 - [ ] **Step 2: Write failing raw-byte safety tests**
 
 Tests must assert:
 
 - SQLite WAL/journal files are not synced as standalone user files.
 - database operation logs are recorded for structured row edits.
 - raw SQLite bytes are not CRDT-synced.
 - visible SQLite file materializes only after safe close/import/materialization point.
 
 - [ ] **Step 3: Implement visible SQLite rules**
 
 Visible database files are allowed for user data. `.dohc/databases` is allowed for hidden internal/cache databases only.
 
 - [ ] **Step 4: Run tests**
 
 ```bash
 pnpm --filter @dohc/sqlite-worker test
 pnpm --filter @dohc/workspace-core test src/databases.test.ts
 pnpm test:desktop:e2e apps/desktop/e2e/sqliteImport.spec.ts
 ```
 
 Expected: pass.
 
 - [ ] **Step 5: Commit**
 
 ```bash
 git add packages/workspace-core services/sqlite-worker apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Support visible SQLite data files"
 ```
 
 ---
 
-## Phase 9: Postgres Cloud Sync And Self-Hosted Server
+## Phase 9: Better Auth, Postgres Cloud Sync, And Self-Hosted Server
 
 **Files:**
 
+- Create: `services/workspace-api/src/auth/betterAuth.ts`
+- Create: `services/workspace-api/src/auth/betterAuth.test.ts`
+- Modify: `services/workspace-api/src/auth/session.ts`
+- Create: `apps/desktop/src/renderer/CloudLogin.tsx`
+- Create: `apps/desktop/e2e/cloudLogin.spec.ts`
 - Modify: `services/workspace-api/src/server.ts`
 - Modify: `packages/workspace-postgres`
 - Create: `packages/workspace-sync/src/cloudSync.ts`
 - Create: `packages/workspace-sync/src/cloudSync.test.ts`
 - Create: `apps/desktop/e2e/cloudSync.spec.ts`
 - Modify: `docker-compose.dev.yml`
 - Modify: `docker-compose.self-host.yml`
 - Modify: `docs/self-hosting.md`
 
-- [ ] **Step 1: Write failing cloud sync tests**
+- [ ] **Step 1: Write failing Better Auth tests**
+
+`services/workspace-api/src/auth/betterAuth.test.ts` must assert:
+
+- email/password signup and login work against Postgres via the Drizzle adapter.
+- device authorization flow issues a usable desktop session (request device code, approve in browser-session context, poll succeeds, token works against the API).
+- organization plugin supports create/invite/role for team workspaces.
+- session validation middleware rejects missing/invalid/expired tokens with `unauthorized`.
+- `ResolveActor` resolves a Better Auth session to the same actor shape existing authz checks use.
+- local-only desktop flows never require auth.
+- no WorkOS/Convex auth dependency remains in workspace-api.
+
+- [ ] **Step 2: Implement Better Auth in workspace-api**
+
+- Mount Better Auth (Drizzle adapter, provider `pg`) inside workspace-api on the existing Postgres instance.
+- Enable `organization` and `deviceAuthorization` plugins.
+- Wire `ResolveActor` to Better Auth sessions; keep all downstream authz unchanged.
+- Email delivery: SMTP env config with console fallback for dev/self-host; production provider deferred.
+- Document the WorkOS-behind-Better-Auth enterprise SSO/SCIM upgrade path in `docs/architecture/dohc-cloud.md`.
+
+- [ ] **Step 3: Implement desktop device-flow login**
+
+- `CloudLogin.tsx` shows the device code, opens the verification URL in the system browser (via safe shell handler), polls for approval, and stores the session token with Electron `safeStorage`.
+- Login is only reachable from "Enable dohc Cloud sync"; local-only use never sees it.
+- `apps/desktop/e2e/cloudLogin.spec.ts` drives the flow against the local dev server with a test-approved device code.
+- Test seam (required — do not improvise): workspace-api under `DOHC_TEST_AUTH=1` (dev/test only, asserted absent in production builds) exposes a test-only approval route (e.g., `POST /test/device/approve`) backed by a seeded test user; the desktop app under `DOHC_DESKTOP_TEST=1` surfaces the verification URL/code via the test bridge instead of opening the system browser. The E2E reads the code from the bridge, approves via the API as the seeded user, asserts polling succeeds and the stored token authenticates a real API request. Mocking the entire device flow client-side is a test-quality failure the verifier must flag.
+- Service bring-up: add root scripts `dev:cloud` (compose up postgres/minio + workspace-api dev server as background tasks; hocuspocus added in Phase 10) and `check:cloud-ready` (bounded readiness poll of postgres/object storage/API — and hocuspocus when enabled — printing the exact remediation command for any unreachable service). The desktop Playwright config gets a helper that fails fast naming the bring-up command. Every cloud/collab E2E command block in Phases 9, 10, 15, and 18 starts with `pnpm dev:cloud && pnpm check:cloud-ready`.
+
+- [ ] **Step 4: Write failing cloud sync tests**
 
 Tests must assert:
 
 - local-first personal workspace can sync after login.
 - local-only workspace works without login.
 - shared/team workspace creates cloud-first local working copy.
 - normal allowed edits auto-sync.
 - permission changes/public sharing require explicit confirmation.
 - another collaborator sees synced updates.
 
-- [ ] **Step 2: Implement sync protocol**
+- [ ] **Step 5: Implement sync protocol**
 
 Sync protocol carries:
 
 - workspace manifest.
 - file content hashes.
 - change sets.
 - asset blobs.
 - database operation logs.
 - provenance.
 - conflict summaries.
 
-- [ ] **Step 3: Implement Postgres sync backend**
+- [ ] **Step 6: Implement Postgres sync backend**
 
 Use `workspace-postgres` as the only cloud/self-host backend for new architecture.
 
-- [ ] **Step 4: Run tests**
+- [ ] **Step 7: Run tests**
 
 ```bash
+pnpm --filter @dohc/workspace-api test src/auth
 pnpm --filter @dohc/workspace-sync test
 pnpm --filter @dohc/workspace-postgres test
 pnpm --filter @dohc/workspace-api test
+pnpm dev:cloud
+pnpm check:cloud-ready
+pnpm test:desktop:e2e apps/desktop/e2e/cloudLogin.spec.ts
 pnpm test:desktop:e2e apps/desktop/e2e/cloudSync.spec.ts
 ```
 
 Expected: pass.
 
-- [ ] **Step 5: Commit**
+- [ ] **Step 8: Commit**
 
 ```bash
-git add packages/workspace-sync packages/workspace-postgres services/workspace-api apps/desktop docker-compose.dev.yml docker-compose.self-host.yml docs/self-hosting.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
-git commit -m "Add Postgres cloud sync for desktop workspaces"
+git add packages/workspace-sync packages/workspace-postgres services/workspace-api apps/desktop docker-compose.dev.yml docker-compose.self-host.yml docs/self-hosting.md docs/architecture/dohc-cloud.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+git commit -m "Add Better Auth and Postgres cloud sync for desktop workspaces"
 ```
 
 ---
 
-## Phase 10: Liberal Collaboration And AI-Assisted Conflicts
+## Phase 10: Liberal Collaboration, Live Co-Editing, And AI-Assisted Conflicts
 
 **Files:**
 
 - Create: `packages/workspace-sync/src/collaborationPolicy.ts`
 - Create: `packages/workspace-sync/src/collaborationPolicy.test.ts`
 - Create: `packages/workspace-history/src/conflictResolution.ts`
 - Create: `packages/workspace-history/src/conflictResolution.test.ts`
+- Create: `services/hocuspocus/src/postgres-acl.ts`
+- Create: `services/hocuspocus/src/postgres-acl.test.ts`
+- Create: `apps/desktop/src/renderer/collab/useCollabDoc.ts`
 - Create: `apps/desktop/e2e/collaboration.spec.ts`
+- Create: `apps/desktop/e2e/liveCoEditing.spec.ts`
 - Modify: desktop sync UI
 
 - [ ] **Step 1: Write failing liberal policy tests**
 
 Tests must assert:
 
 - edit access allows normal user edits.
 - edit access allows normal agent edits.
 - no approval is required for ordinary file edits.
 - explicit protected folder blocks or proposes changes.
 - boundary crossings require confirmation.
+- collaborator edits appear in the shared workspace history timeline with correct attribution: which human, and which agent acting for whom.
+- returning to a shared workspace after time away surfaces a plain-language catch-up of change sets since the user last looked.
 
 - [ ] **Step 2: Write failing conflict tests**
 
 Tests must assert:
 
 - safe markdown changes auto-merge.
 - unmergeable conflict preserves both versions.
 - conflict summary is human-readable.
 - AI resolution proposal can be stored.
 - user can apply, keep both, or dismiss.
 - no Git conflict markers are inserted by default.
 
-- [ ] **Step 3: Implement collaboration policy**
+- [ ] **Step 3: Write failing Hocuspocus Postgres ACL tests**
+
+`services/hocuspocus/src/postgres-acl.test.ts` must assert:
+
+- edit access resolved from workspace-postgres grants allows document writes.
+- read-only access allows connect/read but rejects writes.
+- no access rejects the connection.
+- Better Auth session tokens are accepted as the connection credential.
+- no Convex import or Convex env var remains in the ACL path.
+
+- [ ] **Step 4: Write failing two-client live co-editing E2E**
+
+`apps/desktop/e2e/liveCoEditing.spec.ts` must launch two Electron clients on the same shared workspace markdown doc and assert:
+
+- concurrent edits from both clients converge to identical content.
+- remote presence/cursor is visible while the peer edits.
+- a client that disconnects, edits offline, and reconnects converges without data loss and without Git markers.
+- local-first personal workspaces work fully without Hocuspocus running.
+- typing latency stays within the existing typing budget while co-editing is active; propagation time between clients is measured and recorded.
+
+- [ ] **Step 5: Implement live co-editing**
+
+- Port `services/hocuspocus/src/convex-acl.ts` to `postgres-acl.ts` (workspace-postgres grants + Better Auth sessions). Mark `convex-acl.ts` for deletion in Phase 13.
+- Wire the desktop markdown editor to Yjs/Hocuspocus via `useCollabDoc.ts` for shared cloud-first workspaces only.
+- Canonical-state model (default, adopted): the CRDT doc is canonical while a shared text file has an active editor session; the filesystem is canonical while closed. The CRDT materializes back to the file on settle through the same batched sync/change-set path. The Phase 10 judge-panel design doc must define, and the implementation must TEST, each of these data-loss cases:
+  - active canonical state while a shared text file is open (and what "open" means across two clients).
+  - a base version/hash recorded for every materialization.
+  - watcher suppression for self-materialized writes (no materialize → watch → materialize loops).
+  - conflict behavior when the on-disk file changes outside Yjs while the doc is open (external agent edit during a live session).
+  - offline edit + reconnect convergence without loss.
+  - rename/delete of a file with an active Yjs doc.
+  - Every case above gets an explicit data-loss test; "preserves both versions" is the floor, silent loss is never acceptable.
+- CRDT applies to markdown/text only — never raw SQLite bytes or binary assets.
+
+- [ ] **Step 6: Implement collaboration policy**
 
 Policy should lean liberal:
 
 ```txt
 allowed edit -> sync
 explicit protected target -> propose/review
 boundary crossing -> confirm
 conflict -> AI-assisted resolution
 permission denied -> keep local unsynced and explain
 ```
 
-- [ ] **Step 4: Run collaboration E2E**
+- [ ] **Step 7: Run collaboration E2E**
 
 ```bash
 pnpm --filter @dohc/workspace-sync test
 pnpm --filter @dohc/workspace-history test
+pnpm --filter @dohc/hocuspocus test src/postgres-acl.test.ts
+pnpm dev:cloud
+pnpm check:cloud-ready
 pnpm test:desktop:e2e apps/desktop/e2e/collaboration.spec.ts
+pnpm test:desktop:e2e apps/desktop/e2e/liveCoEditing.spec.ts
 ```
 
 Expected: pass.
 
-- [ ] **Step 5: Commit**
+- [ ] **Step 8: Commit**
 
 ```bash
-git add packages/workspace-sync packages/workspace-history apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
-git commit -m "Add liberal collaboration and AI conflicts"
+git add packages/workspace-sync packages/workspace-history services/hocuspocus apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+git commit -m "Add liberal collaboration, live co-editing, and AI conflicts"
 ```
 
 ---
 
 ## Phase 11: Local Agent Integration And MCP
 
 **Files:**
 
 - Create: `packages/mcp/package.json`
 - Create: `packages/mcp/src/server.ts`
 - Create: `packages/mcp/src/tools.ts`
 - Create: `packages/mcp/src/tools.test.ts`
 - Create: `apps/desktop/src/agents/AgentIntegration.ts`
 - Create: `apps/desktop/src/agents/AgentIntegration.test.ts`
 - Create: `apps/desktop/e2e/localAgent.spec.ts`
-- Modify: desktop settings UI
+- Create: `apps/desktop/src/renderer/settings/DesktopSettings.tsx` (+ test) — a single settings surface reachable from the command palette and app menu, following the Design Review Loop rubric; created here because Phase 11 is its first consumer (no earlier phase builds settings)
 
 - [ ] **Step 1: Write failing MCP tests**
 
 MCP tools must include:
 
 ```txt
 dohc.list_workspaces
 dohc.workspace_status
 dohc.sync_now
 dohc.create_app
 dohc.test_app
 dohc.import_data
 dohc.query_database
 dohc.share
 dohc.resolve_conflict
 dohc.open_in_dohc
 ```
 
 Tests must assert tools operate on allowed workspace paths and reject path traversal.
 
 - [ ] **Step 2: Write failing local agent E2E**
 
 Flow:
 
 1. create local workspace.
 2. open workspace folder path.
 3. simulate external agent writing files.
 4. dohc detects and syncs changes.
 5. MCP `test_app` runs against local app.
 6. MCP `sync_now` reports clean state.
 
 - [ ] **Step 3: Implement MCP server**
 
 Desktop runs/advertises a local MCP server for Codex/Claude Code configuration. It should be optional and clearly user-controlled.
 
 - [ ] **Step 4: Add setup docs and UI**
 
 Desktop settings show:
 
 - workspace path.
 - MCP server status.
 - copyable MCP config snippet.
 - agent usage examples.
 
 - [ ] **Step 5: Run tests**
 
 ```bash
 pnpm --filter @dohc/mcp test
 pnpm --filter @dohc/desktop test src/agents
 pnpm test:desktop:e2e apps/desktop/e2e/localAgent.spec.ts
 ```
 
 Expected: pass.
 
 - [ ] **Step 6: Commit**
 
 ```bash
 git add packages/mcp apps/desktop docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Add local agent MCP integration"
 ```
 
 ---
 
 ## Phase 12: Web App Repositioning
 
 **Files:**
 
 - Rename or split: `apps/app` -> `apps/web` if safe
 - Modify: `apps/web/package.json`
 - Modify: web routes/components as needed
 - Create: `apps/web/src/__tests__/cloudWebRole.test.ts`
 - Modify: root scripts
 
 - [ ] **Step 1: Write failing web role tests**
 
 Tests must assert web supports:
 
 - cloud workspace access.
 - shared links.
 - mobile-friendly viewing/editing.
 - cloud-only workspace.
 - no local filesystem claims.
 - prompts user to install desktop for local folders/agent filesystem power.
 
 - [ ] **Step 2: Split or rename web app**
 
 If safe, rename `apps/app` to `apps/web` and update package names/imports.
 
-If not safe in one phase, keep path temporarily but rename product/package surfaces to `@dohc/web` and record deletion condition.
+The rename is "safe" iff after `git mv apps/app apps/web` plus updating pnpm-workspace.yaml, root scripts, tsconfig path aliases, and playwright config: (1) `grep -rn 'apps/app'` over `*.{ts,tsx,json,yml,yaml,mjs}` (excluding docs/ and node_modules) returns zero hits, (2) `pnpm -r --if-present typecheck && pnpm --filter @dohc/web test` passes, (3) `pnpm test:e2e` passes. If any condition fails after one focused fix pass, keep the path, record the failing condition verbatim in the execution log as the deletion condition, and move on. (Note: the package is already named `@dohc/web` while living at `apps/app`.)
 
 - [ ] **Step 3: Update web UX**
 
 Web should not feel like the primary local-files client. It should clearly be dohc Cloud/web access.
 
 - [ ] **Step 4: Run tests**
 
 ```bash
 pnpm --filter @dohc/web test
 pnpm --filter @dohc/web typecheck
 pnpm test:e2e
 ```
 
 Expected: pass.
 
 - [ ] **Step 5: Commit**
 
 ```bash
 git add apps package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Reposition web app for cloud access"
 ```
 
 ---
 
 ## Phase 13: Convex Deletion And Ported Test Gate
 
 **Files:**
 
 - Delete: `apps/web/convex` or `apps/app/convex`
 - Delete: `packages/workspace-convex-compat`
 - Delete/modify: Convex scripts and generated API files
 - Modify: `package.json`
 - Modify: `pnpm-lock.yaml`
 - Create: `docs/superpowers/reviews/2026-06-10-convex-deletion-review.md`
 
 - [ ] **Step 1: Create ported test map**
 
 The review must list every important Convex-era behavior and its replacement test:
 
 ```md
 | Convex-era behavior | Replacement package/test | Status |
 |---|---|---|
 | atom create/read/write | workspace-core/workspace-sync/workspace-postgres tests | pass |
 | authz boundaries | workspace-api + sync policy tests | pass |
+| auth/login (WorkOS via Convex) | Better Auth tests + desktop cloudLogin E2E | pass |
+| hocuspocus ACL (convex-acl) | postgres-acl tests + live co-editing E2E | pass |
 | app trust | local app trust + cloud sync tests | pass |
 | uploads/assets | desktop file type + workspace sync tests | pass |
 | onboarding/setup | desktop first-run tests | pass |
 ```
 
 - [ ] **Step 2: Run tests before deletion**
 
 ```bash
 pnpm check:desktop-local-first-baseline
 ```
 
 Expected: pass.
 
+- [ ] **Step 2.5: Cross-model pre-deletion audit**
+
+Run in background, registered in the Resume Snapshot (1 call, xhigh): `codex exec` (read-only sandbox) reading the Convex sources (`apps/app/convex` or `apps/web/convex`), `packages/workspace-convex-compat`, and `services/hocuspocus/src/convex-acl.ts` in full against the ported test map, asked to list (a) every user-visible or security-relevant behavior implemented in Convex code with NO row in the map, and (b) every map row whose named replacement test does not actually cover the behavior — with file:line citations. The triage subagent verifies each claimed gap; confirmed gaps get a map row plus a replacement test before Step 3 runs. Step 3 MUST NOT start while this audit is in flight. This hunts unknown-unknowns the diff-shaped reviews cannot see: a behavior missing from the map appears in no diff.
+
 - [ ] **Step 3: Delete Convex**
 
-Remove Convex-specific packages, scripts, generated API files, env examples, and compatibility package.
+Remove Convex-specific packages, scripts, generated API files, env examples, and compatibility package. This includes `services/hocuspocus/src/convex-acl.ts` (replaced by `postgres-acl.ts` in Phase 10) and the `@convex-dev/workos-authkit` dependency (replaced by Better Auth in Phase 9).
 
 Do not delete product behavior; delete only after replacement tests exist.
 
 - [ ] **Step 4: Run tests after deletion**
 
 ```bash
 pnpm -r --if-present typecheck
 pnpm -r --if-present test
 pnpm test:desktop:e2e
 pnpm check:debt
 git diff --check
 ```
 
 Expected: pass.
 
 - [ ] **Step 5: Commit**
 
 ```bash
-git add -A docs/superpowers/reviews/2026-06-10-convex-deletion-review.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
+# Full reviewed stage — the deletion touches sources, packages, lockfile, env examples
+git status --short   # paste this into the execution log so deletion scope is inspectable
+git add -A
+git status --short   # verify nothing unexpected remains unstaged
 git commit -m "Delete Convex after local-first replacements"
 ```
 
 ---
 
 ## Phase 14: Packaging, Updates, Signing Readiness, And Smoke Tests
 
 **Files:**
 
 - Create: `apps/desktop/electron-builder.yml` or builder config
 - Create: `apps/desktop/src/updates/*`
 - Create: `apps/desktop/src/updates/updateMachine.test.ts`
 - Create: `apps/desktop/scripts/package-smoke.mjs`
 - Modify: `package.json`
 - Modify: CI docs/config if present
 - Create: `docs/desktop.md`
 
 - [ ] **Step 1: Write failing packaging smoke**
 
 Smoke must assert:
 
 - desktop build exists.
 - main/preload/renderer build outputs exist.
 - Electron fuses are configured for release builds.
 - unsigned release build is not silently treated as production-signed.
 - package metadata uses `dohc`.
 
 - [ ] **Step 2: Implement builder config**
 
 Use `electron-builder` for initial packaging because:
 
 - t3code uses it successfully.
 - docs cover code signing and auto-update.
 - it supports macOS/Windows/Linux artifacts.
 
 Release signing secrets are not required for local dev, but CI/release config must fail safely if production signing is requested without credentials.
 
 - [ ] **Step 3: Implement update state machine tests**
 
 Do not require live update server. Test state transitions and user-visible messaging.
 
 - [ ] **Step 4: Run package smoke**
 
 ```bash
 pnpm build:desktop
 pnpm smoke:desktop
 pnpm --filter @dohc/desktop test src/updates
 ```
 
 Expected: pass.
 
 - [ ] **Step 5: Commit**
 
 ```bash
 git add apps/desktop docs/desktop.md package.json docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Add desktop packaging and update readiness"
 ```
 
 ---
 
 ## Phase 15: Self-Host, Cloud Naming, And Open-Source Readiness
 
 **Files:**
 
 - Modify: `docs/self-hosting.md`
 - Create: `docs/architecture/desktop-local-first.md`
 - Create: `docs/architecture/dohc-cloud.md`
 - Create: `docs/architecture/workspace-sync.md`
 - Modify: `README.md`
 - Modify: `docker-compose.self-host.yml`
 - Create: `scripts/check-self-host-desktop-path.mjs`
 - Modify: `package.json`
 
 - [ ] **Step 1: Document product shape**
 
 Docs must state:
 
 - `dohc` is the product.
 - `dohc Desktop` is the primary local-first client.
 - `dohc Cloud` is managed sync/hosting/collaboration.
 - self-hosted dohc runs the cloud/sync/collab server.
 - local-only works with no account.
 - federation is deferred.
+- the collaboration thesis: dohc brings git-grade building-collaboration (change sets, history, attribution, AI-assisted merge) to everyday people. dohc Cloud is the paid engine for shared building — this is why dohc is not an Obsidian clone, and why the history/attribution/catch-up surfaces are core product.
 
 - [ ] **Step 2: Write self-host check**
 
 Check:
 
 - Postgres starts.
 - object storage starts.
 - workspace API starts.
 - web starts.
 - Hocuspocus starts if enabled.
 - app tester starts.
 - sqlite worker starts.
 - desktop can connect to local self-host endpoint.
 
 - [ ] **Step 3: Run docs/smoke**
 
 ```bash
+pnpm dev:cloud
+pnpm check:cloud-ready
 pnpm check:self-host
 pnpm check:self-host-desktop-path
 ```
 
 Expected: pass or exact Docker/service blocker recorded.
 
 - [ ] **Step 4: Commit**
 
 ```bash
 git add README.md docs docker-compose.self-host.yml scripts/check-self-host-desktop-path.mjs package.json docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Document desktop local-first cloud shape"
 ```
 
 ---
 
 ## Phase 16: Performance Budgets And Native-Speed Gate
 
 **Files:**
 
 - Create: `packages/performance/package.json`
 - Create: `packages/performance/tsconfig.json`
 - Create: `packages/performance/src/budgets.ts`
 - Create: `packages/performance/src/measurements.ts`
 - Create: `packages/performance/src/assertBudget.ts`
 - Create: `packages/performance/src/assertBudget.test.ts`
 - Create: `apps/desktop/e2e/performance.spec.ts`
 - Create: `apps/desktop/src/performance/desktopMarks.ts`
 - Create: `apps/desktop/src/performance/desktopMarks.test.ts`
 - Create: `scripts/check-performance.mjs`
 - Create: `docs/superpowers/reviews/2026-06-10-desktop-performance-review.md`
 - Modify: `package.json`
 - Modify: execution log
 
 - [ ] **Step 1: Add performance package and budgets**
 
 Create `packages/performance/src/budgets.ts` with named budgets matching the Performance Budgets section:
 
 ```ts
 export const performanceBudgets = {
   coldLaunchToShellMs: 2000,
   warmLaunchToShellMs: 1000,
   createEmptyWorkspaceMs: 1000,
   openThousandFileWorkspaceMs: 1500,
   fileTreeSearchTenThousandPathsMs: 100,
   fileTreeSearchVisibleResultMs: 200,
   openMarkdown250KbMs: 150,
   typingLongTaskMs: 50,
   singleFileSyncDetectMs: 2000,
   hundredFileChangeSetMs: 3000,
   warmAppOpenMs: 1000,
   appTesterSmallAppMs: 15000,
   sqliteTenThousandRowsFirstPageMs: 1000,
   csvTenThousandRowsImportMs: 5000,
 } as const;
 ```
 
 - [ ] **Step 2: Write failing budget tests**
 
 `packages/performance/src/assertBudget.test.ts` must assert:
 
 - passing measurements under budget pass.
 - over-budget measurements fail with a helpful message.
-- CI environment multipliers require explicit `PERF_BUDGET_MULTIPLIER`.
+- CI environment multipliers require explicit `PERF_BUDGET_MULTIPLIER`, capped at 3.0, with a per-budget written justification naming the hardware constraint. Multipliers never apply to relative-regression ratchets (the 20% memory and 10% bundle rules) — those are environment-independent.
+- any edit to `budgets.ts` after its first commit must be named explicitly in that commit's Codex review prompt ("budget X changed from A to B because C").
 - missing measurements fail.
 
 - [ ] **Step 3: Instrument desktop**
 
 Add performance marks around:
 
 - Electron app ready.
 - first window created.
 - first renderer paint.
 - first workspace shell interactive.
 - workspace folder creation.
 - file tree loaded.
 - file tree search complete.
 - markdown file opened.
 - sync batch started/completed.
 - app runtime opened.
 - SQLite first page rendered.
 
 Marks must be available to Playwright Electron tests through a safe test-only bridge.
 
 - [ ] **Step 4: Write desktop performance E2E**
 
 `apps/desktop/e2e/performance.spec.ts` must measure:
 
 1. cold launch to visible shell.
 2. warm launch to visible shell.
 3. create empty workspace.
 4. open generated 1,000-file workspace.
 5. search generated 10,000-path file tree.
 6. open 250KB markdown file.
 7. batch 100 changed files.
 8. open warm cached app.
 9. open 10,000-row SQLite table first page.
 10. import 10,000-row CSV.
 
 The test should save measurements to:
 
 ```txt
 test-results/performance/desktop-performance.json
 ```
 
 and attach screenshots for the launch/file-tree/database states.
 
 - [ ] **Step 5: Add performance script**
 
 Create `scripts/check-performance.mjs` that:
 
 - reads `test-results/performance/desktop-performance.json`.
 - checks every required measurement.
 - compares each number to `packages/performance` budgets.
 - prints a clear table.
 - fails on missing or over-budget metrics.
 
 Add root script:
 
 ```json
 "check:performance": "node scripts/check-performance.mjs"
 ```
 
 - [ ] **Step 6: Fix performance issues**
 
-If any measurement is over budget, optimize before moving on.
+If any measurement is over budget, optimize before moving on. Exit rule: per over-budget metric, maximum 3 optimization attempts with recorded before/after numbers; after the third failed attempt, run the Recovery Protocol fresh-model consult (one Codex diagnosis of the hot path) before deferral; if still over, record the gap as a deferred finding for the Phase 16 checkpoint review rather than looping — but a metric that regressed relative to an earlier phase's recorded number is never deferrable.
 
 Expected optimization areas:
 
 - lazy-load heavy renderer panels.
 - virtualize large file trees/tables.
 - move scan/index/import work off the renderer thread.
 - debounce and batch file watcher work.
 - cache app builds.
 - page SQLite data.
 - avoid duplicate markdown parsing.
 - remove unnecessary React re-renders.
 - avoid sync polling loops.
 
 Record every optimization in the execution log with before/after numbers.
 
 - [ ] **Step 7: Write performance review**
 
 Create `docs/superpowers/reviews/2026-06-10-desktop-performance-review.md`:
 
 ```md
 # Desktop Performance Review
 
 ## Verdict
 
 ## Environment
 
 ## Measurements
 
 | Budget | Target | Measured | Pass |
 |---|---:|---:|---|
 
 ## Optimizations Made
 
 ## Regressions Prevented By Tests
 
 ## Remaining Performance Risks
 ```
 
 - [ ] **Step 8: Run performance verification**
 
 ```bash
 pnpm --filter @dohc/performance test
 pnpm --filter @dohc/desktop test src/performance
 pnpm test:desktop:e2e apps/desktop/e2e/performance.spec.ts
 pnpm check:performance
 ```
 
 Expected: pass. If CI hardware makes a hard budget unrealistic, record local environment and use an explicit multiplier with explanation. Do not silently loosen budgets.
 
 - [ ] **Step 9: Commit**
 
 ```bash
 git add packages/performance apps/desktop scripts/check-performance.mjs docs/superpowers/reviews/2026-06-10-desktop-performance-review.md package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Add desktop performance budgets"
 ```
 
 ---
 
 ## Phase 17: Evolution Cleanup And Codebase Excellence Gate
 
 **Files:**
 
 - Create: `docs/architecture/codebase-map.md`
 - Create: `docs/superpowers/reviews/2026-06-10-desktop-local-first-tech-debt-audit.md`
 - Create: `knip.json`
 - Create: `scripts/check-architecture-debt.mjs`
 - Modify: `scripts/check-tech-debt.mjs`
 - Modify: `package.json`
 - Modify/delete: obsolete code identified by this phase
 - Modify: execution log
 
 - [ ] **Step 1: Install unused-code tooling**
 
 Install `knip` for unused files, exports, and dependency detection:
 
 ```bash
 pnpm add -D -w knip
 ```
 
 Add root scripts:
@@ -1796,309 +2189,325 @@ Expected:
 
 Delete or consolidate as much as tests allow.
 
 Priority deletion targets:
 
 - Convex packages, generated files, scripts, env vars, docs, and runtime imports.
 - `packages/workspace-convex-compat`.
 - dual-backend switch code.
 - Convex-only tests once replacement tests prove the behavior.
 - duplicated backend clients.
 - duplicated file tree/path utilities.
 - duplicated file-type detection tables.
 - duplicated upload/import code.
 - stale `.views` runtime/product language after `.apps` tests cover replacement.
 - web-first onboarding/setup code that conflicts with desktop first-run.
 - old agent tools that duplicate MCP/local-file workflows.
 - dead scripts from the old dev stack.
 - stale docs that describe the old web-first/Convex architecture as current.
 
 Keep only:
 
 - compatibility/migration code backed by active tests.
 - historical docs clearly marked historical.
 - security checks.
 - review gates.
 - app trust checks.
 - provenance/history code.
 
 - [ ] **Step 7: Consolidate architecture**
 
 For every duplicated helper, choose one owner package:
 
 ```txt
 workspace path validation -> packages/workspace-core
 file type detection -> packages/workspace-core
 filesystem scan/diff/apply -> packages/workspace-fs
 sync policy -> packages/workspace-sync
 change sets/conflicts -> packages/workspace-history
 database file rules -> packages/workspace-core + sqlite-worker
 MCP tool schemas -> packages/mcp
 IPC schemas -> desktop-bridge-contracts or apps/desktop/src/ipc
 ```
 
 Move logic to the owner, update imports, and delete the duplicates.
 
 - [ ] **Step 8: Write tech debt audit**
 
 `docs/superpowers/reviews/2026-06-10-desktop-local-first-tech-debt-audit.md` must include:
 
 ```md
 # Desktop Local-First Tech Debt Audit
 
 ## Standard
 
 This branch should leave dohc in a lean, coherent state that a top-tier engineer would want to work in.
 
 ## Code Deleted
 
 ## Code Consolidated
 
 ## Dependencies Removed
 
 ## Convex Deletion Evidence
 
 ## Web-First Code Retained And Why
 
 ## Compatibility Code Retained And Deletion Conditions
 
 ## Allowlisted Unused/Architecture Findings
 
 ## Tests That Prove Behavior Survived
 
 ## Commands Run
 
 ## Remaining Risk
 ```
 
 - [ ] **Step 9: Run post-cleanup verification**
 
 ```bash
+pnpm dev:cloud
+pnpm check:cloud-ready
 pnpm -r --if-present typecheck
 pnpm -r --if-present test
 pnpm build:desktop
 pnpm test:desktop:e2e
 pnpm smoke:desktop
 pnpm check:performance
 pnpm test:e2e
 pnpm check:self-host
 pnpm check:lean
 git diff --check
 ```
 
 Expected: pass. Fix cleanup regressions before continuing.
 
 - [ ] **Step 10: Commit**
 
 ```bash
 git add -A docs/architecture/codebase-map.md docs/superpowers/reviews/2026-06-10-desktop-local-first-tech-debt-audit.md knip.json scripts/check-architecture-debt.mjs scripts/check-tech-debt.mjs package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Clean up desktop local-first evolution"
 ```
 
 ---
 
 ## Phase 18: Final E2E Product Readiness Matrix
 
 **Files:**
 
 - Create: `apps/desktop/e2e/productReadiness.spec.ts`
 - Create: `docs/superpowers/reviews/2026-06-10-desktop-local-first-readiness-review.md`
 - Modify: execution log
 
 - [ ] **Step 1: Write final product readiness E2E**
 
 The test must run this full flow:
 
 1. launch Electron desktop.
 2. create local-only personal workspace with no account.
 3. verify real folder exists on disk.
 4. create markdown, CSV, image fixture, audio fixture, PDF fixture, SQLite, and app files.
 5. point simulated local agent at the folder and modify files.
 6. dohc detects batched changes.
 7. create finance tracker app from CSV/SQLite.
 8. run app tester.
 9. reload app and verify persistence.
 10. enable cloud sync.
 11. sync to Postgres cloud/self-host dev server.
 12. open web client and see synced files.
 13. create shared workspace.
 14. collaborator edits normal file and syncs without approval.
 15. boundary-crossing action asks for confirmation.
 16. conflict is summarized without Git markers.
 17. MCP reports workspace clean.
 
 - [ ] **Step 2: Run full verification**
 
 ```bash
+pnpm dev:cloud
+pnpm check:cloud-ready
 pnpm -r --if-present typecheck
 pnpm -r --if-present test
 pnpm build:desktop
 pnpm test:desktop:e2e
 pnpm smoke:desktop
 pnpm check:performance
 pnpm test:e2e
 pnpm check:self-host
 pnpm check:lean
 git diff --check
 ```
 Expected: pass. If any external service is unavailable, record exact blocker and rerun after service is started.
 
 - [ ] **Step 3: Write readiness review**
 
 `docs/superpowers/reviews/2026-06-10-desktop-local-first-readiness-review.md` must answer:
 
 - Is desktop usable as the primary client?
 - Does local-only work without account?
 - Does local folder editing work with external agents?
 - Does cloud sync work?
 - Does shared collaboration lean liberal without losing boundaries?
 - Do apps and SQLite work from visible files?
 - Is web correctly secondary?
 - Is Convex fully removed?
 - Is self-hosting honest?
 
 - [ ] **Step 4: Commit**
 
 ```bash
 git add apps/desktop/e2e/productReadiness.spec.ts docs/superpowers/reviews/2026-06-10-desktop-local-first-readiness-review.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
 git commit -m "Verify desktop local-first product readiness"
 ```
 
 ---
 
 ## Acceptance Criteria
 
 The plan is complete only when:
 
 - dohc Desktop launches and is usable as the primary client.
 - local-only workspace works with no account.
 - user can choose `~/dohc` or attach arbitrary folders.
 - personal workspace defaults to local-first.
 - shared/team workspace defaults to cloud-first with local working copy.
 - local files are real files on disk.
 - external Codex/Claude Code-style agents can edit the folder and dohc reflects changes.
 - dohc MCP tools expose sync/share/app/import/test/status capabilities.
 - sync is automatic, settled, batched, and avoids half-written files.
 - dohc-native history/change sets exist without Git as default.
 - conflicts are AI-assisted/human-readable and do not use Git markers by default.
 - normal shared edits sync without approval when the user has edit access.
 - real boundary crossings ask for confirmation.
+- dohc Cloud login works from desktop via the Better Auth device authorization flow; self-host gets working auth with no external vendor account.
+- two desktop clients can live co-edit shared workspace markdown through Hocuspocus/Yjs with convergence, presence, and offline-reconnect safety; the Hocuspocus ACL has no Convex dependency.
+- workspace history is a visible first-class surface: a change-set timeline with kind, human/agent attribution, plain-language summaries, and files touched — working in local-only mode and in shared workspaces.
+- returning to a shared workspace surfaces a plain-language catch-up of what changed since the user last looked.
 - apps are visible `.apps/<name>` source folders.
 - user-meaningful SQLite databases can be visible `.sqlite` files.
 - uploads/import/export support CSV, TXT, JSON, PNG/JPEG/WebP/GIF/SVG, PDF, audio, video, SQLite, and generic files.
 - app testing catches blank/fake/non-persistent apps.
 - Postgres powers cloud/self-host sync.
 - web is retained as cloud/shared/mobile-friendly access, not the local-first center.
 - Convex is removed after replacement tests pass.
 - self-host docs and smoke checks exist.
 - Electron E2E tests, screenshots, and smoke tests pass.
 - performance budgets are measured and pass.
 - a dedicated evolution cleanup phase deletes or consolidates obsolete code before final readiness.
+- every phase commit received an independent third-party review and every checkpoint received a cumulative third-party review (Codex gpt-5.5 xhigh preferred; a recorded fallback reviewer otherwise), with all findings fixed or explicitly rejected in the execution log.
 - `pnpm check:lean` passes.
 - tech debt audit proves obsolete code was deleted, consolidated, or justified with deletion conditions.
 
 ## Self-Grade Rubric Before Final
 
 The implementation must score `2` in every row before it can be called complete.
 
 | Area | 0 | 1 | 2 |
 |---|---|---|---|
 | Desktop | absent | launches but incomplete | Electron desktop is primary usable client |
-| Native UX | web shell in Electron | partial desktop polish | native-feeling first-run/workspace shell with tested shortcuts/layout |
+| Native UX | web shell in Electron | partial desktop polish | native-feeling muted dohc shell with tested screenshots, shortcuts, layout, and no marketing chrome |
 | Performance | unmeasured or slow | partial measurements | explicit budgets pass for launch, file tree, sync, apps, SQLite, imports |
 | Local files | projection only | partial folder support | real local folders are the main workspace surface |
 | Accountless local | login required | partial local-only | local-only works with no account |
 | Sync | manual/noisy | partial batching | settled batched sync with history and conflict tests |
-| Collaboration | restrictive or unsafe | partial liberal policy | edit access syncs freely; real boundary crossings guarded |
+| Auth | absent or vendor-locked | login works but untested edge cases | Better Auth email/device-flow/orgs tested for cloud and self-host with no vendor dependency |
+| Collaboration | restrictive or unsafe | partial liberal policy | edit access syncs freely; live co-editing converges with presence and offline-reconnect tests; change-set history with human/agent attribution and catch-up surfaces visible and tested; real boundary crossings guarded |
 | Apps | hidden/static | visible but untested | visible `.apps` source folders with tested persistent runtime |
 | SQLite/data | markdown fallback | partial imports | visible SQLite/data imports tested end to end |
 | Agents/MCP | absent | folder only | local agents edit files and MCP exposes dohc-aware tools |
 | Cloud/self-host | unclear | dev only | Postgres sync server and self-host smoke documented/tested |
 | Web role | still primary/local-confused | partially repositioned | web clearly serves cloud/shared/mobile access |
 | Convex removal | still required | partially removed | Convex deleted after replacement tests pass |
 | Security | renderer/IPC unsafe | partial hardening | context isolation, sandbox, validated IPC, fuses/signing readiness tested |
 | E2E proof | unit-only | partial flows | desktop product readiness E2E passes |
 | Tech debt | old code accumulates | cleanup incomplete | obsolete code deleted/consolidated with audit evidence |
 
 ## Final Response Requirements
 
 Final response must include:
 
 - changed file summary.
 - code deleted/consolidated.
 - commits made.
 - tests run.
 - failing tests, if any.
 - Electron screenshots/manual smoke results.
+- UI/UX screenshot/design review notes.
 - performance measurements and budget result.
 - self-host smoke result.
 - self-grade table.
 - remaining risks.
 
 Do not send a final "done" response until all phases are complete, the execution log is complete, the self-grade rubric is all `2`, and full verification passes.
 
 ## Copy-Paste Prompt For Implementing Agent
 
 ```text
 Please branch out and fully execute the desktop local-first dohc plan.
 
 Work in /home/ice/dev/dohc.
 
 Branching:
 - Start after the completed dual-backend branch is merged or explicitly chosen as base.
-- Create branch: codex/desktop-local-first-cloud-sync.
+- Create branch: claude/desktop-local-first-cloud-sync.
 
 Outcome:
-Implement docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md fully. Pivot dohc to Electron-first and local-file-first. Cut Convex after replacement tests prove the behavior. Keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, AppTester, and agent-output pieces from the completed old plan.
+Implement docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md fully. Pivot dohc to Electron-first and local-file-first. Cut Convex after replacement tests prove the behavior. Keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, AppTester, and agent-output pieces from the completed old plan. Auth is Better Auth inside workspace-api (WorkOS deferred as the enterprise SSO path behind it). Live co-editing via Hocuspocus/Yjs for shared workspace markdown is in scope, with the Hocuspocus ACL ported from Convex to Postgres.
 
 Read first:
 1. AGENTS.md
 2. apps/app/AGENTS.md if touching current app code
 3. apps/app/convex/_generated/ai/guidelines.md before deleting or porting Convex code
 4. docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md
 5. docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md
 6. docs/superpowers/reviews/2026-06-09-dual-backend-tech-debt-audit.md
 7. docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md
 8. docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md if it exists
 
 Execution mode:
 - Work phase by phase in order.
 - Use strict TDD: failing test, confirmed failure, implementation, passing targeted test, regression tests, E2E/smoke where relevant, delete-or-justify, execution log, commit.
+- Use native multi-agent orchestration per the plan's Orchestration section: recon fan-outs before heavy phases, design judge panels before Phases 9 and 10, per-phase verifier subagents before each commit, multi-agent adversarial reviews at checkpoints, background long-running tasks, and self-paced loops while AFK.
+- After every phase commit and at every checkpoint, run independent third-party review using the effort tier from the plan's Codex third-party review section: xhigh for checkpoints and high-risk phases (2, 4, 5, 9, 10, 11, 13, 16, 17, 18); high for low-risk phases (0, 1, 12, 14, 15) and advisory screenshot/scenario passes. If preferred Codex gpt-5.5 is unavailable, use the fallback chain and record the reviewer in the execution log. Fix or explicitly reject every finding.
+- Role split: the lead implementation agent owns code, tests, commits, and the execution log; Codex is used only as read-only independent reviewer/red-team/consultant, and all Codex findings are verified by non-Codex verifiers before fixes land.
+- For UI phases, inspect screenshots and explicitly record whether the UI feels native, muted, fast, and consistent with dohc.
 - Keep going while I am AFK.
 - Do not stop because work is long, difficult, slow, or partially complete.
 - If interrupted/resumed, read the execution log, inspect git status, run nearest test for last changed area, and continue from first incomplete phase.
 
 Non-negotiables:
 - Electron renderer must not get raw Node/Electron access.
 - IPC/preload APIs must be narrow and validated.
 - Local-only personal workspace works with no account.
 - Normal edits sync automatically when user has edit access.
 - Guard only real boundary crossings.
 - Do not CRDT-sync raw SQLite bytes.
 - Do not store binary assets as markdown text.
 - Delete Convex only after replacement tests prove behavior.
 - Reduce tech debt; deletion is valuable work.
 - Performance is a product invariant. The app must feel native and fast. Do not accept slow startup, sluggish file trees, janky typing, slow sync, slow app opens, or slow SQLite/import flows.
+- Preserve dohc's current simple, clean, muted style. Take inspiration from Obsidian, Codex, t3code, Linear, and Raycast. Do not add marketing heroes, decorative gradients/orbs, card-heavy dashboards, or loud palettes.
 
 Testing:
 - Install and use Electron E2E tooling, including Playwright Electron automation.
 - Run targeted tests in every phase.
-- Run Electron screenshots/smokes for desktop phases.
+- Run Electron screenshots/smokes for desktop phases and check layout, text fit, command palette, file tree, first-run, file views, and agent activity UI.
 - Add/update performance measurements for phases that touch desktop UX, file trees, sync, apps, SQLite, imports, or agents.
 - Run security/collaboration regressions after touching auth, sync, sharing, sandbox, IPC, apps, SQLite, or agents.
 - Run Phase 16 performance verification before cleanup.
 - Run Phase 17 cleanup/deletion verification before final readiness.
 - Run full Phase 18 verification before final response.
 - Run `pnpm check:performance` before final response.
 - Run `pnpm check:lean` before final response.
 - Do not skip, delete, or weaken tests to move forward.
 
 Stop only if:
-- same blocker remains after three concrete attempts.
+- the same blocker remains after three concrete attempts plus the Recovery Protocol fresh-model consult.
 - missing external secret/service is genuinely required.
 - user decision is genuinely required.
 - continuing would violate a non-negotiable.
 
 Final response:
-- If complete, include changed file summary, deleted/consolidated code, commits, tests, Electron smoke screenshots/results, performance measurements, self-host smoke, self-grade table, and remaining risks.
+- If complete, include changed file summary, deleted/consolidated code, commits, tests, Electron smoke screenshots/results, UI/UX review notes, performance measurements, self-host smoke, self-grade table, and remaining risks.
 - If blocked, say blocked and list incomplete phases, attempts, files inspected, commands run, failing tests, and smallest required input.
 ```
diff --git a/docs/superpowers/reviews/2026-06-10-desktop-local-first-cloud-sync-plan-audit.md b/docs/superpowers/reviews/2026-06-10-desktop-local-first-cloud-sync-plan-audit.md
new file mode 100644
index 0000000..6749c09
--- /dev/null
+++ b/docs/superpowers/reviews/2026-06-10-desktop-local-first-cloud-sync-plan-audit.md
@@ -0,0 +1,138 @@
+# Desktop Local-First Cloud Sync Plan Audit
+
+Date: 2026-06-10
+
+Reviewed plan: [`docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md)
+
+## Verdict
+
+Almost handoff-ready.
+
+The updated plan fixed the major first-pass blockers around desktop Playwright wiring, broad Convex deletion staging, explicit cloud-service bring-up, governance-source reads, and live co-editing data-loss requirements.
+
+The Codex collaboration model is good if the intended shape is: **Claude or another lead agent implements, Codex acts as independent reviewer/red-team/recovery consultant, and Codex never authors production artifacts.** That separation is exactly the right instinct. It preserves independent review, gives you cross-model critique, and avoids burning Codex budget on ordinary keystrokes.
+
+Before starting, fix the remaining stale Codex instructions in the main loop and copy-paste prompt. They are small text edits, but important because agents usually obey the prompt block literally.
+
+## Findings
+
+### P1: Copy-paste prompt and main loop still override Codex effort tiering
+
+The plan now has a good Codex budget model: high-risk phase reviews and checkpoints use `xhigh`; low-risk reviews and advisory uses can use `high`; fallback reviewers are allowed when the preferred Codex model/tool is unavailable.
+
+But older command examples still tell the implementer to run `model_reasoning_effort="xhigh"` after every phase commit. The copy-paste prompt repeats that instruction. Because the copy-paste prompt is what the implementing agent is most likely to follow, this can burn Codex quota unnecessarily and undermine the budget rule.
+
+Evidence:
+
+- [`plan:L292`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L292)
+- [`plan:L334`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L334)
+- [`plan:L336`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L336)
+- [`plan:L2471`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L2471)
+
+Recommendation:
+
+Replace the stale examples with wording like:
+
+```text
+After every phase commit, run independent third-party review using the effort tier specified in the Codex third-party review section. Prefer:
+- xhigh for checkpoints and high-risk phases 2, 4, 5, 9, 10, 11, 13, 16, 17, 18.
+- high for low-risk phases 0, 1, 12, 14, 15 and advisory screenshot/scenario passes.
+
+If preferred Codex gpt-5.5 is unavailable, use the fallback chain and record the reviewer in the execution log.
+```
+
+The copy-paste prompt should say the same thing rather than hardcoding `xhigh` for every phase.
+
+### P2: Copy-paste stop conditions are stale
+
+The main plan requires the Recovery Protocol fresh-model consult before declaring blocked after repeated attempts. The copy-paste prompt still says to stop after three attempts, without the required recovery consult.
+
+Evidence:
+
+- [`plan:L420`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L420)
+- [`plan:L442`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L442)
+- [`plan:L2503`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L2503)
+
+Recommendation:
+
+Update the prompt block so its stop condition matches the main plan:
+
+```text
+Stop only if the same blocker remains after three concrete attempts plus the Recovery Protocol fresh-model consult, or if an external secret/service, user decision, or non-negotiable violation genuinely blocks progress.
+```
+
+### P2: Codex preflight wording has one confusing edge case
+
+Phase 0 says failed Codex capabilities disable only the uses needing that capability and "never the review gate." That is true for optional `codex exec` and image attachment uses, but not for `codex exec review`: if review itself fails, the plan should explicitly trigger the independent-review fallback chain.
+
+Evidence:
+
+- [`plan:L343`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L343)
+- [`plan:L652`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L652)
+
+Recommendation:
+
+Change the Phase 0 preflight wording to:
+
+```text
+If optional Codex capabilities fail, disable only the uses needing them. If `codex exec review` or the preferred model fails, use the independent-review fallback chain from the Codex third-party review section.
+```
+
+### P3: Make the lead/Codex role split explicit in the copy-paste prompt
+
+The detailed plan says Codex is review-only and must not author implementation artifacts. That is good. The copy-paste prompt does not make the role split as explicit, and this matters because it uses a `claude/` branch name while heavily invoking Codex.
+
+Evidence:
+
+- [`plan:L347`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L347)
+- [`plan:L460`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L460)
+- [`plan:L2452`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L2452)
+- [`plan:L2470`](../plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md#L2470)
+
+Recommendation:
+
+Add one line to the prompt:
+
+```text
+Role split: the lead implementation agent owns code, tests, commits, and execution log; Codex is used only as read-only independent reviewer/red-team/consultant, with all Codex findings verified by non-Codex verifiers before fixes land.
+```
+
+## Resolved First-Pass Findings
+
+- Desktop Playwright config contradiction is fixed. Phase 2 now creates `apps/desktop/playwright.config.ts`, keeps root `playwright.config.ts` untouched, and uses `playwright test --config apps/desktop/playwright.config.ts`.
+- Phase 2 now includes `pnpm-workspace.yaml` for the Electron `onlyBuiltDependencies` allowlist.
+- Convex deletion staging is fixed. Phase 13 now uses full `git add -A` after a recorded `git status --short`.
+- Cloud service bring-up is now listed in the Phase 9, Phase 10, Phase 15, Phase 17, and Phase 18 command blocks.
+- Governance source-read exception is now explicit: digests cannot replace direct reads of `AGENTS.md`, `apps/app/AGENTS.md`, or Convex guidelines before governed edits.
+- Phase 10 now defines the canonical-state model and requires data-loss tests for active CRDT sessions, materialization base versions, watcher suppression, external edits during live sessions, offline reconnect, and rename/delete.
+
+## Codex Collaboration Assessment
+
+The collaboration design is strong with the small prompt cleanup above.
+
+What is good:
+
+- Codex is independent and read-only for reviews.
+- Codex is not assigned implementation lanes, scripts, migrations, or tests.
+- Codex findings are triaged and verified by non-Codex verifiers before they become work.
+- Mandatory reviews get budget priority; discretionary Codex uses are capped and skippable.
+- Codex transcripts go to `docs/superpowers/reviews/codex/` instead of bloating the execution log.
+- Phase 13 adds a valuable cross-model pre-deletion audit over Convex source, which is exactly where diff-only review can miss behavior.
+- Recovery consults are bounded and do not reset the blocked-attempt counter.
+
+What to keep in mind:
+
+- This is not a good plan for Codex as the lead implementer, because the plan intentionally says Codex must not author or materially shape production artifacts. That is fine if Claude or another agent is lead.
+- If the team wants Codex to implement, the role split must be rewritten. Otherwise Codex should stay reviewer/red-team only.
+
+## Verification Performed
+
+- Reviewed the updated plan front matter, AI execution contract, Codex collaboration section, Phase 0 preflight, Phase 2 Electron/Playwright setup, Phase 9 cloud auth/sync, Phase 10 collaboration/live co-editing, Phase 13 Convex deletion, Phase 15/17/18 service bring-up, acceptance criteria, and copy-paste prompt.
+- Ran `git diff --check -- docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/reviews/2026-06-10-desktop-local-first-cloud-sync-plan-audit.md`; result was clean.
+- Verified local Codex CLI presence: `/mnt/c/Users/ice/.codex/bin/wsl/81645c5d269e0fb2/codex`, version `codex-cli 0.137.0-alpha.4`.
+- Verified `codex exec review --help` supports `--commit`, `--base`, `--uncommitted`, `-m`, `-c`, `--json`, and `--output-schema`.
+- Did not run an actual `gpt-5.5` review invocation, so model/auth availability should still be verified by Phase 0 as the plan requires.
+
+## Summary
+
+Fix the three prompt/wording issues above, then I would consider this ready for the team to start. The architecture and execution loop are ambitious but coherent, and the Codex collaboration setup is meaningfully better than "ask another model to look at it" because it has independence, budget, provenance, verification, and bounded recovery rules.
diff --git a/package.json b/package.json
index b6999d9..a851ecf 100644
--- a/package.json
+++ b/package.json
@@ -1,35 +1,36 @@
 {
   "name": "dohc",
   "private": true,
   "type": "module",
   "engines": {
     "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
     "pnpm": "10.24.0"
   },
   "scripts": {
     "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
     "dev:app": "pnpm --filter @dohc/web --if-present run dev",
     "dev:sync": "node scripts/dev-sync.mjs",
     "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
     "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
     "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
     "build": "pnpm -r --if-present build",
     "start": "pnpm --filter @dohc/web --if-present run start",
     "preview": "pnpm --filter @dohc/web --if-present run preview",
     "reset:dev": "node scripts/reset-dev-data.mjs",
     "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
     "typecheck": "pnpm -r --if-present typecheck",
     "test": "pnpm -r --if-present test",
     "test:e2e": "playwright test",
     "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
     "sync:local": "pnpm --filter @dohc/workspace-fs sync",
     "lint": "pnpm -r --if-present lint",
     "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
+    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
     "check:self-host": "node scripts/check-self-host.mjs",
     "check:debt": "node scripts/check-tech-debt.mjs"
   },
   "packageManager": "pnpm@10.24.0",
   "devDependencies": {
     "@playwright/test": "^1.60.0"
   }
 }
diff --git a/scripts/check-desktop-local-first-baseline.mjs b/scripts/check-desktop-local-first-baseline.mjs
new file mode 100644
index 0000000..78e3277
--- /dev/null
+++ b/scripts/check-desktop-local-first-baseline.mjs
@@ -0,0 +1,30 @@
+import { spawnSync } from "node:child_process";
+
+// Tests must run under Node 22.13.0: Node 25 breaks 17 @dohc/web tests
+// (see execution log Environment section). Pin via PATH prefix.
+const pinnedNodeBin = "/home/ice/.local/share/nvm/v22.13.0/bin";
+const pnpmBin = "/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin";
+
+const env = {
+  ...process.env,
+  PATH: `${pinnedNodeBin}:${pnpmBin}:${process.env.PATH ?? ""}`,
+};
+
+const commands = [
+  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
+  ["pnpm", ["--filter", "@dohc/web", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-postgres", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-fs", "test"]],
+  ["pnpm", ["--filter", "@dohc/workspace-api", "test"]],
+  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
+  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
+  ["pnpm", ["--filter", "@dohc/agent-sandbox", "test"]],
+  ["pnpm", ["check:debt"]],
+];
+
+for (const [cmd, args] of commands) {
+  console.log(`\n$ ${cmd} ${args.join(" ")}`);
+  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
+  if (result.status !== 0) process.exit(result.status ?? 1);
+}

exec
/bin/bash -lc "cat package.json && find . -maxdepth 3 -name package.json -print | sort | sed 's#"'^./##'"' | xargs -r -n1 sh -c 'printf \"--- %s\\n\" \""'$0"; grep -E "'"\\\"name\\\"|\\\"test\\\"|\\\"typecheck\\\"\" \""'$0" | head -20'"'" in /home/ice/dev/dohc
2026-06-10T08:10:04.798588Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open
 succeeded in 5938ms:
{
  "name": "dohc",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
    "pnpm": "10.24.0"
  },
  "scripts": {
    "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
    "dev:app": "pnpm --filter @dohc/web --if-present run dev",
    "dev:sync": "node scripts/dev-sync.mjs",
    "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
    "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
    "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
    "build": "pnpm -r --if-present build",
    "start": "pnpm --filter @dohc/web --if-present run start",
    "preview": "pnpm --filter @dohc/web --if-present run preview",
    "reset:dev": "node scripts/reset-dev-data.mjs",
    "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "test:e2e": "playwright test",
    "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
    "sync:local": "pnpm --filter @dohc/workspace-fs sync",
    "lint": "pnpm -r --if-present lint",
    "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
    "check:self-host": "node scripts/check-self-host.mjs",
    "check:debt": "node scripts/check-tech-debt.mjs"
  },
  "packageManager": "pnpm@10.24.0",
  "devDependencies": {
    "@playwright/test": "^1.60.0"
  }
}
apps/app/package.json: 1: printf: Illegal option --
  "name": "@dohc/web",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
node_modules/accessor-fn/package.json: 1: printf: Illegal option --
  "name": "accessor-fn",
    "name": "Vasco Asturiano",
node_modules/ai/package.json: 1: printf: Illegal option --
  "name": "ai",
    "test": "pnpm test:node && pnpm test:edge",
node_modules/ansi-regex/package.json: 1: printf: Illegal option --
	"name": "ansi-regex",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsd",
		"test",
node_modules/ansi-styles/package.json: 1: printf: Illegal option --
	"name": "ansi-styles",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsd",
node_modules/ansis/package.json: 1: printf: Illegal option --
"name":"ansis",
node_modules/argparse/package.json: 1: printf: Illegal option --
  "name": "argparse",
    "test": "npm run lint && nyc mocha",
node_modules/assertion-error/package.json: 1: printf: Illegal option --
  "name": "assertion-error",
    "test",
    "test": "deno test --coverage=coverage",
node_modules/ast-kit/package.json: 1: printf: Illegal option --
  "name": "ast-kit",
    "test": "vitest",
    "typecheck": "tsc --noEmit"
node_modules/async-channel/package.json: 1: printf: Illegal option --
  "name": "async-channel",
    "test": "jest --env=node --colors --coverage test",
node_modules/async-mutex/package.json: 1: printf: Illegal option --
  "name": "async-mutex",
    "test": "yarn lint && nyc --reporter=text --reporter=html --reporter=lcov mocha test/*.ts",
node_modules/babel-dead-code-elimination/package.json: 1: printf: Illegal option --
  "name": "babel-dead-code-elimination",
    "typecheck": "tsc",
    "test": "vitest run",
node_modules/bail/package.json: 1: printf: Illegal option --
  "name": "bail",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/baseline-browser-mapping/package.json: 1: printf: Illegal option --
  "name": "baseline-browser-mapping",
    "test": "npm run build && npm run fix-cli-permissions && npm run test:format && npm run test:lint && npm run test:jasmine && npm run test:jasmine-browser",
node_modules/bezier-js/package.json: 1: printf: Illegal option --
  "name": "bezier-js",
    "test": "npm run prettier jest",
node_modules/bidi-js/package.json: 1: printf: Illegal option --
  "name": "bidi-js",
    "test": "npx babel-node --plugins @babel/plugin-transform-modules-commonjs test/runTestsOnSrc.js",
node_modules/birpc/package.json: 1: printf: Illegal option --
  "name": "birpc",
    "typecheck": "tsc --noEmit",
    "test": "vitest"
node_modules/boolbase/package.json: 1: printf: Illegal option --
  "name": "boolbase",
    "test": "echo \"Error: no test specified\" && exit 1"
node_modules/browserslist/package.json: 1: printf: Illegal option --
  "name": "browserslist",
node_modules/cac/package.json: 1: printf: Illegal option --
  "name": "cac",
    "test": "jest",
node_modules/caniuse-lite/package.json: 1: printf: Illegal option --
  "name": "caniuse-lite",
    "name": "Ben Briggs",
node_modules/canvas-color-tracker/package.json: 1: printf: Illegal option --
  "name": "canvas-color-tracker",
    "name": "Vasco Asturiano",
node_modules/ccount/package.json: 1: printf: Illegal option --
  "name": "ccount",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/chai/package.json: 1: printf: Illegal option --
  "name": "chai",
    "test",
    "test": "npm run test-node && npm run test-chrome",
node_modules/chalk/package.json: 1: printf: Illegal option --
	"name": "chalk",
		"test": "xo && nyc ava && tsd",
node_modules/character-entities-html4/package.json: 1: printf: Illegal option --
  "name": "character-entities-html4",
    "name",
    "test": "npm run generate && npm run build && npm run format && npm run test-coverage"
node_modules/character-entities-legacy/package.json: 1: printf: Illegal option --
  "name": "character-entities-legacy",
    "name"
    "test": "npm run generate && npm run build && npm run format && npm run test-coverage"
node_modules/character-entities/package.json: 1: printf: Illegal option --
  "name": "character-entities",
    "name",
    "test": "npm run generate && npm run build && npm run format && npm run test-coverage"
node_modules/character-reference-invalid/package.json: 1: printf: Illegal option --
  "name": "character-reference-invalid",
    "name"
    "test": "npm run generate && npm run build && npm run format && npm run test-coverage"
node_modules/check-error/package.json: 1: printf: Illegal option --
  "name": "check-error",
    "test": "npm run test:node && npm run test:browser",
node_modules/cheerio-select/package.json: 1: printf: Illegal option --
    "name": "cheerio-select",
        "test": "npm run test:jest && npm run lint",
node_modules/cheerio/package.json: 1: printf: Illegal option --
  "name": "cheerio",
    "test": "npm run lint && npm run test:vi",
node_modules/chokidar/package.json: 1: printf: Illegal option --
  "name": "chokidar",
    "test": "node index.test.js",
node_modules/cliui/package.json: 1: printf: Illegal option --
  "name": "cliui",
    "test": "c8 mocha ./test/*.cjs",
node_modules/color-convert/package.json: 1: printf: Illegal option --
  "name": "color-convert",
    "test": "node test/basic.js"
node_modules/color-name/package.json: 1: printf: Illegal option --
  "name": "color-name",
    "test": "node test.js"
node_modules/comma-separated-tokens/package.json: 1: printf: Illegal option --
  "name": "comma-separated-tokens",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/concurrently/package.json: 1: printf: Illegal option --
  "name": "concurrently",
    "test": "vitest --project unit",
node_modules/consola/package.json: 1: printf: Illegal option --
  "name": "consola",
    "test": "pnpm lint && pnpm vitest run --coverage"
node_modules/convert-source-map/package.json: 1: printf: Illegal option --
  "name": "convert-source-map",
    "test": "tap test/*.js --color"
    "name": "Thorsten Lorenz",
node_modules/convex-helpers/package.json: 1: printf: Illegal option --
  "name": "convex-helpers",
    "typecheck": "tsc --noEmit",
node_modules/convex-test/package.json: 1: printf: Illegal option --
  "name": "convex-test",
    "test",
    "test": "vitest",
node_modules/convex/package.json: 1: printf: Illegal option --
  "name": "convex",
    "test": "vitest --silent",
    "typecheck": "tsc --noEmit --emitDeclarationOnly false",
node_modules/cookie-es/package.json: 1: printf: Illegal option --
  "name": "cookie-es",
    "test": "pnpm lint && vitest run --coverage"
node_modules/crossws/package.json: 1: printf: Illegal option --
  "name": "crossws",
    "test": "pnpm lint && pnpm typecheck && vitest run --coverage",
    "typecheck": "tsgo --noEmit --skipLibCheck"
node_modules/css-select/package.json: 1: printf: Illegal option --
    "name": "css-select",
        "test": "npm run test:jest && npm run lint",
node_modules/css-tree/package.json: 1: printf: Illegal option --
  "name": "css-tree",
    "test": "mocha lib/__tests --require lib/__tests/helpers/setup.js --reporter progress",
node_modules/css-what/package.json: 1: printf: Illegal option --
    "name": "css-what",
        "test": "npm run test:jest && npm run lint",
node_modules/csstype/package.json: 1: printf: Illegal option --
  "name": "csstype",
    "test": "jest --runInBand",
node_modules/d3-array/package.json: 1: printf: Illegal option --
  "name": "d3-array",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-binarytree/package.json: 1: printf: Illegal option --
  "name": "d3-binarytree",
    "name": "Vasco Asturiano",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-color/package.json: 1: printf: Illegal option --
  "name": "d3-color",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-dispatch/package.json: 1: printf: Illegal option --
  "name": "d3-dispatch",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-drag/package.json: 1: printf: Illegal option --
  "name": "d3-drag",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-ease/package.json: 1: printf: Illegal option --
  "name": "d3-ease",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-force-3d/package.json: 1: printf: Illegal option --
  "name": "d3-force-3d",
    "name": "Vasco Asturiano",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-format/package.json: 1: printf: Illegal option --
  "name": "d3-format",
    "name": "Mike Bostock",
    "test": "vitest",
node_modules/d3-interpolate/package.json: 1: printf: Illegal option --
  "name": "d3-interpolate",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-octree/package.json: 1: printf: Illegal option --
  "name": "d3-octree",
    "name": "Vasco Asturiano",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-quadtree/package.json: 1: printf: Illegal option --
  "name": "d3-quadtree",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-scale-chromatic/package.json: 1: printf: Illegal option --
  "name": "d3-scale-chromatic",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-scale/package.json: 1: printf: Illegal option --
  "name": "d3-scale",
    "name": "Mike Bostock",
    "test": "TZ=America/Los_Angeles mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-selection/package.json: 1: printf: Illegal option --
  "name": "d3-selection",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-time-format/package.json: 1: printf: Illegal option --
  "name": "d3-time-format",
    "name": "Mike Bostock",
    "test": "TZ=America/Los_Angeles mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-time/package.json: 1: printf: Illegal option --
  "name": "d3-time",
    "name": "Mike Bostock",
    "test": "TZ=America/Los_Angeles mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-timer/package.json: 1: printf: Illegal option --
  "name": "d3-timer",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-transition/package.json: 1: printf: Illegal option --
  "name": "d3-transition",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/d3-zoom/package.json: 1: printf: Illegal option --
  "name": "d3-zoom",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/data-urls/package.json: 1: printf: Illegal option --
  "name": "data-urls",
    "test": "node --test",
node_modules/db0/package.json: 1: printf: Illegal option --
  "name": "db0",
    "test": "pnpm lint && pnpm test:types && vitest run --coverage && pnpm test:bun",
node_modules/debug/package.json: 1: printf: Illegal option --
  "name": "debug",
    "test": "npm run test:node && npm run test:browser && npm run lint",
node_modules/decimal.js/package.json: 1: printf: Illegal option --
  "name": "decimal.js",
    "name": "Michael Mclaughlin",
    "test": "node ./test/test.js"
node_modules/decode-named-character-reference/package.json: 1: printf: Illegal option --
  "name": "decode-named-character-reference",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/deep-eql/package.json: 1: printf: Illegal option --
  "name": "deep-eql",
    "test": "npm run test:node && npm run test:browser",
node_modules/defu/package.json: 1: printf: Illegal option --
  "name": "defu",
    "test": "pnpm lint && pnpm test:types && pnpm vitest run",
node_modules/dequal/package.json: 1: printf: Illegal option --
  "name": "dequal",
    "name": "Luke Edwards",
    "test": "uvu -r esm test"
node_modules/detect-libc/package.json: 1: printf: Illegal option --
  "name": "detect-libc",
    "test": "semistandard && nyc --reporter=text --check-coverage --branches=100 ava test/unit.js",
node_modules/devlop/package.json: 1: printf: Illegal option --
  "name": "devlop",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/diff/package.json: 1: printf: Illegal option --
  "name": "diff",
    "test": "nyc yarn _test",
node_modules/dom-serializer/package.json: 1: printf: Illegal option --
  "name": "dom-serializer",
    "test": "npm run test:jest && npm run lint",
node_modules/domelementtype/package.json: 1: printf: Illegal option --
    "name": "domelementtype",
        "test": "npm run lint && prettier --check **/*.{ts,json,md}",
node_modules/domhandler/package.json: 1: printf: Illegal option --
    "name": "domhandler",
        "test": "npm run test:jest && npm run lint",
node_modules/dompurify/package.json: 1: printf: Illegal option --
    "test": "cross-env NODE_ENV=test BABEL_ENV=rollup npm run lint && npm run test:jsdom && npm run test:browser -- --project=chromium",
      "name": "node",
  "name": "dompurify",
    "test": "test"
node_modules/domutils/package.json: 1: printf: Illegal option --
    "name": "domutils",
        "test": "npm run test:jest && npm run lint",
node_modules/drizzle-orm/package.json: 1: printf: Illegal option --
  "name": "drizzle-orm",
    "test": "vitest run",
node_modules/dts-resolver/package.json: 1: printf: Illegal option --
  "name": "dts-resolver",
    "test": "vitest",
    "typecheck": "tsc --noEmit",
node_modules/electron-to-chromium/package.json: 1: printf: Illegal option --
  "name": "electron-to-chromium",
    "test": "nyc ava --verbose",
node_modules/emoji-mart/package.json: 1: printf: Illegal option --
  "name": "emoji-mart",
node_modules/emoji-regex/package.json: 1: printf: Illegal option --
  "name": "emoji-regex",
    "name": "Mathias Bynens",
    "test": "mocha",
node_modules/empathic/package.json: 1: printf: Illegal option --
	"name": "empathic",
		"name": "Luke Edwards",
		"test": "uvu"
node_modules/encoding-sniffer/package.json: 1: printf: Illegal option --
    "name": "encoding-sniffer",
        "test": "npm run test:vi && npm run lint",
node_modules/enhanced-resolve/package.json: 1: printf: Illegal option --
  "name": "enhanced-resolve",
    "test": "npm run test:coverage",
node_modules/entities/package.json: 1: printf: Illegal option --
    "name": "entities",
        "test": "npm run test:vi && npm run lint",
node_modules/env-runner/package.json: 1: printf: Illegal option --
  "name": "env-runner",
    "test": "pnpm lint && pnpm typecheck && vitest run --coverage",
    "typecheck": "tsgo --noEmit --skipLibCheck"
node_modules/es-module-lexer/package.json: 1: printf: Illegal option --
  "name": "es-module-lexer",
    "test": "npm install -g chomp ; chomp test"
    "test": "test"
node_modules/esbuild/package.json: 1: printf: Illegal option --
  "name": "esbuild",
node_modules/escalade/package.json: 1: printf: Illegal option --
  "name": "escalade",
    "name": "Luke Edwards",
    "test": "uvu -r esm test -i fixtures"
node_modules/escape-string-regexp/package.json: 1: printf: Illegal option --
	"name": "escape-string-regexp",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsd"
node_modules/estree-util-is-identifier-name/package.json: 1: printf: Illegal option --
  "name": "estree-util-is-identifier-name",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/estree-walker/package.json: 1: printf: Illegal option --
	"name": "estree-walker",
		"test": "uvu test"
node_modules/eventemitter3/package.json: 1: printf: Illegal option --
  "name": "eventemitter3",
    "test": "c8 --reporter=lcov --reporter=text mocha test/test.js",
node_modules/eventsource-parser/package.json: 1: printf: Illegal option --
  "name": "eventsource-parser",
    "test": "npm run test:node",
node_modules/expect-type/package.json: 1: printf: Illegal option --
  "name": "expect-type",
    "test",
    "test": "vitest run"
node_modules/exsolve/package.json: 1: printf: Illegal option --
  "name": "exsolve",
    "test": "pnpm lint && pnpm test:types && vitest run --coverage",
node_modules/extend/package.json: 1: printf: Illegal option --
	"name": "extend",
		"test": "npm run tests-only",
			"name": "Jordan Harband",
node_modules/fast-equals/package.json: 1: printf: Illegal option --
  "name": "fast-equals",
    "test": "vitest run --config=config/vitest.config.ts",
    "typecheck": "tsc --noEmit"
node_modules/fdir/package.json: 1: printf: Illegal option --
  "name": "fdir",
    "test": "vitest run __tests__/",
node_modules/fetchdts/package.json: 1: printf: Illegal option --
  "name": "fetchdts",
    "name": "Daniel Roe",
    "test": "pnpm test:unit && pnpm test:types",
node_modules/float-tooltip/package.json: 1: printf: Illegal option --
  "name": "float-tooltip",
    "name": "Vasco Asturiano",
node_modules/force-graph/package.json: 1: printf: Illegal option --
  "name": "force-graph",
    "name": "Vasco Asturiano",
node_modules/gensync/package.json: 1: printf: Illegal option --
  "name": "gensync",
    "test": "jest"
node_modules/get-caller-file/package.json: 1: printf: Illegal option --
  "name": "get-caller-file",
    "test": "tests"
    "test": "mocha test",
node_modules/get-tsconfig/package.json: 1: printf: Illegal option --
  "name": "get-tsconfig",
    "name": "Hiroki Osame",
node_modules/graceful-fs/package.json: 1: printf: Illegal option --
  "name": "graceful-fs",
    "test": "test"
    "test": "nyc --silent node test.js | tap -c -",
node_modules/h3-v2/package.json: 1: printf: Illegal option --
  "name": "h3",
    "test": "pnpm lint && vitest --run --coverage"
node_modules/h3/package.json: 1: printf: Illegal option --
  "name": "h3",
    "test": "pnpm lint && vitest --run --coverage"
node_modules/has-flag/package.json: 1: printf: Illegal option --
	"name": "has-flag",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsd"
node_modules/hast-util-to-jsx-runtime/package.json: 1: printf: Illegal option --
  "name": "hast-util-to-jsx-runtime",
    "test": "npm run generate && npm run build && npm run format && npm run test-coverage"
node_modules/hast-util-whitespace/package.json: 1: printf: Illegal option --
  "name": "hast-util-whitespace",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/highlight.js/package.json: 1: printf: Illegal option --
  "name": "highlight.js",
    "test": "mocha test",
node_modules/hookable/package.json: 1: printf: Illegal option --
  "name": "hookable",
    "test": "pnpm lint && vitest run --coverage",
node_modules/html-encoding-sniffer/package.json: 1: printf: Illegal option --
  "name": "html-encoding-sniffer",
    "test": "node --test",
node_modules/html-url-attributes/package.json: 1: printf: Illegal option --
  "name": "html-url-attributes",
node_modules/htmlparser2/package.json: 1: printf: Illegal option --
    "name": "htmlparser2",
        "test": "npm run test:vi && npm run lint",
node_modules/httpxy/package.json: 1: printf: Illegal option --
  "name": "httpxy",
    "test": "pnpm lint && pnpm typecheck && vitest run --coverage",
    "typecheck": "tsgo --noEmit"
node_modules/iconv-lite/package.json: 1: printf: Illegal option --
    "name": "iconv-lite",
        "test": "mocha --reporter spec --grep ."
node_modules/index-array-by/package.json: 1: printf: Illegal option --
  "name": "index-array-by",
    "name": "Vasco Asturiano",
node_modules/inline-style-parser/package.json: 1: printf: Illegal option --
  "name": "inline-style-parser",
    "test": "jest --colors --testPathIgnorePatterns=test/index.test.mjs",
node_modules/internmap/package.json: 1: printf: Illegal option --
  "name": "internmap",
    "name": "Mike Bostock",
    "test": "mocha 'test/**/*-test.js' && eslint src test",
node_modules/iron-webcrypto/package.json: 1: printf: Illegal option --
  "name": "iron-webcrypto",
node_modules/is-alphabetical/package.json: 1: printf: Illegal option --
  "name": "is-alphabetical",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/is-alphanumerical/package.json: 1: printf: Illegal option --
  "name": "is-alphanumerical",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/is-decimal/package.json: 1: printf: Illegal option --
  "name": "is-decimal",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/is-fullwidth-code-point/package.json: 1: printf: Illegal option --
	"name": "is-fullwidth-code-point",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsd-check"
node_modules/is-hexadecimal/package.json: 1: printf: Illegal option --
  "name": "is-hexadecimal",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/is-plain-obj/package.json: 1: printf: Illegal option --
	"name": "is-plain-obj",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsd"
		"test",
node_modules/is-potential-custom-element-name/package.json: 1: printf: Illegal option --
  "name": "is-potential-custom-element-name",
    "name": "Mathias Bynens",
    "test": "mocha"
node_modules/isbot/package.json: 1: printf: Illegal option --
  "name": "isbot",
    "test": "./scripts/test/procedure.sh",
node_modules/isomorphic-dompurify/package.json: 1: printf: Illegal option --
  "name": "isomorphic-dompurify",
    "typecheck": "tsc --noEmit",
    "test": "NODE_OPTIONS='--expose-gc' vitest run"
node_modules/isomorphic.js/package.json: 1: printf: Illegal option --
  "name": "isomorphic.js",
    "test": "npm run lint",
node_modules/jerrypick/package.json: 1: printf: Illegal option --
  "name": "jerrypick",
    "name": "Vasco Asturiano",
node_modules/jiti/package.json: 1: printf: Illegal option --
  "name": "jiti",
    "test": "pnpm lint && pnpm test:types && vitest run --coverage && pnpm test:node-register && pnpm test:bun && pnpm test:native",
node_modules/jose/package.json: 1: printf: Illegal option --
  "name": "jose",
node_modules/js-tokens/package.json: 1: printf: Illegal option --
  "name": "js-tokens",
    "test": "mocha --ui tdd",
node_modules/js-yaml/package.json: 1: printf: Illegal option --
  "name": "js-yaml",
    "test": "npm run lint && mocha",
node_modules/jsdom/package.json: 1: printf: Illegal option --
  "name": "jsdom",
    "test": "npm-run-all --continue-on-error test:*",
node_modules/jsesc/package.json: 1: printf: Illegal option --
  "name": "jsesc",
    "name": "Mathias Bynens",
    "test": "mocha tests"
node_modules/json-schema/package.json: 1: printf: Illegal option --
  "name": "json-schema",
  	{"name": "Kris Zyp", "email": "kriszyp@gmail.com"}],
  "scripts": { "test": "vows --spec test/*.js" }
node_modules/json5/package.json: 1: printf: Illegal option --
  "name": "json5",
    "test": "run-s lint-report tap",
node_modules/kapsule/package.json: 1: printf: Illegal option --
  "name": "kapsule",
    "name": "Vasco Asturiano",
node_modules/kleur/package.json: 1: printf: Illegal option --
  "name": "kleur",
    "name": "Luke Edwards",
    "test": "uvu -r esm -i utils -i xyz"
node_modules/lib0/package.json: 1: printf: Illegal option --
  "name": "lib0",
    "test": "c8 --check-coverage --lines 100 --branches 100 --functions 100 --statements 100 node --unhandled-rejections=strict ./test.js --repetition-time 50",
node_modules/lightningcss-linux-x64-gnu/package.json: 1: printf: Illegal option --
  "name": "lightningcss-linux-x64-gnu",
node_modules/lightningcss-linux-x64-musl/package.json: 1: printf: Illegal option --
  "name": "lightningcss-linux-x64-musl",
node_modules/lightningcss/package.json: 1: printf: Illegal option --
  "name": "lightningcss",
    "name": "lightningcss"
    "test": "uvu node/test"
node_modules/linkifyjs/package.json: 1: printf: Illegal option --
  "name": "linkifyjs",
    "test": "echo \"Error: no test specified\" && exit 1"
node_modules/lodash-es/package.json: 1: printf: Illegal option --
  "name": "lodash-es",
    "test": "echo \"See https://travis-ci.org/lodash-archive/lodash-cli for testing details.\""
node_modules/longest-streak/package.json: 1: printf: Illegal option --
  "name": "longest-streak",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/loose-envify/package.json: 1: printf: Illegal option --
  "name": "loose-envify",
    "test": "tap test/*.js"
node_modules/loupe/package.json: 1: printf: Illegal option --
  "name": "loupe",
    "test": "npm run test:node && npm run test:browser",
node_modules/lowlight/package.json: 1: printf: Illegal option --
  "name": "lowlight",
    "test": "npm run generate && npm run build && npm run format && npm run test-coverage",
node_modules/lru-cache/package.json: 1: printf: Illegal option --
  "name": "lru-cache",
    "test": "tap",
node_modules/lucide-react/package.json: 1: printf: Illegal option --
  "name": "lucide-react",
    "typecheck": "tsc",
    "test": "pnpm build:icons && vitest run",
node_modules/magic-string/package.json: 1: printf: Illegal option --
  "name": "magic-string",
    "test": "vitest run",
node_modules/markdown-table/package.json: 1: printf: Illegal option --
  "name": "markdown-table",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/marked/package.json: 1: printf: Illegal option --
  "name": "marked",
    "test": "npm run build:reset && npm run build:docs && npm run test:specs && npm run test:unit && npm run test:umd && npm run test:cjs && npm run test:types && npm run test:lint",
node_modules/mdast-util-find-and-replace/package.json: 1: printf: Illegal option --
  "name": "mdast-util-find-and-replace",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-from-markdown/package.json: 1: printf: Illegal option --
  "name": "mdast-util-from-markdown",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-gfm-autolink-literal/package.json: 1: printf: Illegal option --
  "name": "mdast-util-gfm-autolink-literal",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-gfm-footnote/package.json: 1: printf: Illegal option --
  "name": "mdast-util-gfm-footnote",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-gfm-strikethrough/package.json: 1: printf: Illegal option --
  "name": "mdast-util-gfm-strikethrough",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-gfm-table/package.json: 1: printf: Illegal option --
  "name": "mdast-util-gfm-table",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-gfm-task-list-item/package.json: 1: printf: Illegal option --
  "name": "mdast-util-gfm-task-list-item",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-gfm/package.json: 1: printf: Illegal option --
  "name": "mdast-util-gfm",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-mdx-expression/package.json: 1: printf: Illegal option --
  "name": "mdast-util-mdx-expression",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-mdx-jsx/package.json: 1: printf: Illegal option --
  "name": "mdast-util-mdx-jsx",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-mdxjs-esm/package.json: 1: printf: Illegal option --
  "name": "mdast-util-mdxjs-esm",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-phrasing/package.json: 1: printf: Illegal option --
  "name": "mdast-util-phrasing",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-to-hast/package.json: 1: printf: Illegal option --
  "name": "mdast-util-to-hast",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-to-markdown/package.json: 1: printf: Illegal option --
  "name": "mdast-util-to-markdown",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdast-util-to-string/package.json: 1: printf: Illegal option --
  "name": "mdast-util-to-string",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/mdn-data/package.json: 1: printf: Illegal option --
  "name": "mdn-data",
    "test": "npm run lint"
node_modules/micromark-core-commonmark/package.json: 1: printf: Illegal option --
  "name": "micromark-core-commonmark",
node_modules/micromark-extension-gfm-autolink-literal/package.json: 1: printf: Illegal option --
  "name": "micromark-extension-gfm-autolink-literal",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/micromark-extension-gfm-footnote/package.json: 1: printf: Illegal option --
  "name": "micromark-extension-gfm-footnote",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/micromark-extension-gfm-strikethrough/package.json: 1: printf: Illegal option --
  "name": "micromark-extension-gfm-strikethrough",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/micromark-extension-gfm-table/package.json: 1: printf: Illegal option --
  "name": "micromark-extension-gfm-table",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/micromark-extension-gfm-tagfilter/package.json: 1: printf: Illegal option --
  "name": "micromark-extension-gfm-tagfilter",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/micromark-extension-gfm-task-list-item/package.json: 1: printf: Illegal option --
  "name": "micromark-extension-gfm-task-list-item",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/micromark-extension-gfm/package.json: 1: printf: Illegal option --
  "name": "micromark-extension-gfm",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/micromark-factory-destination/package.json: 1: printf: Illegal option --
  "name": "micromark-factory-destination",
node_modules/micromark-factory-label/package.json: 1: printf: Illegal option --
  "name": "micromark-factory-label",
node_modules/micromark-factory-space/package.json: 1: printf: Illegal option --
  "name": "micromark-factory-space",
node_modules/micromark-factory-title/package.json: 1: printf: Illegal option --
  "name": "micromark-factory-title",
node_modules/micromark-factory-whitespace/package.json: 1: printf: Illegal option --
  "name": "micromark-factory-whitespace",
node_modules/micromark-util-character/package.json: 1: printf: Illegal option --
  "name": "micromark-util-character",
node_modules/micromark-util-chunked/package.json: 1: printf: Illegal option --
  "name": "micromark-util-chunked",
node_modules/micromark-util-classify-character/package.json: 1: printf: Illegal option --
  "name": "micromark-util-classify-character",
node_modules/micromark-util-combine-extensions/package.json: 1: printf: Illegal option --
  "name": "micromark-util-combine-extensions",
node_modules/micromark-util-decode-numeric-character-reference/package.json: 1: printf: Illegal option --
  "name": "micromark-util-decode-numeric-character-reference",
node_modules/micromark-util-decode-string/package.json: 1: printf: Illegal option --
  "name": "micromark-util-decode-string",
node_modules/micromark-util-encode/package.json: 1: printf: Illegal option --
  "name": "micromark-util-encode",
node_modules/micromark-util-html-tag-name/package.json: 1: printf: Illegal option --
  "name": "micromark-util-html-tag-name",
    "name"
node_modules/micromark-util-normalize-identifier/package.json: 1: printf: Illegal option --
  "name": "micromark-util-normalize-identifier",
node_modules/micromark-util-resolve-all/package.json: 1: printf: Illegal option --
  "name": "micromark-util-resolve-all",
node_modules/micromark-util-sanitize-uri/package.json: 1: printf: Illegal option --
  "name": "micromark-util-sanitize-uri",
node_modules/micromark-util-subtokenize/package.json: 1: printf: Illegal option --
  "name": "micromark-util-subtokenize",
node_modules/micromark-util-symbol/package.json: 1: printf: Illegal option --
  "name": "micromark-util-symbol",
node_modules/micromark-util-types/package.json: 1: printf: Illegal option --
  "name": "micromark-util-types",
node_modules/micromark/package.json: 1: printf: Illegal option --
  "name": "micromark",
node_modules/ms/package.json: 1: printf: Illegal option --
  "name": "ms",
    "test": "mocha tests.js"
node_modules/nanoid/package.json: 1: printf: Illegal option --
  "name": "nanoid",
node_modules/nf3/package.json: 1: printf: Illegal option --
  "name": "nf3",
    "test": "pnpm lint && pnpm test:types && vitest run --coverage",
node_modules/nitro/package.json: 1: printf: Illegal option --
  "name": "nitro",
    "test": "pnpm lint && pnpm build && pnpm typecheck && pnpm test:rollup && pnpm test:rolldown",
    "typecheck": "tsgo --noEmit --skipLibCheck"
node_modules/node-releases/package.json: 1: printf: Illegal option --
  "name": "node-releases",
node_modules/nth-check/package.json: 1: printf: Illegal option --
    "name": "nth-check",
        "test": "npm run test:jest && npm run lint",
node_modules/object-assign/package.json: 1: printf: Illegal option --
  "name": "object-assign",
    "name": "Sindre Sorhus",
    "test": "xo && ava",
node_modules/ocache/package.json: 1: printf: Illegal option --
  "name": "ocache",
    "test": "pnpm lint && pnpm typecheck && vitest run --coverage",
    "typecheck": "tsgo --noEmit --skipLibCheck"
node_modules/ofetch/package.json: 1: printf: Illegal option --
  "name": "ofetch",
    "test": "pnpm lint && vitest run --coverage"
node_modules/ohash/package.json: 1: printf: Illegal option --
  "name": "ohash",
    "test": "pnpm lint && vitest run --coverage && pnpm test:types",
node_modules/orderedmap/package.json: 1: printf: Illegal option --
  "name": "orderedmap",
node_modules/parse-entities/package.json: 1: printf: Illegal option --
  "name": "parse-entities",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/parse5-htmlparser2-tree-adapter/package.json: 1: printf: Illegal option --
    "name": "parse5-htmlparser2-tree-adapter",
node_modules/parse5-parser-stream/package.json: 1: printf: Illegal option --
    "name": "parse5-parser-stream",
node_modules/parse5/package.json: 1: printf: Illegal option --
    "name": "parse5",
node_modules/pathe/package.json: 1: printf: Illegal option --
  "name": "pathe",
    "test": "pnpm lint && vitest run --coverage",
node_modules/pathval/package.json: 1: printf: Illegal option --
  "name": "pathval",
    "test": "npm run test:node && npm run test:browser",
node_modules/pg-cloudflare/package.json: 1: printf: Illegal option --
  "name": "pg-cloudflare",
    "test": "echo e2e test in pg package"
node_modules/pg-connection-string/package.json: 1: printf: Illegal option --
  "name": "pg-connection-string",
    "test": "nyc --reporter=lcov mocha && npm run check-coverage",
node_modules/pg-int8/package.json: 1: printf: Illegal option --
	"name": "pg-int8",
		"test": "tap test"
node_modules/pg-pool/package.json: 1: printf: Illegal option --
  "name": "pg-pool",
    "test": "test"
    "test": " node_modules/.bin/mocha"
node_modules/pg-protocol/package.json: 1: printf: Illegal option --
  "name": "pg-protocol",
    "test": "mocha dist/**/*.test.js",
node_modules/pg-types/package.json: 1: printf: Illegal option --
  "name": "pg-types",
    "test": "tape test/*.js | tap-spec && npm run test-ts",
node_modules/pg/package.json: 1: printf: Illegal option --
  "name": "pg",
    "test": "make test-all"
node_modules/pgpass/package.json: 1: printf: Illegal option --
  "name": "pgpass",
    "test": "\"$npm_execpath\" run _hint && \"$npm_execpath\" run _covered_test"
node_modules/picocolors/package.json: 1: printf: Illegal option --
  "name": "picocolors",
node_modules/picomatch/package.json: 1: printf: Illegal option --
  "name": "picomatch",
    "test": "npm run lint && npm run mocha",
node_modules/playwright-core/package.json: 1: printf: Illegal option --
  "name": "playwright-core",
    "name": "Microsoft Corporation"
node_modules/playwright/package.json: 1: printf: Illegal option --
  "name": "playwright",
    "name": "Microsoft Corporation"
node_modules/postcss/package.json: 1: printf: Illegal option --
  "name": "postcss",
node_modules/postgres-array/package.json: 1: printf: Illegal option --
  "name": "postgres-array",
    "name": "Ben Drucker",
    "test": "standard && tape test.js"
node_modules/postgres-bytea/package.json: 1: printf: Illegal option --
  "name": "postgres-bytea",
    "name": "Ben Drucker",
    "test": "standard && tape test.js"
node_modules/postgres-date/package.json: 1: printf: Illegal option --
  "name": "postgres-date",
    "name": "Ben Drucker",
    "test": "standard && tape test.js"
node_modules/postgres-interval/package.json: 1: printf: Illegal option --
  "name": "postgres-interval",
    "name": "Ben Drucker",
    "test": "standard && tape test.js"
node_modules/preact/package.json: 1: printf: Illegal option --
  "name": "preact",
    "test": "npm-run-all build lint test:unit",
node_modules/prettier/package.json: 1: printf: Illegal option --
  "name": "prettier",
node_modules/prismjs/package.json: 1: printf: Illegal option --
	"name": "prismjs",
		"test": "npm-run-all test:*",
node_modules/prop-types/package.json: 1: printf: Illegal option --
  "name": "prop-types",
    "test": "npm run tests-only",
node_modules/property-information/package.json: 1: printf: Illegal option --
  "name": "property-information",
    "test": "npm run generate && npm run build && npm run format && npm run test-coverage"
node_modules/prosemirror-changeset/package.json: 1: printf: Illegal option --
  "name": "prosemirror-changeset",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-commands/package.json: 1: printf: Illegal option --
  "name": "prosemirror-commands",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-dropcursor/package.json: 1: printf: Illegal option --
  "name": "prosemirror-dropcursor",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-gapcursor/package.json: 1: printf: Illegal option --
  "name": "prosemirror-gapcursor",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests"
node_modules/prosemirror-history/package.json: 1: printf: Illegal option --
  "name": "prosemirror-history",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-keymap/package.json: 1: printf: Illegal option --
  "name": "prosemirror-keymap",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-model/package.json: 1: printf: Illegal option --
  "name": "prosemirror-model",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-schema-list/package.json: 1: printf: Illegal option --
  "name": "prosemirror-schema-list",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-state/package.json: 1: printf: Illegal option --
  "name": "prosemirror-state",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-tables/package.json: 1: printf: Illegal option --
  "name": "prosemirror-tables",
      "name": "Eduard Shvedai",
      "name": "Huanhuan Huang",
      "name": "Ocavue",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
node_modules/prosemirror-transform/package.json: 1: printf: Illegal option --
  "name": "prosemirror-transform",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/prosemirror-view/package.json: 1: printf: Illegal option --
  "name": "prosemirror-view",
      "name": "Marijn Haverbeke",
    "test": "pm-runtests",
node_modules/punycode/package.json: 1: printf: Illegal option --
  "name": "punycode",
    "name": "Mathias Bynens",
      "name": "Mathias Bynens",
    "test": "mocha tests",
node_modules/quansync/package.json: 1: printf: Illegal option --
  "name": "quansync",
      "name": "Kevin Deng",
    "test": "vitest",
    "typecheck": "tsgo --noEmit"
node_modules/react-dom/package.json: 1: printf: Illegal option --
  "name": "react-dom",
node_modules/react-force-graph-2d/package.json: 1: printf: Illegal option --
  "name": "react-force-graph-2d",
    "name": "Vasco Asturiano",
node_modules/react-is/package.json: 1: printf: Illegal option --
  "name": "react-is",
node_modules/react-kapsule/package.json: 1: printf: Illegal option --
  "name": "react-kapsule",
    "name": "Vasco Asturiano",
node_modules/react-markdown/package.json: 1: printf: Illegal option --
  "name": "react-markdown",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/react-simple-code-editor/package.json: 1: printf: Illegal option --
  "name": "react-simple-code-editor",
node_modules/react/package.json: 1: printf: Illegal option --
  "name": "react",
node_modules/readdirp/package.json: 1: printf: Illegal option --
  "name": "readdirp",
    "test": "node test/index.test.js",
node_modules/remark-gfm/package.json: 1: printf: Illegal option --
  "name": "remark-gfm",
    "test": "npm run build && npm run format && npm run test-coverage",
node_modules/remark-parse/package.json: 1: printf: Illegal option --
  "name": "remark-parse",
node_modules/remark-rehype/package.json: 1: printf: Illegal option --
  "name": "remark-rehype",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/remark-stringify/package.json: 1: printf: Illegal option --
  "name": "remark-stringify",
node_modules/require-directory/package.json: 1: printf: Illegal option --
  "name": "require-directory",
      "name": "Troy Goode",
    "test": "mocha",
node_modules/require-from-string/package.json: 1: printf: Illegal option --
  "name": "require-from-string",
    "name": "Vsevolod Strukchinsky",
    "test": "mocha"
node_modules/resolve-pkg-maps/package.json: 1: printf: Illegal option --
  "name": "resolve-pkg-maps",
    "name": "Hiroki Osame",
node_modules/rolldown-plugin-dts/package.json: 1: printf: Illegal option --
  "name": "rolldown-plugin-dts",
    "test": "vitest",
    "typecheck": "tsc --noEmit",
node_modules/rolldown/package.json: 1: printf: Illegal option --
  "name": "rolldown",
node_modules/rollup/package.json: 1: printf: Illegal option --
  "name": "rollup",
    "test": "npm run build && npm run test:all",
node_modules/rope-sequence/package.json: 1: printf: Illegal option --
  "name": "rope-sequence",
    "test": "node test.js"
node_modules/rou3/package.json: 1: printf: Illegal option --
  "name": "rou3",
    "test": "pnpm lint && pnpm test:types && vitest run --coverage",
node_modules/rxjs/package.json: 1: printf: Illegal option --
  "name": "rxjs",
    "test": "cross-env TS_NODE_PROJECT=tsconfig.mocha.json mocha --config spec/support/.mocharc.js \"spec/**/*-spec.ts\"",
      "name": "Ben Lesh",
      "name": "Paul Taylor",
      "name": "Jeff Cross",
      "name": "Matthew Podwysocki",
      "name": "OJ Kwon",
      "name": "Andre Staltz",
node_modules/safer-buffer/package.json: 1: printf: Illegal option --
  "name": "safer-buffer",
    "test": "standard && tape tests.js"
    "name": "Nikita Skovoroda",
node_modules/saxes/package.json: 1: printf: Illegal option --
  "name": "saxes",
    "test": "npm run build && mocha --delay",
node_modules/scheduler/package.json: 1: printf: Illegal option --
  "name": "scheduler",
node_modules/semver/package.json: 1: printf: Illegal option --
  "name": "semver",
    "test": "tap test/ --100 --timeout=30",
node_modules/seroval-plugins/package.json: 1: printf: Illegal option --
  "name": "seroval-plugins",
    "test": "vitest",
node_modules/seroval/package.json: 1: printf: Illegal option --
  "name": "seroval",
    "test": "vitest",
node_modules/shell-quote/package.json: 1: printf: Illegal option --
	"name": "shell-quote",
		"name": "James Halliday",
		"test": "npm run tests-only",
node_modules/siginfo/package.json: 1: printf: Illegal option --
  "name": "siginfo",
    "test": "standard"
node_modules/source-map-js/package.json: 1: printf: Illegal option --
  "name": "source-map-js",
    "test": "npm run build && node test/run-tests.js",
node_modules/source-map/package.json: 1: printf: Illegal option --
  "name": "source-map",
    "test": "git submodule update --init --recursive; node test/run-tests.js",
node_modules/space-separated-tokens/package.json: 1: printf: Illegal option --
  "name": "space-separated-tokens",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/split2/package.json: 1: printf: Illegal option --
  "name": "split2",
    "test": "npm run lint && npm run unit",
    "test"
node_modules/srvx/package.json: 1: printf: Illegal option --
  "name": "srvx",
    "test": "pnpm lint && pnpm typecheck && vitest run --coverage",
    "typecheck": "tsgo --noEmit --skipLibCheck",
node_modules/stackback/package.json: 1: printf: Illegal option --
  "name": "stackback",
    "test": "mocha --ui qunit"
node_modules/std-env/package.json: 1: printf: Illegal option --
  "name": "std-env",
    "test": "pnpm lint && pnpm typecheck && vitest run --coverage",
    "typecheck": "tsc --noEmit"
node_modules/string-width/package.json: 1: printf: Illegal option --
	"name": "string-width",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsd"
node_modules/stringify-entities/package.json: 1: printf: Illegal option --
  "name": "stringify-entities",
    "test": "npm run generate && npm run build && npm run format && npm run test-coverage"
node_modules/strip-ansi/package.json: 1: printf: Illegal option --
	"name": "strip-ansi",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsd"
node_modules/strip-literal/package.json: 1: printf: Illegal option --
  "name": "strip-literal",
    "test": "vitest",
    "typecheck": "tsc --noEmit"
node_modules/style-to-js/package.json: 1: printf: Illegal option --
  "name": "style-to-js",
    "test": "jest",
node_modules/style-to-object/package.json: 1: printf: Illegal option --
  "name": "style-to-object",
    "test": "jest",
node_modules/supports-color/package.json: 1: printf: Illegal option --
	"name": "supports-color",
		"name": "Sindre Sorhus",
		"test": "xo && ava"
node_modules/symbol-tree/package.json: 1: printf: Illegal option --
  "name": "symbol-tree",
    "test": "istanbul cover test/SymbolTree.js",
node_modules/tagged-tag/package.json: 1: printf: Illegal option --
	"name": "tagged-tag",
		"name": "Sindre Sorhus",
		"test": "tsc index.d.ts"
node_modules/tailwindcss/package.json: 1: printf: Illegal option --
  "name": "tailwindcss",
node_modules/tapable/package.json: 1: printf: Illegal option --
  "name": "tapable",
    "test": "jest",
node_modules/tinybench/package.json: 1: printf: Illegal option --
  "name": "tinybench",
node_modules/tinycolor2/package.json: 1: printf: Illegal option --
  "name": "tinycolor2",
    "test": "node cjs/test.js && node esm/test.js"
node_modules/tinyexec/package.json: 1: printf: Illegal option --
  "name": "tinyexec",
    "test": "npm run build && c8 node --test"
node_modules/tinyglobby/package.json: 1: printf: Illegal option --
  "name": "tinyglobby",
    "test": "node --test \"test/**/*.ts\"",
    "typecheck": "tsc --noEmit"
node_modules/tinypool/package.json: 1: printf: Illegal option --
  "name": "tinypool",
node_modules/tinyrainbow/package.json: 1: printf: Illegal option --
  "name": "tinyrainbow",
node_modules/tinyspy/package.json: 1: printf: Illegal option --
  "name": "tinyspy",
node_modules/tldts-core/package.json: 1: printf: Illegal option --
  "name": "tldts-core",
    "name": "Rémi Berson"
    "test": "nyc ../../node_modules/.bin/mocha --config ../../.mocharc.cjs"
node_modules/tldts/package.json: 1: printf: Illegal option --
  "name": "tldts",
    "name": "Rémi Berson"
    "test": "nyc ../../node_modules/.bin/mocha --config ../../.mocharc.cjs"
node_modules/tough-cookie/package.json: 1: printf: Illegal option --
    "name": "Jeremy Stashewsky",
      "name": "Ivan Nikulin",
      "name": "Shivan Kaul Sahib",
      "name": "Clint Ruoho",
      "name": "Ian Livingstone",
      "name": "Andrew Waterman",
      "name": "Michael de Libero ",
      "name": "Jonathan Stewmon",
      "name": "Miguel Roncancio",
      "name": "Sebastian Mayr",
      "name": "Alexander Savin",
      "name": "Lalit Kapoor",
      "name": "Sam Thompson",
      "name": "Colin Casey",
      "name": "Will Harney",
  "name": "tough-cookie",
    "test": "vitest",
node_modules/tr46/package.json: 1: printf: Illegal option --
  "name": "tr46",
    "test": "node --test",
node_modules/tree-kill/package.json: 1: printf: Illegal option --
  "name": "tree-kill",
    "test": "mocha"
    "name": "Peteris Krumins",
      "name": "Todd Wolfson",
      "name": "William Hilton",
      "name": "Fabrício Matté",
node_modules/trim-lines/package.json: 1: printf: Illegal option --
  "name": "trim-lines",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/trough/package.json: 1: printf: Illegal option --
  "name": "trough",
    "test": "npm run build && npm run format && npm run test-coverage",
node_modules/tsdown/package.json: 1: printf: Illegal option --
  "name": "tsdown",
    "test": "vitest",
    "typecheck": "tsc --noEmit",
node_modules/tslib/package.json: 1: printf: Illegal option --
    "name": "tslib",
node_modules/tsx/package.json: 1: printf: Illegal option --
  "name": "tsx",
    "name": "Hiroki Osame",
node_modules/type-fest/package.json: 1: printf: Illegal option --
	"name": "type-fest",
		"name": "Sindre Sorhus",
		"test": "run-p test:*"
node_modules/typescript/package.json: 1: printf: Illegal option --
    "name": "typescript",
        "test": "hereby runtests-parallel --light=false",
node_modules/ufo/package.json: 1: printf: Illegal option --
  "name": "ufo",
    "test": "pnpm lint && vitest run --typecheck"
node_modules/uint8array-extras/package.json: 1: printf: Illegal option --
	"name": "uint8array-extras",
		"name": "Sindre Sorhus",
		"test": "xo && ava && tsc index.d.ts"
node_modules/unconfig-core/package.json: 1: printf: Illegal option --
  "name": "unconfig-core",
node_modules/unconfig/package.json: 1: printf: Illegal option --
  "name": "unconfig",
node_modules/undici-types/package.json: 1: printf: Illegal option --
  "name": "undici-types",
      "name": "Daniele Belardi",
      "name": "Ethan Arrowood",
      "name": "Matteo Collina",
      "name": "Matthew Aitken",
      "name": "Robert Nagy",
      "name": "Szymon Marczak",
      "name": "Tomas Della Vedova",
node_modules/undici/package.json: 1: printf: Illegal option --
  "name": "undici",
      "name": "Daniele Belardi",
      "name": "Ethan Arrowood",
      "name": "Matteo Collina",
      "name": "Matthew Aitken",
      "name": "Robert Nagy",
      "name": "Szymon Marczak",
      "name": "Tomas Della Vedova",
    "test": "npm run test:javascript && cross-env NODE_V8_COVERAGE= npm run test:typescript",
node_modules/unenv/package.json: 1: printf: Illegal option --
  "name": "unenv",
    "test": "pnpm lint && pnpm test:types && pnpm build && pnpm vitest --run",
node_modules/unified/package.json: 1: printf: Illegal option --
  "name": "unified",
    "test": "npm run build && npm run format && npm run test-coverage",
node_modules/unist-util-is/package.json: 1: printf: Illegal option --
  "name": "unist-util-is",
    "test",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/unist-util-position/package.json: 1: printf: Illegal option --
  "name": "unist-util-position",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/unist-util-stringify-position/package.json: 1: printf: Illegal option --
  "name": "unist-util-stringify-position",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/unist-util-visit-parents/package.json: 1: printf: Illegal option --
  "name": "unist-util-visit-parents",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/unist-util-visit/package.json: 1: printf: Illegal option --
  "name": "unist-util-visit",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/unplugin/package.json: 1: printf: Illegal option --
  "name": "unplugin",
    "typecheck": "tsgo --noEmit",
    "test": "nr test:build && vitest run",
node_modules/unstorage/package.json: 1: printf: Illegal option --
  "name": "unstorage",
    "test": "pnpm lint && pnpm test:types && vitest run --coverage",
node_modules/update-browserslist-db/package.json: 1: printf: Illegal option --
  "name": "update-browserslist-db",
node_modules/use-sync-external-store/package.json: 1: printf: Illegal option --
  "name": "use-sync-external-store",
node_modules/valibot/package.json: 1: printf: Illegal option --
  "name": "valibot",
    "test": "vitest --typecheck",
node_modules/vfile-message/package.json: 1: printf: Illegal option --
  "name": "vfile-message",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/vfile/package.json: 1: printf: Illegal option --
  "name": "vfile",
    "test": "npm run build && npm run format && npm run test-coverage"
node_modules/vite-node/package.json: 1: printf: Illegal option --
  "name": "vite-node",
    "typecheck": "tsc --noEmit"
node_modules/vite/package.json: 1: printf: Illegal option --
  "name": "vite",
    "typecheck": "tsc && tsc -p src/node && tsc -p src/client && tsc -p src/module-runner && tsc -p src/shared && tsc -p src/node/__tests_dts__ && tsc -p src/module-runner/__tests_dts__",
node_modules/vitefu/package.json: 1: printf: Illegal option --
  "name": "vitefu",
    "test": "uvu tests \".*\\.test\\.js\""
node_modules/vitest/package.json: 1: printf: Illegal option --
  "name": "vitest",
    "test",
node_modules/w3c-keyname/package.json: 1: printf: Illegal option --
  "name": "w3c-keyname",
node_modules/w3c-xmlserializer/package.json: 1: printf: Illegal option --
  "name": "w3c-xmlserializer",
    "test": "node --test",
node_modules/webidl-conversions/package.json: 1: printf: Illegal option --
  "name": "webidl-conversions",
    "test": "node --test",
node_modules/webpack-virtual-modules/package.json: 1: printf: Illegal option --
  "name": "webpack-virtual-modules",
    "test": "yarn lint && yarn tests",
node_modules/whatwg-encoding/package.json: 1: printf: Illegal option --
  "name": "whatwg-encoding",
    "test": "node --test",
node_modules/whatwg-mimetype/package.json: 1: printf: Illegal option --
  "name": "whatwg-mimetype",
    "test": "node --test",
node_modules/whatwg-url/package.json: 1: printf: Illegal option --
  "name": "whatwg-url",
    "test": "node --test test/*.js",
node_modules/why-is-node-running/package.json: 1: printf: Illegal option --
  "name": "why-is-node-running",
    "test",
      "name": "Jon Peck",
node_modules/wrap-ansi/package.json: 1: printf: Illegal option --
	"name": "wrap-ansi",
		"name": "Sindre Sorhus",
		"test": "xo && nyc ava"
node_modules/ws/package.json: 1: printf: Illegal option --
  "name": "ws",
    "test": "nyc --reporter=lcov --reporter=text mocha --throw-deprecation test/*.test.js",
node_modules/xml-name-validator/package.json: 1: printf: Illegal option --
  "name": "xml-name-validator",
    "name",
    "test": "node --test",
node_modules/xmlbuilder2/package.json: 1: printf: Illegal option --
  "name": "xmlbuilder2",
    "test": "tsc && npx publint && tsx --test test/**/*test.ts",
node_modules/xmlchars/package.json: 1: printf: Illegal option --
  "name": "xmlchars",
    "test": "mocha",
node_modules/xtend/package.json: 1: printf: Illegal option --
  "name": "xtend",
    "test": "node test"
      "name": "Jake Verbaten"
      "name": "Matt Esch"
node_modules/y-indexeddb/package.json: 1: printf: Illegal option --
  "name": "y-indexeddb",
    "test": "npm run lint",
node_modules/y-prosemirror/package.json: 1: printf: Illegal option --
  "name": "y-prosemirror",
    "test": "npm run lint && rollup -c && node dist/test.cjs",
node_modules/y-protocols/package.json: 1: printf: Illegal option --
  "name": "y-protocols",
    "test": "npm run lint && npm run dist && node dist/test.cjs",
node_modules/y18n/package.json: 1: printf: Illegal option --
  "name": "y18n",
    "test": "c8 --reporter=text --reporter=html mocha test/*.cjs",
node_modules/yallist/package.json: 1: printf: Illegal option --
  "name": "yallist",
    "test": "test"
    "test": "tap test/*.js --100",
node_modules/yargs-parser/package.json: 1: printf: Illegal option --
  "name": "yargs-parser",
    "test": "c8 --reporter=text --reporter=html mocha test/*.cjs",
node_modules/yargs/package.json: 1: printf: Illegal option --
  "name": "yargs",
      "name": "Yargs Contributors",
    "test": "c8 mocha --enable-source-maps ./test/*.cjs --require ./test/before.cjs --timeout=12000 --check-leaks",
node_modules/yjs/package.json: 1: printf: Illegal option --
  "name": "yjs",
    "test": "npm run dist && NODE_ENV=development node ./dist/tests.cjs --repetition-time 50",
    "test": "tests"
node_modules/zod/package.json: 1: printf: Illegal option --
  "name": "zod",
    "test": "pnpm vitest run",
node_modules/zwitch/package.json: 1: printf: Illegal option --
  "name": "zwitch",
    "test": "npm run build && npm run format && npm run test-coverage"
package.json: 1: printf: Illegal option --
  "name": "dohc",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
packages/brand/package.json: 1: printf: Illegal option --
  "name": "@dohc/brand",
packages/config/package.json: 1: printf: Illegal option --
  "name": "@dohc/config",
packages/workspace-contracts/package.json: 1: printf: Illegal option --
  "name": "@dohc/workspace-contracts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
packages/workspace-convex-compat/package.json: 1: printf: Illegal option --
  "name": "@dohc/workspace-convex-compat",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
packages/workspace-fs/package.json: 1: printf: Illegal option --
  "name": "@dohc/workspace-fs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
packages/workspace-postgres/package.json: 1: printf: Illegal option --
  "name": "@dohc/workspace-postgres",
    "test": "vitest run --no-file-parallelism",
    "typecheck": "tsc --noEmit"
services/agent-sandbox/package.json: 1: printf: Illegal option --
  "name": "@dohc/agent-sandbox",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
services/app-tester/package.json: 1: printf: Illegal option --
  "name": "@dohc/app-tester",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
services/hocuspocus/package.json: 1: printf: Illegal option --
  "name": "@dohc/hocuspocus",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
services/sqlite-worker/package.json: 1: printf: Illegal option --
  "name": "@dohc/sqlite-worker",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
services/workspace-api/package.json: 1: printf: Illegal option --
  "name": "@dohc/workspace-api",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"

exec
/bin/bash -lc "nl -ba scripts/check-desktop-local-first-baseline.mjs && nl -ba package.json | sed -n '1,50p'" in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { spawnSync } from "node:child_process";
     2	
     3	// Tests must run under Node 22.13.0: Node 25 breaks 17 @dohc/web tests
     4	// (see execution log Environment section). Pin via PATH prefix.
     5	const pinnedNodeBin = "/home/ice/.local/share/nvm/v22.13.0/bin";
     6	const pnpmBin = "/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin";
     7	
     8	const env = {
     9	  ...process.env,
    10	  PATH: `${pinnedNodeBin}:${pnpmBin}:${process.env.PATH ?? ""}`,
    11	};
    12	
    13	const commands = [
    14	  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
    15	  ["pnpm", ["--filter", "@dohc/web", "test"]],
    16	  ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
    17	  ["pnpm", ["--filter", "@dohc/workspace-postgres", "test"]],
    18	  ["pnpm", ["--filter", "@dohc/workspace-fs", "test"]],
    19	  ["pnpm", ["--filter", "@dohc/workspace-api", "test"]],
    20	  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
    21	  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
    22	  ["pnpm", ["--filter", "@dohc/agent-sandbox", "test"]],
    23	  ["pnpm", ["check:debt"]],
    24	];
    25	
    26	for (const [cmd, args] of commands) {
    27	  console.log(`\n$ ${cmd} ${args.join(" ")}`);
    28	  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
    29	  if (result.status !== 0) process.exit(result.status ?? 1);
    30	}
     1	{
     2	  "name": "dohc",
     3	  "private": true,
     4	  "type": "module",
     5	  "engines": {
     6	    "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
     7	    "pnpm": "10.24.0"
     8	  },
     9	  "scripts": {
    10	    "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
    11	    "dev:app": "pnpm --filter @dohc/web --if-present run dev",
    12	    "dev:sync": "node scripts/dev-sync.mjs",
    13	    "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
    14	    "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
    15	    "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
    16	    "build": "pnpm -r --if-present build",
    17	    "start": "pnpm --filter @dohc/web --if-present run start",
    18	    "preview": "pnpm --filter @dohc/web --if-present run preview",
    19	    "reset:dev": "node scripts/reset-dev-data.mjs",
    20	    "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
    21	    "typecheck": "pnpm -r --if-present typecheck",
    22	    "test": "pnpm -r --if-present test",
    23	    "test:e2e": "playwright test",
    24	    "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
    25	    "sync:local": "pnpm --filter @dohc/workspace-fs sync",
    26	    "lint": "pnpm -r --if-present lint",
    27	    "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
    28	    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
    29	    "check:self-host": "node scripts/check-self-host.mjs",
    30	    "check:debt": "node scripts/check-tech-debt.mjs"
    31	  },
    32	  "packageManager": "pnpm@10.24.0",
    33	  "devDependencies": {
    34	    "@playwright/test": "^1.60.0"
    35	  }
    36	}

exec
/bin/bash -lc "nl -ba scripts/check-dual-backend-baseline.mjs | sed -n '1,200p' && nl -ba scripts/check-tech-debt.mjs | sed -n '1,220p'" in /home/ice/dev/dohc
 succeeded in 0ms:
     1	import { spawnSync } from "node:child_process";
     2	
     3	const commands = [
     4	  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
     5	  ["pnpm", ["--filter", "@dohc/web", "test"]],
     6	  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
     7	  ["pnpm", ["--filter", "@dohc/hocuspocus", "test"]],
     8	  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
     9	];
    10	
    11	for (const [cmd, args] of commands) {
    12	  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true });
    13	
    14	  if (result.status !== 0) {
    15	    process.exit(result.status ?? 1);
    16	  }
    17	}
     1	#!/usr/bin/env node
     2	import { readdirSync, readFileSync, statSync } from 'node:fs'
     3	import { fileURLToPath } from 'node:url'
     4	import { dirname, join, relative } from 'node:path'
     5	
     6	const root = join(dirname(fileURLToPath(import.meta.url)), '..')
     7	const term = (...parts) => parts.join('')
     8	const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
     9	const phraseRegex = (...parts) => new RegExp(escaped(term(...parts)), 'gi')
    10	
    11	const debtPatterns = [
    12	  { label: term('TO', 'DO'), regex: new RegExp(`\\b${term('TO', 'DO')}\\b`, 'g') },
    13	  { label: term('TB', 'D'), regex: new RegExp(`\\b${term('TB', 'D')}\\b`, 'g') },
    14	  { label: term('temporary ', 'dual ', 'backend'), regex: phraseRegex('temporary ', 'dual ', 'backend') },
    15	  { label: term('remove ', 'after ', 'migration'), regex: phraseRegex('remove ', 'after ', 'migration') },
    16	  { label: term('legacy ', 'views ', 'TO', 'DO'), regex: phraseRegex('legacy ', 'views ', 'TO', 'DO') },
    17	  { label: term('skip ', 'because ', 'migration'), regex: phraseRegex('skip ', 'because ', 'migration') },
    18	  { label: term('dead ', 'code'), regex: phraseRegex('dead ', 'code') },
    19	]
    20	
    21	const allowlist = [
    22	  {
    23	    file: 'docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md',
    24	    patterns: [
    25	      term('TO', 'DO'),
    26	      term('TB', 'D'),
    27	      term('temporary ', 'dual ', 'backend'),
    28	      term('remove ', 'after ', 'migration'),
    29	      term('legacy ', 'views ', 'TO', 'DO'),
    30	      term('skip ', 'because ', 'migration'),
    31	      term('dead ', 'code'),
    32	    ],
    33	    contains: 'The script must fail on:',
    34	    reason: 'The active implementation plan quotes the exact prohibited terms to define this check.',
    35	    deleteWhen: 'Remove this allowlist entry after the implementation plan is archived or deleted.',
    36	  },
    37	  {
    38	    file: 'docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md',
    39	    patterns: [term('TO', 'DO'), term('TB', 'D')],
    40	    contains: 'no untracked',
    41	    reason: 'The active implementation plan names the expected scan outcome.',
    42	    deleteWhen: 'Remove this allowlist entry after the implementation plan is archived or deleted.',
    43	  },
    44	  {
    45	    file: 'docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.md',
    46	    patterns: [term('TO', 'DO')],
    47	    contains: 'pseudo-test helper names',
    48	    reason: 'Historical implementation plan text documents a review rule, not live source debt.',
    49	    deleteWhen: 'Remove this allowlist entry when historical plans are moved out of repo-wide debt scans.',
    50	  },
    51	  {
    52	    file: 'docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.md',
    53	    patterns: [term('TB', 'D')],
    54	    contains: 'Placeholder scan',
    55	    reason: 'Historical implementation plan text documents an already completed placeholder scan.',
    56	    deleteWhen: 'Remove this allowlist entry when historical plans are moved out of repo-wide debt scans.',
    57	  },
    58	  {
    59	    file: 'apps/app/convex/confirmTier.ts',
    60	    patterns: [term('dead ', 'code')],
    61	    contains: 'single source of truth',
    62	    reason: 'This comment records that the confirm-tier helper is wired and reviewed, not obsolete code.',
    63	    deleteWhen: 'Remove the comment or this allowlist entry if confirm-tier policy is moved into a shared package.',
    64	  },
    65	  {
    66	    file: 'apps/app/convex/views.ts',
    67	    patterns: [term('TO', 'DO')],
    68	    contains: 'prefix-aware index',
    69	    reason: 'The bounded scan is retained for existing views compatibility until a prefix-aware view index exists.',
    70	    deleteWhen: 'Delete after view package discovery uses an indexed prefix lookup and the views regression suite covers the replacement.',
    71	  },
    72	  {
    73	    file: 'apps/app/convex/entities.ts',
    74	    patterns: [term('dead ', 'code')],
    75	    contains: 'existing` branch',
    76	    reason: 'This comment explains a mode-specific unreachable branch in shared entity update logic.',
    77	    deleteWhen: 'Remove the comment or split the helper when entity creation and update paths are separated.',
    78	  },
    79	]
    80	
    81	const skippedDirectories = new Set([
    82	  '.git',
    83	  '.gstack',
    84	  '.turbo',
    85	  '.next',
    86	  '.output',
    87	  '.vercel',
    88	  'coverage',
    89	  'dist',
    90	  'node_modules',
    91	  'playwright-report',
    92	  'test-results',
    93	])
    94	const skippedFiles = new Set([
    95	  'pnpm-lock.yaml',
    96	  'package-lock.json',
    97	  'yarn.lock',
    98	])
    99	const skippedExtensions = new Set([
   100	  '.avif',
   101	  '.bmp',
   102	  '.gif',
   103	  '.ico',
   104	  '.jpeg',
   105	  '.jpg',
   106	  '.pdf',
   107	  '.png',
   108	  '.sqlite',
   109	  '.webp',
   110	  '.zip',
   111	])
   112	
   113	validateAllowlist()
   114	
   115	const hits = []
   116	for (const file of walk(root)) {
   117	  const rel = normalize(relative(root, file))
   118	  if (skippedFiles.has(rel)) continue
   119	  const body = readTextFile(file)
   120	  if (body === null) continue
   121	  const lines = body.split(/\r?\n/)
   122	  for (const pattern of debtPatterns) {
   123	    pattern.regex.lastIndex = 0
   124	    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
   125	      const line = lines[lineIndex]
   126	      pattern.regex.lastIndex = 0
   127	      if (!pattern.regex.test(line)) continue
   128	      const hit = {
   129	        file: rel,
   130	        line: lineIndex + 1,
   131	        pattern: pattern.label,
   132	        text: line.trim(),
   133	      }
   134	      if (!isAllowed(hit, lines)) hits.push(hit)
   135	    }
   136	  }
   137	}
   138	
   139	if (hits.length > 0) {
   140	  console.error('Tech debt check failed. Unallowed debt markers found:')
   141	  for (const hit of hits) {
   142	    console.error(`- ${hit.file}:${hit.line} [${hit.pattern}] ${hit.text}`)
   143	  }
   144	  process.exit(1)
   145	}
   146	
   147	console.log(`Tech debt check passed with ${allowlist.length} documented allowlist entries.`)
   148	
   149	function* walk(dir) {
   150	  for (const name of readdirSync(dir)) {
   151	    if (skippedDirectories.has(name)) continue
   152	    const full = join(dir, name)
   153	    const stat = statSync(full)
   154	    if (stat.isDirectory()) {
   155	      yield* walk(full)
   156	      continue
   157	    }
   158	    if (!stat.isFile()) continue
   159	    if (skippedExtensions.has(extensionOf(name))) continue
   160	    yield full
   161	  }
   162	}
   163	
   164	function extensionOf(name) {
   165	  const index = name.lastIndexOf('.')
   166	  return index === -1 ? '' : name.slice(index).toLowerCase()
   167	}
   168	
   169	function normalize(path) {
   170	  return path.replace(/\\/g, '/')
   171	}
   172	
   173	function readTextFile(file) {
   174	  const body = readFileSync(file)
   175	  if (body.includes(0)) return null
   176	  return body.toString('utf8')
   177	}
   178	
   179	function isAllowed(hit, lines) {
   180	  return allowlist.some((entry) => {
   181	    if (entry.file !== hit.file) return false
   182	    if (!entry.patterns.includes(hit.pattern)) return false
   183	    if (entry.contains && !hit.text.includes(entry.contains)) {
   184	      const context = lines.slice(Math.max(0, hit.line - 12), Math.min(lines.length, hit.line + 4))
   185	      return context.some((line) => line.includes(entry.contains))
   186	    }
   187	    return true
   188	  })
   189	}
   190	
   191	function validateAllowlist() {
   192	  for (const entry of allowlist) {
   193	    if (!entry.reason || !entry.deleteWhen) {
   194	      throw new Error(`Allowlist entry for ${entry.file} is missing reason or deletion condition.`)
   195	    }
   196	    if (!Array.isArray(entry.patterns) || entry.patterns.length === 0) {
   197	      throw new Error(`Allowlist entry for ${entry.file} has no patterns.`)
   198	    }
   199	  }
   200	}

exec
/bin/bash -lc "grep -n \"xhigh\\|gpt-5.5\\|check:desktop\\|check-dual\\|Stop only\\|Recovery\\|codex\" docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md | sed -n '1,220p'" in /home/ice/dev/dohc
 succeeded in 0ms:
292:13. run independent third-party review of the phase commit (`codex exec review -m gpt-5.5 --commit <phase-sha>` at the effort tier specified in the Codex third-party review section: xhigh for high-risk phases 2, 4, 5, 9, 10, 11, 13, 16, 17, 18; high for low-risk phases 0, 1, 12, 14, 15); record findings in the execution log; fix or explicitly reject every finding; land fixes as follow-up commits.
332:- Tool: `codex exec review` (Codex CLI, verified installed and authenticated in this environment).
333:- Model: always pass `-m gpt-5.5` (verified working on this account; `gpt-5.5-fast` is not available under ChatGPT-account auth and adds output speed, not review depth). Do not modify the user's global `~/.codex/config.toml`.
334:- Effort tiering: checkpoint `--base main` reviews, per-phase reviews for security/sync/data-loss/deletion phases (2, 4, 5, 9, 10, 11, 13), design red-teams, the Phase 13 pre-deletion audit, and recovery consults run at `model_reasoning_effort="xhigh"`. Per-phase reviews for low-risk phases (0, 1, 12, 14, 15), adversarial scenario consults, and screenshot judging run at `"high"`. Remaining phases default to xhigh.
336:- After every phase commit: run `codex exec review -m gpt-5.5 --commit <phase-sha>` at the phase's effort tier (see Effort tiering below). VERIFIED CONSTRAINT (0.130.0 and 0.137.0-alpha both): `--commit` cannot be combined with a custom prompt — commit-scoped reviews run with Codex's default review instructions, which is acceptable. For high-risk phases (2, 4, 5, 9, 10, 11, 13), follow with a targeted plain `codex exec` read-only call prompting the phase's specific risk areas plus over-engineering/orphaned-code/simplification findings against `git show <phase-sha>`. Record findings in the execution log.
337:- At every major checkpoint: run `codex exec review -m gpt-5.5 -c model_reasoning_effort="xhigh" --base main` (checkpoints are always xhigh) over the cumulative branch diff with targeted questions for that checkpoint's risk area (e.g., IPC validation at Phase 4, merge/data-loss at Phase 10, deletion completeness at Phase 13).
340:- Pipelining: Codex reviews ALWAYS run as background tasks with stdout redirected to `docs/superpowers/reviews/codex/phase-NN.md`, launched immediately after the phase commit. While a review runs, the lead performs only read-only next-phase work (recon fan-outs, execution-map drafting, failing-test design — no commits, no shared-file mutation). A triage subagent reads the output file, dedupes, verifies each finding against actual code, and returns ≤15 numbered one-line actionable findings; the lead reads the raw transcript only when a triaged finding is ambiguous. Findings are triaged before the next phase's first commit.
342:- Invoke codex by the absolute path recorded in the execution log Environment section (PATH drift in fresh shells must not break the gate). If codex is temporarily unavailable, mark the phase "codex review pending," continue, and retry via self-paced wakeups (~10/30/60 min, max 3); a pending review is never silently dropped — the acceptance criteria remain the backstop.
343:- The gate is "independent third-party review," not one vendor binary. Phase 0 preflight verifies `codex` + `gpt-5.5` availability and records the result. If the exact tool/model is unavailable to the runner (different machine, CI, auth limits), the gate is satisfied by the first available fallback, recorded per phase in the execution log: (1) another available Codex model at the highest reasoning effort, (2) CodeRabbit review, (3) an independent adversarial verifier-subagent panel using the Checkpoint Review Recipe plus manual reviewer signoff. A runner without the preferred tool can therefore still complete every phase and the acceptance criteria.
347:- Independence rule: Codex never reviews an artifact Codex authored or materially shaped. Codex authors no code, no tests, and no candidate designs in this repo — its only write target is its own transcript under `docs/superpowers/reviews/codex/`. Codex is never assigned an implementation lane, utility module, script, or migration, in any worktree or phase: commit-scoped reviews must never audit their own author, and ChatGPT usage limits are reserved for judgment, not keystrokes. Where Codex consults influence landed work (adversarial scenarios, recovery diagnoses, design-review findings), the phase log records provenance in one line each; the Phase 18 readiness review audits that no phase-commit review covered Codex-originated artifacts beyond triaged review findings.
349:- Call ledger: the execution log Environment section gains an append-only Codex Calls table (date | purpose | effort | duration | outcome). Every codex invocation of any kind is logged.
350:- Discretionary-call hardening: same invocation discipline as the mandatory gate — absolute codex path, background task registered in the Resume Snapshot, stdout to `docs/superpowers/reviews/codex/`, hard timebox stated at launch (20 min recovery consult, 30 min screenshot pass, 45 min design red-team), terminated via the tracked task id on timeout, never pattern kills. Flag experiments (`--output-schema`, `-i`, session resume) happen on discretionary calls only — never change the mandatory review invocation mid-run.
354:1. Design red-team (Phases 9 and 10; 2 calls, xhigh, 45-min timebox): after the judges select a winning design and BEFORE implementation lanes launch, run `codex exec` (read-only sandbox) over the winning doc in `docs/architecture/` plus the Non-Negotiables and the named failure scenarios, prompted for data-loss holes, ordering/idempotency flaws, hand-waved failure scenarios, and simpler alternatives. Findings go through the standard triage→verify→fix-or-reject pipeline before lane briefs are issued; the design doc gains a Red-team Findings section. While it runs the lead does only read-only phase prep. On failure/timeout, fold the design questions into that phase's commit-review prompt and proceed. Codex never authors judge-panel candidates — all candidates are Claude subagents; cross-model input enters only here, post-verdict.
355:2. Adversarial scenario consult (post-Phase-4 checkpoint: IPC validation; Phase 10: the six data-loss cases; post-Phase-11 checkpoint: MCP path scoping; 3 calls, high effort): `codex exec` read-only, prompted to ENUMERATE concrete attack/loss scenarios (inputs, sequence, expected invariant violation) — output is scenario descriptions, never test files or repo writes. The lead transcribes chosen scenarios into owned tests under normal TDD (recorded RED required), discards duplicates per the code-size rules, and logs which landed scenarios were Codex-origin. A scenario asserting behavior that contradicts the plan's contracts is rejected with reasoning, never satisfied by weakening the implementation.
356:3. Recovery consult (rare; see Recovery Protocol): one bounded fresh-model diagnosis before any blocked declaration or Phase 16 deferral.
357:4. Pre-deletion audit (Phase 13, 1 call, xhigh): see Phase 13 Step 2.5.
391:ALWAYS background (registered in Resume Snapshot, with completion notification): docker compose stacks; workspace-api/hocuspocus/web dev servers (never foreground — WSL safety); the baseline script; full `pnpm -r` test/typecheck; full `pnpm test:desktop:e2e`; electron-builder packaging; `pnpm check:self-host`; Phase 17/18 verification batteries; all `codex exec review` runs; the two-client liveCoEditing E2E.
414:### Recovery Protocol
419:- Toolchain freeze: Phase 0 records `node -v`, `pnpm -v`, and `command -v codex` in the Environment section. Tests must run under the Node version that reproduces the dual-backend green sweep (22.13.0 verified — Node 25 breaks 17 web tests); pin via PATH prefix in scripts, do not run `nvm use` mid-run. Codex is invoked by absolute path.
420:- Fresh-model consult (required before declaring blocked): when the same blocker survives three concrete attempts, or a Phase 16 metric is still over budget after its 3 optimization attempts, the lead writes a self-contained brief to `docs/superpowers/reviews/codex/blocker-<phase>-<slug>.md` (symptom, exact failing command, path to full output, files inspected, the three attempts and why each failed) and makes ONE `codex exec` consult — read-only sandbox, xhigh, 20-minute timebox, backgrounded — asking for the most likely root cause and the smallest concrete fix or next experiment. Rules: this is attempt 4-of-4, never a counter reset; any proposed diagnosis must be independently confirmed by the lead via repro or exact code citation before any code change; if Codex is unavailable or the timebox expires, proceed directly to the blocked report (zero retries). The diagnosis file is attached to any blocked report. This consult is exempt from the per-phase review budget but logged in the call ledger.
440:Stop only if:
442:- the same blocker remains after three concrete attempts plus the Recovery Protocol fresh-model consult.
459:- The dual-backend plan is MERGED into main at bc62bd2 (PR #30). All "old plan" code lives in the current working tree. Never check out, diff against, or port from the stale local branch `codex/dual-backend-filesystem-agent-runtime`.
479:- Pending reviews: (codex/verifier in flight)
483:- Toolchain freeze: node version, pnpm version, absolute codex path
515:- Codex third-party review findings: (one-liners + pointer to docs/superpowers/reviews/codex/phase-NN.md)
524:- Update the Resume Snapshot at every TDD-step transition, before launching anything long-running (codex review, full suite, fan-out, worktree), and immediately after every commit. Register background tasks and worktrees in the snapshot BEFORE launching; clear entries on completion/merge. On resume, reconcile the snapshot against `git status`, `git worktree list`, and on-disk artifacts before doing anything else.
526:- No raw command output, stack traces, or codex transcripts over ~10 lines — write full output to `test-results/` or `docs/superpowers/reviews/codex/phase-NN.md` and link the path.
645:"check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs"
650:Preflight first: start `pnpm dev:postgres` as a background task and poll readiness (bounded, ~60s max); record `node -v`, `pnpm -v`, and `command -v codex` in the execution log Environment section (toolchain freeze — tests run under Node 22.13.0 via PATH prefix; Node 25 breaks 17 web tests); record display server state. The baseline script must pin the test Node via PATH.
652:Codex capability preflight (one cheap call each, recorded in Environment): verify `codex exec review` works; verify plain `codex exec` completes under a read-only sandbox; verify `-i` correctly describes a known test PNG. If optional capabilities (`codex exec`, `-i`) fail, disable only the discretionary uses needing them. If `codex exec review` or the preferred model itself fails, the review gate is NOT disabled — it switches to the independent-review fallback chain from the Codex third-party review section, recorded in the execution log.
655:pnpm check:desktop-local-first-baseline
1743:pnpm check:desktop-local-first-baseline
1750:Run in background, registered in the Resume Snapshot (1 call, xhigh): `codex exec` (read-only sandbox) reading the Convex sources (`apps/app/convex` or `apps/web/convex`), `packages/workspace-convex-compat`, and `services/hocuspocus/src/convex-acl.ts` in full against the ported test map, asked to list (a) every user-visible or security-relevant behavior implemented in Convex code with NO row in the map, and (b) every map row whose named replacement test does not actually cover the behavior — with file:line citations. The triage subagent verifies each claimed gap; confirmed gaps get a map row plus a replacement test before Step 3 runs. Step 3 MUST NOT start while this audit is in flight. This hunts unknown-unknowns the diff-shaped reviews cannot see: a behavior missing from the map appears in no diff.
2005:If any measurement is over budget, optimize before moving on. Exit rule: per over-budget metric, maximum 3 optimization attempts with recorded before/after numbers; after the third failed attempt, run the Recovery Protocol fresh-model consult (one Codex diagnosis of the hot path) before deferral; if still over, record the gap as a deferred finding for the Phase 16 checkpoint review rather than looping — but a metric that regressed relative to an earlier phase's recorded number is never deferrable.
2397:- every phase commit received an independent third-party review and every checkpoint received a cumulative third-party review (Codex gpt-5.5 xhigh preferred; a recorded fallback reviewer otherwise), with all findings fixed or explicitly rejected in the execution log.
2471:- After every phase commit and at every checkpoint, run independent third-party review using the effort tier from the plan's Codex third-party review section: xhigh for checkpoints and high-risk phases (2, 4, 5, 9, 10, 11, 13, 16, 17, 18); high for low-risk phases (0, 1, 12, 14, 15) and advisory screenshot/scenario passes. If preferred Codex gpt-5.5 is unavailable, use the fallback chain and record the reviewer in the execution log. Fix or explicitly reject every finding.
2504:Stop only if:
2505:- the same blocker remains after three concrete attempts plus the Recovery Protocol fresh-model consult.

exec
/bin/bash -lc "node - <<'EOF'
const {spawnSync}=require('node:child_process');
const r=spawnSync('node',['-e','console.log(process.argv.slice(1))'],{encoding:'utf8',shell:true});
console.log('status',r.status); console.log('stdout',r.stdout); console.error(r.stderr);
EOF" in /home/ice/dev/dohc
 succeeded in 0ms:
status 2
stdout 
/bin/sh: 1: Syntax error: "(" unexpected

(node:3) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)

exec
/bin/bash -lc "node - <<'EOF'
const {spawnSync}=require('node:child_process');
for (const args of [[\"--filter\",\"@dohc/web\",\"typecheck\"],[\"check:debt\"]]) {
 const r=spawnSync('printf',args,{encoding:'utf8',shell:true});
 console.log(r.status, JSON.stringify(r.stdout), JSON.stringify(r.stderr));
}
EOF" in /home/ice/dev/dohc
 succeeded in 0ms:
2 "" "/bin/sh: 1: printf: Illegal option --\n"
0 "check:debt" ""
(node:3) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)

exec
/bin/bash -lc "grep -n \"4 pre-existing\\|1618\\|failure\\|baseline\\|Node 25\\|Node 22\" docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md docs/superpowers/plans/2026-06-10-old-plan-port-delete-inventory.md | sed -n '1,240p'" in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:6:- Expected test state: baseline recorded — all package suites green; @dohc/web 1618/1623 (4 pre-existing main failures, see Gotchas); check:debt green
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:7:- Dirty files and intent: Phase 0 commit staging everything (AGENTS.md, plan, package.json, baseline script, this log, inventory, team audit doc)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:15:- Toolchain freeze: tests run under Node v22.13.0 via PATH prefix `/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH`. Shell default is Node v25.2.1 — Node 25 breaks 17 @dohc/web tests (verified 2026-06-10: AtomEditor.lifecycle suite 13/13 fail on 25, 13/13 pass on 22.13). Never run `nvm use`.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:36:- D-06 | Node 22.13.0 frozen for tests; codex by absolute path | Node 25 breaks 17 web tests; PATH drift | pre-phase
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:44:- All 9 packages/services mature and tested: workspace-contracts (conformance harness, 8 tests), workspace-postgres (Drizzle schema/migrations/repos/services, 12 tests, dev-ready, zero Convex coupling), workspace-fs (materialize/scan/diff/apply/syncClient/watch — watch is POLLING, 6 tests), workspace-api (HTTP handler + ResolveActor at src/auth/session.ts, 1 test, no production listener), agent-sandbox (allowlist shell, diff capture, 2+4 tests), sqlite-worker (11 tests; needs node:sqlite ⇒ Node 22.13+), app-tester (25 tests, backend matrix), hocuspocus (78 tests, Convex-coupled ACL), workspace-convex-compat (conformance-only consumer: workspace-contracts tests).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:45:- Final sweep: 1619 web tests passed under Node 22.13. Postgres pkg tests need `--no-file-parallelism` (shared DB fixture).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:65:- Node 25 breaks 17 @dohc/web tests; pin 22.13.0 via PATH (see Environment).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:71:- ECONNREFUSED from :5432/:9000/:1234 = environment failure, never a test failure.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:73:- Pre-existing failures on main @ e2de7a3 (fail under BOTH Node 22.13 and 25; broke between dual-backend sweep and merge): apps/app/convex/agentSandboxIntegration.test.ts ("teaches the model when to use shell" — AGENT_SRC prompt strings), src/__tests__/agentApprovalResume.test.tsx ("returns explicit scoped approval decisions"), src/__tests__/searchWriteAudit.test.ts ("no atom-inserting convex file outside the known set"), src/__tests__/uploadFiles.test.tsx ("exposes an upload button in the file sidebar area"). 4 tests / 1618 passed. NOT fixed in Phase 0 — these are main's bugs; several die with Convex in Phase 13 anyway.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:80:- Execution map: env preflight (done: services healthy, node/codex/display recorded) → execution log (this file) → baseline script Node-pinned → baseline background run → inventory doc from recon digests → commit → codex review (high tier, background)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:81:- Resume notes: baseline launching; inventory doc next; commit after baseline result recorded.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:82:- Files changed: AGENTS.md (product philosophy: three legs, git-for-everyday-people, fast-is-a-feature, less-code; pivot note), plan (all pre-execution amendments), package.json (+check:desktop-local-first-baseline), scripts/check-desktop-local-first-baseline.mjs (new, Node-pinned), this log (new), inventory doc (new), team audit doc (committed as-is)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:88:- Tests added: none (baseline phase)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:89:- Commands run: docker compose ps (healthy); node path checks; component path verification; `pnpm check:desktop-local-first-baseline` (Node-pinned, background) — @dohc/web typecheck PASS, web tests 1618/1623 PASS (4 pre-existing, recorded in Gotchas); continue-on-error sweep of remaining suites — workspace-contracts 10/10, workspace-postgres 14/14, workspace-fs 8/8, workspace-api 3/3, app-tester 25/25, sqlite-worker 11/11, agent-sandbox 3/3, check:debt PASS (after rewording two self-tripping doc lines), web typecheck PASS
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:90:- Failing tests fixed: n/a — 4 web failures are pre-existing on main @ e2de7a3, recorded not fixed (several die with Convex in Phase 13)
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md:99:- Remaining risk: baseline may surface pre-existing failures beyond the known Node issue — will be recorded verbatim, not fixed here
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:251:- Never record deferred work as code comments — the debt gate (`check:debt`) fails on the literal deferred-work marker tokens it scans for, and the failure surfaces phases later, far from its cause. Deferred work goes in the execution log's deferred-findings list with a completion condition. Adding entries to the check-tech-debt or knip allowlists for code this branch authored is forbidden; allowlists are for pre-existing/historical paths only, and every addition must be named in that phase's Codex review prompt.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:283:4. run the tests and record the failure.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:325:- Design judge panels: before implementing the sync protocol (Phase 9) and the conflict/co-editing model (Phase 10), generate at least 3 independent designs and score them with parallel judges against concrete failure scenarios: concurrent edit, offline rename, half-written file, watcher storm, clock skew, partial upload, reconnect-after-divergence. Each candidate is a doc with fixed sections: data model, message/protocol flow, behavior under each named failure scenario, estimated LOC and new dependencies, what it deletes. Judges receive identical briefs (candidate docs + Non-Negotiables + sync payload list + settle windows + perf budgets) and output a scored matrix (scenario × design, 0-2) plus a one-paragraph verdict. The winning design goes to `docs/architecture/` (losing designs and fatal flaws included); the Decision Ledger gets a one-line entry.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:354:1. Design red-team (Phases 9 and 10; 2 calls, xhigh, 45-min timebox): after the judges select a winning design and BEFORE implementation lanes launch, run `codex exec` (read-only sandbox) over the winning doc in `docs/architecture/` plus the Non-Negotiables and the named failure scenarios, prompted for data-loss holes, ordering/idempotency flaws, hand-waved failure scenarios, and simpler alternatives. Findings go through the standard triage→verify→fix-or-reject pipeline before lane briefs are issued; the design doc gains a Red-team Findings section. While it runs the lead does only read-only phase prep. On failure/timeout, fold the design questions into that phase's commit-review prompt and proceed. Codex never authors judge-panel candidates — all candidates are Claude subagents; cross-model input enters only here, post-verdict.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:372:Phase 0:  fan out read-only explorers (one per required digest + one per existing package classification); baseline runs in background.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:391:ALWAYS background (registered in Resume Snapshot, with completion notification): docker compose stacks; workspace-api/hocuspocus/web dev servers (never foreground — WSL safety); the baseline script; full `pnpm -r` test/typecheck; full `pnpm test:desktop:e2e`; electron-builder packaging; `pnpm check:self-host`; Phase 17/18 verification batteries; all `codex exec review` runs; the two-client liveCoEditing E2E.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:411:- Test-quality: method = disposable `git worktree add`, revert all non-test files in the phase range there, run the phase's test commands, expect failure; output = list of tests that still pass without the implementation (each is a finding). NEVER mutate the lead's checkout.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:417:- External service down (Postgres, minio, hocuspocus): the lead is authorized to start/restart via the documented compose commands (background, per WSL safety — no pattern kills). Not a blocker. An ECONNREFUSED/timeout from a service port is an environment failure, never a test failure; fix the environment, never the test.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:418:- Electron launch failure on this machine: the fix is ALWAYS environmental, never webPreferences (see Phase 2).
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:419:- Toolchain freeze: Phase 0 records `node -v`, `pnpm -v`, and `command -v codex` in the Environment section. Tests must run under the Node version that reproduces the dual-backend green sweep (22.13.0 verified — Node 25 breaks 17 web tests); pin via PATH prefix in scripts, do not run `nvm use` mid-run. Codex is invoked by absolute path.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:572:- Create: `scripts/check-desktop-local-first-baseline.mjs`
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:608:- [ ] **Step 3: Add baseline check**
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:610:Create `scripts/check-desktop-local-first-baseline.mjs`:
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:645:"check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs"
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:648:- [ ] **Step 5: Environment preflight, then run baseline**
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:650:Preflight first: start `pnpm dev:postgres` as a background task and poll readiness (bounded, ~60s max); record `node -v`, `pnpm -v`, and `command -v codex` in the execution log Environment section (toolchain freeze — tests run under Node 22.13.0 via PATH prefix; Node 25 breaks 17 web tests); record display server state. The baseline script must pin the test Node via PATH.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:655:pnpm check:desktop-local-first-baseline
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:658:Run as a background task. Expected: pass, or execution log records exact pre-existing failures. An ECONNREFUSED from Postgres is an environment failure — fix services, do not record it as a pre-existing test failure.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:665:git add package.json scripts/check-desktop-local-first-baseline.mjs docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:846:If the build output path differs, update the test after implementing `electron-vite` build. The RED failure should be missing desktop app/build output.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1427:- Test seam (required — do not improvise): workspace-api under `DOHC_TEST_AUTH=1` (dev/test only, asserted absent in production builds) exposes a test-only approval route (e.g., `POST /test/device/approve`) backed by a seeded test user; the desktop app under `DOHC_DESKTOP_TEST=1` surfaces the verification URL/code via the test bridge instead of opening the system browser. The E2E reads the code from the bridge, approves via the API as the seeded user, asserts polling succeeds and the stored token authenticates a real API request. Mocking the entire device flow client-side is a test-quality failure the verifier must flag.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:1743:pnpm check:desktop-local-first-baseline
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2185:- execution log records every failure.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2186:- each failure is either fixed or explicitly allowlisted with a deletion condition.
docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md:2469:- Use strict TDD: failing test, confirmed failure, implementation, passing targeted test, regression tests, E2E/smoke where relevant, delete-or-justify, execution log, commit.
grep: docs/superpowers/plans/2026-06-10-old-plan-port-delete-inventory.md: No such file or directory

exec
/bin/bash -lc "find packages services apps -maxdepth 3 -name package.json -print | sort | while read f; do node -e \"let p=require('./'+process.argv[1]); if(p.name && p.scripts && p.scripts.test) console.log(p.name+'\\t'+process.argv[1]+'\\t'+p.scripts.test)\" \""'$f"; done' in /home/ice/dev/dohc
 succeeded in 386ms:
@dohc/workspace-contracts	packages/workspace-contracts/package.json	vitest run
@dohc/workspace-convex-compat	packages/workspace-convex-compat/package.json	vitest run
@dohc/workspace-core	packages/workspace-core/package.json	vitest run
@dohc/workspace-fs	packages/workspace-fs/package.json	vitest run
@dohc/workspace-postgres	packages/workspace-postgres/package.json	vitest run --no-file-parallelism
@dohc/agent-sandbox	services/agent-sandbox/package.json	vitest run
@dohc/app-tester	services/app-tester/package.json	vitest run
@dohc/hocuspocus	services/hocuspocus/package.json	vitest run
@dohc/sqlite-worker	services/sqlite-worker/package.json	vitest run
@dohc/workspace-api	services/workspace-api/package.json	vitest run

exec
/bin/bash -lc 'git ls-tree -r --name-only 7df1553''^ | grep '"'package.json"'$'"' | sort | while read f; do name="'$(git show 7df1553''^:$f 2>/dev/null | node -e "let s='"''; process.stdin.on('data',d=>s+=d).on('end',()=>{try{let p=JSON.parse(s); if(p.name && p.scripts && p.scripts.test) console.log(p.name+'\\t'+process.argv[1]+'\\t'+p.scripts.test)}catch(e){}})\" \""'$f"); [ -n "$name" ] && echo "$name"; done' in /home/ice/dev/dohc
 succeeded in 386ms:
dohc	package.json	pnpm -r --if-present test
@dohc/workspace-contracts	packages/workspace-contracts/package.json	vitest run
@dohc/workspace-convex-compat	packages/workspace-convex-compat/package.json	vitest run
@dohc/workspace-fs	packages/workspace-fs/package.json	vitest run
@dohc/workspace-postgres	packages/workspace-postgres/package.json	vitest run --no-file-parallelism
@dohc/agent-sandbox	services/agent-sandbox/package.json	vitest run
@dohc/app-tester	services/app-tester/package.json	vitest run
@dohc/hocuspocus	services/hocuspocus/package.json	vitest run
@dohc/sqlite-worker	services/sqlite-worker/package.json	vitest run
@dohc/workspace-api	services/workspace-api/package.json	vitest run

exec
/bin/bash -lc 'git status --short packages/workspace-core && git log --oneline -- packages/workspace-core/package.json | head' in /home/ice/dev/dohc
 succeeded in 140ms:
?? packages/workspace-core/

exec
/bin/bash -lc "find docs/superpowers -name '*old-plan-port-delete-inventory.md' -print -exec nl -ba {} \\; | sed -n '1,120p'" in /home/ice/dev/dohc
 succeeded in 0ms:
docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md
     1	# Old Plan Port/Delete Inventory
     2	
     3	Classification of the merged dual-backend substrate (main @ bc62bd2) for the desktop local-first pivot. Evidence: dual-backend execution log, readiness review, tech-debt audit (digested in the execution log's Reference Digests), and direct path verification on 2026-06-10. The stale local branch `codex/dual-backend-filesystem-agent-runtime` is never used — all code below lives in the current working tree.
     4	
     5	## Keep And Promote
     6	
     7	| Asset | Evidence | Pivot role |
     8	|---|---|---|
     9	| `packages/workspace-contracts` | conformance harness + domain validators, 8 tests green | contract layer both desktop core and cloud sync code against; conformance harness reused for sync engine |
    10	| `packages/workspace-postgres` | Drizzle schema/migrations/repos/services, 12 tests green, zero Convex coupling | the only cloud/self-host backend (Phase 9) |
    11	| `packages/workspace-fs` | materialize/scan/diff/apply/syncClient/watch, 6 tests green | local workspace engine (Phase 5); NOTE: watch is polling — Phase 5 replaces with chokidar |
    12	| `services/workspace-api` | HTTP handler + ResolveActor (`src/auth/session.ts`), route surface proven | cloud/self-host API; Better Auth mounts here (Phase 9) |
    13	| `services/agent-sandbox` | allowlist shell, diff capture, approvals; 2+4 tests green | hosted/cloud sandbox; desktop local agents use folder+MCP first (Phase 11) |
    14	| `services/sqlite-worker` | import/query/row ops, 11 tests green; requires Node 22.13+ (`node:sqlite`) | SQLite import/materialization/query (Phase 8) |
    15	| `services/app-tester` | 25 tests green incl. backend matrix | app quality gate (Phase 7); matrix pivots to desktop/local/cloud |
    16	| `services/hocuspocus` | 78 tests green | live co-editing server (Phase 10) — after ACL port off Convex |
    17	
    18	## Port With Changes
    19	
    20	| Asset | Source paths (verified) | Change |
    21	|---|---|---|
    22	| File-type views | `apps/app/src/components/FileTypeView.tsx`, `DatabaseStudio.tsx`, `DatabaseTableGrid.tsx` | port into desktop FileInspector dispatch table (Phase 6); strip Convex/web data hooks; data via typed desktop bridge |
    23	| File tree / upload | `apps/app/src/components/FileTree.tsx`, `UploadFileButton.tsx` | desktop shell surfaces (Phase 3/6); subject to Phase 3 component reuse map criterion |
    24	| Agent output separation | `apps/app/src/components/AgentActivityTimeline.tsx`, `AgentRunRail.tsx`, `AgentChatSidebar.tsx` | desktop agent activity panel (Phase 3); presentation primitives reusable |
    25	| App runtime / trust | `apps/app/convex/apps.ts`, `appAgent.ts`, `appTesting.ts`, `appTrust.ts` + app runtime client code | behavior ports to local `.apps/<name>` discovery + build cache (Phase 7); trust/scope semantics preserved, Convex storage replaced |
    26	| Hocuspocus ACL | `services/hocuspocus/src/convex-acl.ts` (exports createConvexAcl: checkAtomAccess/loadAtomBootstrap/setBodyCache/createAtom surface) | port to `postgres-acl.ts` against workspace-postgres grants + Better Auth sessions (Phase 10) |
    27	| Backend matrix | `services/app-tester/src/backendMatrix.test.ts`, `apps/app/e2e/backendMatrix.spec.ts` | rewrite as desktop/local/cloud matrix (Phases 9, 18) |
    28	| Auth actor shape | `services/workspace-api/src/auth/session.ts` ResolveActor | keep actor shape; resolve from Better Auth sessions instead of Convex/WorkOS (Phase 9) |
    29	
    30	## Delete After Replacement (each with its gate)
    31	
    32	| Asset | Replacement proof required | Phase |
    33	|---|---|---|
    34	| `apps/app/convex/` (entire Convex backend, ~40 modules) | ported test map rows all pass (atoms/authz/auth/app trust/uploads/onboarding) | 13 |
    35	| `packages/workspace-convex-compat` | conformance covered by postgres adapter alone | 13 |
    36	| Dual-backend switch (`apps/app/src/backend/backendClient.ts`, `convexBackendClient.ts`, `postgresBackendClient.ts`, `DOHC_BACKEND`) | desktop/local/cloud matrix replaces it | 13/17 |
    37	| `@convex-dev/workos-authkit` + `use-auth-bridge.ts` + auth.config.ts + WORKOS_* env | Better Auth tests + cloudLogin E2E green | 13 |
    38	| `services/hocuspocus/src/convex-acl.ts` + HOCUSPOCUS_CONVEX_* env | postgres-acl tests + live co-editing E2E green | 13 |
    39	| Web-first atom tools duplicating local-file paths | MCP/local-file workflows cover behavior | 13/17 |
    40	| `.views` compatibility paths | `.apps` migration/regression tests green | 17 |
    41	| Convex scripts in dev-sync.mjs, reset:dev, env examples | desktop/local dev path documented | 13 |
    42	| `scripts/check-dual-backend-baseline.mjs` | desktop-local-first baseline replaces it | 17 |
    43	
    44	## Delete Immediately
    45	
    46	- Nothing. Day-1 deletion candidates all have live consumers until their phase gate. (Aggression budget goes to Phases 13/17 where tests prove safety.)
    47	
    48	## Tests To Preserve
    49	
    50	- workspace-contracts conformance harness (becomes the sync-engine contract test).
    51	- workspace-postgres schema/conformance/services suites.
    52	- app-tester suite (matrix relabeled, assertions kept).
    53	- hocuspocus suite (ACL tests swapped to postgres-acl, doc/persistence tests kept).
    54	- @dohc/web security/collab slices (authz boundaries, app security/trust, agent approvals) — these become the Phase 13 ported-test-map evidence.
    55	
    56	## Tests To Rewrite
    57	
    58	- `backendSwitch.test.tsx` → desktop/local/cloud mode tests.
    59	- `apps/app/e2e/backendMatrix.spec.ts` → desktop product readiness matrix (Phase 18).
    60	- Convex-coupled integration tests (`agentSandboxIntegration`, `hocuspocusAuth`-dependent) → replacement tests named in the Phase 13 ported test map.
    61	- Web onboarding tests → desktop first-run tests (Phase 3) + web cloud-role tests (Phase 12).
    62	
    63	## Remaining Questions
    64	
    65	- Does `apps/app/src/routes/r/$atomId.tsx` (share-page SSR via ConvexHttpClient) need a Postgres-backed replacement before Phase 13, or does Phase 12 web repositioning subsume it? (Tracked for Phase 12 planning; default: workspace-api share endpoint.)
    66	- sqlite-worker fallback path when `node:sqlite` is unavailable — keep or delete once toolchain freeze guarantees 22.13+? (Phase 8 delete-or-justify.)
    67	- Hocuspocus Y.Doc persistence currently writes to its own Postgres URL (`HOCUSPOCUS_DATABASE_URL`) — unify with workspace Postgres in Phase 10 or keep separate? (Phase 10 design panel input.)

codex
The main executable change is the new baseline check, and it does not match the baseline described by the commit: it aborts on known web failures, skips existing suites, and can silently run under the wrong Node version. These issues make the added check unreliable for the planned phase gates.

Full review comments:

- [P2] Fail fast on the documented web baseline — /home/ice/dev/dohc/scripts/check-desktop-local-first-baseline.mjs:15-15
  With the current baseline documented in this same commit, `@dohc/web` has 4 known failures, so this command returns nonzero and the script exits at line 29 before checking any remaining packages. That means `pnpm check:desktop-local-first-baseline` cannot reproduce the recorded “continue-on-error” baseline sweep and will keep failing at Phase 0/13 invocations until those unrelated web failures disappear; either encode the known failure allowance or continue and summarize failures across all suites.

- [P2] Include all existing package test suites — /home/ice/dev/dohc/scripts/check-desktop-local-first-baseline.mjs:16-23
  The new baseline omits tracked packages that already have test scripts, notably `@dohc/hocuspocus` and `@dohc/workspace-convex-compat`, even though the plan/inventory calls out Hocuspocus ACL/collab and compat behavior as code to preserve or port. In phases that rely on this script as the regression baseline, those suites can break while `check:desktop-local-first-baseline` still passes.

- [P2] Verify the pinned Node toolchain exists — /home/ice/dev/dohc/scripts/check-desktop-local-first-baseline.mjs:5-10
  On any runner without `/home/ice/.local/share/nvm/v22.13.0/bin` or the matching pnpm path, this silently falls through to the caller's PATH, so the baseline may run under Node 25 despite the commit documenting that Node 25 breaks web tests. The script should fail with a clear message or resolve a configurable Node 22.13 binary instead of silently producing a non-comparable baseline.
The main executable change is the new baseline check, and it does not match the baseline described by the commit: it aborts on known web failures, skips existing suites, and can silently run under the wrong Node version. These issues make the added check unreliable for the planned phase gates.

Full review comments:

- [P2] Fail fast on the documented web baseline — /home/ice/dev/dohc/scripts/check-desktop-local-first-baseline.mjs:15-15
  With the current baseline documented in this same commit, `@dohc/web` has 4 known failures, so this command returns nonzero and the script exits at line 29 before checking any remaining packages. That means `pnpm check:desktop-local-first-baseline` cannot reproduce the recorded “continue-on-error” baseline sweep and will keep failing at Phase 0/13 invocations until those unrelated web failures disappear; either encode the known failure allowance or continue and summarize failures across all suites.

- [P2] Include all existing package test suites — /home/ice/dev/dohc/scripts/check-desktop-local-first-baseline.mjs:16-23
  The new baseline omits tracked packages that already have test scripts, notably `@dohc/hocuspocus` and `@dohc/workspace-convex-compat`, even though the plan/inventory calls out Hocuspocus ACL/collab and compat behavior as code to preserve or port. In phases that rely on this script as the regression baseline, those suites can break while `check:desktop-local-first-baseline` still passes.

- [P2] Verify the pinned Node toolchain exists — /home/ice/dev/dohc/scripts/check-desktop-local-first-baseline.mjs:5-10
  On any runner without `/home/ice/.local/share/nvm/v22.13.0/bin` or the matching pnpm path, this silently falls through to the caller's PATH, so the baseline may run under Node 25 despite the commit documenting that Node 25 breaks web tests. The script should fail with a clear message or resolve a configurable Node 22.13 binary instead of silently producing a non-comparable baseline.
