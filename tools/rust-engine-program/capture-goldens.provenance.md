# capture-goldens.json: provenance and change policy

These goldens are a **frozen record**, not a regenerable artifact. There is no
emit flag. To change them, edit the file by hand and tell the reviewer why.

## What they are

The normalized per-path capture projection produced by the **TypeScript** capture
pipeline in `packages/workspace-engine`. The retired
`apps/desktop/src/workspaces/captureOracleGoldens.test.ts` drove
`capture-fixtures.json` through that pipeline when this record was frozen.

`crates/dohc-workspace-engine/tests/capture_differential.rs` replays the same
fixtures against the Rust daemon and compares against the same file. That is what
makes it a differential: two independent implementations, one expected answer.

## Why they cannot be regenerated

R16 deleted `packages/workspace-engine`. The only implementation left that could
regenerate these goldens is the Rust daemon, which this same file grades. The
daemon would be certifying itself, and one regeneration would make any Rust
capture bug the expected answer.

## Provenance and where it is enforced

| | |
| --- | --- |
| Produced by | the TypeScript capture oracle in `packages/workspace-engine` |
| Frozen at commit | `aa2f2a0fb7c79ff4a13886d169ae81dde9568b3f` |
| SHA-256 of `capture-goldens.json` | `246655d8e2f697d069d121c50faec04222f7f45eecc970f1af4e0b4ee64e5292` |
| SHA-256 of `capture-fixtures.json` | `ecf8710b19870fab090abfc2c6b78e80a050d245d60c42c21cc6eb62962122d7` |
| Scenarios | 10 |
| **Enforced by** | `crates/dohc-workspace-engine/tests/capture_differential.rs` |

The test asserts these in Rust source:

- **Both hashes.** The fixtures are frozen with the goldens, because input
  coverage can vanish without changing any output. Drop the first step of
  `update-coalesce` and the final projection is byte-identical, while the
  update-transition case is gone.
- **Scenario identities, not counts.** Names must be unique, and the fixture
  name set must equal the golden key set and the set of scheduled tests.
  Deleting one scenario and duplicating another leaves both lengths at 10.

## If a scenario is added

Add it to `capture-fixtures.json`, add its golden entry, and add its test to
`capture_cases!` in `capture_differential.rs`. Update both hash constants there
and the table above.

## If the goldens and the Rust daemon disagree

The default assumption is that **the daemon is wrong**, because the goldens record
a shipped implementation's behaviour and the daemon is the newer one. Investigate
before changing the file. "The test was failing so I regenerated it" is precisely
the outcome freezing this is meant to prevent.
