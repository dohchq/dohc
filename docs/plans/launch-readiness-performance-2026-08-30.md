# Launch performance evidence

Reader: the person deciding whether this desktop build is ready to launch.

## Verdict

Performance is launch-ready for the measured desktop boundaries. Quick Open is
fast in the 15,000-file fixture; Explorer, graph, large Markdown editing, and
oversized Markdown reading now bound main-thread work; and fresh capture no
longer holds `workspace.open` until the complete History baseline exists.

Large first imports remain visible work. The release build opens a fresh
15,000-file workspace in a named `Importing` phase after 14.746 seconds and
reaches `Ready` after 77.226 seconds. The same workspace reopens ready in 815
ms. Operations that require a complete baseline return an explicit updating
response during import. This meets the run's named-work exception; it is not a
claim that a 77-second first import is the final performance target.
Plans below 1,000 Added files retain the strict baseline barrier, so ordinary
small workspaces do not pay the complexity of a partial-ready shell.

## Results

| Journey | Result | Evidence | Verdict |
| --- | ---: | --- | --- |
| Switch from the 15,000-file workspace to the 8,000-file workspace, before the fix | More than 120,000 ms without all readiness phases | Raw `workspace.open` deadline during fixture preconditioning | Fail |
| Open a fresh 5,000-file workspace, before the fix | 18,087.7 ms to the complete barrier | Exact gate-built binary; hardlinked fixture; capture enabled | Fail |
| Open a fresh 5,000-file workspace after the capture changes | 6,864.4 ms to named `Importing`; 16,153.1 ms to `Ready` | Packaged release sidecar; first/last reads pass before and after close; 256.4 ms ready reopen | Pass for the named-work boundary |
| Open a fresh 15,000-file workspace, before the fix | 181,888.9 ms to the complete barrier | Exact gate-built binary; hardlinked fixture; capture enabled | Fail |
| Open a fresh 15,000-file workspace after the capture changes | 14,745.8 ms to named `Importing`; 77,226.4 ms to `Ready` | Packaged release sidecar; first/last reads pass before and after close; 814.8 ms ready reopen | Pass for the named-work boundary |
| Open the 15,000-file control with capture disabled | 202.7 ms | Separates file listing/open cost from initial History capture | Diagnostic control |
| Expand a 5,000-file folder, before the fix | 2,407 ms to the complete tree | 5,004 mounted rows; seven long tasks; longest 732 ms | Fail |
| Expand that folder after fixed-height virtualization | 80 ms to the first child; 40 ms to focus an initially unmounted End target | 37 mounted rows after expansion; one 53 ms long task; 178 interactions over 10 seconds | Pass for the measured boundary |
| Quick Open across 15,000 paths | 0–1 ms from query to committed results for each of eight keystrokes | Renderer marks in `quickopen-graph.json` | Pass for the measured boundary |
| Build the graph before bounding the interactive set | 2,022 ms | 2,000 nodes and rows mounted; seven long tasks totaling 1,088 ms; 531 ms maximum | Fail |
| Build the bounded graph after the fix | 1,494-1,673 ms to ready across three runs | 240 promoted nodes and rows; 122-171 ms total long-task time; 66-78 ms maximum | Pass for the measured boundary |
| Drag in a 1,500-element Excalidraw scene | 161 pointer frames over 5,154 ms | Two long tasks; longest 88 ms | Observation; needs a frame-interval distribution |
| Open a 3 MiB Markdown document, before the fix | 341 ms to first read window | 32 later long tasks totaling 2,702 ms; longest 586 ms; more than 136,000 added DOM nodes | Fail for settled responsiveness |
| Open the 3 MiB document in the bounded viewer | 198.1 ms to settled viewer | 141 source descendants; 460 whole-page nodes; one 64 ms long task | Pass for the measured boundary |
| Treat that 3 MiB document as editable | The old profile waited 120,000 ms | Editing is deliberately capped at 2 MiB, so this was a profiler false pass | Invalid scenario; fixed |
| Type 30 characters in a 192 KiB Markdown document | About 26,986 ms; only 13 characters persisted | Retained smoke-run trace, screenshot, and fixture file | Fail; input loss |
| Type 30 characters in the hardened 250 KiB editable contract, before the fix | Only 9 characters persisted before the editor fell back to read mode | Hard assertion failed; UI reported "Couldn't save"; retained trace, screenshot, and truncated fixture | Fail; input loss |
| Type 30 characters in the 250 KiB CodeMirror source editor | 132.5 ms typing duration; 30 of 30 persisted | Edit enabled in 2.1 ms; two long tasks; longest 65 ms; saved durable result | Pass for the measured boundary |

## Evidence quality changes

The profiler now uses the default engine for large workspaces and records the
Git commit, dirty state, fixture hash, engine hash, desktop bundle hashes,
longest task, and Explorer expansion phases. It writes this envelope before a
scenario starts. A scenario failure no longer prevents later scenarios from
running or erases partial evidence; the final summary names missing scenarios
and remains an unsuccessful run.

## Remaining performance work

1. Keep reducing first-import latency. The launch fix makes the work explicit
   and nonblocking after a safe scan; it does not make 77 seconds desirable.
2. Reconnect the committed performance budget table to a candidate-build gate.
   The current profiles are diagnostic evidence, not the complete release gate.

The first-import path now batches capture writes, keeps mtime fences in hash
workers, indexes generation high-water reads, and avoids unnecessary FTS
deletes for brand-new moments. The safety layer releases only a proven fresh,
clean all-Added import of at least 1,000 files; smaller, existing, recovered,
migrated, unreadable-policy, or otherwise uncertain stores keep the strict
baseline barrier. Explorer, graph, and large Markdown no longer block launch
in this run.
