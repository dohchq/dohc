---
name: dohc-writing
description: >-
  Use when writing or editing prose in this repository: docs, specs, plans, PR bodies, commit messages, code comments, AGENTS.md, and skills. Also use when asked to rewrite, tighten, simplify, or de-slop text. For words a person sees in the app, use dohc-interface.
---

# Writing for dohc

Write for one reader who will act on the text or decide something from it.
Use plain English, the names the code uses, and the facts that reader needs.

## Before you write

Name the reader and what they will do after reading. If you cannot name both, do not write the document.

Give each document one job: teach a newcomer, walk someone through a task, list facts to look up, or explain why something is the way it is.
Link to the other jobs instead of mixing them in.

## Instructions follow ASD-STE100

Use these rules for text a reader acts on and cannot ask about: procedures, how-to steps, runbooks, skills, AGENTS.md, and product invariants.
In a mixed document, apply them to each sentence the reader acts on.

- Write one instruction per sentence, in 20 words or fewer.
- Put the condition before the action: "If you changed a crate, rebuild the engine."
- Name who acts, in the active voice: "The engine rejects the write."
- Write commands, not narration.
- Keep the text literal, without metaphor, idiom, or humor.
- End each step with what tells the reader it is done: "Done when the package's tests pass."

## Everything else follows Orwell

Use these rules for text a reader thinks about: explanations, specs, plans, PR bodies, and code comments.

1. Never use a metaphor, simile, or other figure of speech you are used to seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, always cut it out.
4. Never use the passive where you can use the active.
5. Never use a foreign phrase, a scientific word, or a jargon word if you can think of an everyday English equivalent.
6. Break any of these rules sooner than say anything outright barbarous.

Vary sentence length. Use a short sentence for a main point and a longer one to carry a fact with its condition.
Prefer a real case, such as a PR, an incident, or a measured number, to a general claim.
Take a position when the evidence supports one, and state real uncertainty plainly.
Keep the author's voice when the text has one.

Accuracy comes first. In instructions, break a rule only when following it would make the text wrong or ambiguous. Everywhere else, Orwell's sixth rule wins.

## Use dohc's words

[`CONTEXT.md`](../../../CONTEXT.md) lists dohc's terms.
Use the word the code, the UI, and the neighboring docs already use, and repeat it instead of switching to a synonym.
Several nouns mean different things in different layers, so check a term against the code before you say what it means.
If the code has not settled a term, say so.

Make each sentence read one way:

- Keep "only" and "not" next to the word they change.
- Make each "it", "this", and "they" point at one obvious thing. Repeat the noun when in doubt.
- Break up noun strings: "the share-link permission scope check" becomes "the check on a share link's permission scope".
- Write "a, b, or both", not "a/b" or "and/or".

## Writing for agents

Skills, AGENTS.md, and prompts are instructions an agent runs. They also need these:

- Describe the process the agent should follow, not the result you hope for.
- Give each rule its reason, so the agent can extend it to cases you did not write down.
- State the behavior you want. Naming a banned behavior makes it more likely, so keep "never" for hard guardrails and pair it with what to do instead.
- Delete each line the model would follow without being told.
- Move material that only some tasks need into its own file. Link it with a line that says when to read it.
- To test a line, run the skill with and without it and compare the results.

## Fix model habits

Find and fix these patterns, which models still produce:

- Puffery and generic claims. Name the mechanism or the measured result.
- A trailing "-ing" clause that claims a result, such as "ensuring security". State the actual guarantee.
- "Not just X, but Y." State Y.
- Groups of three made for rhythm. Use the natural number of items.
- "Serves as", "stands as", and "boasts". Write "is" or "has".
- Em dashes. Use a period or a comma.
- Bold labels that repeat their line, and bold on ordinary nouns.
- Aphorisms, rhetorical fragments, and code written about as a person. Say what the code does.
- Shorthand with arrows, dropped articles, or missing verbs. Write whole sentences.
- Stacked hedges, filler such as "it is important to note that", and opening or closing pleasantries.
- Title case in headings and curly quotation marks.

## Examples

From a runbook:

> Before: Note that the engine binary may need to be rebuilt in cases where changes have been made to any of the crates.
>
> After: If you changed a crate, rebuild the engine through the rust-gate skill.

From a spec:

> Before: It's important to note that share-link permission scope validation logic is performed server-side, ensuring security.
>
> After: The server checks a share link's permission scope. The client never supplies its own.

From a PR body:

> Before: This isn't just a refactor, it's a fundamental shift in how sync works, delivering robust, seamless collaboration.
>
> After: Conflict resolution moves from the renderer to the engine, so two devices editing one document no longer race.

## Before you finish

When you revise, read the whole source first.
Leave code, identifiers, commands, and quotations unchanged.

You are done when:

- every fact, warning, command, and link from the source is still there;
- every number and claim matches the code as it is now;
- no sentence could appear unchanged in another project's docs;
- the text keeps the author's voice and sounds like a person who knows the subject.
