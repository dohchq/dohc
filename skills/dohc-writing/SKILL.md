---
name: dohc-writing
description: dohc's writing discipline — Orwell's six rules plus ASD-STE100 Simplified Technical English, applied by register. Use when drafting or editing any prose in this repo: UI copy, error messages, empty states, docs, plans, specs, PR bodies, commit messages, AGENTS.md, and skills. Also use when asked to rewrite, tighten, simplify, or de-slop existing text.
---

# Writing for dohc

Two systems, one discipline. **Orwell** keeps prose alive. **STE** keeps it
executable. Neither alone is right for this repo, because dohc's text is not
one kind of text.

## Why a system at all

A controlled-language experiment measured three interventions against a
baseline, on two models
([woosal1337/blog ep01](https://github.com/woosal1337/blog/tree/main/videos/ep01-the-cure-for-ai-slop)):

| Intervention | Claude | GPT-5.5 |
| --- | --- | --- |
| STE skill | −74% | −50% |
| Orwell's six rules | −43% | −52% |
| Banned-words list | −3% | −40% |

A writing *system* cut slop by 43–74%. A banned-words list managed 3–40%, and
on Claude it did almost nothing.

Treat this as directional, not settled. It is six tasks and two models, scored
by a heuristic linter that counts the mechanical violations the STE prompt
tells the model to avoid. The authors call it "directional, not proof." The
ordering is the finding. The decimals are not.

The lesson is the whole reason this file exists: **a list of forbidden words
does not work. A system does.** If this skill ever decays into "never say
seamless," it has failed. Judge sentences by whether a reader can act on them,
not by whether they contain a flagged token.

## The register decides the rules

This part is dohc-specific. Get it right first. Ask one question before
writing: **will a reader execute this text, or think about it?**

### 1. Executable text → strict STE

Error messages, empty states, button labels, procedures, runbooks, skills,
agent instructions, product invariants, migration steps.

A reader acts on this text and cannot ask a follow-up question. Ambiguity here
becomes a real failure. Strict rules apply with no exceptions:

- One instruction per sentence. 20 words or fewer.
- Active voice, named actor. `The engine rejects the write`, not
  `the write is rejected`.
- No figurative language, no idiom, no irony, no humor.
- One approved term per concept — see the glossary below.
- State the condition before the action it controls.
- Say what the reader must do, not only what went wrong.

### 2. Explanatory text → STE-flavored

Docs, specs, plans, PR bodies, README, code comments, design notes.

A reader thinks about this text and can re-read it. Keep STE's discipline but
let sentences breathe:

- Prefer short sentences; vary length where it helps the reader.
- Keep contractions where they match the surrounding voice.
- Descriptions up to 25 words. One topic per paragraph.
- A fresh, concrete image is allowed when it does real explanatory work.
- Technical terms are fine. Define an unfamiliar one at first use.

### 3. Editorial text → Orwell only

The letter in AGENTS.md, commit subject lines, brand moments, the argument in
a plan for why a bold approach is right.

This text persuades and is meant to be remembered. STE would flatten it, and
flattening it would be the wrong trade. `fix: the watcher was lying, and gh api
--jq silently made it lie` tells you what happened and sticks. Do not
"correct" writing like that into `fix: correct watcher output filtering`.

Orwell's rules apply. STE applies only as a slop filter: cut padding, cut
hedging, cut inherited phrasing.

### Mixed documents

Most real dohc documents mix registers. This file does — the argument above is
editorial, the rules below are executable. A spec has a Rationale and a
Contract. A PR body has an argument and a test plan.

Section them. Then let **the strictest register present govern any sentence the
reader will act on.** A rule, a step, or a warning obeys strict STE even when
the prose around it is editorial.

## Orwell's six rules

From "Politics and the English Language". They apply everywhere, at the
strength the register allows.

1. Never use a metaphor, simile, or other figure of speech you are used to
   seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, always cut it out.
4. Never use the passive where you can use the active.
5. Never use a foreign phrase, a scientific word, or a jargon word if you can
   think of an everyday English equivalent.
6. Break any of these rules sooner than say anything outright barbarous.

**Rule 1 and STE genuinely conflict.** Orwell attacks *stale* metaphor and so
invites fresh metaphor. STE bans figurative language outright, because a
non-native reader executing a maintenance procedure cannot safely parse it.

The two skills this one draws on leave that unresolved —
[orwell-writing](https://github.com/tamdogood/builder-essential-skills/blob/main/skills/orwell-writing/SKILL.md)
and
[ste-plain-writing](https://github.com/Ryuketsukami/ste-plain-writing).
dohc resolves it by register. Editorial text welcomes fresh metaphor.
Explanatory text allows it where it does real work. Executable text bans it.

**Rule 6 is the anti-flattening clause and it outranks the rest.** Prose that
obeys every rule and reads like a compliance document is a failure. If a rule
is about to make a sentence worse, break it.

## Use one name for one thing

STE's real power is not its sentence rules. It is the controlled dictionary.
For dohc the equivalent is our own nouns.

Term drift between UI, docs, and agent tools is what makes an agent misfire.
The agent cannot tell that two words mean the same thing, or that one word
means two.

Rules:

- Use the approved term. Do not swap in a synonym to avoid repetition.
  Repetition is correct.
- One term, one meaning, per surface.
- When a concept has no approved term yet, pick one, use it consistently, and
  add it here.

### Approved terms

| Term | Means | Do not use |
| --- | --- | --- |
| `workspace` | The top-level scope that owns everything. Every other noun is scoped to one. | vault, space, org, tenant |
| `file` | A user-visible item of workspace content. Contract type `WorkspaceFile`; its `kind` is `atom`, `asset`, or `database`. | page, note, document, item |
| `asset` | A binary file kind — image, audio, video, pdf, sqlite (`AssetKind`). In UI copy say `file` unless the kind matters. | attachment, media, upload |
| `folder` | A container of files. | directory (in UI copy), collection |
| `chat` | The conversation surface as a whole. | conversation, DM |
| `channel` | A named division of the chat surface. Durable rows key on `channel_id`; load-bearing in sharing and authorization. | room, group, space |
| `thread` | A message sequence inside a channel. | topic, reply chain |
| `capture` | Content brought in from outside the workspace. | import, clip, ingest |
| `share` | An explicit grant of access beyond the owner. | permission, invite, ACL |
| `skill` | A reusable process an agent can run. | playbook, macro, recipe |
| `agent` | The non-human actor. Attribution uses the olive `agent` voice. | AI, assistant, bot, model |
| `source-backed` | Derived from an inspectable source rather than hidden state. | synced, generated, smart |

### Terms that mean different things in different layers

- **`atom`** is live in code. It is retired only from user-facing copy, and it
  carries two distinct technical meanings. Neither is legacy.
  - `WorkspaceFile.kind === "atom"` — a text-content file, as opposed to an
    `asset` or a `database`. `AtomKind` is that file's content type
    (`markdown`, `text`, `csv`, `json`, `html`), defined in
    `packages/workspace-contracts/src/domain.ts`.
  - `inlineAtom` in the editor — a ProseMirror **decoration**, deliberately
    not a node or a mark, so the atom stays literal text in the document
    model.

  Use `atom` in contract and editor code, with that layer's meaning. Never put
  it in UI copy. The user's word is `file`.
- **`doc` / `document`** appear widely but inconsistently. They mean a `file`,
  a `Y.Doc`, or prose under `docs/`, depending on where you stand. In new
  writing say `file` for content, `Y.Doc` for the CRDT, and `docs` only for
  the directory.
- **`entity`** is effectively dead in source — 4 occurrences, none of them a
  domain type. It survives in older plans and specs, and in the product
  invariants in `AGENTS.md`. Do not build new copy or new types on it.

Recording the real split beats inventing a tidy answer. A glossary that
quietly picks a winner for an unsettled term is just wrong in a new direction.

## Workflow

Drafting:

1. Name the register. Executable, explanatory, or editorial.
2. Name the audience and what they must be able to do after reading.
3. Draft in concrete, direct English.
4. Apply the register's rules.
5. Check every noun against the glossary.

Revising:

1. Read the whole source first.
2. List what must survive: facts, warnings, constraints, commands, links,
   established voice.
3. Cut words, clauses, and sentences that do no work.
4. Replace stale figures of speech and pompous diction.
5. Make the actor explicit where passive voice hides it.
6. Restore anything the rewrite lost.
7. Flag necessary jargon and necessary passive voice instead of silently
   removing the precision they carry.

## Do not

- Do not remove a caveat, limitation, or warning to make text shorter.
- Do not invent evidence, numbers, examples, or sources.
- Do not flatten a known voice into corporate neutral. See rule 6.
- Do not add personality where neutral prose is correct. The reverse failure
  is just as real.
- Do not claim strict ASD-STE100 conformance. We use its discipline, not its
  certified dictionary, and we have not checked against the current edition.
- Do not rewrite code, identifiers, commands, or quoted text.

## Final pass

- Does each sentence inform or direct? If neither, cut it.
- Does every pronoun have one clear referent?
- Could a shorter common word carry the same meaning?
- Is the actor named wherever the actor matters?
- Does each noun match the glossary?
- In executable text: is any sentence over 20 words, or carrying two
  instructions?
- Did the rewrite keep every fact and constraint from the source?
- Read it aloud. Does it sound like a person who knows the subject?

This skill improves the form of prose. It cannot make a weak idea true or an
unsupported claim credible.

## Why this fits dohc

STE was built for aircraft maintenance manuals: many authors, many native
languages, and one reader who must execute the text exactly, under time
pressure, with no one to ask.

A dohc workspace has that shape. Many authors, human and agent. Text that
agents execute rather than merely read. No follow-up question available at the
moment of execution. The cost of an ambiguous sentence is not a confused
reader — it is an agent that does the wrong thing to real work.

Text is dohc's primitive. A controlled language is that primitive taken
seriously. Applying it to our own repo first is the honest test of whether it
is worth offering to a user's workspace later.
