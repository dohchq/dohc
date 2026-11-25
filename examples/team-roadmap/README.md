# Team roadmap

A product manager owns one roadmap Collection. Engineering and leadership each use their own app on top of it. Nobody copies the data, and no app can do more than its owner approved.

It is ordinary workspace source. Copy the folder, then change the rules or the screens.

## What's in it

| Folder | What it is |
| --- | --- |
| [roadmap/](roadmap) | The Collection: `milestones` and `items` in [schema.sql](roadmap/schema.sql), ten operations in [operations.js](roadmap/operations.js), declared in [dataset.json](roadmap/dataset.json). |
| [roadmap-pm/](roadmap-pm) | The product manager's app. Add items and milestones, set priority and milestone, archive and restore. |
| [eng-triage/](eng-triage) | Engineering's app. Estimate new items, then start, finish, or reopen planned work. |
| [exec-rollup/](exec-rollup) | Leadership's app. Progress by status, milestone, and area. |

Each app keeps all of its source in its own folder, so each one publishes, shares, and changes on its own.

## The rules

An item moves `new` → `triaged` → `planned` → `in_progress` → `done`. The operations hold that order, whichever app or agent calls them:

- Engineering triages a new item before product can plan it. Triage records an estimate of 1 to 60 days and an optional note.
- Planning sets a priority from P0 to P3 and a milestone. Work starts only on planned items.
- Every change takes the item's `version` and refuses with `conflict` if someone changed it first.
- Archiving hides an item from every list and total. Its undo is `restoreItem`.
- Who requested, triaged, and last changed an item comes from the signed-in caller, never from the input.

## Who can do what

Two checks apply to every call. The app's binding in its `app.publish.json` lists the operations that app can ask for, even for the owner. The operation's access says who may run it: `owner` is the product manager, `helper` needs a data grant from the owner, and `link` is anyone who can open an app that binds it.

| Operation | Access | roadmap-pm | eng-triage | exec-rollup |
| --- | --- | --- | --- | --- |
| `listItems` | helper | ✓ | ✓ | |
| `rollup` | link | ✓ | | ✓ |
| `createItem`, `importItems`, `createMilestone`, `planItem`, `archiveItem`, `restoreItem` | owner | ✓ | | |
| `triageItem`, `updateStatus` | helper | | ✓ | |

So `exec-rollup` makes no writes and sees only totals, never titles, notes, or people. `eng-triage` can't archive or plan, even when the product manager opens it.

Some things to know before you share it:

- The product manager approves every app's binding. A teammate who edits an app's source can't widen what it reaches.
- A data grant belongs to a person, not an app. An engineer with a grant for `triageItem` can also call it from the CLI or MCP.
- `rollup` returns totals to anyone with a link to an app that binds it. Leave it out of an app's binding to keep totals private.
- Each change in the Collection's history records an opaque `caller_key`, a hash of the person and the app they used. To read who made a change, use the item's Requested by, Triaged by, and Changed by fields.

## Try it

1. Copy this folder into a workspace as `team-roadmap`, so the apps find `team-roadmap/roadmap/dataset.json`.
2. Publish `team-roadmap/roadmap-pm` and approve the Collection. Select **Load sample roadmap**.
3. Publish `team-roadmap/eng-triage` and `team-roadmap/exec-rollup`, and approve each binding.
4. Share `eng-triage` with each engineer by name. Then give each engineer's share a data grant for `listItems`, `triageItem`, and `updateStatus` with `dohc dataset setGrant`. `dohc dataset describe` lists the operation IDs.
5. Share `exec-rollup` with leadership. Share links don't get change events, so leaders select **Refresh** for the latest totals.

## Tests and benchmark

[team-roadmap-example.test.ts](../../packages/app-backend-runtime/src/team-roadmap-example.test.ts) runs all three apps against one Collection through the real host, worker, and QuickJS sandbox. It checks that changes from product and engineering show up in the rollup, that every operation outside an app's binding or a person's grant is refused without a history entry, and that each change records the person and app behind it.

The benchmark seeds 5,000 items and runs a mixed read and write load at 10 and 30 concurrent callers. It prints latency percentiles, throughput, and where the time goes: lane queue, host SQLite and JS, IPC, worker SQLite, QuickJS start, and guest code. It doesn't run in CI. From `packages/app-backend-runtime`:

```sh
pnpm bench:team-roadmap            # 2,000 operations per run at 10 and 30 callers
pnpm bench:team-roadmap 4000 1,10,30
```

To typecheck the apps, run `pnpm exec tsc --noEmit -p tsconfig.team-roadmap.json` from `apps/desktop`.
