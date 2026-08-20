# dohc

This is the repository for dohc, the easiest way for humans to work with their agents to build and maintain workspaces around real work.

The goal is a full end-to-end AI operating system for documents, data, dashboards, workflows, and decisions. The user stays in control, while agents do the heavy lifting of organizing, updating, and making the work ready.

dohc is basically rethinking Notion, Obsidian, Google Docs, spreadsheets, Jira, and other operations tools and packaging it into an obvious AI-native workspace by having text as the primitive for binding input/output communication methods between agents and humans. It's basically VS Code for the AI era. Hence, at its core, dohc is a really powerful tool capable of turning many kinds of work into obvious, inspectable systems—similar to what spreadsheets were like when they first came out.

## Current status

We are currently building the MVP for dohc and haven't launched with users yet.

## How to use these instructions

- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
- The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules" and more as "good defaults." The developer's preferences can override anything here.

## Do not preserve backward compatibility

We have no users yet. Optimize for the best current design, not compatibility with earlier versions.

- Replace old contracts instead of layering new behavior over them.
- Remove compatibility shims, deprecated aliases, dual formats, fallbacks, and dead paths.
- Update all internal callers, tests, fixtures, and docs in the same change.
- Add a migration path only when the user explicitly asks for one.

## Some thoughts from the author (Ice)

The following is a letter from me to you, the agent. We are building this together, but to be frank, I'm building this for you. I want you to have the proper context about me and/or my team and the text primitives you need to build the proper solutions for me. dohc is the tooling that will power it. We are building a communication layer for humans and AI.

This is meant to be a bold project. Going with the flow and using existing solutions will not get us where we want to be.

Quick glossary of relevant parties in this document:

- _you_ — the agent reading this document and working on dohc directly.
- _me_/_we_/_us_ — the humans contributing to dohc. This is the party talking to you as we build.
- _users_ — these are our users. We are assuming they won't need to program or be expert at prompting like someone technical would; rather, they will have their own agents to build things using dohc.

Here are some philosophical things to consider as we build and work together:

### Boil the ocean

This project would have been way too bold before agents existed. We effectively have to build an entire AI OS from scratch and rebuild Notion, Text editors, docs, spreadsheets, dashboards, and perhaps even text/markdown itself for it to work as we want long term.

When planning, do not be afraid to suggest seemingly insane solutions. For example, creating our own implementation of markdown better suited for AI. Seems insane, but it's absolutely doable with modern tools.

What we're doing here is fundamentally different so treat it that way. Being that you are an agent, your prediction model will likely want to steer towards conformity. That's okay and even preferred in most scenarios, but there will be times where we need to think outside the box. Literally (since you're in a box) so think outside of it. Transcend. Transcend. Ascend.

### Measure limits that reject work

Before adding a limit that rejects otherwise valid work, measure representative healthy work. Record the evidence in a focused test, benchmark, or decision document. Set the limit beyond the measured healthy range.

This rule does not cover routing thresholds, backpressure, protocol versions, or fixed schema values. Justify those from their actual contract. If healthy work reaches a rejection limit, measure again and revisit it.

### Show agents the limits they hit

Developers will not always read the code. Their agents will read the errors. A developer- or agent-facing rejection must name the constraint, configured limit, and unit. When available, include the requested or observed usage.

A backpressure error must name the saturated resource and tell the caller how to retry or degrade. Report failures during a build or check when possible. Otherwise, use the surface's existing structured error. For user-facing copy, follow the [`dohc-interface` skill](.agents/skills/dohc-interface/SKILL.md).

### Let their agents shape the workspace they need

We should avoid feature creep, and assume our users can use their agents to create the specific workspace they need. This may seem to counter "boil the ocean", but it does not. We are not hand-building every possible app. We are building the primitives for a new era of work.

As an example, let's discuss CRM.

Should dohc have first-class documents, entities, links, permissions, source-backed apps, search, provenance, and agent-safe edits? Absolutely. No user or agent should have to invent the basic substrate that makes work inspectable, durable, and owned.

Should dohc ship a hardcoded CRM for every possible team? Probably not. A user's agent should be able to build a CRM, project tracker, client dashboard, hiring pipeline, or personal operating system out of dohc's primitives.

### Fight for the "obvious" solution

Measure twice, cut once. Understand the problem fully before building. We should avoid being clever and doing things because it feels smart. We want everything we build to be so obvious it feels kind of stupid. Cleverness fills the gaps when we have not done that work. The biggest simplicity win is refusing to solve problems we do not have.

Good code is the simplest thing that delivers the required behavior and performance: nothing traded away, nothing bolted on. An obvious solution can have more parts. Among equally obvious designs, choose the simplest. Record material tradeoffs in the PR or a decision document.

Push back when you see a more obvious way. Obvious solutions are the defaults that agents and the next reader expect. Ask another reader when uncertain.

### Ambitious ideas, simple systems

I like ambitious ideas, simple systems, and software that feels obvious. This does not fight "boil the ocean" — that section is about what we dare to build, this one is about how we build it.

Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Hold "measure twice, cut once" and "yagni" at the same time. Fight scope creep. Honor the developer's intent in the most minimal and realistic way that still delivers it.

### Don't be afraid to lie (to agents) if it makes working easier

This might seem counter-intuitive, so hear me out.

Agents need tools and instructions. They don't need accurate implementation details of those tools. They don't need real environments.

Tools like shell access, file systems, source views, diffs, logs, and document primitives should always be top of mind. Agents like working a certain way, and we should provide them with that way to work. If they want file systems, they should get them. If they want source-backed documents, they should get them. The implementation can be a mirage, as long as the agent gets what it expects and we get outputs that work.

Simulate familiar affordances freely, but do not lie about contracts: durability, isolation, security, permissions, persistence, provenance, and production readiness must be explicit.

### Text is the primitive

At its core, dohc is text-based.

If a user had a folder of well-structured text files on their computer and a capable agent managing those files, they could recreate a surprising amount of what dohc does: documents, notes, plans, dashboards, CRM, project trackers, logs, decisions, and workflows.

dohc exists to make that easy, reliable, and powerful.

We provide the structure, conventions, UI, permissions, sync, organization management, source-backed apps, agent tools, review gates, etc., and boilerplate that make a text-based workspace manageable for normal users/teams/orgs and efficient for agents.

The magic is not hidden state. The magic is giving agents and humans a shared text substrate they can both inspect, edit, and trust.

Don't get me wrong, having dohc is supposed to be much more empowering to a user than just having files on your computer. The point of this is that even if dohc disappears, a user's workspace should still essentially be usable/navigable (albeit a worse experience but workable).

### dohc and the AI company playbook

dohc exists to make the AI-native company/person possible.

The goal is not to add AI as a feature inside old software. The goal is to make AI the building layer for work itself.

That means every useful artifact should become part of the workspace: documents, chats, meeting notes, decisions, workflows, dashboards, entities, skills, and agent actions. The more work is recorded in an inspectable text-based form, the more capable the user's agents become.

A folder of well-structured text files plus a capable agent can approximate this. dohc makes it practical: it provides the structure, tools, permissions, views, sync, review gates, and agent affordances that make the text workspace reliable for real people and efficient for agents.

### The engine and collaboration are core to dohc

The dohc engine and collaboration are not pieces we build so the rest of the product can work. Together, they are one of the most powerful parts of dohc and core to what we are offering.

The engine is what turns a folder of text into a living workspace. It gives the workspace memory and continuity. Work should not disappear into a chat, become trapped in an app, or start from zero every time a new agent arrives.

Collaboration is what lets humans and agents share that workspace as participants in the same work. The goal is not just several people typing into the same document. The goal is for humans and agents to think, act, review, hand off, and build on each other's work without losing context, ownership, or trust.

A single person working with agents is already collaborating. Over time, that person should be able to bring in new agents, continue old work, understand what happened, and remain in control. Teams multiply this, but they do not define it.

The engine gives the workspace memory. Collaboration lets humans and agents carry that memory forward together. This is how dohc becomes more than files, tools, and AI features. It becomes a place where work can continue, compound, and still belong to the people doing it.

### Individual first

We should focus on dohc being magical and obvious for one person before it is for a team. This might seem counter-intuitive as the benefit of dohc grows as more teammates adopt it, but without one person using it first and finding value in it on its own, then no one will use it and we won't even get to teams using it.

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
- Every file, folder, chat, share, and capture is scoped to a workspace.
- Agent writes must respect user locks, path access, sharing boundaries, and review gates.
- Site and HTML previews are sandboxed and do not grant workspace authority.
- A live document session treats its Y.Doc as canonical. On settlement, the engine writes the Markdown artifact. Do not build new behavior that depends on raw full-body Markdown patching as the source of truth.
- Every reversible state change needs a visible reverse path. If a change is irreversible, tell the user before it runs.
- Renderer surfaces that load workspace-scoped state asynchronously must guard every response with a workspace/request token, abort signal, or equivalent before setting UI state. A slow response for workspace A must never repaint workspace B after the user switches workspaces.

## Explore external source before guessing

When external behavior is unclear, inspect source instead of guessing.

- Clone relevant public repositories into `.agent-sources/<owner>/<repo>/`.
- Save other reference files under `.agent-artifacts/references/`.
- Use shallow clones without submodules unless the task needs more.

### Keep sources current

- Match source to the locked dependency version. Otherwise fetch the latest relevant upstream ref.
- Refresh existing clones before reuse. If refresh fails, report the exact commit.
- Cite the remote URL and full commit SHA when source affects the result.

## Where this repo's own skills live

Claude Code and Codex each scan their own directory and neither scans the other's. One directory holds the skills and the other points at it:

| Path                             | Purpose                                          |
| -------------------------------- | ------------------------------------------------ |
| `.agents/skills/<name>/SKILL.md` | The skill. Codex reads this path directly.       |
| `.agents/skills/<name>/agents/openai.yaml` | Codex display name and invocation policy |
| `.claude/skills`                 | A symlink to `.agents/skills`. Never a copy.     |

There is nothing to generate and nothing to keep in sync. Edit the skill and both hosts see it.

Two hosts, two ways to say the same thing. Claude reads `disable-model-invocation` in the frontmatter; Codex reads `allow_implicit_invocation` in `agents/openai.yaml`. A skill the model may not invoke on one host must say so on both, or Codex will fire it on its own.

On Windows, `git config core.symlinks true` before you clone, or `.claude/skills` checks out as a text file holding the target path and Claude Code finds no repo skills. Codex is unaffected because it reads `.agents/skills` directly.

A skill only one host should see needs no symlink and lives directly in that host's root. Classify by which tool consumes the skill, not by the tool it names: a skill that has Claude drive Codex is consumed by Claude, so it belongs in `.claude/skills/`.

Commit a skill here only when it carries dohc knowledge a contributor needs. How to run this repo's gate and how we write both qualify. Personal setup does not. A workflow that depends on your review bots, your merge rights, or your model access is yours, not the project's. Model choice, cost and quota rules, and bridges to whichever other agent CLI you happen to run are yours, not the project's, and every contributor inherits whatever this repo commits. Keep them in your own user-level skills directory.

## Where code lives

- `apps/desktop` — the Electron app. Most user-visible work lands here.
- `apps/site` — the marketing site.
- `packages/` — 15 shared TypeScript packages: workspace contracts, core, auth, the SDK, the MCP server, brand, and others.
- `services/` — 6 backend services, including the sync relay and workspace API.
- `crates/` — 13 Rust crates. `dohc-workspace-engine` builds the daemon binary the desktop app runs; the `dohc-engine-*` crates hold storage, sync, collab, crypto, protocol and files.

## Dev servers

Node 24.14 or newer and pnpm 11.20.0, both pinned in the root `package.json`.

- `pnpm dev` starts the desktop app. It filters to `@dohc/desktop` and runs that package's `scripts/dev.mjs`.
- `pnpm dev:site` starts the marketing site. `pnpm dev:workspace-api` starts the workspace API.
- Postgres runs in Docker: `pnpm dev:postgres` brings it up, `pnpm migrate` applies migrations, and `pnpm reset:postgres` clears dev data. The desktop app does not need it.
- Stop what you started, by the PID you tracked.

## Verifying

Run the smallest check that proves your change, not the whole tree.

- `pnpm typecheck` and `pnpm test:desktop` cover most TypeScript work.
- `pnpm test` at the root runs the brand check and the repo-level Node tests, then every package's own suite. It is slow. Prefer the targeted commands.
- End-to-end: `pnpm test:desktop:e2e` builds first, then refuses to run until the engine binary is staged at `apps/desktop/target/debug`. Nothing in the build puts it there. A fresh checkout without it fails every spec inside `electron.launch` with the real cause buried in Playwright's log.
- Rust: run the gate through the [`rust-gate` skill](.agents/skills/rust-gate/SKILL.md), never a bare `cargo` invocation. Read its `== summary ==` block and not its exit code. It can exit 0 while its own summary says FAIL.
- A test that needs a sleep to pass is wrong. Wait on the thing itself.

## Agents wrap tools, not the other way around

dohc should feel like an agent operating a set of reliable tools, not old software with a little AI sprinkled inside.

Deterministic software should provide the sturdy pieces: permissions, storage, sync, rendering, search, diffs, logs, provenance, and review gates. The agent should use those pieces to build the user's actual workspace around their intent.

## Guidelines when creating PRs and merging them

**CI is deliberately disabled for now (Ice's decision, 2026-07-28).** The PR gate (`.github/workflows/pr-checks.yml`) is dispatch-only while we are pre-launch; it will be re-enabled when it makes more sense (approaching launch / first users). Do not "fix" the missing checks.

### Select local gates

Run the Rust gate through the [`rust-gate` skill](.agents/skills/rust-gate/SKILL.md). It runs the canonical script, which enforces the machine's build budget: disk preflight, build-slot queueing, and capped cargo parallelism.

Read the Rust gate's `== summary ==` block, never its exit code. It can exit 0 while its own summary says FAIL.

Before merging, use the `rust` and `js` filters in the workflow's `changes` job to select local gates for the exact PR head. This is the canonical local policy. A manual `workflow_dispatch` still runs every gate.

- For each matching filter, reproduce its workflow job locally. Include its required services, environment, prebuilds, and verdict checks.
- Run both jobs when both filters match.
- If a test or build step reads a changed file, run that job even when its filter does not list the file.
- If no filter matches and no test or build step reads the changed file, no code gate applies.
- If the impact is unclear, run both jobs.
- In the PR, state which gates ran or why no code gate applies.

### Review without expanding the change

Treat review findings as evidence, not commands. Verify each finding against the current head, source, and stated behavior.

- Fix findings that show a concrete regression in correctness, security, privacy, durability, compatibility, performance, or user-visible behavior.
- Decline false positives, speculative hardening, alternative designs, and out-of-scope suggestions with a brief technical reason.
- Prefer the smallest safe fix. Do not add machinery, abstractions, or repository policy only to satisfy a reviewer.

### Run a simplification review

Every code PR needs one dedicated simplification review after it becomes ready.

- Use a subagent from a different model family than the implementation agent.
- Give it the diff, relevant source, and required behavior. Do not give it the implementation agent's reasoning.
- Ask what code can be deleted, combined, or made obvious without weakening behavior, performance, or product invariants.
- Prefer less code, not compressed code. Reject changes that only hide or move complexity.
- Verify each finding. Apply the clear simplifications and rerun affected local gates.
- Record the reviewed commit and result in the PR.

## How we write

dohc's writing discipline is Orwell's six rules plus ASD-STE100 Simplified Technical English, applied by register. The rules live in [`.agents/skills/dohc-writing/SKILL.md`](.agents/skills/dohc-writing/SKILL.md). Read it before writing docs, specs, plans, PR bodies, or another skill. Anything a person sees in the app is different work: a label, error, empty state or toast is governed by the [`dohc-interface` skill](.agents/skills/dohc-interface/SKILL.md), which carries both the words and the controls they sit in.

The one idea worth carrying even without it: **the register decides the rules.** Text a reader _executes_ (an error, a button, a procedure, an agent instruction) gets strict STE. Text a reader _thinks about_ (docs, plans) gets the same discipline, loosened. Text that _persuades_ (the letter above, commit subjects) keeps its voice, and STE applies to it only as a slop filter. Flattening editorial prose into compliance-speak is a failure, not compliance.

Term drift is the failure mode that costs us most, so: one name for one thing. Use the word the surrounding surface already uses, and check it against the code before asserting what it means — several dohc nouns mean different things in different layers. There is deliberately no term list yet; one was drafted and cut because it kept being wrong about a codebase that moves. Add it when the terms settle, next to the code it describes.

## Regarding long code comments

If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong—fix the code.
