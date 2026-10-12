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
