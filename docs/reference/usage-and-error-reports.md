# Usage and error reports

Official dohc releases send two kinds of reports to dohc's developers: usage
reports and error reports. Each has its own switch in **Settings > Privacy**,
and both start on. The first time a release could send a report (and once again
if a release expands what usage reports count), dohc shows a notice naming the
reports that release sends. It stays until you close it. No report leaves before
a notice has named its kind. If a notice named only one kind, a new notice names
the other before it leaves, for example when you turn its switch on. If both
switches are off, no notice appears until you turn one on.

## Usage reports

Usage reports count finished actions and reliability signals. They go to PostHog
(directly or through `https://dohc.computer/telemetry`). Failed sends retry with
backoff for up to 30 minutes and drop permanent errors immediately; turning
**Send usage reports** off aborts any send under way and drops the queue at once.

| Event | Sent when |
| --- | --- |
| `app_launched` | dohc starts. Carries bucketed workspace counts (`0`, `1`, `2-5`, `6+`), bucketed synced workspace counts, and whether agents are configured. |
| `app_active_heartbeat` | At most once per UTC day while dohc is running, on window focus or a tracked action. |
| `app_update_event` | An update becomes available, starts downloading, finishes downloading, starts installing, or fails (with the failing step). |
| `workspace_added` | You create a local workspace, open an existing folder, join a synced workspace, open a shared view, or mount a share. |
| `workspace_opened` | A window opens a workspace. Carries how it opened (`user`, `auto_restore`, `deep_link`, or `cli`) and the workspace kind (`local`, `synced`, or `received_share`). |
| `feature_used` | A core desktop action or automation succeeds. Carries its fixed capability ID and door (`renderer` or `automation`). |
| `tool_invoked` | A local CLI or MCP write tool completes, or any CLI or MCP call fails or is refused. Carries the door (`cli` or `mcp`), capability ID, outcome (`ok`, `error`, or `refused`), and duration in ms. Successful read calls are skipped. |
| `share_created` | You share with people, or create a share link. The event says which. |
| `app_published` | You publish an app. The event says whether it runs locally. |
| `chat_message_sent` | You send a chat message. |
| `crash_signal` | A window, GPU, utility, engine, or prior fatal main process crash occurs. Carries only the source and fixed reason, with its timestamp rounded down to the UTC hour so it cannot be matched to an error report. |

Each usage event also carries a random ID made for this installation, a per-event
UUID, `schema_version: 2`, the dohc version, release channel, package target
(`dist`), operating system name and version, processor type, and `server_kind`
(`none`, `drive`, or `self_hosted`). dohc asks PostHog not to build a person
profile and not to look up a location from the connection.

## Error reports

Error reports describe a problem dohc met. They also go to PostHog. A report
holds:

- the error's type, when it is one dohc knows;
- the error's message only when dohc wrote it from a fixed template;
  every other message reads `<message withheld>`;
- the places in dohc's own code where it happened;
- which part of dohc failed: the app, a window, the graphics process, or the workspace engine;
- the dohc version, release channel, operating system, processor type, and Electron version.

A report never holds the installation's random number. Each report carries a
new random number of its own, so it names nothing that links it to another
report or to usage reports. dohc asks PostHog not to build a person profile and not to look up a
location from the connection. dohc sends each distinct problem once per
launch, and at most 25 problems per launch.

## What reports never hold

Neither report holds file, folder, or workspace names, file content, chats,
prompts, links, account details, or paths outside dohc's own code. dohc
does not record your screen, your clicks, or its logs, and it sends no crash
dumps.

The crash report and diagnostics stay on this computer. A crash report leaves
only when you choose **Send report** and confirm in dohc's dialog.
**Settings > Privacy > Diagnostics** shows the same facts about this computer,
and you can copy them or save them to a file.

## Turn reports off

- Turn off either switch in **Settings > Privacy**. dohc stops the report
  under way and drops reports that are waiting.
- Or set `"privacy": { "usageReports": false, "errorReports": false }` in
  `dohc-settings.json`.
- Or start dohc with `DOHC_TELEMETRY=off` or `DO_NOT_TRACK=1` in its
  environment.

A development build, a test run, and a build without a PostHog project send
no reports.
