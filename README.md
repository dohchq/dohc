<a href="https://dohc.computer">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="social-assets/dohc-readme-banner-dark.png">
    <img src="social-assets/dohc-social-banner.png" alt="dohc. Build and share small apps with your agents.">
  </picture>
</a>

<p align="center">
  <a href="https://dohc.computer/#downloads"><img alt="Download for macOS, Windows, and Linux" src="https://img.shields.io/badge/download-macOS%20%7C%20Windows%20%7C%20Linux-2d342e?style=flat-square"></a>
  <a href="#where-it-is-today"><img alt="Early alpha" src="https://img.shields.io/badge/status-early%20alpha-2d342e?style=flat-square"></a>
  <a href="LICENSE"><img alt="License AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-2d342e?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://dohc.computer">Website</a> |
  <a href="https://dohc.computer/#downloads">Download</a> |
  <a href="docs/README.md">Docs</a> |
  <a href="docs/how-to/self-host.md">Self-host</a> |
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

dohc is a free, open-source desktop app and local-first runtime for personal apps. Open a folder as a workspace to build, run, and share small apps with your agents. dohc handles structured data, permissions, chat, version history, sync, and browser share links.

When an agent builds you an app, you can run it in your workspace with only the data you approve, publish it to a share link, and keep working on it with people and agents in chat.

[Download the newest nightly build](https://dohc.computer/#downloads) or [run it from source](#run-it-from-source).

## Why this exists

Agents can build a small app fast. Every app then needs the same things: a place for its data, an interface people already know, a safe way to share it, a way to work on it together, and a record of what each agent changed.

Developers can wire that up with git, MCP servers, Tailscale, Supabase, and Cloudflare. That setup is tedious, so most of these apps stay on one laptop, and most people never build them. dohc puts that runtime in one desktop app.

Agents now write much of the software people run, and few people read it. The more an agent builds for you, the more you depend on the layer underneath. dohc is that layer. Sync, history, permissions, and app isolation work the same for people and agents. When you approve an agent-built app, you choose which workspace data and capabilities it can reach, without reading its code. Its browser frontend can still make ordinary network requests, so review where it sends data.

Keeping an app's source, data, documents, and chat in one workspace makes the work easier to use, change, and hand over. A workspace is useful on one computer, and another person or agent can continue the same work when you share it.

## Agents and workspace apps

dohc is agent agnostic. It does not provide an agent or prescribe how agents should work. A human, agent, or script can change the same workspace through the access each user configures.

Workspace apps are web apps whose source lives in the workspace. Collaborators can inspect and edit the source with their own tools and agents. Apps receive only the workspace data and capabilities their owner exposes.

Published apps can be opened through a share link by people who do not use dohc, subject to the owner's access settings. Publishing from the packaged desktop requires Windows x64, an Apple silicon Mac running macOS 13.5 or later, or Linux x64 with Linux 5.13 or later and Landlock enabled. It also requires a self-hosted server with app publishing enabled. It is disabled in the default server bundle; see the [self-hosting guide](docs/how-to/self-host.md).

Apps can use approved Collection data through the operations their owner grants. Creating local Collection-backed apps requires Windows x64, an Apple silicon Mac running macOS 13.5 or later, or Linux x64 with Linux 5.13 or later and Landlock enabled. See the [app backend guide](docs/how-to/app-backend.md) for data, sharing, and current limits, and the [desktop capability requirements](docs/reference/desktop-capabilities.md) for platform and service limits.

## Where it is today

dohc is an early alpha, released as nightly builds. Download the newest one from Releases. When an update is available, select Update at the top right of dohc to download it, then select Restart to update. On Windows and macOS, a downloaded update also installs when you quit dohc. On Linux, approve the installation when the system asks. We are still proving these workflow benefits with users. Expect missing pieces, rough edges, and breaking changes. Read the known issues pinned at the top of the issue list before you start. Saving a note can rewrite Markdown that dohc doesn't keep yet, so try dohc on a copy of a notes folder.

The desktop app currently includes:

- Workspace apps whose source lives in the workspace, with Collection data, forms, and share links.
- Collections with table, board, and calendar views.
- A rich Markdown editor with wikilinks, backlinks, and a graph view.
- Drawings and diagrams that sit in the same folder as your docs.
- Workspace chat that people and outside agents can use.
- Version history with diffs and restore.
- Search across workspace files and chats.
- A `dohc` CLI and an MCP server, so any agent can work in a workspace.
- Local workspaces that open ordinary folders on your computer.
- Local web project previews.
- Optional self-hosted sync, sharing, presence, and live co-editing.

Local work does not require an account or server. Sync and sharing use a server you operate or dohc Drive.

**dohc Drive is in invite-only alpha.** It is the managed service, with a planned free tier, and it hosts the apps you publish. dohc handles hosting, setup, and maintenance. [Request an invite](https://dohc.computer/#drive). If you have one, connect the desktop app to `https://drive.dohc.computer`. Self-hosting provides the same collaboration capabilities; you operate the services and choose who can reach them.

Follow the [self-hosting guide](docs/how-to/self-host.md) to set up a server and connect the desktop app.

## Run it from source

You need Node.js 24.16 or newer, pnpm 11.20.0, and the Rust toolchain pinned in [`rust-toolchain.toml`](rust-toolchain.toml).

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
apps/mobile           phone app in React Native with Expo, on demo data until its server work lands
apps/site             marketing site and interactive product demo
crates                Rust workspace engine and supporting crates
docs                  user guides and reference; engineering guidance in docs/engineering
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
