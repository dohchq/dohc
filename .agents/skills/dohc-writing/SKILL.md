---
name: dohc-writing
description: >-
  Use when drafting or editing prose in this repository that a reader thinks about rather than acts on: docs, specs, plans, PR bodies, commit messages, AGENTS.md, and other skills. Also use when asked to rewrite, tighten, simplify or de-slop existing text. Applies Orwell's rules, ASD-STE100 Simplified Technical English by register, and an AI-tell pass that preserves human voice. For anything a person sees in the app, use dohc-interface instead.
---

# Writing for dohc

Three checks, one discipline. **Orwell** keeps prose alive. **STE** keeps it
executable. The **AI-tell pass** cuts model habits without erasing the author's
voice. No one check is enough, because dohc's text is not one kind of text.

## Why a system at all

A controlled-language experiment measured three interventions against a
baseline, on two models
([woosal1337/blog ep01](https://github.com/woosal1337/blog/tree/main/videos/ep01-the-cure-for-ai-slop)):

| Intervention | Claude | GPT-5.5 |
| --- | --- | --- |
| STE skill | −74% | −50% |
| Orwell's six rules | −43% | −52% |
| Banned-words list | −3% | −40% |

A writing *system* cut slop by 43% to 74%. A banned-words list managed 3% to 40%, and
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

**Writing UI copy? That is the `dohc-interface` skill, not this one.**
It holds the concrete rules for labels, errors, empty states, toasts, and
destructive actions, and it is binding for those surfaces.

A reader acts on this text and cannot ask a follow-up question. Ambiguity here
becomes a real failure. These rules hold unless obeying one would make the text
wrong or unclear. See the precedence rule under Orwell's six:

- One instruction per sentence. 20 words or fewer.
- Active voice, named actor. `The engine rejects the write`, not
  `the write is rejected`.
- No figurative language, no idiom, no irony, no humor.
- One term per concept, and the same term the surrounding surface uses.
- State the condition before the action it controls.
- Say what the reader must do, not only what went wrong.

### 2. Explanatory text → STE-flavored

Docs, specs, plans, PR bodies, README, code comments, design notes.

A reader thinks about this text and can re-read it. Keep STE's discipline but
let sentences breathe. Explanatory text can state why something matters, but it
does not become editorial by default:

- Prefer short sentences; vary length where it helps the reader.
- Keep contractions where they match the surrounding voice.
- Descriptions up to 25 words. One topic per paragraph.
- A fresh, concrete image is allowed when it does real explanatory work.
- Technical terms are fine. Define an unfamiliar one at first use.
- State the motivation once, then explain the product, mechanism, or tradeoff.
- Use first person only when the author or source already establishes it.
- Keep memorable lines that carry a real idea. Do not add slogans for tone.

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

Most real dohc documents mix registers. This file does. The argument above is
editorial, and the rules below are executable. A spec has a Rationale and a
Contract. A PR body has an argument and a test plan.

Section them. Then let **the strictest register present govern any sentence the
reader will act on.** A rule, a step, or a warning obeys strict STE even when
the prose around it is editorial.

A request for "soul" does not change the register. Treat a section as editorial
only when its job is to persuade. Keep a README, design note, or PR body
explanatory unless the author supplied an editorial passage or asked for one.

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

The two skills this one draws on leave that unresolved:
[orwell-writing](https://github.com/tamdogood/builder-essential-skills/blob/main/skills/orwell-writing/SKILL.md)
and
[ste-plain-writing](https://github.com/Ryuketsukami/ste-plain-writing).
dohc resolves it by register. Editorial text welcomes fresh metaphor.
Explanatory text allows it where it does real work. Executable text bans it.

**Rule 6 is the anti-flattening clause.** Prose that obeys every rule and reads
like a compliance document is a failure. If a rule is about to make a sentence
worse, break it.

**Precedence, so this is decidable.** Being accurate outranks everything. In
executable text, the strict rules then outrank Rule 6: break one only when
obeying it would make the text wrong or ambiguous, never to make it sound
better. In explanatory and editorial text, Rule 6 outranks the strict rules.

## Use one name for one thing

STE's real power is not its sentence rules. It is the controlled dictionary.
For dohc the equivalent is our own nouns.

Term drift between UI, docs, and agent tools is what makes an agent misfire.
The agent cannot tell that two words mean the same thing, or that one word
means two.

Rules:

- Use the word the surrounding surface already uses. Match the UI, the
  contract, and the neighbouring docs.
- Do not swap in a synonym to avoid repetition. Repetition is correct.
- One term, one meaning, within a document.
- Check the word against the code before asserting what it means. Several dohc
  nouns mean different things in different layers.
- When the codebase has not settled a term, say so in the text. Do not pick a
  winner silently.

**There is deliberately no term list here yet.** One was drafted for this file
and removed. It made specific claims about a large, moving codebase, and review
found it wrong round after round. Some entries would have told an agent to
avoid a live contract, and one could have excluded direct
messages from channel-wide authorization. A word list that is subtly wrong is
worse than no list, because it states things authoritatively to a reader who
will act on them. Add one when the terms settle, and keep it next to the code
it describes so it cannot drift.

## Cut AI tells without flattening the voice

AI slop fails in two directions. Padding can make thin ideas look substantial.
Over-editing can leave prose sterile, anonymous, and just as machine-made.
Remove the first failure without causing the second.

### Make every claim earn its sentence

- Cut puffery, promotional language, vague attribution, and generic
  conclusions.
- Name the evidence or source. If none exists, state the claim at its actual
  level of certainty.
- Delete trailing `-ing` clauses that only pretend to explain a result.
- Describe the mechanism, action, or measured result instead of how it feels.
- Make a sentence specific to dohc or its task. Cut it if it could describe any
  project unchanged.

### Break model habits

- Prefer `is` and `has` to decorative substitutes.
- State the point directly instead of framing it as "not just X, but Y."
- Use the natural number of examples. Do not force a rule of three.
- Repeat the established term. Do not cycle through synonyms for variety.
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
a strong voice, use calm specificity instead of inventing one.

For explanatory and editorial text:

- Preserve first person when the author already uses it. Do not invent a
  narrator.
- Take a position when the source or evidence supports that position.
- Vary sentence length instead of forcing every paragraph into one rhythm.
- Keep the specific detail that makes the point credible or memorable.
- Admit real uncertainty or tension instead of smoothing it into balance.
- Match the source's intensity. Do not turn an explanation into a manifesto.
- Let the structure follow the thought. Do not split one thesis into several
  slogan-like sections.

Executable text is different. Its voice comes from calm specificity, not
personality. Do not add humor, attitude, or conversational filler to a command
or warning.

## Workflow

Drafting:

1. Name the register. Executable, explanatory, or editorial.
2. Name the audience and what they must be able to do after reading.
3. Draft in concrete, direct English.
4. Apply the register's rules.
5. Check every noun against the surrounding surface and the code.
6. Remove AI tells, then preserve the voice supported by the source.

Revising:

1. Read the whole source first.
2. List what must survive: facts, warnings, constraints, commands, links,
   established voice.
3. Cut words, clauses, and sentences that do no work.
4. Replace stale figures of speech and pompous diction.
5. Make the actor explicit where passive voice hides it.
6. Scan for formulaic structure, filler, vague claims, and decorative prose.
7. Preserve supported voice, rhythm, and concrete detail after cutting.
8. Restore anything the rewrite lost.
9. Flag necessary jargon and necessary passive voice instead of silently
   removing the precision they carry.

## Do not

- Do not remove a caveat, limitation, or warning to make text shorter.
- Do not invent evidence, numbers, examples, or sources.
- Do not invent first person, slogans, or intensity to make prose feel human.
- Do not flatten a known voice into corporate neutral. See rule 6.
- Do not add personality where neutral prose is correct. The reverse failure
  is just as real.
- Do not claim strict ASD-STE100 conformance. We use its discipline, not its
  certified dictionary, and we have not checked against the current edition.
- Do not rewrite code, identifiers, or commands.
- Do not rewrite an attributed quotation or a verbatim citation. Text the user
  quoted *so that you would rewrite it* is the target, not a quotation.

## Final pass

- Does each sentence inform or direct? If neither, cut it.
- Does every pronoun have one clear referent?
- Could a shorter common word carry the same meaning?
- Is the actor named wherever the actor matters?
- Does each noun match what the surrounding surface and the code call it?
- In executable text: is any sentence over 20 words, or carrying two
  instructions?
- Did the rewrite keep every fact and constraint from the source?
- Does any sentence use an em dash, forced triad, vague attribution, or generic
  conclusion?
- Did the draft invent a narrator, slogan, or level of intensity that the
  source did not establish?
- Did the cleanup leave the prose sterile or erase the author's point of view?
- What still makes this look obviously AI-generated?
- Read it aloud. Does it sound like a person who knows the subject?

This skill improves the form of prose. It cannot make a weak idea true or an
unsupported claim credible.

## Why this fits dohc

STE was built for aircraft maintenance manuals: many authors, many native
languages, and one reader who must execute the text exactly, under time
pressure, with no one to ask.

A dohc workspace has that shape. Many authors, human and agent. Text that
agents execute rather than merely read. No follow-up question is available at
the moment of execution. An ambiguous sentence does not only confuse a reader.
It can make an agent do the wrong thing to real work.

Text is dohc's primitive. A controlled language is that primitive taken
seriously. Applying it to our own repo first is the honest test of whether it
is worth offering to a user's workspace later.
