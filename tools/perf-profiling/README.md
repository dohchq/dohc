# Renderer profiling harness

## Measure a Windows release package

Use this workload when comparing release startup, editing, workspace switches, and idle cost.
It launches the packaged executable with isolated local workspaces and a new profile.
It does not rebuild the package, change Electron fuses, or enable a product test bridge.

1. Install the checkout's pinned dependencies before the measurement slot.
2. Prepare baseline and candidate packages with their build receipts.
3. Reserve an idle Windows host and exclusive access to its desktop. Use Node 24.16 or newer and PowerShell 7.
4. Run `node tools/perf-profiling/packaged-benchmark.mjs --help` for the options.
5. Run each package with a new output directory and its full build commit:

```powershell
node tools/perf-profiling/packaged-benchmark.mjs --binary C:/packages/baseline/dohc.exe --package-commit <full-build-SHA> --output C:/perf/baseline-1 --label baseline
node tools/perf-profiling/summarize-packaged-benchmark.mjs C:/perf/baseline-1
```

Use `--label candidate` for the candidate. Keep the workload settings identical. Alternate baseline and candidate runs.

To fail on a regression, run `node tools/perf-profiling/compare-packaged-benchmark.mjs <baseline-directory> <candidate-directory>`.
It writes `comparison.json` in the candidate directory and exits 1 when the candidate fails.
The candidate fails when:

- either receipt is incomplete, or the receipts differ in a setting other than `--find-cap` and `--write-cap`;
- the p95 of Collection open, typing on its own, or typing during an automation run exceeds the baseline's by more than 10% or 17 ms, whichever is larger;
- an automation case's median press-to-settled time exceeds the baseline's median by more than 25% or 17 ms, whichever is larger;
- an automation case has fewer than five runs on either side;
- a measurement the baseline has is missing from the candidate;
- any candidate automation case failed its own checks.

Contention cases, which type during the run, report press-to-settled with verdict `reported` and do not gate on that duration. Their typing-during-run check still gates on p95. Undersampled automation durations show `insufficient-runs`; missing measurements still fail.

Change the p95 margin with `--margin-percent` and the automation median margin with `--automation-margin-percent`. The defaults are 10 and 25. `--floor-ms` controls both floors, default 17. The comparison records all three values. The floor is one 60 Hz frame; these timings end at an animation-frame callback.

On this host, two three-run passes of the same main package failed 10 of 24 checks under the old p95 rule. Collection open and typing stayed within the margin. Finished-case medians agreed within 10% for 7 of 12 cases, but at-cap Finds varied 24 to 36%. Press-to-settled while typing varied 45 to 47%. With few runs, p95 is the slowest run, so one outlier decides the result. Use at least five runs per side for automations and alternate baseline and candidate runs.

An automation case is compared across receipts only when its fixture digest matches: the same records, steps, and expected outcome. A case whose fixture depends on `--find-cap`, or whose expected outcome changed with the limits, is checked only within the candidate.
Use `--engine-commit <full-SHA>` when a diagnostic package has a separately built engine.
The receipt records executable, ASAR, engine, harness, and helper hashes separately from the harness checkout commit.
Output directories cannot be reused. Failure logs and fixtures remain available for diagnosis.
Cleanup closes the recorded app and helper; failed startup and shutdown also terminate their owned process trees.
Ctrl-C and SIGTERM cancel pending launch or idle work, stop owned processes, and preserve the failed-run receipt.

The Collection scenario defaults to five runs; other scenarios default to three. Set `--runs` to override the default.
The default workload uses three fresh/restart cycles, 100-paragraph rich editing, 5,000-paragraph source editing,
30 trusted keystrokes per document, ten switches, and 60 seconds each of visible and minimized idle.
`--files 5000 --scenario switches` adds deterministic flat files; the two editor documents count toward each workspace's total.
Fixture receipts contain file counts and content/name digests. Other scenarios are `startup`, `small-switch`, and `small-tab`.

The palette, search, Collection, and soak scenarios launch once per run. `chat-history` launches twice: once to seed,
then a restart to measure. Each palette, search, chat, and Collection timing starts when the renderer receives the
trusted keydown or mousedown. It ends at the first animation-frame callback after the predicate matched, so within
one frame of the paint that first shows the surface. That callback runs before the paint when the match came between
frames, and one frame after the paint when the match came during a frame. The observer checks the predicate at
installation, on DOM mutations, on focus changes, and in every animation frame, so a change without a DOM mutation is
seen within one frame. `matchedIn` records which check saw the match: `install`, `frame`, `mutation`, or `focus`.
The end rule is the same for all four. Visible means the first frame where no ancestor computes to opacity 0; a palette
entrance animation counts from that frame, and `entranceAnimating` records whether it was still running. The harness
wall time sits beside each timing in the receipt.

- `--files 5000 --scenario go-to`: Ctrl+P to a focused Go to input, then `fixture-004242` one keystroke at a time, then a warm reopen. Each keystroke ends when the input echoes the prefix and the first ranked row contains its characters in order. The summary calls this `keystrokeToFirstMatchPaintedMs`; it does not check the other rows, so it is not a full re-ranking time. After the last keystroke the first ranked row must be `fixture-004242.txt`.
- `--scenario command-palette`: Ctrl+Shift+P to the first command row, then a warm reopen. Every palette close first waits until no animation runs on the palette or its ancestors. Go to's typing already outlasts the entrance animation; the wait gives the command palette's warm reopen the same settled start.
- `--files 5000 --scenario search`: the Search rail button to a focused input, then `fixture` and `fixture 4242.` submitted with Enter, each to its first result row and to the complete state.
- `--files 5000 --scenario go-to-mixed`: runs the same Go to samples after provisioning the admitted mixed-kind workload through a dedicated test relay. This arm signs in and relaunches. Use the signed-out `go-to` arm for Pass A comparisons.
- `--scenario chat-history [--chat-messages 200]`: seeds one #general post and its replies through `packages/cli/bin/dohc.js` against the running package, restarts, then opens the channel to its post card and the thread to its first and to all comment rows. One observer carries both comment milestones from the same click.
- `--scenario collection [--records 500] [--find-cap 50] [--write-cap 200]`: seeds `records/collection.yaml` and Markdown records with pre-minted ids, waits for the Explorer to mark the folder as a Collection, then opens it to the first table rows. It then runs the typing workload in `small.md`, then the automation phase described below.
- `--scenario soak [--soak-minutes 10]`: repeats a mixed cycle (open both documents, Go to typing `small`, command palette, search for `Performance`, two switches) until the time is up and records working set and private bytes per process kind after each cycle. Each cycle records its search query. The document-open and switch timings are the existing harness wall-clock observations.
- `--scenario soak --soak-minutes 60 --heap-snapshot-minutes 10,60`: also captures renderer heaps at the first completed cycle boundary at or after each requested minute. Minutes must be distinct positive integers within the soak duration. Capture is off by default.

Heap capture waits until both workspace switches finish, leaving workspace 0 selected with no workload step running.
The renderer pauses while HeapProfiler collects and streams the snapshot. The next cycle starts after the file closes.
Each run directory holds `renderer-heap-10m.heapsnapshot` and `renderer-heap-60m.heapsnapshot` for this example.
Incomplete files keep a `.partial` suffix.
Each capture receipt records its boundary `cycle`, requested and actual elapsed times, byte count, status, and `pauseMs`.
The soak receipt and summary also report total `heapSnapshotPauseMs`. Capture pauses are outside measured cycle durations.

`go-to` and `search` reject `--files` below 4243, because their queries name `fixture-004242`.
`go-to-mixed` requires at least 5,000 files to include generated sources and that target.
Search waits for the Explorer to list every fixture file before it submits. A sample whose search id changed before Enter is flagged `debounceFiredBeforeSubmit`.
With an engine capture, search queries the engine index and returns at most 50 results in one batch, so `limitHit` false does not mean the results are complete. `sawUpdating` records whether the view passed through updating, whose retry backoff lands in the settled time.
Chat seeding runs `seed-chat-cli.mjs` through `scripts/verification/process.mjs`. The packaged benchmark throws unless it runs on Windows, so seeding always runs in that runner's job object. The job kills every descendant when the harness-owned job owner exits, including a CLI worker whose launcher exited abnormally. Each CLI call times out after 60 seconds. Each message still runs two Node processes, the launcher and the CLI. Output returns only after both pipes close. The receipt hashes `packages/cli` bin, src, and package.json, the seed script, and the runner. The thread comment list is not virtualized, so every reply renders.
The Collection table is virtualized and pages on demand: `rowsRendered` is the visible window and `loadedRecords` is the first page.

The automation phase measures Collection automations in both kinds of Collection. It writes `automation-bench/` to disk, as an agent would, and creates the generated dataset `automation-data/` through the checkout CLI. `dataset-cli.mjs` calls the CLI's own `executeCli` in one process and runs in the same job object as chat seeding. Each Collection has a trigger record, one Button field per case, and one automation per case in `automations.yaml`. Only a press starts a run, so seeding starts none. The cases:

- `baseline`: one Find of 50 records, then 4 fields on each, 200 assignments.
- `find-500`: one Find of 500 records, then 2 fields on each, 1,000 assignments.
- `five-finds`: five Finds of 100 records each, overlapping by 50, then 2 fields on each, 1,000 assignments.
- `set-then-find` and `add-then-find`: a Find after a Set or an Add. `visibility` records whether the later Find saw the earlier step's change (`stepwise`) or the records as they were when the run started (`run-start`).
- `find-at-cap` and `find-over-cap`: a Find of exactly `--find-cap` records and of one more.
- `wide`: 50 records with 4,000-character notes, about 200 KB of formula scope, set to a 3,900-character literal.
- `baseline-typing` and `find-500-typing`: the baseline and 500-match cases again, with the typing workload in `small.md` while they run. A case expected to finish fails when no keystroke arrived between the press and the settle text.

`--find-cap` and `--write-cap` name the limits the package under test enforces; they default to the current ones. A case over either limit must be refused with the executor's limit message and leave every record as seeded. Any other case must finish with every record at its expected value, read from the settled Markdown or through the dataset's approved list operation. A case that does neither fails the run. Pass the candidate's limits to measure a package that raises them.

Before the first document case, the harness scrolls the table until it holds every record, so no Find runs before the engine indexed the records it wrote. Before each press, the harness dismisses the shown toast and waits until main and the engine use under 5% of one core for three consecutive intervals of at least one second. The settle text counts only inside the toast stack or the Notices panel. A press that does not settle within five minutes fails the run.

Failed runs settle on main's `Automation "<name>" failed` Notice, including document and dataset refusals. Their settle time ends after main reports the failure. Failed and refused settle times are not comparable with receipts from before #1562. Recovery failures also match `Automation "<name>" did not finish` and `Automation "<name>" switched off`. A press that fails before starting still matches `<field> did not start.` Successful, skipped, and ended runs keep their renderer settle texts.

After a failed settle, the harness reads main's Notice list through the preload bridge, without opening the Notices panel. It selects a failure Notice whose id was absent before the press, scoped to the workspace, Collection path and automation. This distinguishes document and dataset Notices with the same title. `reason` records that Notice's body. When no Notice matches, it records the observed settle text, up to 500 characters. Verification and `journal.runs` use only this press's saved run. A failed settle counts as `refused` when the Notice body matches an executor limit message. A failure with no limit message stays `failed`.

Each case records:

- the time from the trusted mousedown to the first animation-frame callback after the settle text appeared;
- `startMs`, from that mousedown to the run header's `startedAtMs`, which the executor sets when it creates the run, before any Find. It covers the press, the claim and loading the automation;
- `runMs`, from `startedAtMs` to `finishedAtMs`, which covers every Find, formula evaluation and write;
- `findMs`, the sum of saved steps' reads and Finds, and `planMs`, their planning and formula evaluation;
- `writeMs`, the sum of saved effects' application times, and `writes`, their completed application count. One Set effect can change several fields on one record. Kept or skipped results still count as completed applications;
- `appendMs` and `appendCount`, the sum and count of measured effect-result appends, including opening, appending, flushing and closing the progress file;
- the saved run's header and progress bytes, and the header's sampled peak;
- CPU per process kind until the run settles. The formula evaluator runs on a worker thread in main, so its CPU is part of main CPU;
- sampled peak memory per process kind, and renderer long tasks until the settle text painted.

Stage times use the executor's clock. Step lines carry `findMs`, `planMs`, `appendMs` and `appendCount`; effect lines carry `writeMs` and `writeCount`. Reads include acquiring read access and checking permissions. Append totals measure the executor's awaited `appendEffect` call, including store queueing and filesystem checks. The existing final save persists them. Run setup and step saves remain outside stage totals. Created-record and replan lines saved during effect application count toward `writeMs`. Timing adds no journal writes or flushes.

Append timing stays missing if a resumed step has effects whose append timing was not saved, or if its count does not cover every saved effect. A measured step with no effects has zero append time and count.

A run refused before saving its first plan leaves its times and count missing. A later refusal retains measurements only for saved stages. Older journals without timing fields, and totals with an unmeasured saved stage, stay missing. The summary reports sample count, p50, p95 and maximum for each metric. Snapshots come about once a second, so a short memory or header peak can be missed.
Soak growth includes allocator and garbage-collector timing. It is not a leak proof.
A chat lane with a long history has no seeding path outside the product UI or the engine daemon, so the benchmark does not measure it.

Startup waits for a naturally visible app window and editable DOM, then two animation frames.
Observed latency includes CDP, window verification, and scheduling. Window verification is not subtracted.
`spawnedObservedMs` includes synchronous spawn and receipt writes; it is not OS process birth.
Native launch marks start at module evaluation. Renderer paint timestamps are aligned with the harness spawn wall clock.
Workspace-switch phases come from production performance entries; external click-to-editable observations remain separate.

Only reported Chromium EventTiming durations are called input-to-next-paint. The reporting floor is 16 ms;
missing samples stay missing, including when no typing workload ran. Trusted CDP input excludes physical keyboard delivery.
Idle counters cover observed descendants and match PID plus creation time. IO counters are not physical disk traffic.
Context switches and hardware wakeups are unavailable. Minimized idle does not represent every background or power state.
The loopback updater feed advertises no installable update. Fresh profiles do not imply a cold OS cache.
The app receives no inherited `DOHC_*`, `NODE_OPTIONS`, or `ELECTRON_RUN_AS_NODE` settings.
Only the controlled loopback `DOHC_UPDATE_URL` is added.

`--profile-renderer true` records diagnostic switch CPU profiles.
`--profile-main true --scenario startup` requests V8 startup logs and requires an output path without whitespace.
Main profiling must produce a log matching the recorded main PID.
CPU-profiled runs and `--heap-snapshot-minutes` runs are marked diagnostic in summaries.
The comparison command refuses diagnostic runs. Use separate uninstrumented soaks for the memory budgets.

Run `node --test tools/perf-profiling/packaged-benchmark.test.mjs` for CLI, lifecycle, fixture, and summary checks. The fixture contract check imports the automation executor, so build `@dohc/app-backend-runtime` first, as the JS gate does.
These tests also run through the canonical root test command. They do not launch the GUI workload.

This harness profiles the desktop renderer on seeded workspaces. Its six
scenarios measure:

- `switch-profile`: ten workspace switches after both workspaces are ready,
  as a phase timeline with median and p95 offsets.
- `explorer-profile`: expanding a 5,000-file Explorer folder, to first child
  and to the complete tree.
- `quickopen-graph`: eight Quick Open keystrokes and Graph construction.
- `excalidraw-profile`: pointer-frame dragging in the 1,500-element scene.
- `bigdoc-profile`: opening, typing in, and saving the 250 KiB document.
- `bigdoc-read-profile`: a settled read of the 3 MiB Markdown document.

The reader is the next agent preparing a scheduled profiling run.

## Measure document-size limits

This is PR 1 of 5. It measures the decision without changing a product limit.
Prepare the release package and its matching relay checkout before the booking.
Run pnpm --filter @dohc/app-backend-runtime build in that checkout.
Keep any diagnostic content/SQL/state raise in a disposable checkout; preserve its patch and build receipt.
Native ingress, worker and process memory budgets stay unchanged.

Calibrate the estimate with a packaged pilot first. It runs one size, four pairs per shape, the relay and a one-minute soak:

~~~powershell
node tools/perf-profiling/packaged-benchmark.mjs --binary <release.exe> --package-commit <SHA> --output <pilot-directory> --label candidate --scenario document-size --document-mode pilot --document-mib 2 --runs 4 --keystrokes 60 --soak-minutes 1
node tools/perf-profiling/summarize-packaged-benchmark.mjs <pilot-directory>
~~~

Read `documentSize.timing` in the summary. `pairMs` covers pairs 1 to 3 with peer and churn arms and lean pair 4.
`relayCaseMs` is the relay work per case, and `seedMsPerValidation` is the seeding wall time per validation across both workers.
Treat `seedMsPerValidation` as a lower bound. Each validation replays the whole suffix, and cut reads and commits run serially on the relay's main thread.
The pilot seeds to 452 entries; the full run seeds to 3,855, about 1,930 on average.
Scale the pilot's cost by suffix length with each relay case's `seed.windows`, which record suffix, CPU median and wall time per 128 seeds.
Relay and seed costs also grow with document size, so 2 MiB values understate larger sizes.
Also read each phase's `rate` and the soak's `compactionTimings` against its `compactions`.
The pilot reaches no checkpoint and never stops seeding. Pilots cannot choose a limit.

Run the full benchmark from the harness checkout on an admitted idle Windows host.
Run the baseline first. The candidate's `--baseline` names the baseline's output directory:

~~~powershell
node tools/perf-profiling/packaged-benchmark.mjs --binary <baseline.exe> --package-commit <SHA> --output <baseline-directory> --label baseline --scenario document-size --document-mib 2,5,8,10 --runs 20 --keystrokes 60 --relay-sessions 1,2,4 --updates-per-second 8 --churn-edits 100000 --soak-minutes 60
node tools/perf-profiling/packaged-benchmark.mjs --binary <release.exe> --package-commit <SHA> --output <candidate-directory> --label candidate --baseline <baseline-directory> --scenario document-size --document-mib 2,5,8,10 --runs 20 --keystrokes 60 --relay-sessions 1,2,4 --updates-per-second 8 --churn-edits 100000 --soak-minutes 60
~~~

Use --relay-checkout <path> or --engine-commit <SHA> when those inputs differ.
The candidate decides its 2 MiB extensions and early stops against the baseline receipt, and records that receipt's hash.
Summarize each result.json, then run compare-packaged-benchmark.mjs <baseline-directory> <candidate-directory>.
The comparison is inconclusive when the candidate recorded another baseline receipt.
The receipt hashes sources, packages, engine, schema, fixtures and harness, and saves the relay patch.
Full and soak remain separate release requirements; other scenarios keep their settings comparison rules.

Book **six hours per package**. The uncalibrated normal estimate is **5.1 hours**:
115 minutes for 106 lean GUI pairs at 65 seconds, 5 for controls, 26 for seeding,
90 for the other relay and fixture work, 60 for one soak and 10 for setup.
Seeding is 61,680 validations, 30,840 per worker, at the 50 ms CPU budget.
A size whose fresh separate arms exceed that budget stops before it seeds.
Seeding itself stops once a 128-seed window after the first has a CPU median over that budget.
These stops bound worker CPU, not main-thread wall time.
An extension adds 18 to 33 minutes, at most one per size.
A fallback soak adds 60 minutes. It fits only when the calibrated normal run is under five hours.
The six-hour deadline aborts owned work and marks unfinished evidence inconclusive. It never grants a size.
Baseline runs only the 2 MiB relay/churn/soak arms, plus three GUI refusal pairs per larger shape,
about three hours. This saves baseline work without treating a refusal as performance evidence.

| Work | Gate configuration | Confidence cost |
| --- | --- | --- |
| Sizes | All 2, 5, 8 and 10 MiB, exact UTF-8 including frontmatter. | No size interpolation. |
| Shapes/pairs | Formatted-retained: ten 2 MiB control pairs, twenty at each larger size. Other shapes: three pairs each. | Twenty-pair p95 is second-slowest; ten-pair p95 is slowest. Shape proofs have weak tail power. |
| Extension | An arm whose planned-pair open, first-key or typing p95 is within 10% of its limit gets more pairs right away: shapes to twenty, the worst shape to forty. At most one arm per size, the first in run order. The comparator repeats the decision with the same control. | 17 to 30 more pairs. Twenty-pair p95 is second-slowest and forty-pair third-slowest, not distribution-free bounds. |
| Stops | After each case, a candidate checks it as the comparator does. A failed or missing check ends the run, because no larger size can be chosen. A stopped run first finishes its forty control opens in fresh launches, so a smaller passing size stays choosable. In the relay, a failed separate arm or separate CPU over budget skips the case's later arms and churn. Seeding stops once its CPU median exceeds the budget. | Larger sizes stay unmeasured once a smaller size fails. |
| Correctness | Export/history in the first three fresh/restart pairs; full durable hash every pair. Three peer/churn renderer arms per shape. | Rare correctness failures have less repetition. |
| Controls | Forty 5,000-paragraph opens and forty with 500 distinct local links, pooled once across fresh launches. Startup pools all launches. | One pooled control across forty fresh launches; no per-size control gate or variance estimate. |
| Relay | Independent of GUI pairs: 240 updates/session for separate 1/2/4 and shared 4, on the worst shape at every size. Other shapes get separate/4 and native separate/1 proofs. | One independent worker/storage launch per arm; update percentiles do not estimate run-to-run GC/JIT variance. |
| Long suffix | Worst-shape separate/4 seeds 3,855 production-validated commits into each document, across both workers. Its timed updates see suffixes of 3,855 to 4,094 entries, the longest the journal allows. Separate 1/2 and shared 4 start fresh; separate/4 bounds their CPU, wait and slot at that suffix. | Seeding is unpaced and excluded from latency statistics. CPU p50 is a long-suffix median, an upper bound on the steady state; mid-suffix updates are not sampled. Shared latency remains diagnostic. |
| Checkpoints | Each separate/4 document's last timed update commits the real 4,095th entry and its checkpoint. Unit-test both count and 20 MiB suffix-byte triggers. | Byte-trigger timing is not measured: a large artificial update would change the workload. |
| Churn | Exactly 100,000 edits, eight client IDs; exact state-ceiling crossing search capped at one million, then censored. Replay churned separate 1/4 and shared 4; other shapes separate 1/4. | No decision loss from censoring beyond required headroom. Churned relay samples have short suffixes; the seeded separate/4 arm covers long-suffix replay cost. |
| Joins | Separate/1: worst shape has twenty native and twenty named/link socket joins across fresh/restart; other shapes have six native and twelve socket proofs. Real restore once per shape. | Join tail has twenty samples. Restore/ACK/native-drain latency is diagnostic, not an unapproved gate. |
| Soak | One sixty-minute formatted-retained soak starting at 100,000 edits at the largest otherwise-passing size; next size down if it fails. At most two hours. | Smaller sizes and other shapes rely on rising memory cost; there is no independent sixty-minute sample for them. Two failures leave no qualified raise. |

Long paragraphs exceed 700 bytes so normal fixtures retain node headroom at 10 MiB.
Separate 120-byte paragraph/list/table probes enter the real relay validator and report their admission/refusal and node/depth counts.
Native admission is exercised when the relay accepts. Rust exposes no node-count metric; the harness does not invent one.

A second production IPC session stays connected to the GUI's canonical engine Y.Doc for the peer control.
Another arm applies 100,000 CRDT replacements through that session before GUI open/typing.
This measures renderer fan-out and churn; named/Edit-link network peers are covered separately by real socket/provider probes.
Trusted selections alternate beginning/middle/end. Preparation waits two frames after scrolling.
Key timing starts at event.timeStamp and ends in a MessageChannel task posted from rAF, including queue and layout/paint opportunity.
Edit activation is separate; edit-ready is first content plus activation, excluding Playwright's scheduling gap.
Total click-to-editable remains diagnostic. History/export use the ordinary bridge and Copy as Markdown.

The relay uses production SQLite, authority, journal/checkpoint code and two real workers with a **512 MiB hard old-generation limit**.
Each relay arm runs in a fresh owned process, excluding earlier proof/churn allocations. Fixture Y.Docs live in a separate owned process with independent client IDs, including shared-document peers.
Proof clients allocate only after timed samples finish. Private bytes gate on the relay PID only. The process inventory separately reports native and generator memory.
Native draining happens after the measured admission loop; it cannot throttle offered validation load.
The scheduler offers eight updates/s/session and records achieved rate, queue lag, worker CPU, wait, slot and occupancy.
Boundary/25 ms worker heap samples can miss brief peaks. Exclude final heap sampling from occupied time.
A five-second asynchronous process sampler replaces one-second pwsh launches; its cost is recorded.
GUI memory and history probes run independently of typing.
The engine compacts a document once 64 updates are pending past its snapshot.
Only the soak times compaction. The soak gates its edit rate, not typing latency, and arms that gate typing latency never wait on the engine.
Before each soak key, the harness reads the edited document's head.
In the last four keys before the threshold, each key waits for an append, so the harness finds the key that crossed it.
Compaction timing starts at that key's dispatch and ends when the new snapshot is visible.
If the editor's saves trail by four keys or more, a key can cross the threshold without waiting, and that compaction has no timing; the half-coverage rule then fails the soak. If they trail by fewer, the append a key waits for can be an earlier key's, so timing starts a key late and leaves out part of the save delay. Compare `compactionTimings` with `compactions` after the first soak at 10 MiB.
A detached 5 ms poll times it while typing continues, so compaction neither stalls the soak's rate nor goes untyped.
The soak's compaction check needs a timing for at least half of the observed compactions.
A 60-key arm spends most of each 125 ms key on CDP round trips and frame waits, so its rate measures the harness.
A longer arm keeps the same per-key cost, so 60-key arms report their rate and the soak gates it. Latency samples do not depend on the rate.

| Gate | Budget |
| --- | --- |
| Relative comparisons | Each records baseline, spread and margin. Allow max(10% of control, 17 ms, control p95 minus p50). Candidate variability never enlarges its own allowance. |
| Startup; 500-link open | Matching package baseline with that margin. Startup p50; links p50/p95. |
| First key/typing | 2 MiB versus matching baseline; larger sizes versus this package's matching 2 MiB solo/peer/churn control. Same margin at p50/p95 for solo and p95 for peer/churn. |
| 5,000-paragraph control | Open p50/p95 <=487/532 ms, measured once. |
| 2 MiB first content; edit-ready | p50/p95 <=487/532 ms; 750/1000 ms. |
| 5 MiB first content; edit-ready | 750/1000 ms; 1250/1500 ms. |
| 8 MiB first content; edit-ready | 1000/1250 ms; 1750/2000 ms. |
| 10 MiB first content; edit-ready | 1250/1500 ms; 2250/2500 ms. |
| Achieved edit rate | >=456 edits/min over the soak and >=7.6 updates/s per separate relay session. 60-key arms report their rate. CPU and recorded writes normalize to 480 edits/min. |
| Renderer private bytes | <=435 MB at ten minutes; <=477 MB at sixty minutes and sampled peak. |
| Relay update | CPU p50/p95 <=50/100 ms; wait/slot/backlog <=100 ms; two-worker occupancy <=80%. Shared latency is reported. |
| Relay memory | Worker sampled heap <=384 MiB; 512 MiB hard limit. Relay PID private plus restore reservation <=1 GiB. |
| Restore reservation | Actual framed R; native reservation <=512 MiB. Read event count/reserves from the profile and header bytes from Rust. Memory takes precedence over the 20 MiB state ceiling. |
| Join; settle/compaction | Join p95 <=2 s; settle/observed compaction <=1 s. |
| State/transfer | State <=20 MiB; initial framed transfer <=3S+64 KiB; steady framed socket bytes <=2 KiB/edit. Payload bytes reported separately. |
| Retained history | Post-compaction referenced bytes excluding the current snapshot/vector; net growth <=2 MiB over the first compaction. Trend is diagnostic. |
| Write volume | Record OS byte counters normalized per 480 edits, separately from retained overhead. No write-volume gate. fsWrite is operations, never bytes. |
| Engine CPU | At most one normalized core during editing. |

Open allowances increase with bytes to pay for full parse/admission; they do not weaken typing or the original control.
Report logical retained overhead, current state, physical SQLite/WAL, sampled peaks, update/snapshot/transfer sizes and native drain/restore/ACK costs separately.
For each shape require 100,000 edits to fit and at least 5 MiB initial headroom below 20 MiB.
State-reader and admission bounds follow that state derivation; only the projector's 16 MiB output ceiling stays fixed.
Choose the largest contiguous otherwise-passing size, then require its full soak. Missing metrics/refusals/crashes/lost edits fail closed.
No passing 2 MiB means no raise. Always measure 8 MiB before choosing between 5 and 10.

For a launch-free plan, add --document-mib 2 --document-mode dry-run; the binary may be absent.
No pilot or full packaged run is part of harness verification.
For the bounded relay smoke, write settings.json with absolute checkout/directory paths and updatesPerSecond: 8, then run:

~~~powershell
node --import ./services/sync-relay/node_modules/tsx/dist/loader.mjs tools/perf-profiling/document-size-runner.mjs smoke <settings.json>
~~~

Smoke uses separate/shared two-session 2 MiB documents and three updates/session.
Without engineBinary it proves storage/worker/client plumbing, not native or GUI paths.
Run the harness suite with node --test tools/perf-profiling/packaged-benchmark.test.mjs.

## Run the full profiles

Use Node 24.16 or newer and pnpm 11.20.0.

1. Schedule an otherwise idle machine and exclusive access to the desktop display.
2. Run `node tools/perf-profiling/run-profiles.mjs --output test-results/perf-profiling`.

Do not run full profiles concurrently. CPU profiles need an otherwise idle machine.

Add `--headed` when the run needs an explicitly headed Playwright launch.
Electron launches a real window in either mode.

The runner performs these actions:

1. Prepares and verifies the engine and desktop for this checkout, then stages the engine for E2E.
2. Seeds deterministic workspaces under `<output>/fixtures`.
3. Runs each profiling spec in a separate Electron profile.
4. Runs the six scenarios serially.
5. Writes an attributable `run.json` before launching the scenarios.
6. Writes each raw artifact and `summary.json` under the output directory.

Scenarios continue after one fails. The command still exits unsuccessfully,
and `summary.json` records the failure beside every completed scenario. This
keeps one broken path from hiding the rest of the launch evidence. Each
scenario also has its own Playwright output directory, so a later pass cannot
erase an earlier failure screenshot or trace.

Preparation installs frozen dependencies and rebuilds the engine or desktop when its inputs or artifacts differ from the receipt.
An engine rebuild acquires a shared build slot and uses the workstation's build budget.
To prepare before the profiling window, run `pnpm qa:prepare` in the same checkout.
The profiling runner still verifies that preparation before it seeds workspaces or collects profiles.

## Run the plumbing smoke

Run this command once after harness changes:

`node tools/perf-profiling/run-profiles.mjs --tiny --output test-results/perf-profiling-tiny`

Tiny mode limits `large-flat` to 200 files. It also shortens timed pointer and Explorer interactions.
Tiny results prove plumbing only. Do not compare them with full profiling results.

## Seed fixtures without profiling

Run this command:

`node tools/perf-profiling/seed-workspaces.mjs --output test-results/perf-fixtures`

Pass `--seed <uint32>` to select another deterministic corpus.
Pass `--tiny` to generate the smoke-scale corpus.

The seeder replaces its output directory. It writes `seed-manifest.json` with actual counts and byte sizes.

Full scale contains these workspaces:

- `large-flat`: 15,000 files, including 9,000 Markdown files and one 5,000-file folder. Other files stay in collapsed buckets.
- `large-deep`: 8,000 files distributed through eight folder levels.
- `big-docs`: one editable 250 KiB Markdown file plus stress files from 1 MiB
  through 5 MiB.
- `drawings`: Excalidraw scenes with 300 and 1,500 elements.

The seeded RNG, file ordering, fixed timestamps, and JSON formatting make fixture bytes stable across runs.

## Read the output

Each scenario JSON keeps raw marks, CDP metrics, long tasks, and CPU profiles when captured.

`summary.json` contains:

- the exact Git commit, dirty state, and SHA-256 hashes of the desktop bundles,
  staged engine, and fixture manifest;
- workspace-switch phase median and p95 offsets;
- the top ten functions by sampled self time for each CPU profile;
- long-task support, counts, total duration, and longest task;
- Explorer expansion-to-first-child and expansion-to-complete-tree timings;
- React commit counts when available;
- scenario-specific Explorer, Quick Open, Graph, Excalidraw, editable
  big-document, and bounded oversized-read metrics.

A missing scenario is `null`, never a pass. `complete` is true only when every
scenario produced an artifact.

React commit counts are currently `null`. The app has no production React Profiler or commit mark.


## Measure engine History queries

The ignored Rust test `history_page_benchmark` measures first pages, later pages, and a three-edit object in a 100,000-moment version.
The fixture also contains 1,000 protected rows and 100 version markers.
The candidate drains those streams before timing a later text cursor, so the benchmark exercises a text position as well as marker positions.
It reports capture-inclusive reads and the first reopen after removing the candidate's History index migration.
The reopen builds both History indexes.
After the reads, it times 100 saves through `versionedText.write`, following ten warmup saves.
It then imports ten batches of 100 moments through `apply_moment_envelope`, following one warmup batch.
Each imported moment uses its own production sync transaction. Envelope preparation stays outside timing.
`save` reports milliseconds per save. `importPerMoment` reports milliseconds per moment, averaged within each batch.
Both paths append to the same 100,000-moment fixture. Compare their baseline and candidate values to measure the indexes' write cost.

Prepare separate base and candidate checkouts before the admitted measurement window.
Copy `crates/dohc-workspace-engine/tests/history_page_benchmark.rs` from the candidate into the base checkout.
The harness chooses the old page cursor when `HISTORY_BENCH_MODE=baseline`.
Keep both checkouts and build outputs within their registered task worktrees.

Read the repository's `rust-gate` skill and build each executable through its build budget with these arguments:

```text
cargo test --locked --release -p dohc-workspace-engine --test history_page_benchmark --no-run -j 8
```

Use the test executable path printed by Cargo. It is platform-specific and includes a content hash.
Record its SHA256, checkout commit, profile, fixture size, and concurrent host context.
Both arms must use the release profile and the same fixture.

Run both arms from the candidate checkout with the repository runner:

```text
node tools/perf-profiling/history-query-benchmark.mjs --exe <base-release-test-executable> --mode baseline
node tools/perf-profiling/history-query-benchmark.mjs --exe <candidate-release-test-executable> --mode candidate
```

Use absolute executable paths for the base and candidate builds. The runner fixes the fixture size at 100,000 moments.
The runner acquires profiling admission, monitors the owned child, and releases admission after the child exits.
Admission refusal ends the command without launching the executable. Rerun during the scheduled window.
Do not run the test through Cargo while holding profiling admission: its build slot conflicts with profiling admission.
Do not bypass an admission refusal.

The runner prints `HISTORY_BENCH` numbers after successful completion and a final admission check.
After the run, it rejects results from a debug-profile build.
It records the executable SHA256, process ownership, raw log, numbers, and admission observations under `.agent-artifacts/history-page/measurement-*`.
TEMP, TMP, and DOHC_TEST_SCRATCH_ROOT stay inside that run's checkout.
Preserve the printed evidence path with the comparison.
