# Local Yrs changes

For maintainers updating the Yrs dependency: this directory contains the
`yrs` 0.27.3 crates.io archive, with SHA-256
`9d3a728b1abffeca5b9e5319c5b81e04b73790cbdc1e342da8d91b440b3026cb`.
Its recorded upstream commit is
`ac476a47ecc68be26e8c5b48a4be035773636d3a` in
[y-crdt/y-crdt](https://github.com/y-crdt/y-crdt).
The MIT `LICENSE` was copied from that commit; its SHA-256 is
`b6d81564e9c46473907bd3c09d4d5ab0f21cfbe6ac35d46daf1bdb0423182a5b`.

The local change in `src/types/text.rs` adds `Text::try_visit_diff`.
It visits borrowed text fragments and active attributes, stopping on the
consumer's first error. The engine uses it to check actual run, attribute,
and byte budgets before copying text. Existing Delta and snapshot APIs keep
their upstream implementation.

Visitor regression tests live in `crates/yrs-spike/tests/text_diff_visitor.rs`;
projection budget tests live in `crates/dohc-engine-collab/src/ydoc.rs`.
Both run in the canonical workspace Rust gate. This dependency is excluded
from workspace membership and selected through the root Cargo patch.

`src/any.rs` uses the existing signed-varint reader and writer for Any integers.
This preserves negative zero across Yjs import, snapshot encoding, and reopen.
Ordinary integer values keep their existing bytes. Regression tests cover
signed zero, safe integer extrema, and the shared bootstrap projection vectors.
