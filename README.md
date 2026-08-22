# dohc

dohc is a local-first file sync and collaboration workspace for humans and agents. It syncs your files and data across your devices and lets you share work with your team and your agents.

At a glance, it is a text editor, chat, and app runner in one. The important part is underneath. Your files stay on your computer, dohc adds multiplayer editing and sharing, and apps you and your agents build get storage and authorization.

[Download a build](https://github.com/dohc-ai/dohc/releases) or [run it from source](#run-it-from-source).

## Why this exists

This whole AI thing is still new and we're still trying to figure out how agents should fit into real work. So far, we mostly end up trying to bolt agents onto our old workflows with varying levels of success. We built dohc to help us figure this out rather than claim we already have.

Instead of a fixed CRM, project process, or agent-team template, dohc provides building blocks. It handles the boring parts: file sync, history, identity, permissions, storage, and app isolation. Users and agents decide how to work without rebuilding that infrastructure.

In a way, working with an agent resembles collaborating with another person: communicating with natural language and building on shared context. That is why dohc is multiplayer by design: humans and agents share one workspace. One person can use dohc as a personal workspace and can easily share their work when they're ready.

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

## Run the collaboration services

Multi-device sync, sharing, presence, and live co-editing use two optional services:

- `services/workspace-api` provides authentication.
- `services/sync-relay` carries engine operations, files, shares, and presence.

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

## Repository map

```text
apps/desktop          Electron desktop app
apps/site             marketing site and interactive product demo
crates                Rust workspace engine and supporting crates
packages              shared TypeScript contracts, clients, tools, and UI code
services              optional authentication and sync services
tools                 Rust engine gate scripts, fixtures, and evidence
```

## Checks

Run the smallest check that covers your change. Common checks are:

```bash
pnpm typecheck
pnpm test:desktop
pnpm test
```

Run Rust checks through [`rust-gate`](.agents/skills/rust-gate/SKILL.md), never a bare `cargo` command. Contributors and agents should read [`AGENTS.md`](AGENTS.md) before changing the codebase.

## Stack

Electron, React, Vite, Tailwind CSS, Tiptap, Yjs, Rust, SQLite, Better Auth, Postgres, Vitest, and Playwright.
