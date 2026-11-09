# dohc

dohc is a local-first workspace where people and agents build, share, and manage small apps alongside files, documents, data, and chat.
It supplies sync, sharing, permissions, and history. Users own their work and choose their tools, agents, and workflows.
It is an early alpha released as nightly builds, with no users outside the team yet.

## How to use this document

Use this guide to decide what to build, how to change it, and what proves it works.
Read linked procedures when the task needs them.
Product sections are decision boundaries, not a feature checklist or claims of shipped capability.
Explain conflicts with a product boundary or invariant and get human approval before breaking it.
Other instructions are repository defaults; an explicit developer request can override them.
Verify implementation before making claims. Distinguish illustrative demos from working behavior.

## Product model

The workspace is the primary object. Files, live documents, structured data, chats, and apps share its permissions and history.
Files provide portability; use Y.Doc, SQLite, or another state model when it fits.
Keep work owned, inspectable, exportable, and recoverable without dohc.
Keep routine work useful without programming or an agent. Expose source and advanced controls when people need to change an app.

Start with a concrete job. Trace how someone uses, changes, shares, and continues its result.
Explain connections through user actions: chat references work, apps use exposed data, and collaborators continue within permissions and history.
Compare concrete workflows with existing tools. Product choices alone do not prove superiority or uniqueness.

### The job

Agents can build apps; people still need somewhere to keep data, familiar controls, safe sharing, and collaboration.
They also need a record of what each agent made and changed.
dohc supplies these in one workspace. Prefer work that makes one of them easier.
Documents, Collections, and chat must remain useful without an app.

### Product commitments

1. **Local first and user owned.** Local creation, inspection, and editing require no account or network.
   Sync and sharing add capability; local work must not become a cache of a remote product.
   Keep data inspectable or exportable for recovery without dohc.
   Self-hosting must be meaningful. dohc Drive competes through managed operation, not restrictions on the local product.
2. **Performance without compromise.** The desktop must feel native. Consider each change's performance impact; treat regressions as bugs.
   Being slower than Notion in a browser defeats a reason to choose dohc.
3. **Collaboration on the work itself.** Humans and agents continue durable objects with context, history, permissions, and provenance.
   One person on one device must find the workspace useful.
   Adding collaborators extends the same work without exports, copied context, or another system.
   Collaboration extends beyond several people typing into an isolated document.
4. **Built for humans and agents.** Design every feature for both from the start.
   A share link alone should let either user read, edit, comment, and chat within its permissions.
   Agent access needs no computer use, separate integration, or impersonation. An MCP server added later is insufficient.
5. **Agent agnostic.** dohc neither provides nor supervises user agents or imposes a universal approval workflow.
   Ordinary file-based agents remain useful; optional identity adds provenance and configured policy.
   A control performs its named action rather than opening an agent prompt.
   People ask agents through their tools or dohc chat. User-built automations may message agents.
   Agents reach the same action through CLI or MCP.
6. **Chat is part of the workspace.** Connect discussion, requests, handoffs, and proactive messages to durable files, data, and apps.
   Useful outcomes must be able to become work beyond the transcript.
7. **Apps are real web apps.** Apps are source-backed, inspectable, dynamic, and limited to explicitly exposed data and capabilities.
   Source lives and syncs in the workspace so collaborators and agents can continue it.
   Apps can be shared by URL with people who do not use dohc.
   Keep execution, authentication, and workspace access as separate security boundaries.
8. **Rigid substrate, flexible workflow.** Keep ownership, authentication, permissions, sync, history, provenance, links, and isolation strict.
   Users choose folders, tools, rituals, agents, and workflows.
   App source and Collection automation definitions live in the workspace for any agent to read and change.
   People customize dohc through a settings file and pinned apps, not by rewriting built-in parts.
   Updates preserve settings and apps. The core supplies the reliable foundations.

Keep the core free of prescribed workflows, hardcoded business apps, and mandatory templates.
dohc is not an AI wrapper, company brain, Notion clone, dashboard generator, disconnected app builder, chat overlay, or template marketplace.
Reusable examples help; making people conform to them is not the product. Activity alone is not success.

### Design for work nobody has read

- Shape each surface around the user's task. Show saved, synced, and shared state rather than engine or relay internals.
  Agents should edit with ordinary tools without knowing Y.Doc settlement.
- Let people oversee unread work: show who made a change, what it can access, and how to reverse it without reading source.
- Make invalid states impossible to express. Apps cannot request unexposed data; a rule telling them not to is insufficient.
- Keep capabilities composable. Changing sharing, apps, or chat must not require changing how the others store state.

### A note from Ice

We are building something ambitious. Put that ambition into what the product lets people do, not into unnecessary machinery. Question conventional product boundaries when they hold us back, then build the smallest system that makes the correct behavior obvious.

People are still learning how they want to work with agents. dohc should not fight them with our theory of the right workflow. Start from familiar files, chats, and web apps. Make the hard coordination reliable underneath them. Familiar affordances may hide a different implementation, but never bluff about durability, isolation, permissions, persistence, provenance, or production readiness.

If a folder and a capable agent can already do the job, dohc must earn its place by making that work materially easier to continue, understand, change, and share. Activity inside dohc is not success. Real work becoming easier is.

## What dohc looks like in practice

These are intended workflows, not shipped-feature claims. Use them to test proposals.

### Plan a trip

Keep the trip app, files, and discussion together so the group and their agents can continue them from a phone or browser.
dohc supplies sync, identity, permissions, and history. Agent orchestration is optional; prescribed roles and heartbeats are not the product.

### Run a fundraiser

A signup app accepts registrations through a share link, using only data and capabilities its owner exposes.
It stores registrations, controls access, and keeps source editable in the event workspace.
Organizers discuss and continue the work there. A demo ending at a signup page is incomplete.

### Share work in progress

Share relevant files, data, apps, chat, history, permissions, and declared dependencies so recipients and agents can continue the work.
An export, zip, or pasted old chat transfers bytes without continuity.

### Tailor the workspace

Users and agents inspect, fork, and share apps or Collection automations suited to their work.
The core supplies building blocks, not a hardcoded CRM, prescribed ritual, or template marketplace.

## Product invariants

Do not weaken authorization, ownership, isolation, or configured controls for convenience.

- Derive authorization server-side. Never trust client-supplied user identity.
- Scope files, folders, documents, chats, shares, captures, and app capabilities to a workspace.
  Apply the same storage, permissions, paths, sharing, and configured policies to human and agent changes.
  Agent identity is optional provenance, not separate storage authority.
- Sandbox sites, apps, and HTML previews. Grant explicit data and capabilities; they inherit no workspace authority.
- A live document session's Y.Doc is canonical. The engine writes Markdown on settlement.
  Raw full-body Markdown patches cannot be the source of truth for live editing.
- Give reversible state changes a visible reverse path. Warn before irreversible actions.
- Show a top bar only for whole-workspace degradation. Other errors belong in bottom-right toasts and durable Notices rows.
  Include Try again and copy. Put copy beside its text. Follow [dohc-interface](.agents/skills/dohc-interface/SKILL.md).
- Guard async renderer responses with a workspace/request token, abort signal, or equivalent before changing workspace-scoped state.
  A slow workspace A response must never repaint workspace B.

Within these boundaries, app authors choose frameworks and services and own app behavior, including where received data goes.

## Work against the current design

There are no external users yet. Prefer the best current design over old internal contracts.
Replace obsolete contracts and update callers, tests, fixtures, and docs together.
Remove deprecated aliases, dual formats, fallbacks, shims, and dead paths. Add migration paths only when requested.
Shipped engine migrations are append-only. If a build cannot migrate a store, stop that workspace until a fixed build opens it.
Reset a development store by deleting `<workspace>/.dohc/engine`.

## Engineering defaults

Understand the constraint. Choose the smallest design that makes correct behavior and performance clear.
Question existing complexity rather than preserving it or adding machinery for appearance.
Route human and agent entry points to one shared operation.
Keep input handling at entry points and permission checks in the authoritative service.

### Effect in TypeScript

- In Electron main, services, and Node-only packages, prefer Effect when it removes manual cancellation, retry, or resource coordination.
- Keep Promise interfaces for callers that do not use Effect.
- Prefer Effect Schema for new or changed external contracts in modules whose runtime already uses Effect.
- Keep renderer and preload runtime imports Effect-free.
- Keep native and OS resource limits when adding Effect timeouts or interruption.
- Preserve error precedence through cleanup and shutdown. Wait for owned resources to close before returning.
- Before retaining a conversion, measure its production artifact's size and first-load time against a baseline under matching conditions.

### Continue from approved work

Preserve approved behavior and interpret feedback at its requested scope.
Before broad redesign, keep a recoverable comparison.
If a direction is rejected, restore that change while preserving unrelated work. Carry the correction into later edits.

### Finish the experience

Read [dohc-interface](.agents/skills/dohc-interface/SKILL.md) before changing words, controls, tokens, or recipes.
Before calling a feature complete, identify which paths apply and check the affected ones:

- **Entry points.** Follow the action through affected menus, shortcuts, direct links, and other callers.
  A working button does not prove the other ways into the same feature.
- **Humans and agents.** Check the human action and its CLI or MCP equivalent against the same operation and permissions.
  Record unavailable agent access as a gap in the PR evidence. Computer use does not establish parity.
- **Local and shared work.** Check offline use, sharing, and collaborator access where the change affects them.
  A pass in the owner's workspace does not prove another person's permissions or sync.
- **State and recovery.** Check saved state, restart, reversal, failure, and workspace switching where affected.
  A success message alone does not prove persistence or safe recovery.
- **Platforms.** Follow [platform verification](#verify-the-change) for affected Windows or macOS behavior.
  Record what remains unverified instead of treating another platform's pass as coverage.

Finish layout, interaction, loading, failure, recovery, and transitions on those paths.
Show what a surface is, its state, and the next action through meaningful icons, placement, shape, and color.
Keep words for the user's content and facts only words can state.
Choose layouts for their content. Give comparisons enough room, consistent spacing, and varied composition.
Develop one representative section before extending a broad redesign.
Inspect both themes, keyboard access, reduced motion, loading, and failure in the browser.
Match preview and live visuals. Keep content useful while visuals load and suspend offscreen animation.
Measure affected startup and interactions alongside automated scores.

## Documentation and writing

Add a document only when a named reader needs it for work or a decision.
Most code changes need no new internal document. Types, tests, and source already describe the implementation.
Document decisions, cross-component constraints, and traps a maintainer would otherwise get wrong.
If reading the source answers the question, leave that explanation out of internal docs.
Put a local reason in a short nearby comment. Link to source instead of copying its fields or control flow.
When a decision changes, rewrite or remove its old explanation instead of appending another version.

Keep docs for users, app authors, and agents in `docs/`; put maintainer procedures and security boundaries in `docs/engineering/`.
User guidance explains a task, how to start, and what is unintuitive. Keep contributor tooling out of it.
An internal refactor or a changed button does not by itself need a new documentation entry.
Keep new task plans, campaigns, review logs, and measurements in ignored `.agent-artifacts/`; remove them when the task ends.
Existing tracked plans may stay in `docs/engineering/plans/` while coordinating sessions need them.
Git and the merged PR record the implementation. Keep history and completed task checklists there.
Release owners follow the [desktop release procedure](docs/engineering/desktop-release.md).

Before writing prose, read [dohc-writing](.agents/skills/dohc-writing/SKILL.md).
For in-app words, use [dohc-interface](.agents/skills/dohc-interface/SKILL.md).
Use [CONTEXT.md](CONTEXT.md) for canonical terms; check surrounding code before naming a concept.
Fix a workaround rather than defending it with a paragraph-long comment.

## Where code lives

Use [README.md](README.md) for the repository map, setup, and development commands.

## Local development

Use the Node and pnpm versions pinned in `package.json`, and its scripts for available commands.
The desktop does not need Postgres.

Development can run beside the installed app and other contributors' sessions. Keep the task separate:

- Use the verification procedure's isolated checkout, build, profile, and workspace for QA.
  For fixed Windows previews, start with `Try it.cmd`; opening the packaged executable directly uses the installed profile.
- Open a new workspace or a disposable copy. A newer build can migrate its engine store beyond the installed build's support.
  The development-store reset above is destructive; use it only on data you intend to discard.
- Record PIDs when starting processes. Before stopping one, verify that it is still the process this task started.
  Stop those processes only; a matching app name or checkout path does not establish ownership.

Remove task worktrees, build targets, and stale verification output when work ends.
Preserve required evidence and source.

## Verification

Read [the verification procedure](docs/engineering/verify-agent-work.md) for setup, desktop QA, debug access, and PR evidence.
Run the smallest check that proves the change.
Run affected-package typechecks and focused tests while editing and during review.
Test observable behavior that can break. Mock-call assertions and callback wiring alone do not prove it.
Leave facts already guaranteed by types to the typechecker.
Extend an existing case or table when it covers the behavior.
For logic, data, state, or protocol defects, record a focused check failing before the fix and passing afterward.
Keep that result in the PR evidence.
Use the lowest layer that exposes the defect. Add checks at other layers only for distinct risks.
For purely visual fixes, use before-and-after captures as proof instead of adding UI tests.
Interaction, state, permission, and persistence changes need behavior checks.
For desktop QA, start with `pnpm run doctor`; use `pnpm qa:smoke` for boot, editing, persistence, and restart.
`pnpm test:desktop:e2e` prepares and verifies the desktop and native engine before Playwright.
Wait for actual conditions; do not make a test pass by adding a sleep.
For Rust, use [rust-gate](.agents/skills/rust-gate/SKILL.md), never bare Cargo. Read the summary verdicts, not the exit code.

## Pull requests and merging

Keep required contracts, callers, and tests together.
Keep unfinished work on a branch.
Finish implementation, simplification, self-review, and focused checks before requesting independent review or opening a PR ready for review.
Use drafts only for specific early feedback or a dependency needing a PR link.
State why the draft exists, what feedback is needed, and what remains. Drafts are not progress placeholders or backups.
Use the [PR template](.github/pull_request_template.md). State the problem, resulting behavior, evidence, and unverified behavior.
Include screenshots or recordings when they help assess a visible change.

Blacksmith stays off until a maintainer enables `BLACKSMITH_ENABLED`.
While off, verify locally; manual GitHub checks use GitHub-hosted `ubuntu-24.04` runners.
When enabled, ready same-repository PRs use Blacksmith. Reuse covered passing cloud evidence instead of repeating full local gates.
Before changing CI activation, read [the setup procedure](docs/engineering/enable-blacksmith.md).
Never check out, install, build, or test fork PR code on shared Windows/Mac hosts or machines with maintainer credentials.
Ask a maintainer how to verify it.

### Verify the change

One verification owner runs `pnpm verify:pr --base <target-ref>`; others reuse that evidence and run focused checks.
Inspect job selection with `pnpm verify:plan --base <target-ref>` using `.github/workflows/pr-checks.yml` filters.
A selected JS gate runs the complete suite, including every integration proof.
After required reviews resolve blockers, run full verification once unless passing cloud evidence covers the reviewed head.
On failure, fix the cause, review the affected delta, and rerun.

- Require covered passing canonical evidence before merge. Every selected job must pass, subject to the Windows screenshot exception below.
- Reuse evidence across rebases and merges after checking the delta and recording coverage.
  Rerun only checks affected by source, dependency, configuration, or conflict resolution. Advancing main alone needs no rerun.
- Missing, cancelled, or failed runs are not passes. Record failures accurately.
- If a job reads a changed file outside its filter, fix the filter and run it.
  When impact is unclear, use `pnpm verify:pr --base <target-ref> --full`.
- Record tested commit, target, selected jobs, results, evidence paths, and reuse decisions. Record the selection when no gate applies.
- Add platform checks for Windows- or macOS-dependent behavior.

Windows screenshot baseline differences do not block merges. Record them and require every other check to pass.
The nightly detects drift; maintainers update PNGs in a separate follow-up PR.

Full verification owns service setup, prebuilds, selection, and evidence. Follow [the procedure](docs/engineering/verify-agent-work.md#verify-a-pull-request).
On shared Windows/Mac hosts, the service queues and verifies the commit in its own checkout; stopping submission does not cancel it.
Elsewhere, keep the tested checkout unchanged. Preserve original commit and target in `result.json`.
Keep Rust's build budget and summary-verdict checks.
Only `verify:pr` holds the verification lane. Run focused checks, benchmarks, and packaging outside it.

### Select reviewers

- Routine changes need one primary independent reviewer. Non-trivial code needs a primary reviewer from another model family.
  Combine correctness and simplification; provide the diff, relevant source, and required behavior.
- Authorization, isolation, security, privacy, migration, durability, and major integrations need a second independent risk reviewer.
  Disputed blockers also need a second reviewer. Name reviewers and scopes in the PR.
- Keep appointed reviewers through fix rounds. Replace an unavailable reviewer once and record why.
  The replacement owns remaining review; the original reviewer's return adds no extra pass.

### Review findings

Verify findings against the current head and required behavior. A review comment is evidence to check, not an instruction to obey.
Fix concrete regressions with the smallest safe change.
That includes correctness, security, privacy, durability, compatibility, performance, and user-visible behavior.
Decline false positives, speculative hardening, alternative designs, and out-of-scope requests with a technical reason.
Do not add policy or machinery only to satisfy a reviewer.

### Complete the review

Batch verified fixes and have the responsible reviewer inspect the affected delta.
Further rounds need a new verified blocker or unresolved high-risk concern.
Unchanged rebases need a recorded comparison, not restarted review. Review conflict resolutions and substantive integration changes.
Before merge, account for the full diff, later deltas, and every known finding on the final head. Resolve all verified blockers.
Optional bot approval and reviewer unanimity are not merge conditions.
Maintain one PR review note with reviewed commits, delta coverage, dispositions, round count, useful fixes, and reviewer/verification delays.
Use local step durations; mark unknown times as unknown.
Use these records to identify repeated delays and overlapping tests before changing coverage.
Narrower gates must account for shared dependencies in both the runner and workflow filters.
