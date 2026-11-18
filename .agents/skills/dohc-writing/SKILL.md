---
name: dohc-writing
description: >-
  Use when writing or editing prose in this repository: docs, specs, plans, PR bodies, commit messages, code comments, AGENTS.md, and skills. Also use when asked to rewrite or tighten text. For words inside the app, use dohc-interface.
---

# Writing for dohc

Write in plain and simple language.

- **Plain.** Everyday words and short sentences. Every sentence states a fact, an instruction, or a reason.
- **Exact.** Name the thing, the number, and the unit. Use only numbers you measured or can cite.
- **Understated.** Say what dohc does and let that fact make the claim. Back a superlative with evidence, or cut it.

Follow Orwell's six rules from "Politics and the English Language".

## Procedures

Write runbooks, skills, and the steps inside any document as controlled English, in the spirit of ASD-STE100: one instruction per sentence, the condition first ("If you changed a crate, rebuild the engine."), and a named actor. End a procedure with how the reader knows it worked.

Use this for steps only. Explanations, reasons, and notes keep their natural voice.

## Code comments

Write no comments. If code needs a comment to make sense, change the code: rename it, extract it, or give it a type.

Keep only these:

- Legal and license headers.
- Behavior forced by something we can't change, such as a dependency, platform, vendor, or protocol. A surprise in our own code is not one of these. Fix the code.
- Doc comments that define a public API contract.
- A link to an issue or RFC that explains a constraint the code can't express.
- Lint suppressions for a rule that is wrong for that line or only about style. If the rule protects correctness or safety, fix the code instead.

A long comment that justifies a workaround means the code is wrong. Words like `IMPORTANT` or "do not remove" don't make a comment a keeper. If a constraint matters, enforce it with a type, a test, or a lint rule.

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

> Before: We are pleased to confirm that the installation process has been successfully completed.
>
> After: dohc is installed.

> Before: Note that the engine binary may need to be rebuilt in cases where changes have been made to any of the crates.
>
> After: If you changed a crate, rebuild the engine with the rust-gate skill.

## Last pass

Cut hype words, "not just X, but Y", trailing "-ing" clauses that claim a result, lists of three made for rhythm, and filler such as "Here's the thing." Leave code, identifiers, commands, and quotations unchanged.

You are done when the prose is very easy to understand and 100% clear.
