# Launch performance evidence

Reader: the person deciding whether this desktop build is ready to launch.

## Verdict

Performance is not launch-ready yet. Quick Open is fast in the 15,000-file
fixture, Explorer stays responsive with 5,000 visible descendants, and both
contract-sized Markdown editing and oversized Markdown reading now meet their
measured durability and responsiveness boundaries. Fresh large-workspace
adoption remains the blocker.

The run used the product-default workspace engine. Earlier profiles disabled
it for the large-workspace scenarios and therefore could not expose the cold
adoption failure below. The failure happened while preconditioning the two
workspaces, before any warm cycle was measured.

## Results

| Journey | Result | Evidence | Verdict |
| --- | ---: | --- | --- |
| Switch from the 15,000-file workspace to the 8,000-file workspace | More than 120,000 ms without all readiness phases | The raw deadline is contained, but fresh adoption remains minutes long | Fail |
| Open a fresh 5,000-file workspace in the engine | 18,087.7 ms | Exact gate-built binary; hardlinked fixture; capture enabled | Fail |
| Open a fresh 15,000-file workspace in the engine | 181,888.9 ms | Exact gate-built binary; hardlinked fixture; capture enabled | Fail |
| Open the 15,000-file control with capture disabled | 202.7 ms | Separates file listing/open cost from initial History capture | Diagnostic control |
| Expand a 5,000-file folder, before the fix | 2,407 ms to the complete tree | 5,004 mounted rows; seven long tasks; longest 732 ms | Fail |
| Expand that folder after fixed-height virtualization | 80 ms to the first child; 40 ms to focus an initially unmounted End target | 37 mounted rows after expansion; one 53 ms long task; 178 interactions over 10 seconds | Pass for the measured boundary |
| Quick Open across 15,000 paths | 0–1 ms from query to committed results for each of eight keystrokes | Renderer marks in `quickopen-graph.json` | Pass for the measured boundary |
| Build the graph for 9,000 Markdown files | 2,022 ms | Full fixture, default engine | Observation; no accepted budget |
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

## Launch blockers

1. Make cold adoption of a large workspace finish History readiness within the
   named wait. The shell becoming visible is not enough. A production loading
   cover now prevents false interaction and raw deadline copy, but it does not
   make capture faster. The indexed high-water query removed a growing-table
   scan and passed its correctness gate; fresh 15,000-file evidence became
   slower, so the remaining capture pipeline still needs profiling and repair.
2. Reconnect the committed performance budget table to a candidate-build gate.
   The current profiles are diagnostic evidence, not the complete release gate.

Explorer and large Markdown are no longer blockers in this run. Their
full-scale profiles retain the required durable and keyboard behavior while
bounding work.
