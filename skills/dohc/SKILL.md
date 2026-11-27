---
name: dohc
description: Build, edit, automate, and publish Collections, documents, data, chat, and small apps inside a local-first dohc workspace through the dohc MCP server or CLI. Use when working inside a dohc workspace or when the user asks to create or update dohc Collections, notes, automations, apps, or versions.
---

# Working in a dohc workspace

dohc keeps files, Markdown documents, structured Collections, automations, chat, and small web apps in one local-first workspace with History and Versions. Every user action runs through the same operations in the desktop app, the `dohc` CLI, and the `dohc` MCP server.

## Before your first call

1. Through MCP, `dohc_dataset`, `dohc_collection_access`, and `dohc_publish_app` fill in `workspaceId` for the workspace the server serves. The CLI needs it: read it from the `dohc://workspace/info` resource, `dohc_list_workspaces`, or `workspaceId` in `.dohc/manifest.json` at the workspace root. Never guess `"local"`.
2. Keep the dohc desktop app open for writes, Collections, apps, chat, and Versions.
3. For Markdown files (`.md`), use `dohc_create_document`, `dohc_read_document`, and `dohc_edit_document`. `dohc_write_file` refuses Markdown documents because live documents own their text.
4. For drawings (`.excalidraw`), use `dohc_create_drawing`, `dohc_read_drawing`, and `dohc_edit_drawing`. An open canvas shows each edit at once.

## Core building tools

The desktop MCP server registers over 75 tools, most of them for sync recovery, live-document quarantine, and sharing administration. Start with these core building tools:

| Goal | Primary MCP tool | CLI equivalent |
| --- | --- | --- |
| Recall context across pages, Collections, records, and chat | `dohc_search_workspace` | `dohc workspace search <query>` |
| Explore files | `dohc_list_files`, `dohc_read_file`, `dohc_search_files` | (use workspace files directly) |
| Write non-Markdown files (code, YAML, JSON) | `dohc_write_file` | (use workspace files directly) |
| Create, read, and edit Markdown documents | `dohc_create_document`, `dohc_read_document`, `dohc_edit_document` | `dohc document create\|read\|edit` |
| Create, read, and edit drawings | `dohc_create_drawing`, `dohc_read_drawing`, `dohc_edit_drawing` | `dohc drawing create|read|edit` |
| Work with document Collections (`collection.yaml`) | `dohc_query_collection`, `dohc_create_record`, `dohc_set_record_fields` | `dohc document set-fields` |
| Create, approve, migrate, and invoke transactional Collections (`dataset.json`) | `dohc_dataset` | `dohc dataset <verb> '<JSON>'` |
| Scaffold, stage, verify, and publish web apps (`app.publish.json`) | `dohc_create_app`, `dohc_publish_app` (in a workspace you own, `verifyFrontend` runs the app) | `dohc app <verb> '<JSON>'` |
| Import CSV/JSON and query SQLite | `dohc_import_data`, `dohc_query_database` | (MCP only) |
| Check and change Collection automations (`automations.yaml`) | `dohc_list_automations`, then edit `automations.yaml` with `dohc_write_file`. In a workspace shared with you at Edit, `dohc_switch_automation` turns one on or off | `dohc automation list\|switch` |
| Let a website form or another service add records to a Collection | In a synced workspace you own: `dohc_read_automation_host`, `dohc_use_server_for_automations`, then `dohc_create_incoming_webhook`. `dohc_list_incoming_webhooks` before you retry. See [references/automations.md](references/automations.md) | `dohc automation host\|use-server`, `dohc webhook list\|create` |
| Post or reply in Groups and file comments | `dohc_list_groups`, `dohc_start_group_chat`, `dohc_start_file_chat`, `dohc_reply_to_chat` | `dohc chat groups\|post\|reply` |
| Try changes safely in a Version | `dohc_create_version`, `dohc_compare_version`, `dohc_merge_version` | `dohc version create\|compare\|merge` |

## Choose the right data model

- **Document Collection (`collection.yaml` + `.md` records)**: Best for notes with typed properties (trip plans, tasks, specs) where each record also has a rich Markdown body.
- **Transactional Collection (`dataset.json` + SQLite + operations)**: Best for structured records, multi-table relations, capacity or business rules, public forms, and dynamic apps. Apps bind to approved operations on these Collections; apps have no separate private database.
- **Visible SQLite file (`dohc_import_data` + `dohc_query_database`)**: Best for quick one-off CSV/JSON imports and read-only `SELECT` analysis.

## Detailed references

Read the matching reference before authoring schemas, apps, or automations:

- [references/collections-and-datasets.md](references/collections-and-datasets.md): `collection.yaml` syntax, `dataset.json` (`formatVersion` 1 and 2) invariants, `dohc_dataset` action fields, custom `backend.ts` operations, schema migrations, bound-app drift checks, and public relation choices.
- [references/apps-and-publishing.md](references/apps-and-publishing.md): `app.publish.json` format (optional `inputs`/`packageMap`, named `operations`, multi-Collection `datasets`), built-in `@dohc/app-kit`, `dohc-app-channel` protocol, unified `stage`/`approveStaged`, local approval, and share-link publishing.
- [references/automations.md](references/automations.md): `automations.yaml` schema, triggers, steps, formulas vs. conditions, and message templates.

## Common pitfalls

- **`dohc_dataset` path field name**: `action: "prepare"` takes `descriptorPath`. Collection-scoped actions (`describe`, `invoke`, `prepareSchemaChange`, `prepareMigration`, `askToApply`, `prepareRelationChoices`, `createForm`, `history`, `permissions`, `lifecycle`, `archive`, `restore`, `deletePreview`, `delete`, `export`, `upload`, `file`, etc.) take `datasetPath`. Workspace-scoped and preparation actions (`list`, `create`, `approve`, `discard`, `approveMigration`, `discardMigration`, `migrationPreviewPage`, `cancelInvoke`, and recovery actions) omit both. Always pass the path ending in `dataset.json` (for example `"tracker/dataset.json"`), never the folder alone and never `datasetId`.
- **Approval arguments**: `dohc_dataset` `approve` takes `{ action: "approve", workspaceId, preparationId, revisionSha256 }` (read `revision.revisionSha256` from `prepare`; omit `datasetPath` and `sourceDigest`). `approveMigration` takes `{ action: "approveMigration", workspaceId, preparationId, revisionSha256, approvalDigest }` (omit `datasetPath`).
- **Bound apps after Collection migrations**: Migration previews (`prepareSchemaChange`, `prepareMigration`, `prepareRelationChoices`, `prepareHistoryRestore`) and `dataset permissions` list connected local and share-link apps in `boundApps` with `status` (`"compatible"`, `"needs-refresh"`, or `"incompatible"`). Omit `revision` and `revisionSha256` in `app.publish.json` so `prepareLocal`, `prepare`, or `stage` pins the current approved revision automatically. If an older app still pins `revision` and `revisionSha256` in `app.publish.json`, remove those two lines once before re-preparing and approving it. When editing a local app and its Collections together, use `dohc_publish_app` `stage` -> `approveStaged`.
- **File comments vs. Group posts**: To comment on a file, use `dohc_start_file_chat` (not `dohc_start_group_chat`). To check existing discussions on a file first, use `dohc_list_file_chats`.
- **Drawings**: Read before you edit, and pass each element's `version` as `expectedVersion`. A refusal means someone changed it: read again and retry. Send `requestId` so a retry never applies twice. Undo Run in History skips a drawing an agent created and any drawing open in an editor.
- **Versions**: `dohc_create_version` creates the copy and switches the workspace folder to it immediately. Edit files, run `dohc_compare_version`, then merge with `dohc_merge_version`.
- **Secrets and sharing**: Never include owner-only read operations in a public share-link app's `operations`/`operationIds`. Never read or copy secret files (`.env*`) into workspace apps or databases.
