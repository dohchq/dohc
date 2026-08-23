# dohc

dohc is a local-first file sync and collaboration workspace for humans and agents. It syncs your files and data across your devices and lets you share work with your team and your agents.

We are building the MVP and have not launched with users.

## How to use this document

The product sections below are decision boundaries, not a feature checklist. Use them to reject work that would turn dohc into the wrong product.

- If an instruction conflicts with the task, explain the conflict and get human approval before breaking it.
- Treat the remaining instructions as repository defaults. An explicit developer request can override them.

## Product model

The workspace is the primary product object. It can contain files, live documents, structured data, chats, and apps.

Files are the portable foundation, not the required runtime representation for every feature. Use the state model that fits the subsystem. A live document can be a Y.Doc and structured data can live in SQLite. Keep work owned, inspectable, and exportable instead of forcing all state into flat text.

dohc owns the hard coordination: files, data, identity, sync, history, permissions, apps, and chat. Users and their agents own the workflow.

A workspace must be useful to one person on one device. Team collaboration is still core: adding another person or agent should extend the same work, not require exports, copied context, or a new system.

### Product commitments

1. **Local first and user owned.** Creating, inspecting, and editing local work must not require an account or network connection. Sync and sharing add capability. They do not make local work a cache of a remote product. Keep the underlying files and data inspectable or exportable so the user can recover their work without dohc. Self-hosting must be meaningful; dohc Cloud should win through the managed network and operational experience, not a crippled local product.

2. **Collaboration on the work itself.** Humans and agents share durable workspace objects with their context, history, permissions, and provenance. Do not reduce collaboration to exporting files, pasting context into a chat, or several people typing into an isolated document.

3. **Agent agnostic.** dohc does not provide or supervise the user's agents. Any agent that can work with ordinary files should remain useful. dohc adds reliable tools and optional identity, provenance, and policy controls. It must not impose a universal agent approval workflow.

4. **Chat is part of the workspace.** Chat connects humans, agents, files, data, and apps. It supports requests, discussion, handoffs, and proactive agent messages. Users and agents can turn useful outcomes into durable work instead of losing them in a transcript.

5. **Apps are real web apps.** A dohc app is source-backed, inspectable, dynamic, and connected only to data and capabilities the owner exposes. Its source lives and syncs in the workspace so collaborators and their agents can continue changing it. It can be shared by URL with someone who does not use dohc. Treat app execution, authentication, and workspace access as separate security boundaries.

6. **Rigid substrate, flexible workflow.** Be strict about ownership, authentication, permissions, sync, history, provenance, links, and isolation. Let users and agents decide their folders, tools, rituals, agents, and domain workflows. Plugins extend dohc; keep their source visible and easy for agents to change. The core must already provide the reliable substrate.

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

## Work against the current design

There are no users yet. Optimize for the best current design instead of preserving old internal contracts.

- Replace obsolete contracts instead of adding compatibility layers.
- Remove deprecated aliases, dual formats, fallbacks, shims, and dead paths.
- Update all internal callers, tests, fixtures, and docs in the same change.
- Add a migration path only when the user asks for one.

## Engineering defaults

Understand the constraint before building. Choose the smallest model that makes the required behavior and performance unsurprising. Do not preserve complexity because it exists or add machinery because it looks architecturally impressive.

## Documentation and writing

Name the reader before adding a document to main. If nobody will use it to make a decision or perform work, do not add it. Git records what happened. Tests should enforce rules that code can break.

Read [`.agents/skills/dohc-writing/SKILL.md`](.agents/skills/dohc-writing/SKILL.md) before writing docs, specs, plans, PR bodies, commit messages, or skills. Use [`.agents/skills/dohc-interface/SKILL.md`](.agents/skills/dohc-interface/SKILL.md) for anything a person sees inside the app.

Use one name for one thing. Check terms against the surrounding code before defining them. If a paragraph-long code comment is needed to defend a workaround, fix the code instead.

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

Run the smallest check that proves the change.

- `pnpm typecheck` and `pnpm test:desktop` cover most TypeScript desktop work.
- Root `pnpm test` runs brand checks, repository Node tests, and every package suite. It is slow; prefer targeted commands while iterating.
- `pnpm test:desktop:e2e` requires the engine binary at `apps/desktop/target/debug`. A fresh checkout without it fails inside `electron.launch`, which can hide the real cause in Playwright's log.
- For Rust work, use the [`rust-gate` skill](.agents/skills/rust-gate/SKILL.md), never a bare `cargo` command. Read the gate's `== summary ==` block rather than its exit code.
- A test that needs a sleep to pass is wrong. Wait for the actual condition.

## Pull requests and merging

**CI is deliberately dispatch-only while dohc is pre-launch.**

### Select local gates

Use the `rust` and `js` filters in the [`changes` job of `pr-checks.yml`](.github/workflows/pr-checks.yml) to choose local gates for the exact PR head.

- Reproduce each matching workflow job locally, including its services, environment, prebuilds, and verdict checks.
- Run both jobs when both filters match.
- Run a job when one of its build or test steps reads a changed file even if the filter omits that file.
- Run both jobs if impact is unclear. If no filter or build input matches, no code gate applies.
- State which gates ran, or why none applied, in the PR.

The Rust job must run through the `rust-gate` skill. Its script enforces disk preflight, build-slot queueing, and capped Cargo parallelism. Read the summary, not the process exit code.

### Review findings

Treat a finding as evidence, not a command. Verify it against the current head and required behavior.

- Fix concrete regressions in correctness, security, privacy, durability, compatibility, performance, or user-visible behavior.
- Decline false positives, speculative hardening, alternative designs, and out-of-scope work with a short technical reason.
- Prefer the smallest safe fix. Do not add policy or machinery only to satisfy a reviewer.

### Simplification review

Every code PR needs one simplification review after it becomes ready.

- Use an agent from a different model family than the implementation agent.
- Give it the diff, relevant source, and required behavior without the implementation rationale.
- Ask what can be deleted, combined, or made obvious without weakening behavior, performance, or product invariants.
- Verify each finding. Apply clear simplifications, rerun affected gates, and record the reviewed commit and result in the PR.
