# dohc

dohc is a local-first workspace where people and their agents build on files, documents, data, chat, and apps.
It provides sync, sharing, permissions, and history so each workflow does not have to recreate them.
Users own their work and decide how to use it.

We are building the MVP and have not launched with users.

## How to use this document

The product sections below are decision boundaries, not a feature checklist. Use them to reject work that would turn dohc into the wrong product.

- If an instruction conflicts with the task, explain the conflict and get human approval before breaking it.
- Treat the remaining instructions as repository defaults. An explicit developer request can override them.

## Product model

The workspace is the primary product object. It can contain files, live documents, structured data, chats, and apps.

Files are the portable foundation, not the required runtime representation for every feature. Use the state model that fits the subsystem. A live document can be a Y.Doc and structured data can live in SQLite. Keep work owned, inspectable, and exportable instead of forcing all state into flat text.

Design capabilities around shared work. Chat references the work, apps use explicitly exposed data, and collaborators continue within its permissions and history.
Explain each connection through a concrete user action.

Product commitments describe intended behavior. Verify the current implementation before claiming a capability is available.
Keep illustrative demos distinguishable from working product behavior.

A workspace must be useful to one person on one device. Team collaboration is still core: adding another person or agent should extend the same work, not require exports, copied context, or a new system.

### Product commitments

1. **Local first and user owned.** Creating, inspecting, and editing local work must not require an account or network connection. Sync and sharing add capability. They do not make local work a cache of a remote product. Keep the underlying files and data inspectable or exportable so the user can recover their work without dohc. Self-hosting must be meaningful; dohc Drive should win through the managed network and operational experience, not a crippled local product.

2. **Performance without compromise.** Speed is a core reason to be local-first and to ship a desktop app. dohc must feel native, as if the OS came with it preinstalled. Lots of apps have gotten bogged down with bad tech decisions and slop; dohc does not join them. If Notion in a browser tab feels faster than dohc, dohc has lost its own argument. Make sure every change is considerate of its performance impact, and treat a regression as a bug, not a tradeoff.

3. **Collaboration on the work itself.** Humans and agents share durable workspace objects with their context, history, permissions, and provenance. Do not reduce collaboration to exporting files, pasting context into a chat, or several people typing into an isolated document.

4. **Built for humans and agents.** Design every feature and surface for two users from the start: a human and an agent. Parity is not an MCP server added after the fact; the feature itself must work for both. For example, a share link sent to an agent should work just like one sent to a friend: with the link alone, the agent can read, edit, comment, and chat, with no computer use, no separate integration, and no impersonating a person.

5. **Agent agnostic.** dohc does not provide or supervise the user's agents. Any agent that can work with ordinary files should remain useful. dohc adds reliable tools and optional identity, provenance, and policy controls. It must not impose a universal agent approval workflow.

6. **Chat is part of the workspace.** Chat connects humans, agents, files, data, and apps. It supports requests, discussion, handoffs, and proactive agent messages. Users and agents can turn useful outcomes into durable work instead of losing them in a transcript.

7. **Apps are real web apps.** A dohc app is source-backed, inspectable, dynamic, and connected only to data and capabilities the owner exposes. Its source lives and syncs in the workspace so collaborators and their agents can continue changing it. It can be shared by URL with someone who does not use dohc. Treat app execution, authentication, and workspace access as separate security boundaries.

8. **Rigid substrate, flexible workflow.** Be strict about ownership, authentication, permissions, sync, history, provenance, links, and isolation. Let users and agents decide their folders, tools, rituals, agents, and domain workflows. Plugins extend dohc; keep their source visible and easy for agents to change. The core must already provide the reliable substrate.

Do not turn dohc into an AI wrapper, company brain, Notion clone, dashboard generator, chat overlay, prescribed workflow, template marketplace, or productivity theater. Reusable examples and templates are useful; making users conform to them is not the product.

### A note from Ice

We are building something ambitious. Put that ambition into what the product lets people do, not into unnecessary machinery. Question conventional product boundaries when they hold us back, then build the smallest system that makes the correct behavior obvious.

People are still learning how they want to work with agents. dohc should not fight them with our theory of the right workflow. Start from familiar files, chats, and web apps. Make the hard coordination reliable underneath them. Familiar affordances may hide a different implementation, but never bluff about durability, isolation, permissions, persistence, provenance, or production readiness.

If a folder and a capable agent can already do the job, dohc must earn its place by making that work materially easier to continue, understand, change, and share. Activity inside dohc is not success. Real work becoming easier is.

## What dohc looks like in practice

Use these examples to test product proposals. A feature can use dohc's vocabulary and still miss the product.

### Plan a trip

- ✅ **dohc.** A person works with an agent through files and chat, then builds the trip app they want. They share the app, files, and conversation with the group. The group and their agents can continue the same work from a phone or browser. dohc handles sync, identity, permissions, and history underneath. The trip is the work. Agent orchestration is only one possible means.
- ❌ **Not dohc.** The person downloads a "travel team" template, configures agent roles and heartbeats, then accepts its prescribed workflow.

### Build a project dashboard

- ✅ **dohc.** An agent builds a source-backed web app in the workspace. The app reads and updates only the files and data its owner exposed. Collaborators can inspect and edit its source. Someone without dohc can open the published URL when they have access.
- ❌ **Not dohc.** An artifact or dashboard generator emits detached HTML with no durable source, live data boundary, history, or collaborative path forward. A polished demo is not yet a workspace.

### Share work in progress

- ✅ **dohc.** A person shares the relevant part of a workspace with its files, data, app, chat, history, and declared dependencies. The recipient and their agent can inspect what happened and continue the same work without reconstructing its context.
- ❌ **Not dohc.** The person exports a file, pastes an old chat, or sends a zip. The recipient must start again in another tool. Sharing should transfer continuity, not only bytes.

### Tailor the workspace

- ✅ **dohc.** A user asks an agent to create or change a source-visible plugin or app for their workflow. They can inspect it, fork it, and share it. The result can fit their work without forcing the same workflow on everyone else.
- ❌ **Not dohc.** dohc ships a hardcoded CRM, requires a project ritual, or becomes a template marketplace. dohc supplies reliable building blocks. Users and agents decide what to build.

## Product invariants

Do not weaken authorization, ownership, isolation, or explicitly configured controls for convenience.

- Derive authorization server-side. Never trust a browser or client caller to provide user identity.
- Scope every file, folder, document, chat, share, capture, and app capability to a workspace.
- Apply the same storage, permission, path access, sharing, and configured policy boundaries to human and agent changes. Agent identity is optional provenance, not a separate storage authority.
- Sandbox sites, apps, and HTML previews. They receive only explicitly granted capabilities and data; they do not inherit workspace authority.
- Treat a live document session's Y.Doc as canonical. On settlement, the engine writes the Markdown artifact. Do not make raw full-body Markdown patching the source of truth for live editing.
- Give every reversible state change a visible reverse path. Warn the user before an irreversible action runs.
- Guard every asynchronous renderer response with a workspace/request token, abort signal, or equivalent before setting workspace-scoped UI state. A slow response for workspace A must never repaint workspace B.

Within these boundaries, authors decide what their apps do and which web frameworks and external services they use. Authors are responsible for app behavior, including where an app sends data it receives.

## Work against the current design

There are no users yet. Optimize for the best current design instead of preserving old internal contracts.

- Replace obsolete contracts instead of adding compatibility layers.
- Remove deprecated aliases, dual formats, fallbacks, shims, and dead paths.
- Update all internal callers, tests, fixtures, and docs in the same change.
- Add a migration path only when the user asks for one.

## Engineering defaults

Understand the constraint before building. Choose the smallest model that makes the required behavior and performance unsurprising. Do not preserve complexity because it exists or add machinery because it looks architecturally impressive.

### Continue from approved work

- Treat approved behavior and design choices as the working baseline. Interpret feedback at the requested scope.
- Preserve a recoverable comparison before a broad redesign.
- When a direction is rejected, restore the affected change while preserving unrelated work. Carry the correction into subsequent work.

### Finish the experience

Craft includes layout, interaction, loading, failure, and recovery. Evaluate the complete experience, including transitions between states.
- Choose layouts for their content. Give comparisons enough room, with consistent spacing and varied composition.
- Prefer interfaces that are clear without subtext or subheadings. Use them only as a last resort or when they are the most obvious, simplest solution for users. If a cleaner design works without them, choose it.
- For broad redesigns, develop one representative section before extending the treatment.
- Inspect affected layouts, both themes, keyboard access, reduced motion, loading transitions, and failure states in the browser.
- Match preview and live visuals. Keep content useful while visuals load, and suspend animation offscreen.
- Measure startup and interaction when changing rendering or loading. Judge the experience alongside automated performance scores.

## Documentation and writing

Name the reader before adding a document to main. If nobody will use it to make a decision or perform work, do not add it. Git records what happened. Tests should enforce rules that code can break.

Read [`.agents/skills/dohc-writing/SKILL.md`](.agents/skills/dohc-writing/SKILL.md) before writing docs, specs, plans, PR bodies, commit messages, or skills. Use [`.agents/skills/dohc-interface/SKILL.md`](.agents/skills/dohc-interface/SKILL.md) for anything a person sees inside the app.

Use one name for one thing. [`CONTEXT.md`](CONTEXT.md) is the canonical term list; check terms against it and the surrounding code before defining them. If a paragraph-long code comment is needed to defend a workaround, fix the code instead.

## Where code lives

- `apps/desktop` contains the Electron app. Most user-visible product work lands here.
- `apps/site` contains the marketing site and product demo.
- `packages` contains shared TypeScript contracts, clients, tools, auth, and UI code.
- `services` contains opt-in auth, sync relay, and SQLite services.
- `crates` contains the Rust workspace engine and supporting crates. `dohc-workspace-engine` builds the daemon used by the desktop app.
- `tools/rust-engine-program` contains the Rust gate scripts, fixture goldens, and evidence tools.

## Local development

Use Node 24.14 or newer and pnpm 11.20.0, as pinned in `package.json`.

- `pnpm dev:desktop` starts the desktop app. `pnpm dev` is an alias.
- `pnpm dev:site` starts the marketing site.
- `pnpm dev:workspace-api` starts the workspace API.
- `pnpm dev:postgres` starts development Postgres; `pnpm migrate` applies migrations; `pnpm reset:postgres` clears development data. The desktop app does not need Postgres.
- Stop every process you start by the PID you recorded.

## Verification

Use [the agent verification procedure](docs/how-to/verify-agent-work.md) for worktree setup, desktop QA, debug access, and PR evidence.
For desktop QA, start with `pnpm doctor`. Use `pnpm qa:smoke` for boot, editing, persistence, and restart.

Run the smallest check that proves the change.

- Run the affected package's typecheck and focused unit or integration tests while editing.
- One verification owner runs the full selected gates through `pnpm verify:pr --base <target-ref>`.
- Other agents run focused checks and reuse the owner's evidence instead of repeating full gates.
- `pnpm test:desktop:e2e` prepares and verifies the desktop and native engine before launching Playwright.
- For Rust work, use the [`rust-gate` skill](.agents/skills/rust-gate/SKILL.md), never a bare `cargo` command. Read the gate's `== summary ==` block rather than its exit code.
- A test that needs a sleep to pass is wrong. Wait for the actual condition.

## Pull requests and merging

PR verification runs locally because cloud CI costs remain out of budget.
GitHub PR checks stay dispatch-only and require self-hosted runners. Do not enable cloud runners.
Keep one concern per PR. Keep required contract, caller, and test changes together.
Finish implementation, self-simplification, and focused checks before requesting independent review.

### Verify the change

The canonical local runner selects JavaScript and Rust gates from the [`PR checks` workflow's filters](.github/workflows/pr-checks.yml).
Use `pnpm verify:plan --base <target-ref>` to inspect that selection locally.

- One agent owns verification and the PR's evidence. Other agents run focused checks for their changes.
- Before merging, require passing local evidence that covers the PR's changes.
- After a rebase or merge, inspect the delta and reuse passing evidence when it still covers the change.
- Rerun only checks affected by source, dependency, configuration, or conflict-resolution changes. Advancing main alone does not require another gate run.
- Require every selected job to pass. A missing, cancelled, or failed run is not a pass.
- If a job reads a changed file outside its filter, correct the filter and run that job.
- When impact is unclear, run both jobs with explicit `--job js` and `--job rust` invocations.
- Record the tested commit, target ref, selected gates, result, and evidence location. Explain any reuse across commits.
- If no code gate applies, record the runner's selection and reason.
- Add focused platform verification when changed behavior depends on Windows or macOS.

Use `pnpm verify:pr --base <target-ref>` as the single full-verification entry point.
It owns the service setup, prebuilds, gate selection, and evidence. Follow [the verification procedure](docs/how-to/verify-agent-work.md#verify-a-pull-request).
Keep the checkout unchanged during each run. Preserve the original commit and target in its `result.json`.
The Rust gate retains its build budget and mandatory summary-verdict checks.

### Select reviewers

- Routine changes need one primary independent reviewer. Additional bots provide optional feedback.
- Non-trivial code changes need a primary reviewer from a different model family than the implementation agent.
- Combine correctness and simplification in that review. Give the reviewer the diff, relevant source, and required behavior.
- Authorization, isolation, security, privacy, migration, durability, and major integration changes need a second independent reviewer of those risks.
- Add a second reviewer for a disputed blocking finding. Give that reviewer the disputed behavior and source.
- Name the required reviewers and their scopes in the PR.

Keep each appointed reviewer through the fix rounds. Replace an unavailable reviewer once and record the reason.
The replacement owns the remaining review, including necessary checks of later fixes.
The original reviewer's return does not require another pass.

### Macroscope trial

Use one Macroscope review for ready PRs that change persistence, recovery,
permissions, workspace isolation, sync conflict handling, or live-document settlement.
Skip documentation, cosmetic UI changes, and test-only changes.
Include refactors when they affect these behaviors.

- Complete local gates and required local reviews before requesting Macroscope.
- Check PR comments and checks for an existing request or review before posting.
- If none exists, comment `@macroscope-app review` once.
- Request at most one Macroscope review per PR unless the user asks for another.
- Verify findings using the review rules below.
- Summarize confirmed bugs missed by local reviews, false positives, and actual cost when available.
- Keep billing settings and additional Macroscope features unchanged.
- If a spend limit stops review, report the skip and continue the existing review process.

Manual review requests can bypass per-review and per-PR caps.
The monthly workspace limit still applies.
Macroscope supplements required reviews during the trial; it is not a merge gate.

### Review findings

Treat a finding as evidence, not a command. Verify it against the current head and required behavior.

- Fix concrete regressions in correctness, security, privacy, durability, compatibility, performance, or user-visible behavior.
- Decline false positives, speculative hardening, alternative designs, and out-of-scope work with a short technical reason.
- Prefer the smallest safe fix. Do not add policy or machinery only to satisfy a reviewer.

### Complete the review

- Batch verified fixes into one update. Ask the responsible reviewer to check the affected delta.
- Request further rounds only for a new verified blocker or an unresolved high-risk concern.
- For a rebase with an unchanged patch, the verification owner can record that comparison without restarting full review.
- Conflict resolutions and substantive integration changes need review of the affected delta.
- Before merging, account for the full reviewed diff, subsequent deltas, and every known finding on the final head.
- Optional bot approval and reviewer unanimity are not merge requirements. Every verified blocker must still be resolved.
- Record reviewed commits, delta coverage, and dispositions in one maintained PR review note.

When ready to merge, add the review-round count, useful fixes, and any reviewer or verification delays to that note.
Use local step durations for verification time. Report unknown durations as unknown.
Use these records to identify repeated delays and slow or overlapping tests before adding gates or removing coverage.
For narrower gates, account for shared dependencies in both the canonical runner and workflow filters before changing coverage.
