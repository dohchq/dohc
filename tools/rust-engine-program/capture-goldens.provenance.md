# capture-goldens.json — provenance and change policy

These goldens are a **frozen record**, not a regenerable artifact. There is no
emit flag. If they need to change, that is a hand-edited diff and a reviewer has
to be told why.

## What they are

The normalized per-path capture projection produced by the **TypeScript** capture
pipeline in `packages/workspace-engine`. The retired
`apps/desktop/src/workspaces/captureOracleGoldens.test.ts` drove
`capture-fixtures.json` through that pipeline when this record was frozen.

`crates/dohc-workspace-engine/tests/capture_differential.rs` replays the same
fixtures against the Rust daemon and compares against the same file. That is what
makes it a differential: two independent implementations, one expected answer.

## Why the generator was removed

R16 deletes `packages/workspace-engine`. Once it goes, the only implementation
left that could regenerate these goldens is the Rust daemon — which this same file
is used to grade. The daemon would be certifying itself, and a single regeneration
would bake any Rust capture bug in permanently, silently, and forever.

The removed path was worse than that on its own terms: `DOHC_EMIT_CAPTURE_GOLDENS=1`
rewrote the file **and returned before the comparison**, so one invocation could
change the expected answers and report success.

## Provenance, and where it is ENFORCED

| | |
| --- | --- |
| Produced by | the TypeScript capture oracle in `packages/workspace-engine` |
| Frozen at commit | `aa2f2a0fb7c79ff4a13886d169ae81dde9568b3f` |
| SHA-256 of `capture-goldens.json` | `246655d8e2f697d069d121c50faec04222f7f45eecc970f1af4e0b4ee64e5292` |
| SHA-256 of `capture-fixtures.json` | `ecf8710b19870fab090abfc2c6b78e80a050d245d60c42c21cc6eb62962122d7` |
| Scenarios | 10 |
| **Enforced by** | `crates/dohc-workspace-engine/tests/capture_differential.rs` |

**Both hashes are asserted in Rust source, not merely recorded here.** An earlier
revision of this file claimed that changing the goldens would force a two-file diff
while *nothing actually read the hash* — the freeze was documentation only, and the
daemon could still have certified itself by editing one file. Review caught that. The
constants now live in the test, which is what makes this a freeze rather than a
request.

**The fixtures are frozen too, not just the goldens**, because input coverage can
vanish without changing any output. Drop the first step of `update-coalesce` and the
final projection is byte-identical: every value assertion passes while the
update-transition case is gone.

**Scenario identities are asserted, not just counts.** Deleting one scenario and
duplicating another leaves both lengths at 10; the loop then resolves the duplicate
twice while the deleted scenario's golden is never read. Names must be unique and the
fixture name set must equal the golden key set.

All three checks are mutation-verified — each one was shown to fail against the
specific edit it exists to catch, including the name-set check surviving a *sanctioned*
hash bump, so the layers are independent rather than decorative.

## If a scenario is added

Add it to `capture-fixtures.json`, add its golden entry, and bump the expected
scenario count asserted in `capture_differential.rs`. That count exists because
value comparison cannot see a scenario that quietly stopped existing — if a
scenario is deleted from both files, every remaining assertion still passes.

## If the goldens and the Rust daemon disagree

The default assumption is that **the daemon is wrong**, because the goldens record
a shipped implementation's behaviour and the daemon is the newer one. Investigate
before changing the file. "The test was failing so I regenerated it" is precisely
the outcome freezing this is meant to prevent.
