# dohc

dohc is a local-first desktop app and runtime for personal apps. People and their agents build, run, share, and manage small apps in a workspace folder. The workspace is the primary object. dohc handles data, sync, sharing, permissions, isolation, history, and chat. People own their work and choose their own tools and agents.

dohc is an early alpha, released as nightly builds. There are no users outside the team yet.

Treat this file as good defaults. The person you work with can override any of it. If a rule gets in the way, say so and ask before you break it.

## What dohc stands for

1. **Local first.** Local work needs no account or network. People can read, export, and recover their data without dohc. Self-hosting is real.
2. **Fast.** The desktop must feel native. A slowdown is a bug.
3. **Useful alone.** One person with their agents should get value from dohc. Routine work needs no programming or agent. Documents, Collections, and chat work without an app.
4. **Built for people and agents.** Design each feature for both. Agents use the same operation through the CLI or MCP, not by clicking the screen.
5. **Agent agnostic.** dohc doesn't provide or supervise agents. A control does the action it names. It never opens an agent prompt.
6. **Chat is part of the workspace.** Chat links to files, data, and apps, and what it produces can become real work.
7. **Apps are real web apps.** Their source lives in the workspace. They see only what their owner exposes. Anyone can open a shared app by its URL.
8. **Strict foundation, free workflow.** Capability-secure microservices, disguised as Folders, Collections, and Apps. The runtime enforces ownership, sign-in, permissions, sync, history, and isolation. Everything else is the user's choice. App source and Collection automations are files any agent can edit. Changing sharing, apps, or chat never changes how the others store data. dohc ships no fixed workflows or built-in business apps.
9. **Serious engine, small audience.** "Small" means personal or small-group apps. Build a runtime engineers choose for real work. Keep the runtime and app tools fast and inspectable. Raise or remove accidental limits that block demanding apps. If an app needs new access, add a scoped capability its owner approves.

### Jobs to test ideas against

- **Plan a trip.** A group and their agents keep the trip app, files, and chat together, from a phone or a browser.
- **Run a fundraiser.** A signup app takes registrations through a share link, and organizers keep working on it.
- **Share work in progress.** The other person and their agents get everything they need to continue. A zip file is not enough.
- **Tailor the workspace.** People and agents change, copy, and share apps and automations.
- **Run real accounting.** One person keeps double-entry books in a workspace app. They import bank transactions and attach receipts. Their accountant checks reports through a read-only share link.
- **Run a team on shared Collections.** A product manager owns a roadmap Collection with typed operations. Teammates build and share their own triage and rollup apps on top of it without copying data, breaking each other's apps, or widening anyone's permissions.

## Invariants

Never weaken these for convenience.

- **The server decides who someone is.** Never trust an identity the client sends.
- **Everything belongs to one workspace.** People and agents go through the same storage, permissions, and sharing.
- **Apps and previews run in a sandbox.** They get only what they were granted. Make it impossible for an app to ask for more. A rule that says "don't" is not enough.
- **A live document's Y.Doc is the source of truth.** The engine writes the Markdown file when edits settle.
- **A slow answer for workspace A never changes workspace B.** In renderer components and hooks, read workspace data with `useWorkspaceQuery`. Guard other async results with a request token or an abort signal.
- **Failures show as a toast and a Notices row**, with Try again and copy. A top bar is only for when the whole workspace is broken.
- **Changes can be undone.** Show who made a change and how to undo it. Warn before anything that can't be undone.
- **One operation per action.** Buttons, the CLI, and MCP call the same operation, and it checks permissions. Declare reads in `*Declarations.ts` and writes in `*WriteDeclarations.ts` in `packages/workspace-contracts/src`. Test that each write refuses what it should. After you change a declaration, run `pnpm write:operation-pins` and read the diff.
- **Measure before you add a limit.** Set it above healthy use. The error names the limit, its unit, and the actual usage.

## Stay safe

- **Use your own copy.** Work in your own worktree, build, profile, and workspace. Stop only processes you started. Test on a new workspace or a copy, because a newer build can upgrade a workspace past what the installed app can open.
- **Never run code from a fork PR** on the shared hosts or any machine with maintainer credentials. Ask a maintainer.
- **Never run bare `cargo`.** Use the [rust-gate](.agents/skills/rust-gate/SKILL.md) skill, and read its summary, not its exit code.

## Writing code

- **No backward compatibility.** Replace old code, and update callers, tests, and docs in the same change. Remove fallbacks and dead paths. Add a migration only when asked. Engine migrations that shipped are append-only.
- **Keep it small.** Pick the simplest design that makes the right behavior obvious.
- **No code comments.** If code needs a comment to make sense, change the code. [dohc-writing](.agents/skills/dohc-writing/SKILL.md#code-comments) lists the few exceptions.
- **Effect** is for Electron main, services, and Node-only packages. Keep it out of the renderer and preload. Its timeouts don't stop native work, so keep native limits, wait for resources to close, and report the first error, not a cleanup error.

## Done means it works everywhere

A change often works on the path you tried and nowhere else. Check each that applies:

- **Every way in:** menus, shortcuts, links, and the CLI or MCP.
- **Shared work:** offline use, and another person's permissions and sync.
- **State:** saving, restarting, undo, failure, and switching workspaces.
- **Platforms:** Windows, macOS, Linux, and `apps/mobile`. Say what you couldn't check.
- **Finish:** loading, errors, empty states, both themes, keyboard use, and reduced motion.

## Verifying

[Verify desktop work](docs/engineering/verify-agent-work.md) has the full steps.

- In a new worktree, run `pnpm setup:worktree`, then `pnpm run doctor`.
- While you work, run the typecheck and tests for the packages you changed.
- After you change JavaScript or TypeScript, run `pnpm lint` and `pnpm fmt`.
- For desktop changes, run `pnpm qa:smoke`, then watch your change work in the real app. Mocked tests don't prove a UI.
- Test behavior that can break, not what the types already guarantee.
- A bug fix gets a test that fails before the fix and passes after. A visual fix gets before and after screenshots.
- In tests, wait for the real condition. Never add a sleep.

## Pull requests

- Use the [PR template](.github/pull_request_template.md): what was wrong, what changed, how you checked it, and what you couldn't check.
- Open a PR when it is ready for review. Use a draft only to ask for early feedback, and say what you need.
- Passing PR checks on the latest commit replace a local `pnpm verify:pr`. A missing, cancelled, or failed run is not a pass.
- Non-trivial code gets a review from a different model family. Security, privacy, data loss, and migration changes get a second reviewer.
- Check each review finding against the code. Fix real problems. Decline the rest with a reason.

## Docs

- Most changes need no new doc. The code and tests describe them.
- `docs/` is for users, app authors, and agents. `docs/engineering/` is for maintainers.
- Put plans, notes, and measurements in the ignored `.agent-artifacts/` folder, and delete them when you finish.

## Read when

- Changing anything a person sees: [dohc-interface](.agents/skills/dohc-interface/SKILL.md).
- Writing docs, PR text, commit messages, or comments: [dohc-writing](.agents/skills/dohc-writing/SKILL.md).
- Changing the phone app: [apps/mobile/AGENTS.md](apps/mobile/AGENTS.md).
- Touching sign-in, sharing, sandboxes, or app publishing: [security boundaries](docs/engineering/security-boundaries.md).
- Releasing: [dohc-release](.agents/skills/dohc-release/SKILL.md).
- Word meanings: [CONTEXT.md](CONTEXT.md). Repository map: [README.md](README.md#repository-map).
