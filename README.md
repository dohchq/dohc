# dohc

dohc is a local-first file sync and collaboration workspace for humans and agents. It syncs your files across your devices and lets you share your work with your team and your agents.

At a glance, it is a text editor, chat, and app runner in one. The important part is underneath: your files stay on your computer, multiplayer editing comes standard, and whenever you or your agents need history, access control, or storage, it's already there.

[Download a build](https://github.com/dohc-ai/dohc/releases) or [run it from source](#run-it-from-source).

## Why this exists

This whole AI thing is still new and we're still trying to figure out how agents should fit into real work. So far, we mostly end up trying to bolt agents onto our old workflows with mixed success. We built dohc to help us figure this out by staying out of the way, assuming nothing about how you work, and building on the tools you already use.

Instead of a fixed CRM, project process, or agent-team template, dohc provides building blocks. It handles the boring parts: file sync, history, identity, permissions, storage, hosting, and app isolation. With those parts handled, you and your agents go straight to the work itself.

Agents now write much of the software people run, and few people read it. The more an agent builds for you, the more you depend on the layer underneath. dohc owns that layer. Sync, history, permissions, and app isolation work the same whether a person or an agent made the change, so you can let an agent build an app without reading its code to know what data it can reach.

Lastly, working with an agent resembles collaborating with another person: communicating with natural language and building on shared context. That is why dohc is multiplayer by design: humans and agents share one workspace. One person can use dohc as a personal workspace and can easily share their work when they're ready.

## Agents and workspace apps

dohc is agent agnostic. It does not provide an agent or prescribe how agents should work. A human, agent, or script can change the same workspace through the access each user configures.

Workspace apps are web apps whose source lives in the workspace. An app can read and update only the files and data its owner exposes. Collaborators can inspect and edit the source with their own tools and agents.

The plan is to make published apps available through normal web URLs, including for people who do not use dohc. App publishing and its permission model are still under development.

## Where it is today

dohc is pre-launch and under active development. Expect missing pieces, rough edges, and breaking changes.

The desktop app currently includes:

- Local workspaces that open ordinary folders on your computer.
- A rich Markdown editor with wikilinks, backlinks, and a graph view.
- Search across workspace files and chats.
- Version history with diffs and restore.
- Workspace chat that humans and external agents can use.
- Local web project previews.
- Optional self-hosted sync, sharing, presence, and live co-editing.

Local work does not require an account or server. Sync and sharing use a server you operate.

**dohc Drive is coming soon.** It will be the managed service, with a planned free tier. dohc will handle hosting, setup, and maintenance. Self-hosting provides the same collaboration capabilities; you operate the services and choose who can reach them.

Follow the [self-hosting guide](docs/how-to/self-host.md) to set up a server and connect the desktop app.

## Run it from source

You need Node.js 24.14 or newer, pnpm 11.20.0, and the Rust toolchain pinned in [`rust-toolchain.toml`](rust-toolchain.toml).

```bash
pnpm install
pnpm dev
```

The development command builds the Rust workspace engine before Electron starts. The desktop app runs without an account, server, or environment file.

Run the marketing site separately:

```bash
pnpm dev:site
```

## Develop the collaboration services

Multi-device sync, sharing, presence, and live co-editing use optional services:

- `services/workspace-api` provides authentication.
- `services/sync-relay` carries engine operations, files, shares, and presence.
- `services/share-web` serves browser share links.

Postgres stores authentication data. The relay stores its own data in SQLite. Start Postgres and apply the migrations:

```bash
pnpm dev:postgres
pnpm migrate
```

In both service terminals, set `NODE_ENV=development` and the same `BETTER_AUTH_SECRET`, at least 32 characters. Then start each service:

```bash
pnpm dev:workspace-api
pnpm --filter @dohc/sync-relay dev
```

In a third terminal, [configure share-web](services/share-web/README.md), build its viewer assets, and start it:

```bash
pnpm --filter @dohc/share-web build
pnpm --filter @dohc/share-web dev
```

These commands run development services. Use the [self-hosting guide](docs/how-to/self-host.md) for a production deployment.

## Repository map

```text
apps/desktop          Electron desktop app
apps/site             marketing site and interactive product demo
crates                Rust workspace engine and supporting crates
docs                  ADRs and implementation plans
fixtures              workspace fixtures the engine crates read
packages              shared TypeScript contracts, clients, tools, and UI code
services              optional authentication, sync, and share viewer services
tools/rust-engine-program   the Rust gate and its fixture goldens
tools/perf-profiling  renderer and engine profiling harnesses
```

## Checks

Run the smallest check that covers your change. Common checks are:

```bash
pnpm typecheck
pnpm test:desktop
pnpm test
```

Run Rust checks through [`rust-gate`](.agents/skills/rust-gate/SKILL.md), never a bare `cargo` command. Contributors and agents should read [`AGENTS.md`](AGENTS.md) before changing the codebase, and [`CONTEXT.md`](CONTEXT.md) for the vocabulary.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for accepted changes, checks, and the contributor agreement. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Stack

Electron, React, Vite, Tailwind CSS, Tiptap, Yjs, Rust, SQLite, Better Auth, Postgres, Vitest, and Playwright.

## License

dohc uses [AGPL-3.0-only](LICENSE) by default, including the desktop app, Rust engine, services, and brand package. You may self-host under its terms. Distribution requires the applicable source and notices; modified versions offered over a network must offer corresponding source to their users.

Shared libraries with their own MIT `LICENSE` files and [generated TypeScript protocol types](crates/dohc-engine-protocol/generated/ts/LICENSE) use MIT. These can be reused in proprietary software with the required notices. Their licenses do not relicense AGPL code they use. Third-party code retains its own licenses.

Your files, documents, data, and independently authored apps keep their own licenses. Using dohc does not itself make your work AGPL. Copying or combining AGPL code may carry obligations under that license.

The code licenses do not grant permission to imply official endorsement of a fork or hosted service.
