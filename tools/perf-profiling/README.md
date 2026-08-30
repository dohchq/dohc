# Renderer profiling harness

This harness measures renderer hypotheses A1 and A3 from `DISCOVERY-R2.md`.
It also validates workspace-switch wins through the bounded switch timeline.

The reader is the next agent preparing an orchestrator-scheduled profiling run.

## Run the full profiles

Use Node 24.14 or newer and pnpm 11.20.0.

1. Build the desktop app with `pnpm build:desktop`.
2. Ensure the worktree-root `target/debug` contains the current debug engine.
3. Schedule exclusive access to the engine daemon build slot and desktop display.
4. Run `node tools/perf-profiling/run-profiles.mjs --output test-results/perf-profiling`.

Do not run full profiles concurrently. CPU profiles need an otherwise idle machine.

Add `--headed` when the run needs an explicitly headed Playwright launch.
Electron launches a real window in either mode.

The runner performs these actions:

1. Seeds deterministic workspaces under `<output>/fixtures`.
2. Stages the worktree-root engine through the existing E2E preflight.
3. Runs each profiling spec in a separate Electron profile.
4. Runs the five scenarios serially.
5. Writes an attributable `run.json` before launching the scenarios.
6. Writes each raw artifact and `summary.json` under the output directory.

Scenarios continue after one fails. The command still exits unsuccessfully,
and `summary.json` records the failure beside every completed scenario. This
keeps one broken path from hiding the rest of the launch evidence. Each
scenario also has its own Playwright output directory, so a later pass cannot
erase an earlier failure screenshot or trace.

The runner does not build the app or the Rust engine.

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
- scenario-specific Explorer, Quick Open, Graph, Excalidraw, and big-document metrics.

A missing scenario is `null`, never a pass. `complete` is true only when every
scenario produced an artifact.

React commit counts are currently `null`. The app has no production React Profiler or commit mark.
