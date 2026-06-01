# dohc — product spec (overview)

A working summary of what the dohc app does today. The implementation
lives in `apps/app`.

## Core model

- **Atoms** — plain-text markdown files in a per-user vault. Each has a
  rename-proof `id:` (frontmatter), a `title:`, and optional user
  properties. Wikilinks (`[[path]]`) connect atoms.
- **Inline atoms** — `{key: value}` captures inside prose, and `{= … }`
  formulas that compute live from other files (e.g.
  `{= sum(logs.2025_07_*.billable)}`). Computed values render after the
  token and update as the underlying files change.
- **Live views** — block-level live lists/tables backed by inspectable
  fenced `query` source. They are for repeating collections; inline atoms
  and formulas remain the live scalar/value syntax.
- **Folder views** — app-like custom views stored under any folder's
  `.views/<name>/` package. They use normal web code, but read dohc
  through a source-backed SDK; the canonical work state remains in atoms,
  entities, inline values, and imports/exports.
- **Entities** — a flexible store (people, projects, clients, …) with
  user-declared types, shown through live views.
- **Folders** — organize atoms; support icons, colors, stars, and
  drag-and-drop move with wikilink-rewrite cascade.

## Surfaces

- **Workspace shell** — activity bar, file tree, document canvas, and an
  inspector/chat column (exactly one of chat / imports+exports open).
- **Editor** — Tiptap/Yjs-backed markdown editor with a raw source mode,
  wikilink pills, inline-atom decorations, and ASCII sketches.
- **HTML atoms** — `.html` atoms render in a sandboxed, server-built
  shell (zero-network, sanitized).
- **Views** — folder-local app surfaces over dohc. They live in `.views/`,
  compile ordinary TypeScript/React/CSS, render in an opaque sandbox, and
  talk to the workspace only through dohc's SDK.
- **Chat** — the dohc agent: find, draft, organize; shows sources and
  changes.
- **Onboarding** — a short questionnaire seeds the agent's first turn,
  which builds source atoms, identity context, a setup run, and a first
  cockpit (`home.html` or `.views/home`).
- **Graph** — a force-directed view of atoms and their links.
- **Imports / Exports** — controlled workspace-to-workspace data/text
  exchange. Exports publish only selected fields; imports subscribe to
  fields another workspace exposes.
- **Document sharing** — per-atom shares (view/edit), separate from
  imports/exports.

## Stack

TanStack Start + TanStack Router, React 19, Vite, Tailwind CSS v4,
Convex (backend + agent), WorkOS AuthKit, Tiptap, Yjs, Hocuspocus, Vitest,
Nitro.

## Invariants

- The agent always checks onboarding state first and never ends
  onboarding with an empty vault.
- Authorization is derived server-side; no client may fake completion or
  ownership. See `docs/security/authz-boundaries.md`.
