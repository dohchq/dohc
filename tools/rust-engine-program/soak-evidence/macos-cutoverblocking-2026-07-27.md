# macOS cutoverBlocking soak — banked evidence (2026-07-27)

The Actions artifact quota blocked uploading the evidence JSONs, and run logs
expire after ~90 days, so the closing verdict lines are banked here verbatim.
This is the evidence the R15-2 / GATE6 closure rests on.

## Two PASSes under two different criteria — attributed honestly

The two runs did NOT pass under the same rule, and the record must not
manufacture redundancy it does not have (an adversarial review of the first
draft of this file caught exactly that).

**Run 30265974274** — head `86d5b2ed`, created 12:27Z, nearly three hours
BEFORE #293 merged (15:23Z), so it ran the OLD methodology. Its whole-run
slope is OVER the 20,480 B/s bound; it passed under the **#267 tail-window
criterion** (tail 16,996 < 20,480), which Ice ratified on 2026-07-27
(DECISIONS.md). Full line, verbatim:

```
2026-07-27T14:07:39Z | soak-cutoverBlocking | macos/aarch64 | PASS | cycles=11362 crashes=83 durationSecs=5524 rssDisposition=PASS rssSlopeWholeB/s=28754.2 rssSlopeTailB/s=16995.9 warmupDominatedWholeRunFit=true drain=RETAINED rssDrain 208306176->207192064 min=207192064 drop=1114112 (0.6% of run growth) handles 11->11 threads 11->9 handleThreadSlackCalibration=UNCALIBRATED
```

The #293 postmortem later showed the old methodology's numbers measured the
workload as much as the daemon, so this run is best read as corroborating
context, not primary evidence.

**Run 30279897083** — head `ed936680` (includes #293's corrected bound). This
is the run the closure actually rests on: the ONLY pass under the corrected
methodology, and its whole-run fit is inside the bound too — which no
previous run achieved:

```
2026-07-27T16:35:51Z | soak-cutoverBlocking | macos/aarch64 | PASS | cycles=25243 crashes=83 durationSecs=3723 rssDisposition=PASS rssSlopeWholeB/s=2072.3 rssSlopeTailB/s=873.7 warmupDominatedWholeRunFit=false drain=RETAINED rssDrain 51298304->51232768 min=51232768 drop=65536 (0.2% of run growth) handles 11->11 threads 11->9 handleThreadSlackCalibration=UNCALIBRATED workingSetBounded=true userFileGrowth=25 durableGrowthBytes=190202421
```

Normalized per-work trend across quarters (the #293 measure — B/cycle, not
B/s, so a slowing daemon cannot flatter the bound):

```
quarter 1: rss=11597 B/s workload=8.323 cycles/s normalized=1402 B/cycle cycles=0->7383
quarter 2: rss=807  B/s workload=7.301 cycles/s normalized=110  B/cycle cycles=7423->13983
quarter 3: rss=1159 B/s workload=6.397 cycles/s normalized=180  B/cycle cycles=14019->19808
quarter 4: rss=1802 B/s workload=6.041 cycles/s normalized=298  B/cycle cycles=19843->25243
```

Whole-run slope 2,072 B/s and tail slope 874 B/s against the 20,480 B/s bound
— roughly 10x and 23x inside respectively, with `workingSetBounded=true` and
`userFileGrowth=25` (the precondition the runner records about itself; an
unbounded workload serializes the RSS verdicts as null instead).

The same run's full-workspace gate:

```
2026-07-27T15:32:45.500Z | run-rust-checks | darwin/arm64 | PASS | fixture drift=SKIP[yjs/tsx unavailable; fixture drift not checked] fmt --check=PASS clippy -D warnings=PASS build --workspace=PASS test --workspace=PASS cargo-deny=PASS cargo-audit=SKIP
```

## Caveats (part of the record, not footnotes)

- `handleThreadSlackCalibration=UNCALIBRATED` — the handle/thread slack bounds
  were calibrated on Windows only, so the macOS PASS banks the RSS/working-set
  verdict, NOT a resource-handle verdict.
- The macOS gate rows report `fixture drift=SKIP` and `cargo-audit=SKIP`. Both
  are enforced PASS elsewhere (the Linux PR gate installs the JS workspace and
  a pinned cargo-audit; the Windows canonical gate of 2026-07-27 ran both).
  The macOS leg's job is the soak; its gate rows are corroboration.
- `crashes=83` is the workload's crash-recovery scenario counter (deliberate
  kill/recover cycles), not unexpected daemon crashes; a genuine daemon
  failure fails the run regardless of workload validity.
