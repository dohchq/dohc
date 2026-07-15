# dohc — AI-native workspace positioning

This note captures the strategic difference between dohc and builder-first
document platforms such as Coda.

## Core thesis

dohc is not a no-code app builder where the user assembles dashboards,
databases, formulas, and automations by hand.

dohc is an AI-native workspace where the user remains the author, owner,
and decision maker, while the AI is responsible for building out the
documents, notes, apps, workflows, and views that make the work
usable.

The user should describe intent, review results, correct direction, and
approve meaningful changes. The system should do the heavy construction.

## Contrast with Coda

Coda's center of gravity is user-created apps in documents. It gives users
powerful primitives: tables, formulas, buttons, packs, automations, pages,
and dashboards. The user composes those primitives into the operating
system they need.

dohc's center of gravity is AI-created working context. It should give the
AI primitives that are easy to inspect, edit, diff, repair, and compose.
The user still has full agency, but the product should not require the
user to become a builder before they get value.

In short:

- Coda: the user builds apps out of document primitives.
- dohc: the AI builds useful docs, views, and workflows out of
  AI-friendly primitives, with the user in control.

## Product implication

Every major primitive in dohc should be designed for both humans and LLMs.
The product should not hide structure behind opaque UI state if a plain,
inspectable representation would make the workspace easier to understand
and easier for agents to maintain.

The preferred substrate is text:

- Documents are markdown or HTML atoms.
- Sketches and lightweight diagrams can be ASCII-first.
- Dynamic data uses readable, LLM-friendly syntax.
- Links and references are explicit.
- Search, links, recents, and explicit context atoms help agents gather
  context quickly.
- Generated views should be reproducible from source files and structured
  values.
- Important changes should be inspectable, reversible, and attributable.

The UI can be beautiful and polished, but the underlying workspace should
remain legible to a person reading files directly and to an agent planning
its next edit.

## AI-friendly primitives

dohc should prioritize primitives that help agents work reliably:

- **Plain-text atoms:** portable markdown and HTML files with stable IDs,
  titles, frontmatter, links, and source history.
- **Readable structured data:** inline atoms and structured declarations that
  can be read and written without guessing hidden UI state.
- **Agent navigation tools:** search, links, recents, source citations,
  and explicit context atoms that help the agent choose what to read next.
- **Source-backed apps:** dashboards, tables, graphs, and summaries that
  trace back to source atoms and declared data.
- **Inspectable workflows:** automations and routines expressed in clear
  text or structured files before they become UI behavior.
- **Agent-safe changes:** proposed edits, diffs, provenance, permissions,
  and review gates for anything consequential.

These primitives are not just features. They are the operating surface for
the AI.

## User experience goal

The user experience should feel like working with a calm, excellent
operator:

1. The user states what they are trying to accomplish.
2. dohc creates the first useful structure.
3. The user reviews, corrects, and approves.
4. dohc keeps the workspace organized as the work evolves.
5. The user can always inspect the source, understand why something
   exists, and take manual control.

The product should avoid making users start from a blank builder canvas
unless they explicitly want that level of control.

## Design constraint

dohc should not look or feel like an engineering console by default.
Technical power should exist, but it should be progressively disclosed.

Daily surfaces should feel:

- calm
- legible
- premium
- reliable
- friendly to non-engineers
- precise without being cold
- powerful without asking the user to configure everything

## Positioning sentence

dohc is the AI-native workspace that turns messy work into living,
inspectable documents, apps, and workflows.

## Product test

When evaluating a feature, ask:

1. Does this make it easier for the AI to build and maintain useful work
   on the user's behalf?
2. Can a human inspect and understand the underlying source?
3. Does the user stay in control of direction, approval, and ownership?
4. Does this reduce setup burden compared with builder-first tools?
5. Does this make dohc more distinct from Coda, Notion, Airtable, and
   automation builders?

If the answer is no, the feature may be useful, but it is not core to
dohc's differentiation.
