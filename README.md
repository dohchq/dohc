# dohc

dohc is a local-first workspace for you and your agents. Bring files, documents, data, chat, and apps together in one place, with your work on your computer and under your control.

[Download a build](https://github.com/dohc-ai/dohc/releases) · [Report a problem or suggest an improvement](https://github.com/dohc-ai/dohc/issues)

dohc is pre-launch and under active development. Expect rough edges and breaking changes. Check the release notes for what is available in each build.

## One folder. Everything connected.

An agent can help you write a plan, organize information, or build an app. Keeping that work useful means keeping its files, conversations, and changes together, too.

dohc provides the foundations for that work: files, documents, data, chat, and apps, with sync, sharing, permissions, and history. You and your agents decide what to build and how to work. Each project should not have to recreate the infrastructure around it.

Start with your own work on one device. Bring other people and their agents into the same work when you need to collaborate.

## Your work, your tools

Your local workspace does not need an account or a server. Sync and sharing extend it across devices and collaborators. Your files remain yours.

dohc does not provide an agent. Use the agents you already work with. Anything that can read and write files can contribute; dohc adds ways to collaborate on the work itself.

Apps are web apps with their source in the workspace. You and your collaborators can inspect and change them with your own tools and agents. Each app can use only the files and data its owner exposes.

## Make it fit the work

For a trip, keep the plan, bookings, and group conversation together. Ask your agent to build the itinerary or expense tracker that fits your group.

For a project, keep notes and data beside the tools you build from them. A collaborator should be able to understand the work and continue it without reconstructing the context from scattered messages.

These examples describe what dohc is being built for. The workflow is yours to choose.

## Try it and help shape it

Choose a build from [Releases](https://github.com/dohc-ai/dohc/releases) and read its notes before getting started. If something gets in your way, [open an issue](https://github.com/dohc-ai/dohc/issues) with what you tried and what happened.

For running from source or contributing, start with [AGENTS.md](AGENTS.md) and the [development setup procedure](docs/how-to/verify-agent-work.md#prepare-the-checkout). The code and configuration are the source of truth for dependencies, commands, and implementation details.

For self-hosting, see the [deployment configuration](docker-compose.self-host.yml), [environment example](.env.self-host.example), and [operator guidance](services/share-web/README.md).
