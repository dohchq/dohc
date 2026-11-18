---
name: dohc-writing
description: >-
  Use when writing or editing prose in this repository: docs, specs, plans, PR bodies, commit messages, code comments, AGENTS.md, and skills. Also use when asked to rewrite or tighten text. For words inside the app, use dohc-interface.
---

# Writing for dohc

Write in plain and simple language, with the calm, exact tone of good 1960s product writing.

- **Plain.** Everyday words and short sentences. Every sentence states a fact, an instruction, or a reason.
- **Exact.** Name the thing, the number, and the unit. Use only numbers you measured or can cite.
- **Understated.** Say what dohc does and let that fact make the claim. Back a superlative with evidence, or cut it.

Follow Orwell's six rules from "Politics and the English Language".

## Procedures

Write runbooks, skills, and the steps inside any document as controlled English, in the spirit of ASD-STE100: one instruction per sentence, the condition first ("If you changed a crate, rebuild the engine."), and a named actor. End a procedure with how the reader knows it worked.

Use this for steps only. Explanations, reasons, and notes keep their natural voice.

## Ice's words

Some text is Ice's own handwriting, such as "A note from Ice" in `AGENTS.md`. Leave it as written: fix typos only, and propose any other change in the PR instead of rewriting it.

## Code comments

Write the current constraint and what breaks without it. Leave the reviewer, review round, PR or issue number, and plan label to git and the pull request. Keep a link to another project's issue when it explains a workaround.

## House style

- Write "dohc" in lowercase, even at the start of a sentence.
- Use the terms in [`CONTEXT.md`](../../../CONTEXT.md). Repeat a term instead of switching to a synonym.
- Sentence case for headings, straight quotation marks, and the serial comma.
- Measurements as numerals with units, such as "120 ms".
- Use a period or a comma where you want an em dash.

## Examples

> Before: dohc is a blazing-fast, AI-native workspace that seamlessly brings all your work together.
>
> After: dohc keeps your work on your computer. It works without an account or a network connection.

> Before: Note that the engine binary may need to be rebuilt in cases where changes have been made to any of the crates.
>
> After: If you changed a crate, rebuild the engine with the rust-gate skill.

## Last pass

Cut hype words, "not just X, but Y", trailing "-ing" clauses that claim a result, lists of three made for rhythm, and filler such as "Here's the thing." Leave code, identifiers, commands, and quotations unchanged.

You are done when every fact, warning, command, and link from the source is still there, every claim matches the code or a cited source, and a reader would call it plain.
