# AI-native workspace positioning

dohc is not a builder-first document platform. The user does not need to
assemble tables, dashboards, formulas, and automations before useful work can
begin.

The user states intent. The agent reads the workspace, creates or updates the
needed files and views, and explains the result. The user reviews meaningful
changes and keeps ownership of the source.

## Product test

A core dohc feature should answer yes to these questions:

1. Does it help an agent build or maintain useful work?
2. Can a person inspect the underlying source?
3. Does the user control direction, approval, and ownership?
4. Does it reduce setup compared with a builder-first tool?
5. Does it work for one person before it depends on team adoption?

## Preferred primitives

- Markdown and ordinary files for durable source.
- Explicit links, paths, and metadata.
- Search, graph, history, and chat for context.
- Plugins and SQLite files for richer views and structured work.
- Diffs, moments, versions, and provenance for review.
- Host-enforced permissions for shared work.

The interface can be polished without making workspace state opaque.
