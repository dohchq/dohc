---
name: dohc-writing
description: dohc's writing discipline — Orwell's six rules plus ASD-STE100 Simplified Technical English, applied by register. Use when drafting or editing any prose in this repo: UI copy, error messages, empty states, docs, plans, specs, PR bodies, commit messages, AGENTS.md, and skills. Also use when asked to rewrite, tighten, simplify, or de-slop existing text.
---

# Writing for dohc

Two systems, one discipline. **Orwell** keeps prose alive. **STE** keeps it
executable. Neither alone is right for this repo, because dohc's text is not
one kind of text.

## Why a system at all

A controlled-language experiment across Claude and GPT measured three
interventions against a baseline. A writing *system* cut slop by 50–74%. A
banned-words list cut it by 3–40% — sometimes nearly nothing.

The lesson is the whole reason this file exists: **a list of forbidden words
does not work. A system does.** If this skill ever decays into "never say
seamless," it has failed. Judge sentences by whether a reader can act on them,
not by whether they contain a flagged token.

## The register decides the rules

This is the part that is specific to dohc, and the part to get right first.
Ask one question before writing: **will a reader execute this text, or think
about it?**

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
The source skills leave this unresolved. dohc resolves it by register: fresh
metaphor is welcome in editorial text, allowed in explanatory text when it
does real work, and banned in executable text.

**Rule 6 is the anti-flattening clause and it outranks the rest.** Prose that
obeys every rule and reads like a compliance document is a failure. If a rule
is about to make a sentence worse, break it.

## Use one name for one thing

STE's real teeth is not its sentence rules — it is its controlled dictionary.
For dohc the equivalent is our own nouns. Term drift between UI, docs, and
agent tools is what makes an agent misfire, because the agent cannot tell that
two words mean the same thing, or that one word means two.

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
| `file` | A user-visible item of workspace content. The canonical contract type is `WorkspaceFile`. | page, note, document, item |
| `folder` | A container of files. | directory (in UI copy), collection |
| `chat` | A conversation surface in the workspace. | conversation, room, DM |
| `thread` | A message sequence inside a chat. | topic, reply chain |
| `capture` | Content brought in from outside the workspace. | import, clip, ingest |
| `share` | An explicit grant of access beyond the owner. | permission, invite, ACL |
| `skill` | A reusable process an agent can run. | playbook, macro, recipe |
| `agent` | The non-human actor. Attribution uses the olive `agent` voice. | AI, assistant, bot, model |
| `source-backed` | Derived from an inspectable source rather than hidden state. | synced, generated, smart |

### Terms with an open conflict — resolve before reuse

- **`atom`** carries two meanings today. In the editor and CRDT layers it is
  live and precise (`inlineAtom`, `AtomKind`): an atomic inline node. In
  product vocabulary it is legacy — the user-facing surface moved to `file`
  and `folder`, but `AGENTS.md` still lists "atom" among the product
  invariant nouns. Do not introduce `atom` into new product copy or docs. Keep
  it in editor and CRDT code, where it means the node.
- **`doc` / `document`** appear widely but inconsistently, sometimes meaning a
  `file`, sometimes a Y.Doc, sometimes prose in `docs/`. In new writing, say
  `file` for content, `Y.Doc` for the CRDT, and `docs` only for the directory.
- **`entity`** is nearly dead in the code (about 50 uses) yet still appears in
  the product invariants. Do not build new copy on it until it means something
  specific again.

Flagging these beats inventing a tidy answer. A glossary that quietly picks a
winner for a term the codebase has not settled will be wrong in one direction
or the other.

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
  certified dictionary, and we have not checked against the current issue.
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
