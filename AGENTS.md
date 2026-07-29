# dohc

This is the repository for dohc, the easiest way for humans to work with their agents to build and maintain workspaces around real work.

The goal is a full end-to-end AI operating system for documents, data, dashboards, workflows, and decisions. The user stays in control, while agents do the heavy lifting of organizing, updating, and making the work ready.

dohc is basically rethinking notion, obsidian, google docs, spreadsheets, jira, and other operations tools and packaging it into an obvious AI-native workspace by having text as the primitive for binding input/output communication methods between the agent and human/s. It's basically the vscode for the AI era. Hence, at its core dohc is a really powerful tool capable of turning many kinds of work into obvious inspectable systems- similar to what spreadsheets were like when it first came out.

## Current status

We are currently building the MVP for dohc and haven't launched with users yet.

## Some thoughts from the author (Ice)

The following is a letter from me to you, the agent. We are building this together, but to be frank, I'm building this for you. I want you to be have the proper context about me and/or my team and the text primitives you need to build the proper solutions for me. dohc is the tooling that will power it. We are building a communication layer for humans and AI.

This is meant to be a bold project. Going with the flow and using existing solutions will not get us where we want to be.

Quick gloassary of relevant parties in this document:

- _you_ - the agent reading this document and working on dohc directly.
- _me_/_we_/_us_ - the humans contributing to dohc. This is the party talking to you as we build
- _users_ - these are our users. We are assuming they won't need to program or be expert at prompting like someone technical would, rather they will have their own agents to build things using dohc.

Here's some philosophical things to consider as we build and work together:

### Boil the ocean

This project would have been way too bold beforer agents existed. We effectively have to build an entire AI OS from scratch and rebuild Notion, Text editors, docs, spreadsheets, dashboards, and perhaps even text/markdown itself for it to work as we want long term.

When planning, do not be afraid to suggest seeminlgy insane solutions. For example, creating our own implementation of markdown better suited for AI. Seems insane, but it's absolutely doable with modern tools.

What we're doing here is fundamentally different so treat it that way. Being that you are an agent, you're prediction model will likely want to steer towards conformity. That's okay and even preferred in most scenarios, but there will be times where we need to think outside the box. Literally (since you're in a box) so think outside of it. Transcend. Transcend. Ascend.

### Let their agents shape the workspace they need

We should avoid feature creep, and assume our users can use their agents to create the specific workspace they need. This may seem to counter "boil the ocean", but it does not. We are not hand-building every possible app. We are building the primitives for a new era of work.

As an example, let's discuss CRM.

Should dohc have first-class documents, entities, links, permissions, source-backed apps, search, provenance, and agent-safe edits? Absolutely. No user or agent should have to invent the basic substrate that makes work inspectable, durable, and owned.

Should dohc ship a hardcoded CRM for every possible team? Probably not. A user's agent should be able to build a CRM, project tracker, client dashboard, hiring pipeline, or personal operating system out of dohc's primitives.

### Fight for the obvious workspace

We should avoid being clever and doing things because it feels smart. We want everything we build to be so obvious it feels kind of stupid.

When one of us prompts you, never hesitate to push back and suggest ways we could make things more obvious. Note that "simple" and "obvious" are not always the same. Sometimes the obvious solution is more complex.

"Obvious" solutions are the defaults that agents would assume are the case.

### Don't be afraid to lie (to agents) if it makes working easier

This might seem counter-intuitive, so hear me out.

Agents need tools and instructions. They don't need accurate implementation details of those tools. They don't need real environments.

Tools like shell access, file systems, source views, diffs, logs, and document primitives should always be top of mind. Agents like working a certain way, and we should provide them with that way to work. If they want file systems, they should get them. If they want source-backed documents, they should get them. The implementation can be a mirage, as long as the agent gets what it expects and we get outputs that work.

Simulate familiar affordances freely, but do not lie about contracts: durability, isolation, security, permissions, persistence, provenance, and production readiness must be explicit.

### Text is the primitive

At its core, dohc is text-based.

If a user had a folder of well-structured text files on their computer and a capable agent managing those files, they could recreate a surprising amount of what dohc does: documents, notes, plans, dashboards, CRM, project trackers, logs, decisions, and workflows.

dohc exists to make that easy, reliable, and powerful.

We provide the structure, conventions, UI, permissions, sync, organization management, source-backed apps, agent tools, review gates, etc and boilerplate that make a text-based workspace manageable for normal users/teams/orgs and efficient for agents.

The magic is not hidden state. The magic is giving agents and humans a shared text substrate they can both inspect, edit, and trust.

Don't get me wrong, having dohc is supposed to be much more empowering to a user than just having files on your computer. The point of this is that even if dohc disappears, a user's workspace should still essentially be usable/navigatable (albeit a worse experience but workable).

### dohc and the AI company playbook

dohc exists to make the AI-native company/person possible.

The goal is not to add AI as a feature inside old software. The goal is to make AI the building layer for work itself.

That means every useful artifact should become part of the workspace: documents, chats, meeting notes, decisions, workflows, dashboards, entities, skills, and agent actions. The more work is recorded in an inspectable text-based form, the more capable the user's agents become.

A folder of well-structured text files plus a capable agent can approximate this. dohc makes it practical: it provides the structure, tools, permissions, views, sync, review gates, and agent affordances that make the text workspace reliable for real people and efficient for agents.

### Individual first

We should focus on dohc being magical and obvious for one person first before it is for a team. This might seem counter-intuitive as the benefit of dohc grows as more teammates adopt it, but without one person using it first and finding value in it on its own, then no one will use it and we won't even get to teams using it.

A single user should be able to use dohc for personal life, work, projects, research, planning, finances, health, writing, learning, or anything else they want to organize with an agent.

Teams and companies matter, but they are not the starting point. The starting point is one person with a workspace that understands them, remembers their context, helps them think, and turns messy work into clear, inspectable structure.

If dohc only works after a whole company adopts it, we built the wrong thing.

The product should feel valuable even when the entire "organization" is just one human and their agents.

### Open when shared, private when personal

dohc should encourage visibility where work is intentionally shared, because people learn from seeing how agents and teammates work.

But personal workspaces are personal. Transparency must come from explicit workspace boundaries, sharing, provenance, and consent — not accidental leakage.

## Product invariants

Do not weaken authorization, ownership, or review gates for convenience.

- Authorization is derived server-side. Browser/client callers must not be trusted to provide user identity.
- Every atom, folder, entity, share, and capture is scoped to a workspace.
- Agent writes must respect user locks, folder/atom access, sharing boundaries, and skill-turn gates.
- HTML atoms are sandboxed and sanitized.
- `atoms.body` is becoming a derived markdown cache from the canonical Y.Doc. Do not build new behavior that depends on raw full-body markdown patching as the source of truth.
- Renderer surfaces that load workspace-scoped state asynchronously must guard
  every response with a workspace/request token, abort signal, or equivalent
  before setting UI state. A slow response for workspace A must never repaint
  workspace B after the user switches workspaces.

## Repeated work should become skills

When a user likes how an agent handled something, dohc should make it easy to turn that process into a reusable skill, workflow, or playbook.

The best version of dohc does not just complete tasks. It helps users and teams compound how they work. Every repeated process is a candidate to become clearer, more inspectable, and easier for agents to run next time.

## Agents wrap tools, not the other way around

dohc should feel like an agent operating a set of reliable tools, not old software with a little AI sprinkled inside.

Deterministic software should provide the sturdy pieces: permissions, storage, sync, rendering, search, diffs, logs, provenance, and review gates. The agent should use those pieces to build the user's actual workspace around their intent.

## Guidelines when creating PRs and merging them

**CI is deliberately disabled for now (Ice's decision, 2026-07-28).** The PR
gate (`.github/workflows/pr-checks.yml`) is dispatch-only while we are
pre-launch; it will be re-enabled when it makes more sense (approaching
launch / first users). Do not "fix" the missing checks. Consequence for you:
there is no automated safety net, so before merging any PR you must run the
canonical Rust gate (`node tools/rust-engine-program/run-rust-checks.mjs`)
and the JS `typecheck` + `test` suites locally and say so in the PR.

When looking out for reviews in created PRs, look out for reviews by coderabbit, codex and claude. These are setup (coderabbit and codex) to review every PR reliably.

For codex, you have to tag the bot (In a pull request comment, mention @codex review) to trigger a rereview after you commit and push the fixes.

Claude is not setup to review PRs automatically (not part of my subscription), so you have to invoke this review locally (ideally after the PR is created and in parallel with coderabbit and codex reviews). So you have to manually ask claude via the local cli to review the PR and manually go back and forth with it until no issues remain. Everytime claude finishes a review please update the PR via commenting what claude reviewed, then address them. So basically we're trying to do a pseudo claude PR review bot we orchestrate ourselves. Use fable-5 and fallback to opus-5 if fable is unavailable or rate limited.

## How we write

dohc's writing discipline is Orwell's six rules plus ASD-STE100 Simplified
Technical English, applied by register. It lives in
[`.claude/skills/dohc-writing/SKILL.md`](.claude/skills/dohc-writing/SKILL.md)
and covers UI copy, errors, docs, plans, specs, PR bodies, commit messages, and
skills. UI copy has its own concrete rules in
[`docs/brand/copy.md`](docs/brand/copy.md).

The one idea worth carrying even without the skill: **the register decides the
rules.** Text a reader *executes* (an error, a button, a procedure, an agent
instruction) gets strict STE — one instruction per sentence, active voice,
named actor, no figurative language, one approved term per concept. Text a
reader *thinks about* (docs, plans) gets the same discipline, loosened. Text
that *persuades* (the letter above, commit subjects) keeps its voice; Orwell
applies, STE does not. Flattening editorial prose into compliance-speak is a
failure, not compliance.

The evidence for doing this at all: across Claude and GPT, a writing *system*
cut slop by 50–74%, while a banned-words list cut it by 3–40%. Do not let this
turn into a list of forbidden words.

Term drift is the failure mode that actually costs us. One name for one thing —
`file`, `folder`, `workspace`, `chat`, `share`, `capture`, `agent`. The skill
holds the glossary, including the terms that are currently in conflict
(`atom`, `doc`, `entity`) and must not be built on until they are resolved.

## Regarding long code comments

If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong -- fix the code

## Some general rules

These are meant to steer us in the right direction. They are not hard-set, but we should default to following them. If you think one should be ignored, be very loud and cear about that and get approval from us before doing it.

- After a PR is merged, delete its remote branch from GitHub unless the user
  explicitly asks to keep it or another open PR still depends on it. Verify the
  remote ref is gone. Do not delete the local branch or worktree unless asked.
- Brand identity is final: lowercase `dohc`, the drop-lobe mark, warm
  paper + graphite. There must be no legacy product identity in shipping
  source — `src/__tests__/brandNoLegacy.test.ts` enforces this.
- The product is the local-first desktop app (`apps/desktop`) on the workspace
  engine; it needs no backend. The opt-in cloud surface is reduced to live
  collaboration (Hocuspocus + the workspace-api collab-token route) and the
  sync relay, both authenticated by Better Auth over Postgres — see
  [`docs/architecture/backend-modes.md`](docs/architecture/backend-modes.md)
  before touching that stack. (The former Convex web app and the
  sharing/members/invites/files/sync cloud surface have been retired.)
