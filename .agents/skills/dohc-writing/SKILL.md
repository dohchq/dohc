---
name: dohc-writing
description: >-
  Use when drafting or editing prose in this repository that a reader thinks about rather than acts on: docs, specs, plans, PR bodies, commit messages, AGENTS.md, and other skills. Also use when asked to rewrite, tighten, simplify or de-slop existing text. Applies Orwell's rules, ASD-STE100 Simplified Technical English by register, and an AI-tell pass that preserves human voice. For anything a person sees in the app, use dohc-interface instead.
---

# Writing for dohc

Three checks, one discipline. **Orwell** keeps prose alive. **STE** keeps it
executable. The **AI-tell pass** cuts model habits without erasing the author's
voice. No one check is enough, because dohc's text is not one kind of text.

The lesson that holds it together: **a banned-words list does not work, a
system does.** A controlled-language experiment
([woosal1337/blog ep01](https://github.com/woosal1337/blog/tree/main/videos/ep01-the-cure-for-ai-slop))
measured writing systems cutting slop by 43% to 74% while a banned-words list
managed 3% to 40%. Directional, not proof. If this skill ever decays into
"never say seamless," it has failed. Judge sentences by whether a reader can
act on them, not by whether they contain a flagged token.

## The register decides the rules

This part is dohc-specific. Ask one question before writing: **will a reader
execute this text, or think about it?**

### 1. Executable text → strict STE

Procedures, runbooks, skills, agent instructions, product invariants,
migration steps. UI copy is the `dohc-interface` skill, not this one.

A reader acts on this text and cannot ask a follow-up question. Ambiguity here
becomes a real failure.

- One instruction per sentence. 20 words or fewer.
- Active voice, named actor. `The engine rejects the write`, not
  `the write is rejected`.
- No figurative language, no idiom, no irony, no humor.
- One term per concept, and the same term the surrounding surface uses.
- State the condition before the action it controls.
- Put the common case first, exceptions after.
- Say what the reader must do, not only what went wrong.
- Never "simply", "easy", or "quickly" in a procedure.

### 2. Explanatory text → STE-flavored

Docs, specs, plans, PR bodies, README, code comments, design notes.

A reader thinks about this text and can re-read it. Keep STE's discipline but
let sentences breathe:

- Prefer short sentences and vary length where it helps. Descriptions up to
  25 words, one topic per paragraph.
- Keep contractions where they match the surrounding voice.
- A fresh, concrete image is allowed when it does real explanatory work.
- Technical terms are fine. Define an unfamiliar one at first use.
- State the motivation once, then explain the product, mechanism, or tradeoff.
- Headings carry the point, not just the topic. Link with words that say where
  the link goes, never "click here".

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

Most real dohc documents mix registers. This file does. Section them, then let
**the strictest register present govern any sentence the reader will act on.**
A request for "soul" does not change the register: treat a section as
editorial only when its job is to persuade, and keep a README, design note, or
PR body explanatory unless the author supplied an editorial passage or asked
for one.

## One document, one job

The register governs sentences. A whole document also has a mode, and two
questions pick it: does it inform action or understanding, and does it serve
learning or work? Action and learning is a tutorial. Action and work is a
how-to. Understanding and work is reference. Understanding and learning is
explanation. (diataxis.fr)

One document, one mode. No reference tables inside a tutorial, no teaching
inside reference, no persuading inside a how-to. Split and link instead.

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
invites fresh metaphor; STE bans figurative language outright. dohc resolves
it by register: editorial text welcomes fresh metaphor, explanatory text
allows it where it does real work, executable text bans it. The source skills,
[orwell-writing](https://github.com/tamdogood/builder-essential-skills/blob/main/skills/orwell-writing/SKILL.md)
and [ste-plain-writing](https://github.com/Ryuketsukami/ste-plain-writing),
leave that unresolved.

**Precedence, so this is decidable.** Being accurate outranks everything. In
executable text the strict rules then outrank Rule 6: break one only when
obeying it would make the text wrong or ambiguous, never to make it sound
better. In explanatory and editorial text Rule 6 outranks the strict rules:
prose that obeys every rule and reads like a compliance document is a failure.

## Use one name for one thing

STE's real power is its controlled dictionary. For dohc the equivalent is our
own nouns. Term drift between UI, docs, and agent tools is what makes an agent
misfire: it cannot tell that two words mean the same thing, or that one word
means two.

- Use the word the surrounding surface already uses: the UI, the contract, the
  neighbouring docs.
- Do not swap in a synonym to avoid repetition. Repetition is correct.
- One term, one meaning, within a document.
- Check the word against the code before asserting what it means. Several dohc
  nouns mean different things in different layers.
- When the codebase has not settled a term, say so instead of picking a winner
  silently.

**There is deliberately no term list here.** One was drafted and removed:
review found it wrong round after round, and a subtly wrong list is worse than
no list, because it speaks authoritatively to a reader who will act on it. Add
one when the terms settle, and keep it next to the code it describes.

### One reading per sentence

- Keep "only" and "not" next to the word they change. "Only fails on growth"
  and "fails only on growth" say different things.
- Break noun strings: "the share-link permission scope check" becomes "the
  check on a share link's permission scope".
- Give every clause its verb. "Phase 1 moves the converters and Phase 2 the
  runtime" leaves Phase 2 without one.
- Keep the small words that force one parse: "that", and the repeated article
  when "the client and the host" are two things.
- Write plurals out, never "(s)". No slashes: "a, b, or both", never "a/b" or
  "and/or".

## Cut AI tells without flattening the voice

AI slop fails in two directions. Padding can make thin ideas look substantial.
Over-editing can leave prose sterile, anonymous, and just as machine-made.
Remove the first failure without causing the second.

### Make every claim earn its sentence

- Cut puffery, promotional language, vague attribution, and generic
  conclusions.
- Name the evidence or source, or state the claim at its actual level of
  certainty.
- Delete trailing `-ing` clauses that only pretend to explain a result.
- Describe the mechanism, action, or measured result instead of how it feels.
- Cut any sentence that could describe any project unchanged.

### Break model habits

- Prefer `is` and `has` to decorative substitutes.
- State the point directly instead of framing it as "not just X, but Y."
- Use the natural number of examples. Do not force a rule of three.
- Replace abstract project metaphors with the actual component, action, or
  tradeoff.
- Cut filler, stacked hedges, and adverbs that prop up weak verbs.
- Do not use em dashes. Start a new sentence or use a comma. Do not hide the
  same aside in parentheses.
- Use sentence-case headings, straight quotation marks, and only the emphasis
  the reader needs.
- Remove chatbot greetings, praise, and conclusions that add no information or
  action.

### Preserve the author's voice

Cleaning is not finished when the draft becomes neutral. Voice must come from
the source, the user's words, or the surrounding document. If none establishes
one, use calm specificity instead of inventing it. In executable text that
calm specificity *is* the voice: no humor, attitude, or filler in a command or
warning.

- Preserve first person when the author already uses it. Do not invent a
  narrator.
- Take a position when the evidence supports it, and admit real uncertainty
  instead of smoothing it into balance.
- Keep the specific detail that makes the point credible or memorable.
- Match the source's intensity. Do not turn an explanation into a manifesto.

## Worked examples

Executable, from a runbook:

> Before: Note that the engine binary may need to be rebuilt in cases where
> changes have been made to any of the crates.
>
> After: If you changed a crate, rebuild the engine binary through the
> rust-gate skill.

Condition before action, a named actor, a command, one instruction.

Explanatory, from a spec:

> Before: It's important to note that share-link permission scope validation
> logic is performed server-side, ensuring security.
>
> After: The server validates a share link's permission scope. The client
> never supplies its own.

The hedge goes, the noun string breaks up, "is performed" gains an actor, and
"ensuring security" becomes the actual guarantee.

Editorial, from a PR body:

> Before: This isn't just a refactor, it's a fundamental shift in how sync
> works, delivering robust, seamless collaboration.
>
> After: The refactor moves conflict resolution from the renderer to the
> engine. Two devices editing one document no longer race.

"Not just X" becomes the point itself, and puffery becomes a mechanism a
reviewer can check.

## Workflow

Drafting: name the register and the document's mode, draft in concrete direct
English, apply the register's rules, check every noun against the code, then
remove AI tells.

Revising: read the whole source first and list what must survive: facts,
warnings, constraints, commands, links, established voice. Cut, then restore
anything the rewrite lost. Flag necessary jargon and necessary passive voice
instead of silently removing their precision.

## Do not

- Do not remove a caveat, limitation, or warning to make text shorter.
- Do not invent evidence, numbers, examples, or sources.
- Do not flatten a known voice into corporate neutral, and do not add
  personality where neutral prose is correct. Both failures are real.
- Do not claim strict ASD-STE100 conformance. We use its discipline, not its
  certified dictionary.
- Do not rewrite code, identifiers, or commands.
- Do not rewrite an attributed quotation or a verbatim citation. Text the user
  quoted *so that you would rewrite it* is the target, not a quotation.

## Final pass

- Did the rewrite keep every fact, constraint, and warning from the source?
- Did the cleanup leave the prose sterile or erase the author's point of view?
- What still makes this look obviously AI-generated?
- Read it aloud. Does it sound like a person who knows the subject?

This skill improves the form of prose. It cannot make a weak idea true or an
unsupported claim credible.
