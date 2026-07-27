# PR #259 review closure report

## P1 — Unix mount traversal

Disposition: fixed.

The harness now assigns the source root a traversal identity and refuses every
entry whose identity crosses that root. Unix compares `st_dev`; Linux also
resolves the containing mount ID from `/proc/self/mountinfo`, so bind mounts
are rejected even when their device ID is unchanged. The guard is applied to
the clone walk, normal and source snapshots, and recursive floor-skip hashing.

Named proving test:
`rehearsal_harness::tests::unix_mount_identity_boundary_is_refused_before_traversal`

Mutation result: removed the mount-ID comparison while retaining the device-ID
comparison. The named test compiled and failed on its bind-mount assertion:
`a bind mount must be refused even when st_dev is unchanged`. The comparison
was restored and the test passed on Windows and Linux.

## P2 — hardlinks de-linked by the byte clone

Disposition: fixed.

The source clone walk now rejects a regular file with link count greater than
one before `std::fs::copy`. This matches the production inventory and settle
contract instead of allowing a de-linked clone to bank `Complete`. The harness
documentation now records refusal semantics.

Named proving test:
`rehearsal_harness::tests::hard_linked_source_files_are_refused_before_copying`

Mutation result: removed the link-count refusal and allowed the copy to run.
The named test compiled and failed on its assertion:
`hard-linked source files must fail closed before std::fs::copy`. The refusal
was restored and the test passed.

Consequence: the schema-4 evidence artifact is retained for audit but cannot
serve as release-gate evidence because it records three hard-linked source
files under the old de-linking behavior. `GATE6_PACKET.md` now reopens the
rehearsal criterion until a new dogfood run passes the stricter contract.

## P2 — UI-state orphan count

Disposition: fixed.

Both prose claims now report the 16 entries present in the banked schema-4
artifact. The regression test parses the JSON and derives the expected prose
from the actual array length.

Named proving test:
`rehearsal_harness::tests::gate6_orphan_claim_matches_banked_schema4_evidence`

Mutation result: restored both prose claims to 17. The named test compiled and
failed on its release-packet assertion:
`the release packet's orphan count must be derived from the banked artifact`.
The value 16 was restored and the test passed.

## Verification

- `cargo test -p dohc-workspace-engine --features harness`: passed on Windows
  (148 library tests plus all crate integration and doc tests).
- `cargo check -p dohc-workspace-engine --features harness`: passed natively
  under WSL/Linux.
- `cargo clippy -p dohc-workspace-engine --features harness --all-targets -- -D warnings`:
  passed.
- `cargo fmt --all`: passed.
- `git diff --check`: passed.
- `git diff origin/main --stat -- packages/`: empty.

No migration was added. Nothing was pushed.
