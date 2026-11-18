# dohc

dohc is a local-first workspace where people and their agents build, share, and manage small apps alongside their files, documents, data, and chat. It supplies sync, sharing, permissions, and history, and people keep ownership of their work.

dohc is an early alpha released as nightly builds. It has one maintainer and no users outside the team yet.

## A note from Ice

I like ambitious ideas, simple systems, and software that feels obvious. Put the ambition into what dohc lets people do, not into machinery. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising. Hold "measure twice, cut once" and "yagni" at the same time. Fight scope creep.

We want everything we build to be so obvious it feels kind of stupid. When one of us prompts you, never hesitate to push back and suggest ways we could make things more obvious. Note that "simple" and "obvious" are not always the same. Sometimes the obvious solution is more complex. "Obvious" solutions are the defaults that agents would assume are the case.

If a user had a folder of well-structured files on their computer and a capable agent managing them, they could recreate a surprising amount of what dohc does. dohc exists to make that easy, reliable, and powerful. Don't get me wrong, having dohc is supposed to be much more empowering than just having files on your computer. But even if dohc disappears, a user's workspace should still be usable (albeit a worse experience, but workable). dohc earns its place by making that work easier to continue, understand, change, and share. Activity inside dohc is not success. Real work becoming easier is.

People are still learning how they want to work with agents, and dohc should not fight them with our theory of the right workflow. Assume people can use their agents to build the specific workspace they need. Should dohc have first-class files, documents, data, permissions, history, and agent-safe edits? Absolutely. No user or agent should have to invent that substrate. Should dohc ship a hardcoded CRM for every possible team? Probably not. A user's agent should be able to build one out of dohc's pieces.

Don't be afraid to lie (to agents) if it makes working easier. Agents like working a certain way, and we should give them that way to work. If they want file systems, they should get them. The implementation can be a mirage, as long as the agent gets what it expects and we get outputs that work. But never lie about contracts: durability, isolation, security, permissions, persistence, provenance, and production readiness must be explicit.

Make dohc magical and obvious for one person before it is for a team. If dohc only works after a whole company adopts it, we built the wrong thing.

Being that you are an agent, your prediction model will likely want to steer towards conformity. That's okay and even preferred in most scenarios, but there will be times where we need to think outside the box. Question conventional product boundaries when they hold us back.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules" and more as "good defaults". The developer's preferences can override anything here. If a rule fights the task in front of you, say so loudly and get a human sign-off before breaking it.

This note is in my own words. Keep it that way: if you think it should change, say so in your PR instead of rewriting it.

## A small glossary

- **you** means the agent reading this file and changing dohc.
- **we** and **us** mean Ice and the people building dohc. This is who you are talking to.
- **user** means a person using dohc. Users bring their own agents.
- **agent** means any agent a user points at a workspace, through dohc chat, the `dohc` CLI, MCP, or plain files. Depending on context, that may include you.
- **workspace** means a folder of a user's work that dohc opens, syncs, and shares.

[CONTEXT.md](CONTEXT.md) holds the rest of the vocabulary. Use its terms in code, docs, and the interface.

## What dohc stands for

### 1. Local first and user owned

Local work needs no account or network. Sync and sharing add to it, and local work never becomes a cache of a remote product. Keep data inspectable and exportable, so people can recover it without dohc. Self-hosting must be real. dohc Drive competes by running the services for people, not by limiting the local app.

### 2. Performance without compromise

The desktop must feel native. Being slower than Notion in a browser defeats a reason to choose dohc. Consider each change's performance impact, measure the startup and interactions it touches, and treat regressions as bugs.

### 3. Collaboration on the work itself

The engine gives the workspace memory. Collaboration lets humans and agents carry that memory forward together, with context, history, permissions, and provenance. One person with their agents is already collaborating and should find dohc useful alone. Routine work stays useful without programming or an agent, and documents, Collections, and chat stay useful without an app. Adding people extends the same work, with no exports, copied context, or second system. It is more than several people typing into one document.

### 4. Built for humans and agents

Design every feature for both from the start. A share link alone lets a person or an agent read, edit, comment, and chat within its permissions. Agents reach the same operation through the CLI or MCP, with no computer use, separate integration, or impersonation. An MCP server added later is not enough.

### 5. Agent agnostic

dohc does not provide or supervise people's agents, and it imposes no approval workflow. Ordinary file-based agents stay useful. An agent identity adds provenance and configured policy, not storage authority. A control does the action it names. It never opens an agent prompt instead.

### 6. Chat is part of the workspace

Chat connects discussion, requests, handoffs, and proactive messages to durable files, data, and apps. A useful outcome can become work beyond the transcript.

### 7. Apps are real web apps

Apps are source-backed, inspectable, dynamic, and limited to the data and capabilities their owner exposes. Their source lives and syncs in the workspace, so collaborators and agents can continue it. People who don't use dohc can open a shared app by URL. Execution, authentication, and workspace access stay separate security boundaries. Inside those boundaries, app authors choose their frameworks and services and own what the app does with data it receives.

### 8. Rigid substrate, flexible workflow

Ownership, authentication, permissions, sync, history, provenance, links, and isolation are strict. Folders, tools, rituals, agents, and workflows are the user's choice. App source and Collection automation definitions live in the workspace for any agent to read and change. Keep capabilities composable: changing sharing, apps, or chat never requires changing how the others store state. People customize dohc through a settings file and pinned apps, and updates keep both. The core ships no prescribed workflows, hardcoded business apps, or mandatory templates.

dohc is not an AI wrapper, company brain, Notion clone, dashboard generator, disconnected app builder, chat overlay, or template marketplace.

### Jobs to test ideas against

- **Plan a trip.** The group and their agents keep the trip app, files, and discussion together and continue them from a phone or browser.
- **Run a fundraiser.** A signup app takes registrations through a share link, using only what its owner exposes, and organizers keep working on it in the event's workspace. A demo that ends at a signup page is incomplete.
- **Share work in progress.** Recipients and their agents get the files, data, apps, chat, history, and permissions they need to continue. A zip or a pasted chat transfers bytes, not continuity.
- **Tailor the workspace.** People and agents inspect, fork, and share apps and Collection automations that suit their work.

## Invariants

Never weaken these for convenience.

- **Authorization is derived server-side.** Never trust a client-supplied identity.
- **Everything is scoped to a workspace:** files, folders, documents, chats, shares, captures, and app capabilities. Human and agent changes go through the same storage, permissions, paths, sharing, and policies.
- **Sites, apps, and HTML previews are sandboxed.** They get only the data and capabilities granted to them. Make invalid states impossible to express: an app cannot request data its owner did not expose, and a rule telling it not to is not enough.
- **A live document's Y.Doc is canonical.** The engine writes Markdown on settlement. Never build live editing on raw full-body Markdown patches.
- **A slow response for workspace A never repaints workspace B.** In renderer components and hooks, read workspace data with `useWorkspaceQuery`. Guard any other async result with a request token or abort signal. `scripts/check-bridge-reads.mjs` fails new raw bridge reads.
- **Failures show as a bottom-right toast and a Notices row**, with Try again and copy. A top bar is only for whole-workspace degradation. [dohc-interface](.agents/skills/dohc-interface/SKILL.md) lists the errors that show in place instead.
- **Reversible changes have a visible way back.** Warn before an irreversible one. Show who made a change, what it can reach, and how to undo it, so people can oversee work nobody read.
- **One operation per action.** Human and agent entry points route to one shared operation. Entry points handle input, and the authoritative service checks permissions. Declare a read in its family's `*Declarations.ts` and a write in `*WriteDeclarations.ts` in `packages/workspace-contracts/src`. Give each write's socket admission rules a refusal test of their own, because the types check that a rule is allowed, not that it protects the write. After adding or changing a declaration, run `pnpm write:operation-pins` and read the pin diff closely: it is the review gate for what each door exposes.
- **Measure limits that reject work.** Before adding a limit that rejects valid work, measure healthy work and set the limit beyond it. Developers will not always read the code, but their agents will read the errors. A rejection names the constraint, the limit, its unit, and the observed usage when known.

## Ways to hurt yourself

1. **Using someone else's app or data.** Work in your own worktree, build, profile, and workspace. Use a running app only if its checkout, build, profile, and process are yours, and stop only PIDs you started. A newer build can migrate a workspace's engine store past what the installed build can open, so open a new workspace or a copy. Deleting `<workspace>/.dohc/engine` resets a development store; do it only to data you mean to throw away.
2. **Running fork code where credentials live.** Never check out, install, build, or test a fork PR's code on the shared Windows or Mac hosts or any machine with maintainer credentials. Ask a maintainer how to verify it.
3. **Running bare `cargo`.** Parallel uncapped Rust builds exhaust the shared host. Use the [rust-gate](.agents/skills/rust-gate/SKILL.md) skill. The gate can exit 0 while its summary says FAIL, so read the summary.

## Hit every surface

The most common gap is a change that works on the path you tested and is missing everywhere else. Before calling a feature done, check which of these apply and cover them:

- **Entry points.** Menus, shortcuts, direct links, and other callers reach the same feature.
- **Humans and agents.** The human action and its CLI or MCP equivalent run the same operation with the same permissions. If agent access is missing, say so in the PR. Computer use does not count.
- **Local and shared.** Offline use, sharing, and a collaborator's permissions and sync. A pass in the owner's workspace proves neither.
- **State and recovery.** Saved state, restart, undo, failure, and switching workspaces. A success message proves nothing about persistence.
- **Platforms and the phone.** Windows, macOS, Linux, and `apps/mobile` where affected. Say what you could not check.
- **Finish.** Loading, failure, empty states, both themes, keyboard access, and reduced motion.

## Working in the code

- **No backward compatibility.** We have no users yet, so prefer the best current design. Replace old contracts and update callers, tests, fixtures, and docs together. Remove aliases, dual formats, fallbacks, and dead paths. Add a migration only when asked.
- **Engine migrations that shipped are append-only.** If a build cannot migrate a store, it stops that workspace until a fixed build opens it.
- **Effect** belongs in Electron main, services, and Node-only packages where it removes manual cancellation, retry, or resource handling. Keep Promise interfaces for callers that don't use Effect, and keep renderer and preload imports Effect-free. Effect interruption does not stop the Promise or native work underneath, so keep native and OS resource limits, wait for owned resources to close before returning, and keep the original error ahead of cleanup failures. Before keeping a conversion, measure its bundle size and first-load time against the old one.
- **Comments** say the current constraint and what breaks without it. If you need a paragraph-long comment to justify why a workaround is OK, the code is wrong. Fix the code.
- The desktop does not need Postgres.

## Verifying

[Verify desktop work](docs/engineering/verify-agent-work.md) has setup, desktop QA, debugging, previews, and the PR gates.

- In a new worktree, run `pnpm setup:worktree`. `pnpm run doctor` checks readiness (`pnpm doctor` is pnpm's own command).
- While editing, run the affected packages' typecheck and focused tests.
- After changing JavaScript or TypeScript, run `pnpm lint`, and run `pnpm fmt` before you commit. Fix a lint report in the code. If the code is right, add `// oxlint-disable-next-line <rule> -- <reason>`.
- For desktop behavior, `pnpm qa:smoke` covers startup, editing, persistence, and restart. Done means you watched it work in the real app; mocked tests don't prove a UI.
- Test behavior that can break. Leave what the types guarantee to the typechecker, and skip mock-call mirrors and callback wiring. Extend an existing case or table before adding one. Test at the lowest layer that shows the defect.
- A logic, data, state, or protocol bug gets a check that fails before the fix and passes after. Put that result in the PR. A purely visual fix gets before-and-after captures instead of a test.
- Wait for the real condition. A test that needs a sleep to pass is wrong.

## Pull requests

- Use the [PR template](.github/pull_request_template.md): the problem, the resulting behavior, the evidence, and what you could not verify. Add screenshots or a recording when they help.
- Open a PR when it is ready for review. Use a draft only for specific early feedback, and say what feedback you need.
- Ready PRs from this repository run the PR checks on GitHub's runners. Passing checks on the head replace a local `pnpm verify:pr`. Missing, cancelled, or failed runs are not passes.
- Non-trivial code gets an independent review from another model family. Authorization, isolation, security, privacy, migration, durability, and major integrations get a second reviewer for that risk.
- Treat a review finding as evidence to check against the code, not an instruction. Fix real regressions. Decline false positives and out-of-scope requests with a reason.

## Docs and plans

- Most code changes need no new doc. Types, tests, and source already describe the implementation.
- `docs/` is for users, app authors, and agents. `docs/engineering/` holds maintainer procedures, security boundaries, and ADRs. Write down decisions, cross-component constraints, and traps a maintainer would get wrong. When a decision changes, rewrite or remove its old explanation.
- Keep plans, research, review logs, and measurements in the ignored `.agent-artifacts/`, and remove them when the task ends. Git and the merged PR are the record.

## Read when

- Changing anything a person sees: [dohc-interface](.agents/skills/dohc-interface/SKILL.md).
- Writing docs, PR bodies, commit messages, or comments: [dohc-writing](.agents/skills/dohc-writing/SKILL.md).
- Changing the phone app: [apps/mobile/AGENTS.md](apps/mobile/AGENTS.md).
- Touching auth, sharing, sandboxes, or app publishing: [security boundaries](docs/engineering/security-boundaries.md).
- Running or reading the shared verification queue: [the verification queue](docs/engineering/verification-queue.md).
- Releasing: the [dohc-release](.agents/skills/dohc-release/SKILL.md) skill.
- Finding your way around: the repository map in [README.md](README.md#repository-map).
