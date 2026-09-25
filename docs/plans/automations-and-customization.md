# Automations, settings, and apps in the sidebar

Reader: Ice, who agreed the decisions below, and the agents who build and review this work.

Status: agreed with Ice on September 24, 2026, through a grilling session, and in progress. Nothing here is built except the removal of Agent chat. File and line references are to origin/main at 68cb8b315.

## Decisions

The session started from Ice's question: how easily can a person change dohc, and what happens to their change when dohc updates? It settled these:

- **Agent chat is gone.** PR #1231 removed the one built-in plugin. dohc does not provide or supervise people's agents (AGENTS.md commitment 5).
- **The plugin system goes.** Nobody outside dohc writes plugins, and the plugin an agent wrote in the tailor journey never installed. Apps are how people and agents extend their work. Plugins leave once automations have a new home, because plugins are the only place an automation can be declared today (`apps/desktop/src/plugins/pluginManifestSchema.ts:220-267`).
- **People change dohc's own parts in two ways:** a plain settings file, and apps pinned to the sidebar. Nobody rewrites a built-in part. Updates replace dohc's own parts and never touch a person's settings or apps, as Omarchy separates its defaults from `~/.config`.
- **Automations move onto Collections.** They should be as easy to set up as Notion's and as flexible as Supabase's.
- **dohc gets one place for notifications,** its existing Notices, which also holds things sent to a person.

## Part 1: Automations

### What an automation is

An automation is a rule on a Collection: one trigger, optional conditions, then steps that run in order. When someone sets a task's Status to Done, fill in "Finished on" with today's date. `CONTEXT.md` now defines **Automation** and **Personal step**. The builder labels the parts "When", "Only if", and "Do".

### What people see

- A ⚡ Automations button at the top of every Collection shows how many it has. It opens a side panel that lists each automation in plain words, such as "When Status becomes Done, set Finished on to today", with an on and off switch, Edit, Duplicate, and run history.
- A field that an automation sets shows a small ⚡. Hovering names the automation.
- A record's history names the automation for its changes, such as "⚡ Stamp the finish date".
- A **Button** field type shows a button on every record in the table and in the record view. Clicking it runs one automation for that record. The dataset "action" buttons that exist today (`TransactionalCollectionPage.tsx:276`) become buttons of this kind and learn which record was clicked.

Notion puts automations behind a ⚡ at the top of each database, and Airtable behind an Automations tab. Neither asks a person to open a file.

### Where automations are saved

Each Collection folder can hold `automations.yaml`, beside `collection.yaml` or `dataset.json`. People work in the panel; the file is where dohc saves what the panel shows. The file matters for three reasons: the work is a readable file the person owns and can export (commitment 1), any agent that edits files can read and change automations, and the file syncs and keeps history like any other.

A separate file beats a key inside `collection.yaml`. Dataset Collections have no `collection.yaml`. And `collection.yaml` treats any unknown key as damage that stops the schema editors (`crates/dohc-engine-domain/src/collections.rs:1139-1176`, `apps/desktop/src/renderer/collections/schemaWrite.ts:36-58`).

A sketch of the format. The first PR settles the real one.

```yaml
version: 1
automations:
  - id: finished-date
    name: Stamp the finish date
    when: { field-changed: Status }
    if: record.Status == "Done"
    do:
      - set: { "Finished on": today() }
```

### Triggers

| Trigger | Example | Builds on | New work |
|---|---|---|---|
| Record added | a sign-up arrives | engine claims (`crates/dohc-engine-domain/src/automations.rs:308-416`) | a bare record creation with no field history on a never-synced lineage claims nothing today (`automations.rs:326-332`) |
| Record changed, field changed, field set to a value | Status becomes Done | claims; field history has previous and next values | subscriptions match only a path prefix (`automations.rs:248-271`), and a claim carries no field facts |
| Record removed | a task is deleted | nothing | a claim when a record is deleted or leaves the Collection |
| Record starts matching a condition | Status is Blocked and Priority is High | field facts | compare the condition before and after each change; a condition on time, such as a due date passing, needs a schedule |
| Schedule | every weekday at 9 | nothing: no scheduler exists | a scheduler on the owner's main computer or server |
| Button | "Mark paid" on an invoice | dataset action buttons, which pass no record | the Button field type for both kinds of Collection |
| Message in a Group | "/task Buy tickets" | the dispatch scan cursor (`crates/dohc-engine-domain/src/chats/dispatch.rs:121-144`) | a claim on the computer that runs schedules, when it stores the message, whoever wrote it |

Automations fire only for document Collections today. Dataset Collections, which new Collections default to (`NewCollectionDialog.tsx:47`), need their commits to create claims too. Incoming webhooks come after launch.

### Steps

| Step | Builds on | New work |
|---|---|---|
| Change fields, with values from the record, the person, dates, and formulas | `collectionRecordEdits.ts:168-302` for documents; approved edit operations for datasets | formulas |
| Add, find, or change records in any Collection within reach | the same write paths | find queries across Collections |
| If, otherwise | nothing | branch evaluation |
| Notify people | the Notice Center, on this computer only (`NoticeCenter.tsx:199-255`) | Part 2 |
| Post in a Group or a direct message | main can post without a window (`chatDispatchService.ts:391-440`) | a third chat author kind, `automation`; `chat_messages.author_kind` allows only human and agent (`migration.rs:300`) |
| Wake your agent with an @mention (personal step) | the chat runner | dispatch accepts only human messages from this computer's person (`dispatch.rs:121-144`); also accept this person's personal steps, inside the same budget of 10 runs per 10 minutes (`chatDispatchService.ts:26-27`) |
| Run code | the QuickJS guest (`packages/app-backend-runtime/src/guest.ts:106-194`) | an automation API: the code receives the trigger facts and earlier results, and returns values and record changes; the executor applies the changes with the same checks as any other step |

A step that changes a dataset record invokes one of that dataset's approved operations. An automation never goes around a dataset's rules, which keeps the one enforcement path of the app data work (`docs/plans/unified-app-data-campaign.md`). The code step keeps the guest's limits: no network, 1 second of evaluation, 16 MiB of memory, synchronous only (`packages/app-backend-runtime/src/protocol.ts:17-29`). Sending a webhook comes after launch.

### Formulas

Formulas are simple JavaScript expressions, such as `record.Status == "Done"` or `dateAdd(today(), 3, "days")`, with a small set of helpers. They run in the sealed QuickJS guest. The builder writes them for people who do not code, and agents already know the language.

### Who can change an automation, and what it reaches (ADR 0012)

- An automation belongs to its Collection. Anyone who can edit the Collection can create, edit, duplicate, switch off, or delete its automations. Editing one is like editing a record: nobody takes it over.
- Today a person the work is shared with, even with Edit, changes live documents directly but sends every other file change as a change proposal (`CONTEXT.md` Change proposal; ADR 0002). `automations.yaml` is not a live document, so a collaborator's automation edits would arrive as proposals. Item 12 adds a direct lane for a Collection's own files under Edit.
- An automation reaches only what all its editors can reach. In a Trip folder shared with Ana, an automation can change records in Trip and post in Groups that the owner and Ana share. It cannot touch the owner's private Budget or wake the owner's agent. Nobody gains access by writing one, so nothing needs approval.
- A personal step uses one person's own reach, such as waking that person's agent. It shows that person, and only that person can change it. At launch, personal steps are allowed only in Collections that only their person can edit.
- The owner's computer holds more than a collaborator can reach, so its executor checks each step's target against the editors' common reach. It reads the editors from a local copy of the owner's grants, refreshed from the relay. A workspace that has never been shared has only its owner as an editor, so its automations run offline. For a workspace that has ever been shared, even one with no server connection now, when that copy is missing, damaged, or may be stale, the check fails closed: the run waits until the copy is current. Offline, the copy counts as current while no change from another computer has arrived since it was listed, because a new editor can affect this computer's automations only through changes that arrive by sync. A share the owner makes on another computer takes effect here at the next sync; until then, this computer's automations keep the reach they had.
- Sharing a Collection can narrow its automations' reach. The share dialog warns first, and steps that fall outside the new reach stop with a notice.
- Removing an editor can widen its reach. A step that was stopped and would now run waits until a current editor confirms it, so removing someone never switches on what they wrote.
- Deleting an automation removes it from the file, with Undo on the toast, and the file's history can restore it later. When someone switches off an automation you last changed, you get a notice.

### Where an automation runs (ADR 0008)

- On the computer where the triggering change happened, as today. When Ana changes a record, her computer runs the automation at once. Each change has one origin, so exactly one computer claims it for each automation.
- A claim can run more than once: after a crash, the engine runs it again, and Try again runs it again. Each step therefore takes effect once per claim, not once per attempt. The executor records each completed step and its outputs durably, and a retry resumes after the last completed step instead of re-evaluating it, so a step such as `Count + 1` never applies twice. Every write, added record, chat post, and notice carries an id derived from the claim, the automation's definition, the step's position, and the record and field it changes, so a write that landed just before a crash is recognized as done even when one step changes several records. A webhook, once it exists, is sent at most once.
- A button starts at once on the computer of the person who clicks it. Its steps write the way a hand edit writes: a Collection kept only on that computer works offline, and shared data needs what a hand edit needs, such as the configured host for a shared dataset (ADR 0010) or the session host for live editing (ADR 0003). When that is missing, the run waits and says so.
- A message in a Group triggers on the computer that runs schedules, for every message in the Group, so anyone in the Group can trigger it. That computer claims each message exactly once when it stores it.
- A schedule has no triggering change. It runs on the workspace owner's main computer, which by default is the owner's first computer to save an automation. With a self-hosted server or Drive, it runs on the server, so it keeps running while the owner's laptop is off. Advanced settings let the owner choose another computer.
- A schedule missed while its computer was off is skipped. When dohc next opens, a notice lists the skipped times and asks whether to run it now. No default suits every case.
- The self-hosted server does not run automations today. It runs live documents and the dataset host (`services/sync-relay/src/main.ts:231-233`), but no automation executor. This plan adds it, and a self-hosted server gets exactly what Drive gets (ADR 0009).

### Runs, failures, and undo

- Every run is recorded: the trigger, each step, the outcome, and the changes made. Today only failures can be read (`automations.rs:418-469`). At launch the record stays on the computer that ran the automation, because claims are local to that computer (ADR 0008). A failed run reaches the people involved through Notices, which sync (Part 2). A run history shared across computers comes after launch.
- A failed run leaves a notice with Try again. ADR 0008 promised a re-run, and none exists. Try again resumes after the last completed step, reusing earlier steps' outputs. If the automation was edited since the run failed, Try again is not a retry: it starts a new run of the edited automation from the beginning, which can repeat changes the failed run already made. The panel says so, and the person confirms before it runs. The notice stops telling people to "Open the plugin's source" (`NoticeCenter.tsx:106-133`).
- A run's changes to document records can be undone from its history (AGENTS.md: every reversible change gets a way back). A step that invokes a dataset operation can be undone only when the operation is marked reversible; the builder says so when a step uses an operation that is not.
- A record's history shows automation changes in the app. Today only the CLI and SDK show them (`desktopWorkspaceReads.ts:196`).
- A chain of automations stops at depth 4 and tells the people involved (`automations.rs:19-34`).
- An automation posting in chat shows its name and a third shape, beside round people and rounded-square agents. The interface work picks the shape with the dohc-interface skill.
- Agents work with automations through the file. The CLI and MCP add verbs to read run history and to try a run again.

### How it stays fast

The engine filters subscriptions by the kind of change and the fields, so a change that no automation watches costs nothing. The executor runs in desktop main, never in the renderer. Every PR that touches claims or record writes runs the packaged benchmark's `collection` scenario and the typing workload. A regression is a failed check.

## Part 2: Notices

dohc has Notices, a list of problems and finished tasks on one computer. It becomes the one place for everything addressed to a person. `CONTEXT.md` now defines **Notice**.

- Items sent to a person sync to all of that person's computers, like chat messages do.
- At launch, these send a notice: an automation's notify step, @mentions, a skipped schedule, a failed automation, a share sent to you, and a finished agent run.
- Notices stay inside dohc at launch. There are no system pop-ups, email, or phone alerts yet.
- The unified app data plan lists notification delivery as out of scope (`docs/plans/unified-app-data-campaign.md:310`). This plan takes it on.

## Part 3: Settings and apps in the sidebar

- **Settings file.** One plain file per computer that applies when saved. It covers the theme and colors, including the person and agent colors that people choose for themselves, the sidebar's order, hidden sections, and pinned apps, and the editor font and size. Keyboard shortcuts join once dohc has one command list that records each command's shortcut, which the app experience work is building. A setting the file does not recognize, or a value it cannot accept, turns off only that setting, and the rest of the file applies. Today the settings file is cached, and a hand edit applies only after a restart (`apps/desktop/src/settings/userSettingsStore.ts:60-83`). Syncing settings between a person's computers comes after launch, through a server connection.
- **Pin an app to the sidebar.** Any app can get its own icon in the left sidebar, beside Files and Search, and open in the side panel. The pin is personal. This replaces what plugin panels did (`apps/desktop/src/renderer/workbench/pluginActivityViews.ts:33-76`). The app still runs sealed off, with only the data its owner exposed.
- **Show that dohc can be changed.** Each part's ••• menu gets "Customize…", which opens that part's settings. A place that can hold an app offers "Add an app here…". Settings gets "Open settings file". Each of these can hand the job to the person's agent, with the right file named.

## Part 4: Remove plugins

After items 1 to 3 below land, remove the plugin host, the SDK's Node entry, the Plugins view and details page, plugin panels, plugin web apps, plugin automations, agent drivers with `AgentSessionManager`, and their docs and tests. Rewrite AGENTS.md commitment 8 and the "Tailor the workspace" example to describe apps, with no mention of plugins.

## Order of work

Each item is one or more pull requests with one concern. Each gets a review from a different model family and from Opus, and the gates `pnpm verify:plan` selects.

1. The file contract: `automations.yaml` with a version field, its parser, and validation.
2. The engine: subscription filters, change facts on claims, claims for new and removed records, and draining per executor. Rust gate.
3. The executor in main, with field, record, and branch steps, formulas, and the reach check, for document Collections. The ⚡ panel, run history, Try again, and Undo.
4. Remove plugins (Part 4).
5. Notices that sync to a person (Part 2).
6. Chat: the `automation` author kind, posting, the notify step, waking your agent, and the Group message trigger.
7. Dataset Collections: claims from dataset commits, and steps through approved operations.
8. The Button field type for both kinds of Collection.
9. The code step.
10. Schedules, including the server running automations and the skipped-schedule notice.
11. Settings file and sidebar pins (Part 3). This can run beside any item above.
12. A direct lane under Edit for a Collection's own files, `collection.yaml` and `automations.yaml`, and for creating a Collection inside a shared folder, with the provenance, grant checks, and restore that ADR 0002 required for live documents. It changes an authorization contract, so it needs a security review. Ice approved this item on September 25.

Items 5 to 12 can run in parallel once item 3 lands. The app experience work runs at the same time and changes the engine and the shell; coordinate with it before an item touches code it is changing.

## After launch

- Outgoing webhooks, with a sealed store for outside secrets.
- Incoming webhooks through the dohc server, with a security review. A workspace with no server connection cannot receive them.
- Personal steps in shared Collections.
- System pop-ups, email, and phone alerts for notices.
- Settings that sync between a person's computers.
- Email and named services such as Slack or Google.
