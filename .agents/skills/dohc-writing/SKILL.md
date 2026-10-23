---
name: dohc-writing
description: >-
  Use when writing or editing prose in this repository: docs, specs, plans, PR bodies, commit messages, code comments, AGENTS.md, and skills. Also use when asked to rewrite or tighten text. For words inside the app, use dohc-interface.
---

# Writing for dohc

dohc shares its name with the double overhead camshaft, and its site shows a Jaguar XK inline six.
Write the way the engine makers of the 1950s and 1960s wrote about their work: formally, exactly, and without hype.

David Ogilvy's Rolls-Royce advertisement is the model: "At 60 miles an hour the loudest noise in this new Rolls-Royce comes from the electric clock."
One measured fact did all the selling.

## The voice

- **Formal.** Write complete sentences. Prefer "do not" to "don't". Leave out slang, exclamation marks, and emoji.
- **Exact.** Name the part, the number, and the unit. Use only numbers you measured or can cite.
- **Quiet.** State what dohc does and let that fact carry the claim. Back a superlative with evidence, or cut it.
- **Dry.** One understated line is welcome in a README or a PR body. Keep wit out of instructions and warnings.

## Instructions read like a workshop manual

For procedures, runbooks, skills, AGENTS.md, and product invariants, follow ASD-STE100, the controlled English written for aircraft maintenance manuals.

- Write one instruction per sentence, in 20 words or fewer.
- Put the condition first: "If you changed a crate, rebuild the engine."
- Name who acts: "The engine rejects the write."
- Write commands, and keep them literal.
- Give the reason for a rule that is not obvious.
- End a procedure with how the reader knows it worked.

## Everything else follows Orwell

For docs, specs, plans, PR bodies, and code comments, follow the six rules from "Politics and the English Language":

1. Never use a metaphor, simile, or other figure of speech you are used to seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, always cut it out.
4. Never use the passive where you can use the active.
5. Never use a foreign phrase, a scientific word, or a jargon word if you can think of an everyday English equivalent.
6. Break any of these rules sooner than say anything outright barbarous.

## House style

- Write "dohc" in lowercase, even at the start of a sentence.
- Use the terms in [`CONTEXT.md`](../../../CONTEXT.md). Repeat a term instead of switching to a synonym.
- Use sentence case for headings, straight quotation marks, and the serial comma.
- Write measurements as numerals with units, such as "120 ms".
- Use a period or a comma where you want an em dash.

## Examples

> Before: dohc is a blazing-fast, AI-native workspace that seamlessly brings all your work together.
>
> After: dohc keeps your work in ordinary files on your computer. It works without an account or a network connection.

> Before: Note that the engine binary may need to be rebuilt in cases where changes have been made to any of the crates.
>
> After: If you changed a crate, rebuild the engine with the rust-gate skill.

> Before: This isn't just a refactor, it's a fundamental shift in how sync works, delivering robust, seamless collaboration.
>
> After: Conflict resolution moves from the renderer to the engine. Two devices editing one document no longer race.

## Last pass

Cut what marks the text as machine-written.
That includes hype words, "not just X, but Y", trailing "-ing" clauses that claim a result, and lists of three made for rhythm.
When you revise, leave code, identifiers, commands, and attributed quotations unchanged.

You are done when:

- every fact, warning, command, and link from the source is still there;
- every claim matches the code or a cited source, and proposed behavior reads as proposed;
- the text sounds like a careful engineer describing work they are proud of.
