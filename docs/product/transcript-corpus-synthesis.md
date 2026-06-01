# dohc transcript corpus synthesis

This document compacts the notes, videos, tweets, and discussion around
`transcripts/` into one durable product artifact. It is meant to preserve
the product lessons so the raw transcript folder can be deleted after
review. It is not a verbatim archive, so keep a separate archive only if
exact quotes or timestamps matter later.

Source corpus covered:

- `transcripts/ anrej-karpathy-claude-code-idea.txt`
- `transcripts/15-minutes-obsidian-guide.txt`
- `transcripts/does-ai-kill-note-taking-apps.txt`
- `transcripts/how-i-use-obsidian-and-claude-to-run-my-life.txt`
- `transcripts/how-to-do-obsidian-ai.txt`
- `transcripts/karpathy-llm-twitter.txt`
- `transcripts/my-full-claude-cowork-setup.txt`
- `transcripts/obsidian-ai-practical-tips.txt`
- `transcripts/obsidian-llm-wiki.txt`
- `transcripts/primeagen-obsidian.txt`
- `transcripts/ultimate-ai-secod-brain.txt`
- `transcripts/yc-ai-playbood.txt`

## Core thesis

dohc should productize what the best Obsidian, Notion, Claude Code, and
AI-workflow power users are doing manually:

> A user should be able to open dohc, describe what they are trying to do,
> provide a little context, and get a useful AI-maintained workspace without
> first becoming a note-taking or automation expert.

The product is not "AI added to notes." It is an agent operating a durable
text workspace on the user's behalf. Markdown, HTML, chats, runs, sources,
views, commands, skills, and review gates all become part of one inspectable
system.

## The problem hidden in the transcripts

The videos are mostly made by exceptional users. They already have strong
habits, taste, motivation, and willingness to assemble custom systems. They
can watch a tutorial, copy a folder structure, install plugins, write
commands, maintain daily notes, tune prompts, and keep their setup alive.

Most users are not like that. Many admire those workflows but do not know
where to start, do not take notes consistently, and do not want to inherit
someone else's exact setup. The magical dohc first win is:

> "I opened dohc, answered a few good questions, added a couple of things I
> already had, and it took me to the level of those YouTube setups without
> making me build the setup myself."

That is the opportunity. dohc turns the expert workflow into a product loop.

## What the corpus teaches

### 1. Files over apps is correct, but incomplete

The Obsidian-centered transcripts repeatedly return to the same foundation:
local text files last longer than apps. Markdown files are portable,
inspectable, linkable, searchable, and easy for agents to read and edit.

For dohc, this validates "text is the primitive." But the product cannot
stop at files. A folder of markdown plus an agent is powerful for technical
or highly motivated users, but still too raw for normal people. dohc should
provide the missing product layer: storage, permissions, sync, search,
source-backed views, safe agent writes, review gates, polished UI, and
context-aware workflows.

### 2. Systems beat tools

The "does AI kill note-taking apps?" transcript makes an important
distinction: replacing one tool with another is not the point. The durable
value is the user's system of capturing, thinking, deciding, and acting.

dohc should not frame itself as killing Obsidian or Notion. It should make a
better default system possible for people who want the benefits but do not
want the manual burden. The user's judgment still matters. AI should remove
drudgery, surface options, ask for missing context, and propose structure,
but it should not quietly replace the user's taste, priorities, or sense of
meaning.

### 3. The LLM wiki pattern is a core primitive

The Karpathy/LLM-wiki material is one of the clearest product patterns:

- Put raw source material in a durable source layer.
- Have an agent incrementally compile that into structured wiki/workspace
  files.
- Maintain indexes, links, summaries, and logs.
- Ask questions against the compiled workspace instead of repeatedly
  dumping raw context into chat.
- Save useful outputs back into the workspace so knowledge compounds.

For dohc, this maps directly to source atoms, generated atoms, links,
entities, run logs, and generated views. The key product rule is:

> Source first, view second, next action third.

If dohc creates a dashboard before it has real sources, the result feels
like slop. If it creates sources, explains what it knows, builds a polished
view, and names what it still needs, the same surface feels useful.

### 4. Context is the real asset

The practical AI+Obsidian examples all say some version of: stop starting
new chats from zero. AI is powerful when it has the user's actual context:
goals, projects, constraints, values, people, past decisions, content,
style, logs, and current work.

For dohc, "memory" should not mean opaque chatbot memory. It should mean
inspectable context atoms, source files, chats, run artifacts, and
structured metadata the user and agent can both inspect.

### 5. Markdown is a source medium; HTML is a presentation medium

Markdown can be beautiful, especially in a good reader/editor. But the
current onboarding failure showed a real split:

- Markdown is excellent for input, source, notes, run logs, and review.
- HTML is better for polished home surfaces, dashboards, and interactive
  presentation.

The MVP should create a polished `home.html` as the primary landing surface
when a workspace/project has enough source context. That HTML must be
source-backed, sandboxed, and explain what it is using. Otherwise it is just
prettier slop.

JavaScript should be allowed carefully because AI can build interactive
views that markdown cannot express. The product should constrain it through
sandboxing, source-backed SDKs, review gates, and clear provenance rather
than pretending dynamic views do not matter.

### 6. Chat is the cockpit, not an afterthought

Claude Code, Codex, and T3 Code work because the main action is talking to
an agent and reviewing what it did. Files are still crucial, but the user
does not start by manually arranging files. They start from intent.

dohc's Agent view should therefore be first-class:

- Chat is the primary work surface.
- Files are the inspectable source surface.
- Graph is the relationship/source map.
- Right rails show only helpful operational state: progress, changes,
  environment/project context, and meaningful sources.
- Chat history should be durable, browsable, pinnable, renamable, and
  project-scoped when appropriate.

Chats can be treated like workspace artifacts. A chat belongs to no project
or to an intentional project folder. Not every folder is a project. A
project is a chosen work context with its own chats, sources, runs, and
possibly skills.

### 7. Setup Run is the onboarding primitive

The old onboarding experience interviewed the user, generated a markdown
dashboard and files, and then felt underwhelming. The likely cause was not
only visual polish. It was that dohc produced structure without enough
grounding.

The better primitive is a Setup Run:

1. Help the user choose a useful direction from broad options.
2. Ask for just enough context or existing material.
3. Create source files first.
4. Create a polished source-backed `home.html`.
5. Create `.runs/setup.md` explaining objective, sources, view, gaps, and
   next action.
6. Hand the user back a useful cockpit, not a pile of unexplained files.

The onboarding should feel like an agent assembling the user's first
working system, not like a template generator.

### 8. Skills and commands are how work compounds

Several transcripts show commands like context loading, daily planning,
weekly updates, idea graduation, project setup, and wiki maintenance. The
important product insight is not the specific commands. It is the loop:

1. User and agent repeat a useful workflow.
2. The workflow becomes named, inspectable, editable text.
3. The user can run it again.
4. The agent can suggest new commands based on how the user actually works.

dohc should make repeated work become skills. Skills should be local to a
project when they are domain-specific and global when they are broadly
useful. A skill is not just a button; it is the user's accumulated operating
knowledge.

### 9. Collaboration is shared context, not just multiplayer editing

The team and YC transcripts point toward "AI megamind" territory: every
artifact, meeting, decision, prompt, skill, and agent run becomes shared
organizational context. But dohc should still be individual-first for MVP.

Collaboration should enter through the substrate:

- Workspaces define boundaries.
- Shared artifacts have provenance.
- Agent actions are attributable and reviewable.
- Team skills can be saved and reused.
- Team chats and run logs become inspectable context.
- Personal and shared contexts stay separated unless explicitly shared.

The MVP should not depend on a whole team adopting dohc. It should be
magical for one person, while the architecture makes collaboration a natural
extension.

### 10. Guardrails are part of the product, not enterprise garnish

The power-user setups often rely on Git, backups, separate AI zones,
permissions, manual review, and trust boundaries. dohc needs those as
product primitives:

- No fake data.
- Every generated view cites or references its sources.
- AI-generated content should be distinguishable from user-authored source.
- Important edits should be reviewable and reversible.
- Missing context should produce a capture prompt, not invented certainty.
- Agents must respect locks, sharing, workspace boundaries, and skill-turn
  gates.

The best version of dohc is powerful because it is safe enough to trust.

## MVP shape

The strongest MVP direction is:

> dohc is an AI-maintained work cockpit built from inspectable text.

The MVP loop:

1. **Onboard with a Setup Run.** Pick the right mission, gather enough
   context, create source docs, build one useful cockpit.
2. **Retain with the Work Loop.** User opens dohc, sees what matters, talks
   naturally, and dohc updates the workspace with reviewable changes.
3. **Compound with Skills.** Repeated successful work becomes reusable
   process.

### Minimum primitives for that MVP

- Markdown atoms for source, notes, plans, decisions, logs, and skills.
- HTML atoms for polished cockpit/dashboard views.
- Source links and provenance for generated views.
- Agent chat as a first-class center surface.
- Project/no-project chat scoping.
- Setup Run artifacts under `.runs/`.
- Review queue and change summaries.
- A minimal right rail with progress, changes, and relevant sources.
- Graph/source map as an optional understanding surface.
- Workspace and project boundaries that are obvious in the UI.
- Commands/skills as inspectable, runnable text.

### What to defer

- A hardcoded CRM, project tracker, or life OS.
- Full team collaboration magic before the solo loop works.
- Arbitrary unreviewed JS apps with broad authority.
- Complex automation/scheduling.
- Deep connector sprawl.
- Huge template libraries that make onboarding feel generic.
- Import-everything flows that drown the user in old clutter.

## Product rules that should survive

1. **No fake productivity theater.** If dohc does not know, it says what it
   needs and offers the next capture action.
2. **Source first, view second.** Generated dashboards and cockpits must be
   backed by real sources.
3. **The user keeps judgment.** AI can suggest, organize, draft, and update,
   but meaningful direction and approval belong to the user.
4. **The agent works where humans can inspect.** Durable artifacts should be
   readable as text or source-backed views.
5. **Structure is earned.** Avoid over-foldering and over-templating before
   patterns exist.
6. **Chats are work artifacts.** They should be durable, named, scoped,
   searchable, and able to produce workspace changes.
7. **Every repeated win can become a skill.** dohc should notice and help
   the user preserve useful workflows.
8. **Individual first, collaboration ready.** A solo user must get value
   before team adoption.

## Transcript-by-transcript compression

### Karpathy LLM knowledge bases and tweet thread

Raw sources are compiled into a markdown wiki by an LLM. The wiki has
summaries, links, indexes, concepts, and generated outputs. The user rarely
edits the compiled layer directly. This is the closest outside articulation
of dohc's source-backed workspace thesis.

### Obsidian LLM wiki

Makes the LLM-wiki pattern operational: raw, wiki, schema; Git save points;
agent-aware skills; templates; maintenance/linting; query skills; source
preservation. This validates dohc's need for run logs, schema-like
contracts, and agent-safe maintenance.

### Primeagen Obsidian and comments

Many people do not want to maintain note systems. Some find manual notes
ineffective. Obsidian is valuable as documentation/cold storage for some,
but not a universal habit. dohc should not assume users are note-takers.
It should make useful structure happen with lower friction.

### Does AI kill note-taking apps?

The key distinction is tool versus system. AI can retrieve and organize, but
the human still needs judgment and integration. dohc should augment the
user's thinking and work, not silently replace their understanding with an
AI-curated library.

### My full Claude co-work setup

Shows the direction of a daily AI work cockpit: morning briefs, dashboards,
data lake, project setup, autonomous builder, PRD-first behavior, and
agent instructions. For dohc, this supports Setup Run onboarding, polished
home surfaces, and agent operating rules.

### Ultimate AI second brain

Shows two layers: global strategy/context and scoped project execution.
Projects have inputs, process, outputs, local instructions, and local
skills. dohc should model projects as intentional work contexts, not every
folder.

### How I use Obsidian and Claude to run my life

The valuable ideas are low-friction daily capture, context loading,
commands, orphan detection, idea graduation, and agent-suggested workflows.
The "daily note idea extractor" is a strong metaphor for dohc: turn messy
streams into durable work only when worth promoting.

### Practical AI with Obsidian

The main value is a single source of truth: goals, projects, values, style,
people, decisions, and content in one place. AI becomes far more useful when
it can cherry-pick the right context instead of relying on opaque chat
memory.

### 15 minute Obsidian guide

The enduring primitives are local files, links, backlinks, search, graph,
attachments, properties, templates, canvas, and simple big buckets. Avoid
over-foldering and plugin chasing. dohc should provide the power without
making the user learn the machinery first.

### How to do Obsidian AI

Important warning: AI can over-generate and pollute the user's thinking
space. Keep an AI zone, maintain good friction, and require discernment.
dohc's review queue and provenance are the product version of that
discipline.

### YC AI playbook

AI-native organizations use AI as a building layer, record artifacts, share
context, maintain tool registries, and let non-engineers encode workflows in
natural language. dohc should start with one person but preserve the path to
team memory and shared skills.

## The final product intuition

dohc should feel like the obvious workspace an agent would want if it were
helping a human run real life and real work:

- It has files because agents and humans need durable source.
- It has chat because intent arrives conversationally.
- It has views because humans need to see, scan, and decide.
- It has runs because agent work needs a trace.
- It has review because trust is earned.
- It has skills because repeated work should compound.
- It has workspace boundaries because private and shared work must not blur.

If the MVP works, a user should not think, "This is a prettier notes app."
They should think, "Of course this is what LLMs make possible."
