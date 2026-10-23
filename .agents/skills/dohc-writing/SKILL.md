---
name: dohc-writing
description: >-
  Use when writing or editing prose in this repository: docs, specs, plans, PR bodies, commit messages, code comments, AGENTS.md, and skills. Also use when asked to rewrite or tighten text. For words inside the app, use dohc-interface.
---

# Writing for dohc

Write in plain and simple language.

dohc's voice is tastefully formal.
It takes the calm, exact tone of good 1960s product writing and puts it in today's plain language.

## The voice

- **Plain.** Use everyday words and short sentences. Every sentence states a fact, an instruction, or a reason.
- **Exact.** Name the thing, the number, and the unit. Use only numbers you measured or can cite.
- **Understated.** Say what dohc does and let that fact make the claim. Back a superlative with evidence, or cut it.
- **Tastefully formal.** Write complete sentences. Outside instructions, use contractions where they read naturally. Each document may use one of these, if it fits: slang, an exclamation mark, or an emoji. Keep them out of instructions, warnings, and commit messages.

## Instructions follow ASD-STE100

ASD-STE100 is the controlled English of aircraft maintenance manuals.
Use it for procedures, runbooks, skills, AGENTS.md, product invariants, and any step inside another document.

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
> After: dohc keeps your work on your computer. It works without an account or a network connection.

> Before: We are pleased to confirm that the installation process has been successfully completed.
>
> After: dohc is installed.

> Before: Note that the engine binary may need to be rebuilt in cases where changes have been made to any of the crates.
>
> After: If you changed a crate, rebuild the engine with the rust-gate skill.

## Last pass

Cut what marks the text as machine-written:

- hype words;
- "not just X, but Y";
- trailing "-ing" clauses that claim a result;
- lists of three made for rhythm;
- filler sentences with no fact in them, such as "That's it." or "Here's the thing."

When you revise, leave code, identifiers, commands, and attributed quotations unchanged.

You are done when:

- every fact, warning, command, and link from the source is still there;
- every factual claim matches the code or a cited source, and proposed behavior reads as proposed;
- a reader would call it plain and simple language.
