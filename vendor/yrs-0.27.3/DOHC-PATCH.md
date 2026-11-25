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

`src/types/text.rs` also changes `clean_format_gap`, which a local delete in a
text runs to drop the formatting items that delete made redundant. Upstream
scans past a live embedded shared type as if it held nothing, where Yjs's
`cleanupFormattingGap` stops at any live countable item. A note body stored as
one sequence (`docs/engineering/note-body-sequence.md`) holds each block's
start as an embedded element. A local delete before one removed the
formatting items on both sides of it, and a letter someone else typed plain
after that element at the same moment came out marked. The scan now stops at
any live countable item. It still stops at a deleted string or embed, where
Yjs scans on, which leaves a redundant formatting item and changes no text.
The change applies to every text. For a note stored under `body` it reaches
one shape only, a local delete before a shared type embedded in a paragraph's
text, and no writer of that format puts one there. y-prosemirror 1.3.7 and
@tiptap/y-tiptap 3.0.8 write a paragraph's text in three places
(`createTypeFromTextNodes`, `updateYText`, and the move of a neighbouring
text), each with strings and formatting only, and write every inline node as
an element beside the text. The engine's own writer and import insert strings
(`XmlTextPrelim::new`, `apply_delta` of `Delta<String>`). The per-edit check
(`placedItemsFit` in `packages/ydoc-projection/src/liveDocumentValidation.ts`)
admits only letters and formatting under a mark name in a text. So for that
format the patch changes only how the engine tidies around an item no honest
note holds, toward what Yjs does.
Tests: `crates/yrs-interop/tests/body_sequence.rs` for the patch,
`packages/ydoc-projection/src/paragraphTextHoldsOnlyLetters.test.ts` for
y-prosemirror and the per-edit check, and
`the_engines_own_writer_embeds_nothing_in_a_paragraphs_text` in
`crates/dohc-engine-collab/src/ydoc/body_sequence.rs` for the engine's writer.

`src/types/text.rs` adds `Text::try_visit_items` and `TextItem`. It visits
every live item of a text in stored order and delivers a formatting item as
it is stored, where `try_visit_diff` folds every formatting key into a map of
its own. The engine reads a note body sequence with it: it walks every stored
item once, spends its node budget only on what it builds from them, and keeps
no state for a formatting key that is no mark name. `src/branch.rs` adds
`Branch::holds_unkeyed_item` and
`Branch::holds_keyed_item`, which say whether a shared type holds an item of
that kind, live or deleted. An update does not carry a root's kind, so the
engine checks with them that a format-2 note keeps nothing under `body`, no
keyed item under `sequence` and no unkeyed item under `containers`.
`Branch::stored_value` gives the value under a key only when the newest item
there is live and holds plain values (`ItemContent::Any`), and then its last
value. `Map::get` and `Xml::get_attribute` also show an item of another kind,
and show it differently from Yjs: a keyed run of letters reads as the whole
word here and as its last letter there. The engine reads a format-2 note's
attributes, container records and `meta.schemaVersion` through it. Tests for
all three live in `crates/yrs-interop/tests/body_sequence.rs`.

Visitor regression tests live in `crates/yrs-interop/tests/text_diff_visitor.rs`;
projection budget tests live in `crates/dohc-engine-collab/src/ydoc.rs`.
Both run in the canonical workspace Rust gate. This dependency is excluded
from workspace membership and selected through the root Cargo patch.

`src/types/map.rs` adds `Map::entry_id`. It returns the ID of the item that
holds a key's live value, which Yjs exposes as `map._map.get(key).id`. The
engine keeps a person's frontmatter text only for entries still held by the
items that text was written for; tests live in
`crates/dohc-engine-collab/src/ydoc.rs`.

`src/any.rs` uses the existing signed-varint reader and writer for Any integers.
This preserves negative zero across Yjs import, snapshot encoding, and reopen.
Ordinary integer values keep their existing bytes. Regression tests cover
signed zero, safe integer extrema, and the shared bootstrap projection vectors.

`src/types/text.rs` and `src/any.rs` write keys in sorted order. Upstream
inserts a text's formatting items, and encodes an `Any::Map`, in `HashMap`
order, which changes from one run to the next. The engine builds a
successor's base from its identity alone and names it by the SHA-256 of its
bytes, so the same note must give the same bytes every time. `insert_attributes`
and the last loop of `insert_negated_attributes` now open and close marks in
the order of their names, and an `Any::Map` encodes its entries in key order.
Readers in both libraries gather a run's marks and a map's entries into maps,
so what they read does not change. Tests: `crates/yrs-interop/tests/sorted_writes.rs`
for the patch, and `each_shared_note_a_successor_takes_gives_the_pinned_bytes`
in `crates/dohc-engine-collab/src/ydoc/successor_format_two_tests.rs` for the
engine.

`src/deleted_content.rs` adds `deleted_runs`. It reads the items a delete set
names in a document that keeps deleted content: each run's text, embed or
element with its attributes, the line it sat in and its place in the document.
Yjs reads these through item fields that are crate-private here. The engine
uses it to quote text someone else's change removed unseen; tests live in
`crates/yrs-interop/tests/deleted_content.rs`.

`src/id_set.rs` adds `Ranges::subset_of`, which forwards to the existing
`IdRange::subset_of`. Stop's release checks that each client's deleted ranges
are covered without looking the client up again. The collab owner-outbox
unsorted-delete and incomplete-checkpoint-delete tests cover it.
