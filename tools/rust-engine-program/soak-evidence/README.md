# Banked soak evidence

Each JSON here is the full artifact one `dohc-soak-runner` run wrote: the
sample series, the tolerances the assertions used, and the verdict.

## Provenance (from 2026-07-29 onward)

Every artifact the runner writes now carries a `provenance` block:

| field | what it records |
| --- | --- |
| `commit` | `git rev-parse HEAD` at run start, or `unknown` if git could not answer |
| `treeDirty` | whether tracked files were modified at run start; `null` if git could not answer |
| `dirtyCheck` | the exact command behind `treeDirty` (untracked files, including the evidence file itself, are deliberately not "dirty") |
| `invocation` | full `argv`, tier, minutes, cycles, `--quick`, and the evidence path |
| `daemon` | the daemon binary's path, size in bytes, and mtime in unix ms |

The runner refuses to write any `PASS*` verdict whose provenance is
incomplete — an unknown commit, a dirty tree, or a daemon it could not
fingerprint downgrades the verdict to `INVALID(provenance-unattributable)`
and exits non-zero. A `FAIL` or `INVALID` artifact is still written, because
discarding a failing run's samples helps nobody.

Read the fingerprint for what it is: size + mtime distinguishes builds on one
machine, it is not a content hash and cannot detect a deliberately forged
binary.

## Files predating provenance — UNVERIFIABLE attribution

The two artifacts below were written before the runner stamped anything, so
**nothing in them ties their measurements to a tree**. The commits named here
are what `docs/superpowers/plans/rust-engine/EXECUTION_LOG.md` says was being
tested at the time. They are BELIEVED, not verified, and no backfill is
possible: the runs are over. Do not edit provenance into these files.

| file | believed tree | basis | status |
| --- | --- | --- | --- |
| `2026-07-21-cutoverBlocking.json` | at or near `126d79eb` (the #215 merge, 2026-07-21T10:11Z) | the log's verdict line is stamped 2026-07-21T12:44:01Z, after that merge and before `7435f228` banked the file at 13:10Z | UNVERIFIABLE |
| `windows-2026-07-28T21-28-34Z-cutoverBlocking.json` | `0c78d3b6` | the machine-dogfood entry names it as the campaign's final main, and its gate line is stamped 2026-07-28T21:27:07Z — 87 seconds before this run's filename timestamp | UNVERIFIABLE |

`macos-cutoverblocking-2026-07-27.md` banks verdict lines rather than JSON, and
already names the heads its runs came from (`86d5b2ed`, `ed936680`) because
the workflow recorded them — but those are equally unchecked assertions in
prose, not fields any tool validates.

## Residual gap

Nothing validates a *banked* file. The enforcement above runs inside the
producer, so it cannot catch an evidence JSON that is edited, re-banked under
a different commit, or copied from another tree after the fact. Closing that
needs a consumer-side validator (recorded commit vs. the tree being
validated); this directory has none today.
