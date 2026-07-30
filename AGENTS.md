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

### Justify operational limits

Classify a limit by what happens when code reaches it, not by its name.

A defect tripwire rejects work outside supported healthy behavior. Before
adding one, measure a representative workload. Set the tripwire beyond the
measured healthy behavior. Record the measurement in a focused test, benchmark,
or decision document that names the limit. If healthy behavior reaches the
tripwire, measure again. Then revisit the limit.

A backpressure or load-shedding limit rejects work temporarily when a finite
resource is saturated. Set it from measured capacity and latency targets. Give
callers an explicit retry or degradation path.

A routing threshold does not reject work. It selects another supported path,
and healthy work can cross it.

Protocol versions and fixed schema values are contract values, not workload
limits. Justify them with a compatibility or interoperability requirement.

### Show agents the limits they hit

This section governs developer- and agent-facing failures, including build,
check, daemon, and API errors. For any error a user reads, also follow
[`docs/brand/copy.md`](docs/brand/copy.md).

Developers will not always read the code. Their agents will read the errors. An
agent can fix `richdoc node count: limit 128 nodes, requested 129 nodes`; it
cannot fix a blank window.

A defect-tripwire error must name the constraint, its configured limit, and the
unit. When available, include the requested or observed usage in the same unit.
A backpressure error must name the saturated resource. It must tell the caller
how to retry or degrade.

Report the error during a build or check when possible. Otherwise, use the
existing structured error type for that surface. Add stable fields when a
caller needs them to act. Do not catch the error silently.

### Let their agents shape the workspace they need

We should avoid feature creep, and assume our users can use their agents to create the specific workspace they need. This may seem to counter "boil the ocean", but it does not. We are not hand-building every possible app. We are building the primitives for a new era of work.

As an example, let's discuss CRM.

Should dohc have first-class documents, entities, links, permissions, source-backed apps, search, provenance, and agent-safe edits? Absolutely. No user or agent should have to invent the basic substrate that makes work inspectable, durable, and owned.

Should dohc ship a hardcoded CRM for every possible team? Probably not. A user's agent should be able to build a CRM, project tracker, client dashboard, hiring pipeline, or personal operating system out of dohc's primitives.

### Fight for the obvious workspace

We should avoid being clever and doing things because it feels smart. We want everything we build to be so obvious it feels kind of stupid.

Understand the problem before building. When simple and obvious differ, prefer
obvious. Among equally obvious designs, choose the simplest one that meets the
stated behavior and performance requirements. Record material tradeoffs in the
PR or a decision document. Do not hide them in patches or follow-up work.

When one of us prompts you, never hesitate to push back and suggest ways we
could make things more obvious. An obvious solution can have more parts. Obvious
solutions are the defaults that agents and the next reader expect. The next
reader decides whether a design is obvious.

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
launch / first users). Do not "fix" the missing checks.

Before merging, select and run the required local gates for the exact PR head.
For a PR, use the `rust` and `js` filters in the `changes` job of
`.github/workflows/pr-checks.yml`. This policy replaces the workflow header's
older unconditional local-gate reminder. A manual `workflow_dispatch` still
runs all gates by design.

- If `rust` matches, run the canonical Rust gate
  (`node tools/rust-engine-program/run-rust-checks.mjs`). Read its
  `== summary ==` block. Require every required step to report `PASS`; do not
  trust the process exit code alone.
- If `js` matches, reproduce the `javascript` job's required services,
  environment variables, and daemon prebuild locally. Then run
  `pnpm run typecheck` and `pnpm run test`.
- Run both when both filters match. Rust source matches both because the desktop
  end-to-end tests drive the daemon.
- Prose-only changes can skip code gates only when neither filter matches. Some
  documents are test inputs and therefore match `js`.
- If it is unclear whether a file is a test or build input, run both gates.
- In the PR, state which gates ran or why no code gate applies.

When looking out for reviews in created PRs, look out for reviews by coderabbit, codex and claude. These are setup (coderabbit and codex) to review every PR reliably.

For codex, you have to tag the bot (In a pull request comment, mention @codex review) to trigger a rereview after you commit and push the fixes.

Claude is not setup to review PRs automatically (not part of my subscription), so you have to invoke this review locally (ideally after the PR is created and in parallel with coderabbit and codex reviews). So you have to manually ask claude via the local cli to review the PR and manually go back and forth with it until no issues remain. Everytime claude finishes a review please update the PR via commenting what claude reviewed, then address them. So basically we're trying to do a pseudo claude PR review bot we orchestrate ourselves. Use fable-5 and fallback to opus-5 if fable is unavailable or rate limited.

**Use the `pr-review-watch` skill for this — do not hand-roll a review poller.**
See [`.claude/skills/pr-review-watch/SKILL.md`](.claude/skills/pr-review-watch/SKILL.md).
Hand-rolled watchers have failed in every way available: filtering on guessed
commit timestamps (and so hiding a `CHANGES_REQUESTED`), exiting after the first
round so the next one went unseen, polling only one bot, and never noticing that
a `@codex review` trigger silently did not take.

The rule the skill enforces, and the one worth remembering even without it: **a
review applies to a COMMIT, not to a PR.** Before merging anything, compare each
review's `commit_id` against the PR's `headRefOid`:

Prefer `review_status <PR>` from the skill, which handles every shape below (the
skill shows how to extract it — it is a function inside a Markdown file, so it
cannot be sourced directly). This is the copy-pasteable minimum if you are checking
by hand. Set `PR`, and treat a **failed** `gh api` as unknown rather than as "nobody
reviewed" — piping it straight into `grep` hides its exit status, which is why the
commands below capture first:

```
PR=371
HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
SHORT=${HEAD:0:10}
# Guard everything on this. An empty HEAD turns the filters below into
# contains("") and grep "", which match EVERY historical comment and make an
# unknown head look reviewed.
[ -n "$HEAD" ] || echo "HEAD LOOKUP FAILED — stop here, decide nothing"

# 1. formal reviews of THIS head (codex when it HAS findings; CodeRabbit usually).
#    codex files findings as COMMENTED, never CHANGES_REQUESTED. Only APPROVED /
#    CHANGES_REQUESTED / COMMENTED are coverage — a DISMISSED or PENDING review says
#    nothing about the code, so R1T (used to gate step 3) excludes them while R1
#    still shows them, labelled.
TERM='.state=="APPROVED" or .state=="CHANGES_REQUESTED" or .state=="COMMENTED"'
[ -n "$HEAD" ] && { R1=$(gh api "repos/dohc-ai/dohc/pulls/$PR/reviews" --paginate \
  --jq ".[]|select(.commit_id==\"$HEAD\")|if ($TERM) then \"\(.user.login) \(.state)\" else \"\(.user.login) \(.state)   <- NOT coverage\" end") \
  || echo "reviews query FAILED — unknown, not empty"
printf '%s\n' "$R1"
R1T=$(gh api "repos/dohc-ai/dohc/pulls/$PR/reviews" --paginate \
  --jq ".[]|select(.commit_id==\"$HEAD\")|select($TERM)|.user.login"); }

# 2. a codex CLEAN pass is an ISSUE comment, not a review — check it too.
#    Guarded on HEAD: with SHORT empty, contains("") matches every historical
#    comment and prints a stale clean pass as if it were this head's.
[ -n "$HEAD" ] && { CB=$(gh api "repos/dohc-ai/dohc/issues/$PR/comments" --paginate \
  --jq ".[]|select(.user.login==\"chatgpt-codex-connector[bot]\")|select(.body|contains(\"$SHORT\"))|.body") \
  || echo "codex comment query FAILED — unknown, not empty"
printf '%s' "$CB" | grep -iE "didn.t find any major issues|no major issues"; }

# 2b. codex's "cannot run" reply names NO sha, so it can never appear in (2).
#     Query it separately or you will wait for a review that is not coming.
gh api "repos/dohc-ai/dohc/issues/$PR/comments" --paginate \
  --jq ".[]|select(.user.login==\"chatgpt-codex-connector[bot]\")|select(.body|test(\"create an environment for this repo\"))|.created_at" \
  | tail -1

# 3. CodeRabbit's status comment, which it EDITS IN PLACE, names the head it
#    RECEIVED — it is NOT proof it reviewed. Only (1) proves that.
#    ONLY consult it when (1) shows no CodeRabbit review: the rate-limit wrapper
#    NEVER leaves the comment, so on a head CodeRabbit approved this would
#    otherwise contradict (1) and reject a reviewed PR forever (see #317).
[ -n "$HEAD" ] && ! printf '%s' "$R1T" | grep -q coderabbitai && {
CR=$(gh api "repos/dohc-ai/dohc/issues/$PR/comments" --paginate \
  --jq ".[]|select(.user.login==\"coderabbitai[bot]\")|select(.body|contains(\"$HEAD\"))|.body") \
  || echo "CodeRabbit comment query FAILED — unknown, not empty"
printf '%s' "$CR" | grep -iE "review limit|rate limit|review failed|currently processing" \
  && echo "^ CodeRabbit received this head but did NOT review it — not approval"; }
```

CodeRabbit coverage means **a review object in (1)**. Its status comment is written
when it receives a head, before doing any work, so a comment naming the head proves
nothing — two PRs had exactly that with zero reviews ever produced. codex is the
opposite: a clean pass leaves (1) empty and lives only in (2), so checking only (1)
reports a reviewed-and-passed PR as unreviewed.

If neither (1) nor a clean pass in (2) shows the head, the code is **unreviewed**
however many reviews the PR has collected — reviews of superseded commits look
identical to current ones in the GitHub UI.

Two more shapes that decide merges: codex files real findings under state
**`COMMENTED`**, never `CHANGES_REQUESTED`, so a populated review is not a pass;
and `--paginate` runs the `--jq` program **once per page**, so an aggregate like
`[…]|length` returns one count per page and any arithmetic test on it silently
misfires. Count lines instead.

Note `gh api --jq` does **not** accept `--arg` (that is a standalone-`jq` flag,
and `jq` is not installed here) — it exits 1 and prints nothing, which reads
exactly like "no matches". Embed values in the program string as above.

Two adjacent traps that have both cost real cycles: CodeRabbit announces a rate
limit in a comment body rather than failing, so its silence is not approval; and
the canonical Rust gate can exit 0 while its own summary block says FAIL, so read
`== summary ==` and never the exit code.

## How we write

dohc's writing discipline is Orwell's six rules plus ASD-STE100 Simplified
Technical English, applied by register. The rules live in
[`skills/dohc-writing/SKILL.md`](skills/dohc-writing/SKILL.md); UI copy has its
own in [`docs/brand/copy.md`](docs/brand/copy.md). Read the skill before
writing docs, specs, plans, PR bodies, or another skill. For UI copy — any
label, error, empty state, or toast — read the copy guide as well; the skill
alone does not carry those rules.

The one idea worth carrying even without it: **the register decides the
rules.** Text a reader *executes* (an error, a button, a procedure, an agent
instruction) gets strict STE. Text a reader *thinks about* (docs, plans) gets
the same discipline, loosened. Text that *persuades* (the letter above, commit
subjects) keeps its voice, and STE applies to it only as a slop filter.
Flattening editorial prose into compliance-speak is a failure, not compliance.

Term drift is the failure mode that costs us most, so: one name for one thing.
Use the word the surrounding surface already uses, and check it against the
code before asserting what it means — several dohc nouns mean different things
in different layers. There is deliberately no term list yet; one was drafted
and cut because it kept being wrong about a codebase that moves. Add it when
the terms settle, next to the code it describes.

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
