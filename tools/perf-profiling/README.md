# Renderer profiling harness

## Measure a Windows release package

Use this workload when comparing release startup, editing, workspace switches, and idle cost.
It launches the packaged executable with isolated local workspaces and a new profile.
It does not rebuild the package, change Electron fuses, or enable a product test bridge.

1. Install the checkout's pinned dependencies before the measurement slot.
2. Prepare baseline and candidate packages with their build receipts.
3. Reserve an idle Windows host and exclusive access to its desktop. Use Node 24.14 or newer and PowerShell 7.
4. Run `node tools/perf-profiling/packaged-benchmark.mjs --help` for the options.
5. Run each package with a new output directory and its full build commit:

```powershell
node tools/perf-profiling/packaged-benchmark.mjs --binary C:/packages/baseline/dohc.exe --package-commit <full-build-SHA> --output C:/perf/baseline-1 --label baseline
node tools/perf-profiling/summarize-packaged-benchmark.mjs C:/perf/baseline-1
```

Use `--label candidate` for the candidate. Keep the workload settings identical and alternate execution order.
Use `--engine-commit <full-SHA>` when a diagnostic package has a separately built engine.
The receipt records executable, ASAR, engine, harness, and helper hashes separately from the harness checkout commit.
Output directories cannot be reused. Failure logs and fixtures remain available for diagnosis.
Cleanup closes the recorded app and helper; failed startup and shutdown also terminate their owned process trees.
Ctrl-C and SIGTERM cancel pending launch or idle work, stop owned processes, and preserve the failed-run receipt.

The default workload uses three fresh/restart cycles, 100-paragraph rich editing, 5,000-paragraph source editing,
30 trusted keystrokes per document, ten switches, and 60 seconds each of visible and minimized idle.
`--files 5000 --scenario switches` adds deterministic flat files; the two editor documents count toward each workspace's total.
Fixture receipts contain file counts and content/name digests. Other scenarios are `startup`, `small-switch`, and `small-tab`.

The palette, search, Collection, and soak scenarios launch once per run. `chat-history` launches twice: once to seed,
then a restart to measure. Each palette, search, chat, and Collection timing starts when the renderer receives the
trusted keydown or mousedown and ends at the first animation-frame callback after the paint that first shows the
surface: two frames after a match found between frames, one after a match found inside a frame callback.
`matchedIn` records which. The observer checks the predicate on every animation frame, so a change without a DOM
mutation is seen within one frame. Visible means the first frame where no ancestor computes to opacity 0; a palette
entrance animation counts from that frame, and `entranceAnimating` records whether it was still running. The harness
wall time sits beside each timing in the receipt.

- `--files 5000 --scenario go-to`: Ctrl+P to a focused Go to input, then `fixture-004242` one keystroke at a time, then a warm reopen. Each keystroke ends when the input echoes the prefix and the first ranked row contains its characters in order. The summary calls this `keystrokeToFirstMatchPaintedMs`; it does not check the other rows, so it is not a full re-ranking time. After the last keystroke the first ranked row must be `fixture-004242.txt`.
- `--scenario command-palette`: Ctrl+Shift+P to the first command row, then a warm reopen.
- `--files 5000 --scenario search`: the Search rail button to a focused input, then `fixture` and `fixture 4242.` submitted with Enter, each to its first result row and to the complete state.
- `--scenario chat-history [--chat-messages 200]`: seeds one #general post and its replies through `packages/cli/bin/dohc.js` against the running package, restarts, then opens the channel to its post card and the thread to its first and to all comment rows. One observer carries both comment milestones from the same click.
- `--scenario collection [--records 500]`: seeds `records/collection.yaml` and Markdown records with pre-minted ids, waits for the Explorer to mark the folder as a Collection, then opens it to the first table rows.
- `--scenario soak [--soak-minutes 10]`: repeats a mixed cycle (open both documents, Go to typing `small`, command palette, search for `Performance`, two switches) until the time is up and records working set and private bytes per process kind after each cycle. Each cycle records its search query. The document-open and switch timings are the existing harness wall-clock observations.

`go-to` and `search` reject `--files` below 4243, because their queries name `fixture-004242`.
Search waits for the Explorer to list every fixture file before it submits. A sample whose search id changed before Enter is flagged `debounceFiredBeforeSubmit`.
With an engine capture, search queries the engine index and returns at most 50 results in one batch, so `limitHit` false does not mean the results are complete. `sawUpdating` records whether the view passed through updating, whose retry backoff lands in the settled time.
Chat seeding runs `seed-chat-cli.mjs` through `scripts/verification/process.mjs`. On Windows that is a job object that kills every descendant when the harness-owned job owner exits, including a CLI worker whose launcher exited abnormally. On POSIX it is a detached process group, which a timeout or interrupt kills. Each message still runs two Node processes, the launcher and the CLI. Output returns only after both pipes close. The receipt hashes `packages/cli` bin, src, and package.json, the seed script, and the runner. The thread comment list is not virtualized, so every reply renders.
The Collection table is virtualized and pages on demand: `rowsRendered` is the visible window and `loadedRecords` is the first page.
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
Main profiling must produce a log matching the recorded main PID. Profiled runs are marked diagnostic in summaries.
Keep them separate from unprofiled comparisons.

Run `node --test tools/perf-profiling/packaged-benchmark.test.mjs` for CLI, lifecycle, and summary checks.
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

Use Node 24.14 or newer and pnpm 11.20.0.

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

