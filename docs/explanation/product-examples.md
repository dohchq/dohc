# What dohc looks like in practice

For agents and contributors evaluating product proposals. Read these examples with the [product commitments](../../AGENTS.md#product-commitments).
A feature can use dohc's vocabulary and still miss the product.

## Plan a trip

- ✅ **dohc.** A person works with an agent through files and chat, then builds the trip app they want. They share the app, files, and conversation with the group. The group and their agents can continue the same work from a phone or browser. dohc handles sync, identity, permissions, and history underneath. The trip is the work. Agent orchestration is only one possible means.
- ❌ **Not dohc.** The person downloads a "travel team" template, configures agent roles and heartbeats, then accepts its prescribed workflow.

## Build a project dashboard

- ✅ **dohc.** An agent builds a source-backed web app in the workspace. The app reads and updates only the files and data its owner exposed. Collaborators can inspect and edit its source. Someone without dohc can open the published URL when they have access.
- ❌ **Not dohc.** An artifact or dashboard generator emits detached HTML with no durable source, live data boundary, history, or collaborative path forward. A polished demo is not yet a workspace.

## Share work in progress

- ✅ **dohc.** A person shares the relevant part of a workspace with its files, data, app, chat, history, and declared dependencies. The recipient and their agent can inspect what happened and continue the same work without reconstructing its context.
- ❌ **Not dohc.** The person exports a file, pastes an old chat, or sends a zip. The recipient must start again in another tool. Sharing should transfer continuity, not only bytes.

## Tailor the workspace

- ✅ **dohc.** A user asks an agent to create or change a source-visible plugin or app for their workflow. They can inspect it, fork it, and share it. The result can fit their work without forcing the same workflow on everyone else.
- ❌ **Not dohc.** dohc ships a hardcoded CRM, requires a project ritual, or becomes a template marketplace. dohc supplies reliable building blocks. Users and agents decide what to build.
