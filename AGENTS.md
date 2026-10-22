# dohc

dohc is a local-first workspace where people and their agents build on files, documents, data, chat, and apps.
It provides sync, sharing, permissions, and history so each workflow does not have to recreate them.
Users own their work and choose their tools, agents, and workflows.

We are building the MVP and have not launched with users.

## How to use this document

The product sections below are decision boundaries, not a feature checklist. Use them to reject work that would turn dohc into the wrong product.

- If an instruction conflicts with the task, explain the conflict and get human approval before breaking it.
- Treat the remaining instructions as repository defaults. An explicit developer request can override them.

## Product model

The workspace is the primary product object. It can contain files, live documents, structured data, chats, and apps.

Keep routine work useful without programming knowledge or an agent.
Expose source and advanced controls when people need to change an app.

Files are the portable foundation, not the required runtime representation for every feature. Use the state model that fits the subsystem. A live document can be a Y.Doc and structured data can live in SQLite. Keep work owned, inspectable, and exportable instead of forcing all state into flat text.

Start with a job people need to finish. Design capabilities around how they use, change, and share its result.
Chat references the work, apps use explicitly exposed data, and collaborators continue within its permissions and history.
Explain each connection through a concrete user action.

Product commitments describe intended behavior. Verify the current implementation before claiming a capability is available.
Keep illustrative demos distinguishable from working product behavior.

When explaining differentiation, compare a concrete workflow with the tools people already use.
Separate product choices from demonstrated advantages. Support claims of superiority or uniqueness with evidence.

A workspace must be useful to one person on one device. Team collaboration is still core: adding another person or agent should extend the same work, not require exports, copied context, or a new system.

### Product commitments

1. **Local first and user owned.** Creating, inspecting, and editing local work must not require an account or network connection. Sync and sharing add capability. They do not make local work a cache of a remote product. Keep the underlying files and data inspectable or exportable so the user can recover their work without dohc. Self-hosting must be meaningful; dohc Drive should win through the managed network and operational experience, not a crippled local product.

2. **Performance without compromise.** Speed is a core reason to be local-first and to ship a desktop app. dohc must feel native, as if the OS came with it preinstalled. Lots of apps have gotten bogged down with bad tech decisions and slop; dohc does not join them. If Notion in a browser tab feels faster than dohc, dohc has lost its own argument. Make sure every change is considerate of its performance impact, and treat a regression as a bug, not a tradeoff.

3. **Collaboration on the work itself.** Humans and agents share durable workspace objects with their context, history, permissions, and provenance. Do not reduce collaboration to exporting files, pasting context into a chat, or several people typing into an isolated document.

4. **Built for humans and agents.** Design every feature and surface for two users from the start: a human and an agent. Parity is not an MCP server added after the fact; the feature itself must work for both. For example, a share link sent to an agent should work just like one sent to a friend: with the link alone, the agent can read, edit, comment, and chat, with no computer use, no separate integration, and no impersonating a person.

5. **Agent agnostic.** dohc does not provide or supervise the user's agents. Any agent that can work with ordinary files should remain useful. dohc adds reliable tools and optional identity, provenance, and policy controls. It must not impose a universal agent approval workflow.

6. **Chat is part of the workspace.** Chat connects humans, agents, files, data, and apps. It supports requests, discussion, handoffs, and proactive agent messages. Users and agents can turn useful outcomes into durable work instead of losing them in a transcript.

7. **Apps are real web apps.** A dohc app is source-backed, inspectable, dynamic, and connected only to data and capabilities the owner exposes. Its source lives and syncs in the workspace so collaborators and their agents can continue changing it. It can be shared by URL with someone who does not use dohc. Treat app execution, authentication, and workspace access as separate security boundaries.

8. **Rigid substrate, flexible workflow.** Be strict about ownership, authentication, permissions, sync, history, provenance, links, and isolation. Let users and agents decide their folders, tools, rituals, agents, and domain workflows. Apps and Collection automations extend the work; their source and definitions live in the workspace, where any agent can read and change them. People customize dohc through a settings file and pinned apps. They do not rewrite built-in parts, and updates keep their settings and apps. The core must already provide the reliable substrate.

Do not turn dohc into an AI wrapper, company brain, Notion clone, dashboard generator, chat overlay, prescribed workflow, template marketplace, or productivity theater. Reusable examples and templates are useful; making users conform to them is not the product.

### Design for work nobody has read

Agents now write apps and changes that no person reads line by line. A person must still be able to trust that work, and an agent must still be able to continue it.

- Shape each surface like the user's task, not its implementation. A person sees whether their work is saved, synced, and shared, not relay or engine state. An agent edits a file with ordinary tools without knowing about Y.Doc settlement.
- Let a person oversee work they did not read. For any agent change or app, the person can see who made it, what it can reach, and how to reverse it without opening the source.
- Make invalid states impossible to express. An app cannot request data its owner did not expose; a rule that tells it not to is not enough.
- Keep capabilities composable. Changing sharing, apps, or chat must not require changing how the others store their state.

### A note from Ice

We are building something ambitious. Put that ambition into what the product lets people do, not into unnecessary machinery. Question conventional product boundaries when they hold us back, then build the smallest system that makes the correct behavior obvious.

People are still learning how they want to work with agents. dohc should not fight them with our theory of the right workflow. Start from familiar files, chats, and web apps. Make the hard coordination reliable underneath them. Familiar affordances may hide a different implementation, but never bluff about durability, isolation, permissions, persistence, provenance, or production readiness.

If a folder and a capable agent can already do the job, dohc must earn its place by making that work materially easier to continue, understand, change, and share. Activity inside dohc is not success. Real work becoming easier is.

## What dohc looks like in practice

These examples describe intended workflows, not a list of shipped features. Use them to test product proposals.

### Plan a trip

- ✅ **dohc.** A person works with an agent through files and chat, then builds the trip app they want. They share the app, files, and conversation with the group. The group and their agents can continue the same work from a phone or browser. dohc handles sync, identity, permissions, and history underneath. The trip is the work. Agent orchestration is only one possible means.
- ❌ **Not dohc.** The person downloads a "travel team" template, configures agent roles and heartbeats, then accepts its prescribed workflow.

### Run a fundraiser

- ✅ **dohc.** An organizer asks their agent to build a signup app in an event workspace. Participants register through a share link. Organizers manage registrations, discuss changes, and keep editing the app's source in the same workspace. The app uses only the data and capabilities its owner exposes. dohc provides sync, access, and history.
- ❌ **Not dohc.** The demo ends at a signup page. There is no path to store registrations, control access, or continue the work together.

### Share work in progress

- ✅ **dohc.** A person shares the relevant part of a workspace with its files, data, app, chat, history, and declared dependencies. The recipient and their agent can inspect what happened and continue the same work without reconstructing its context.
- ❌ **Not dohc.** The person exports a file, pastes an old chat, or sends a zip. The recipient must start again in another tool. Sharing should transfer continuity, not only bytes.

### Tailor the workspace

- ✅ **dohc.** A user asks an agent to create or change an app or a Collection automation for their workflow. They can inspect it, fork it, and share it. The result can fit their work without forcing the same workflow on everyone else.
- ❌ **Not dohc.** dohc ships a hardcoded CRM, requires a project ritual, or becomes a template marketplace. dohc supplies reliable building blocks. Users and agents decide what to build.

## Product invariants

Do not weaken authorization, ownership, isolation, or explicitly configured controls for convenience.

- Derive authorization server-side. Never trust a browser or client caller to provide user identity.
- Scope every file, folder, document, chat, share, capture, and app capability to a workspace.
- Apply the same storage, permission, path access, sharing, and configured policy boundaries to human and agent changes. Agent identity is optional provenance, not a separate storage authority.
- Sandbox sites, apps, and HTML previews. They receive only explicitly granted capabilities and data; they do not inherit workspace authority.
- Treat a live document session's Y.Doc as canonical. On settlement, the engine writes the Markdown artifact. Do not make raw full-body Markdown patching the source of truth for live editing.
- Give every reversible state change a visible reverse path. Warn the user before an irreversible action runs.
- Put every message where the user expects it. A top bar only when the whole workspace is degraded. Every other error arrives as a bottom-right toast and stays as a row in Notices with Try again and copy. Copy sits beside the text it copies. The rules are in [`.agents/skills/dohc-interface/SKILL.md`](.agents/skills/dohc-interface/SKILL.md).
- Guard every asynchronous renderer response with a workspace/request token, abort signal, or equivalent before setting workspace-scoped UI state. A slow response for workspace A must never repaint workspace B.

Within these boundaries, authors decide what their apps do and which web frameworks and external services they use. Authors are responsible for app behavior, including where an app sends data it receives.

## Work against the current design

There are no users yet. Optimize for the best current design instead of preserving old internal contracts.

- Replace obsolete contracts instead of adding compatibility layers.
- Remove deprecated aliases, dual formats, fallbacks, shims, and dead paths.
- Update all internal callers, tests, fixtures, and docs in the same change.
- Add a migration path only when the user asks for one.
- Shipped engine migrations are append-only. A store the build cannot migrate stops its workspace until a fixed build opens it. To reset a development store, delete `<workspace>/.dohc/engine`.

## Engineering defaults

Understand the constraint before building. Choose the smallest model that makes the required behavior and performance unsurprising. Do not preserve complexity because it exists or add machinery because it looks architecturally impressive.

### Effect in TypeScript

- In Electron main, services, and Node-only packages, prefer Effect when it removes manual cancellation, retry, or resource coordination.
- Keep Promise interfaces for callers that do not use Effect.
- Prefer Effect Schema for new or changed external contracts in modules whose runtime already uses Effect.
- Keep renderer and preload runtime imports Effect-free.
- Keep native and OS resource limits when adding Effect timeouts or interruption.
- Preserve the operation's error precedence through cleanup and shutdown.
- Wait for owned resources to close before returning.
- Before retaining a conversion, measure the production artifact containing the changed module.
  Compare size and first-load time against baseline under matching build and machine conditions.

### Continue from approved work

- Treat approved behavior and design choices as the working baseline. Interpret feedback at the requested scope.
- Preserve a recoverable comparison before a broad redesign.
- When a direction is rejected, restore the affected change while preserving unrelated work. Carry the correction into subsequent work.

### Finish the experience

Craft includes layout, interaction, loading, failure, and recovery. Evaluate the complete experience, including transitions between states.
- Choose layouts for their content. Give comparisons enough room, with consistent spacing and varied composition.
- Show, don't tell. A person should see what a surface is, what state it is in, and what to do next at a glance, without reading. Let icons, placement, shape, and color that means something carry the meaning; keep words for the user's own content and for facts only words can state.
- For broad redesigns, develop one representative section before extending the treatment.
- Inspect affected layouts, both themes, keyboard access, reduced motion, loading transitions, and failure states in the browser.
- Match preview and live visuals. Keep content useful while visuals load, and suspend animation offscreen.
- Measure startup and interaction when changing rendering or loading. Judge the experience alongside automated performance scores.

## Documentation and writing

Name the reader before adding a document to main. If nobody will use it to make a decision or perform work, do not add it. Git records what happened. Tests should enforce rules that code can break.

Keep `docs/` for people using dohc, including app authors and agents. Put essential maintainer procedures and security boundaries in `docs/engineering/`. Keep new task plans, campaigns, review logs, and measurements in ignored `.agent-artifacts/`. Remove them when the task ends. Existing tracked plans may stay in `docs/engineering/plans/` while their coordinating sessions still need them.

Release owners follow the [desktop release procedure](docs/engineering/desktop-release.md).

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

Use Node 24.16 or newer and pnpm 11.20.0, as pinned in `package.json`.

- `pnpm dev:desktop` starts the desktop app. `pnpm dev` is an alias.
- `pnpm dev:site` starts the marketing site.
- `pnpm dev:workspace-api` starts the workspace API.
- `pnpm dev:postgres` starts development Postgres; `pnpm migrate` applies migrations; `pnpm reset:postgres` clears development data. The desktop app does not need Postgres.
- When a task ends, remove its worktree, build targets, and stale verification evidence.

## Verification

Use [the agent verification procedure](docs/engineering/verify-agent-work.md) for worktree setup, desktop QA, debug access, and PR evidence.
For desktop QA, start with `pnpm run doctor`. Use `pnpm qa:smoke` for boot, editing, persistence, and restart.

Run the smallest check that proves the change.

- Run the affected package's typecheck and focused unit or integration tests while editing.
- One verification owner runs the full selected gates through `pnpm verify:pr --base <target-ref>`.
- Other agents run focused checks and reuse the owner's evidence instead of repeating full gates.
- `pnpm test:desktop:e2e` prepares and verifies the desktop and native engine before launching Playwright.
- For Rust work, use the [`rust-gate` skill](.agents/skills/rust-gate/SKILL.md), never a bare `cargo` command. Read the gate's `== summary ==` block rather than its exit code.
- A test that needs a sleep to pass is wrong. Wait for the actual condition.

## Pull requests and merging

Blacksmith stays off until Ice enables the repository variable `BLACKSMITH_ENABLED`.
While off, run PR verification locally. Manual GitHub checks use GitHub-hosted `ubuntu-24.04` runners.
When enabled, ready PRs from this repository use Blacksmith.
Never check out, install, build, or test fork PR code on the shared Windows host, the shared Mac, or any machine with Ice's credentials. Ask Ice how to verify it.
Use passing cloud evidence instead of repeating full gates locally when it covers the change.
Before changing CI activation, read [the Blacksmith setup procedure](docs/engineering/enable-blacksmith.md).
Keep required contract, caller, and test changes together.
Finish implementation, self-simplification, and focused checks before requesting independent review.

### Verify the change

The canonical local runner selects JavaScript and Rust gates from the [`PR checks` workflow's filters](.github/workflows/pr-checks.yml).
Use `pnpm verify:plan --base <target-ref>` to inspect that selection locally.
A selected JavaScript gate runs the complete JavaScript suite with every integration proof.

- One agent owns verification and the PR's evidence. Other agents run focused checks for their changes.
- Run focused checks while implementing and during review rounds.
- After the required reviews finish with no open blocking findings, the verification owner runs `pnpm verify:pr` once, unless passing cloud evidence already covers the reviewed head. If it fails, fix the cause, get the affected delta reviewed, and run it again.
- Before merging, require passing canonical gate evidence that covers the PR's changes.
- After a rebase or merge, inspect the delta and reuse passing evidence when it still covers the change.
- When reusing passing evidence, rerun only checks affected by source, dependency, configuration, or conflict-resolution changes. Advancing main alone does not require another gate run.
- Require every selected job to pass. A missing, cancelled, or failed run is not a pass.
- If a job reads a changed file outside its filter, correct the filter and run that job.
- When impact is unclear, use `pnpm verify:pr --base <target-ref> --full` to run both jobs.
- Record the tested commit, target ref, selected gates, result, and evidence location. Explain any reuse across commits.
- If no code gate applies, record the runner's selection and reason.
- Add focused platform verification when changed behavior depends on Windows or macOS.

Use `pnpm verify:pr --base <target-ref>` as the single full-verification entry point.
It owns the service setup, prebuilds, gate selection, and evidence. Follow [the verification procedure](docs/engineering/verify-agent-work.md#verify-a-pull-request).
On the shared Windows host and the shared Mac it queues the commit with the verification service, which verifies it in its own checkout; stopping the command does not stop the request. Elsewhere, keep the checkout unchanged during each run. Preserve the original commit and target in its `result.json`.
The Rust gate retains its build budget and mandatory summary-verdict checks.
Only `verify:pr` holds the host's verification lane. Run focused checks, benchmarks, and packaging outside it.

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
