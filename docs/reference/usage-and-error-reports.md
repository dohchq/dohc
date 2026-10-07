# Usage and error reports

Official dohc releases send two kinds of reports to dohc's developers: usage
reports and error reports. Each has its own switch in **Settings > Privacy**,
and both start on. The first time a release could send a report, a workspace
window shows a notice. It names the reports that release sends and stays
until you close it. Nothing leaves before a window shows that notice. If both
switches are off, no notice appears until you turn one on.

## Usage reports

Usage reports count a few finished actions. They go to PostHog.

| Event | Sent when |
| --- | --- |
| `app_launched` | dohc starts. |
| `workspace_created` | You create a workspace. |
| `workspace_opened` | A window opens a workspace. |
| `share_created` | You share with people, or create a share link. The event says which. |
| `app_published` | You publish an app. The event says whether it runs locally. |
| `chat_message_sent` | You send a chat message. |

Each event also carries a random number made for this installation, the dohc
version and release channel, the operating system's name, and the processor
type. dohc asks PostHog not to build a person profile and not to look up a
location from the connection.

## Error reports

Error reports describe a problem dohc met. They go to Sentry. A report holds:

- the error's type, when it is one dohc knows;
- the error's message only when dohc wrote it from a fixed template;
  every other message reads `<message withheld>`;
- the places in dohc's own code where it happened;
- which part of dohc failed: the app, a window, the graphics process, or the workspace engine;
- the dohc version, operating system, processor type, and Electron version.

A report never holds the installation's random number. dohc sends each
distinct problem once per launch, and at most 25 problems per launch.

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

A development build, a test run, and a build without report services send no
reports.
