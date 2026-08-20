# dohc

dohc is a local-first file sync and collaboration workspace for humans and agents. It syncs your files and data across your devices and facilitates sharing and collaboration between you, your team and your agents.

dohc brings files, documents, data, chat, and workspace apps together. Humans and agents use the same workspace, while the underlying files remain on the user's computer.

[Download a build](https://github.com/dohc-ai/dohc/releases) or [run it from source](#run-it-from-source).

## What dohc is for

Work with agents often spans a chat, an editor, generated artifacts, and manual file sharing. The output becomes difficult to inspect, continue, or share with its original context.

dohc keeps the work and its context in one workspace. It handles file sync, history, identity, permissions, chat, and app isolation. Users and agents decide how to organize the workspace and which workflows to build.

Teams are not a prerequisite. One person can use dohc with their agents and local files. When they share their work, the relevant files, data, apps, chats, history, and permissions can travel together.

Rather than ship a fixed CRM, project process, or agent-team template, dohc provides building blocks that users and agents can adapt to the work.

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
- Source-visible plugins and local web project previews.
- Optional self-hosted sync, sharing, presence, and live co-editing.

dohc Cloud has not shipped yet.

## Run it from source

You need Node.js 24.14.0, pnpm 11.20.0, and the Rust toolchain pinned in [`rust-toolchain.toml`](rust-toolchain.toml).

```bash
pnpm install
pnpm dev
```

The development command builds the Rust workspace engine before Electron starts. The desktop app runs without an account, server, or environment file.

Run the marketing site separately:

```bash
pnpm dev:site
```

## Run the collaboration services

Multi-device sync, sharing, presence, and live co-editing use two optional services:

- `services/workspace-api` provides authentication.
- `services/sync-relay` carries engine operations, files, shares, and presence.

Postgres stores authentication data. The relay stores its own data in SQLite. Start Postgres and apply the migrations:

```bash
pnpm dev:postgres
pnpm migrate
```

Set `NODE_ENV=development` and the same `BETTER_AUTH_SECRET` of at least 32 characters in both service terminals. Then start each service:

```bash
pnpm dev:workspace-api
pnpm --filter @dohc/sync-relay dev
```

## Repository map

```text
apps/desktop          Electron desktop app
apps/site             marketing site and interactive product demo
crates                Rust workspace engine and supporting crates
packages              shared TypeScript contracts, clients, tools, and UI code
services              optional authentication and sync services
docs                  product, architecture, security, and development notes
tools                  repository gates and Rust engine evidence tools
```

## Checks

Run the smallest check that covers your change. Common checks are:

```bash
pnpm typecheck
pnpm test:desktop
pnpm test
```

Rust changes use the repository's guarded Rust gate. Contributors and agents should read [`AGENTS.md`](AGENTS.md) before changing the codebase.

## Stack

Electron, React, Vite, Tailwind CSS, Tiptap, Yjs, Rust, SQLite, Better Auth, Postgres, Vitest, and Playwright.
