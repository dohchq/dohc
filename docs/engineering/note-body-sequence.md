# Note body sequence (format 2)

How a note's body is stored so that joining and splitting lines cannot double or lose text (#4038). The body is one sequence in which the start of each block is one item: a join deletes one item, a split inserts one, and nothing is copied.

Sections 1 to 3 are frozen as of 2026-11-23: where the format lives, what is stored, and how it is read. A change to them goes through the owner of #4038 and is told to every lane building on them. Section 4 is the rules writers follow; the editor adapter finishes and tests them. Section 5 is the rules the server's checks follow, as built and tested. Section 6 lists behaviour people can meet.

The reader is `packages/ydoc-projection/src/bodySequenceGrammar.ts`, read from Yjs by `bodySequenceYjs.ts`. `packages/ydoc-projection/src/fixtures/body-sequence.json` holds stored notes and the documents they read as; every reader, in any language, must match it.

## 1. Where it lives

- A note in this format has `meta.schemaVersion = 2` and four roots: `sequence` (Y.Text), `containers` (Y.Map), `frontmatter` (Y.Map), `meta` (Y.Map). Nothing is under `body`.
- A note is in this format only when `meta.schemaVersion` is the number 2. With 1, or with no `schemaVersion`, it is today's format and is unchanged; any other value is not this format, and today's checks decide what happens to it.
- `meta.schemaVersion` is written when the note is made or converted, by the engine only. No page changes or deletes it.
- An editor declares `sequence` as Y.Text and `containers` as Y.Map before applying an update. A late declaration leaves Yjs's formatting flags unset for editing.
- A new note's format is chosen where the note is made. Neither setting exists yet; the work that turns the format on adds them: one in the engine for the format of new notes, which also tells a client that seeds a note which format to write, and one in the relay to admit format-2 notes. Both are off unless set.

## 2. What is stored

### 2.1 Items in `sequence`

| Item | Yjs content | Meaning |
| --- | --- | --- |
| Letter | `ContentString` | One UTF-16 unit of text. |
| Boundary | `ContentType` holding a `Y.XmlElement` named `block` | The START of one leaf block. |
| Inline item | `ContentType` holding a `Y.XmlElement` named `hardBreak`, `image`, `escapedPunctuation`, `wikilink`, `inlineAtom`, `mathInline` or `rawInline` | One inline node. Its attributes are the node's. |
| Mark | `ContentFormat`, key = a mark's name exactly (`bold`, `italic`, `strike`, `underline`, `code`, `link`, `highlight`) | Formatting for the letters that follow. |

- An element in the sequence has attributes and no children. Its name never changes.
- A leaf block is a block with no blocks inside: `paragraph`, `heading`, `codeBlock`, `horizontalRule`, `mathBlock`, `rawBlock`.
- Boundary attributes:
  - `type`: the leaf's node type. Not a string, or not one of the six: reads as `paragraph`.
  - the leaf's own attributes: `level` (heading), `language` (codeBlock), `tex` (mathBlock), `source` (rawBlock).
  - `path`: an array of container ids, outermost first. Missing or not an array: no containers.

### 2.2 Records in `containers`

- A container is `blockquote`, `callout`, `bulletList`, `orderedList`, `taskList`, `listItem`, `taskItem`, `table`, `tableRow`, `tableCell` or `tableHeader`.
- A container id matches `^[A-Za-z0-9_-]{1,32}$`. Ids are random.
- Key `<id>` holds the container's node type (a string). Key `<id>.<attribute>` holds one attribute of it (`I7.checked`, `L2.start`, `c9.title`). `<attribute>` is one of: `checked`, `loose`, `start`, `type`, `calloutType`, `title`, `fold`, `height`, `colspan`, `rowspan`, `colwidth`, `align`.
- One place per container, so a tick is one write whatever the item holds, survives its item being indented, and has no copies to go stale.
- An attribute with no record reads as its default. A record no path names is ignored.
- One id can be on two containers: one person lifts a line out of the middle of a callout while another adds a line to its end. The reader shows two containers with the same records (rule 3.4).

### 2.3 Values

- An integer on the wire may be a number or a BigInt; a BigInt inside the safe integer range reads as that number. "Whole number" below means a number with no fraction (so `2`, `2.0` and BigInt `2` all hold, `1.5`, `NaN` and `Infinity` do not).
- Each attribute has a rule. A value that breaks its rule reads as if the attribute were missing, which gives the default:

| Attribute | Holds | Default |
| --- | --- | --- |
| `heading.level` | whole number 1 to 6 | 1 |
| `taskItem.checked` | boolean | false |
| `bulletList.loose`, `orderedList.loose`, `taskList.loose` | boolean | null |
| `orderedList.start` | whole number 0 to 999,999,999 | 1 |
| `tableCell.colspan`, `tableCell.rowspan`, `tableHeader.colspan`, `tableHeader.rowspan` | whole number 1 to 1,000 | 1 |
| `orderedList.type`, `wikilink.label`, `image.title` | string or null | null |
| `codeBlock.language` | null, or a string with no line break (`\n`, `\r`, U+2028 or U+2029) | null |
| `callout.fold` | `""`, `"+"` or `"-"` | `""` |
| `callout.calloutType` | string with no line break (the same four) | `"note"` |
| `callout.title` | string with no line break (the same four) | `""` |
| `mathBlock.tex`, `mathInline.tex`, `rawBlock.source`, `rawInline.source`, `image.src`, `image.alt`, `wikilink.target`, `escapedPunctuation.value`, `inlineAtom.atomId`, `inlineAtom.params`, `inlineAtom.source` | string | `""` |
| `tableCell.colwidth`, `tableHeader.colwidth` | null, or an array of at most 1,000 finite numbers each 0 or more (a BigInt in the safe range counts as its number) | null |
| `tableCell.align`, `tableHeader.align` | null, `"left"`, `"right"`, `"center"` | null |
| `tableRow.height` | null or a whole number 1 to 1,000,000 | null |
| `link.href`, `link.class`, `link.title` | string or null | null |
| `link.target` | string or null | `"_blank"` |
| `link.rel` | string or null | `"noopener noreferrer nofollow"` |

The schema has no other attribute; a test pins the list and the defaults.

- An attribute name that the item's own node or mark type does not have is ignored (a `language` left on a boundary whose type is now `heading` is not read).
- An attribute, a mark and a mark's attribute are read by their own key only. A key named `__proto__` is a key like any other and names nothing here; what it holds is not read as the item's attributes.
- An element's attribute, a record and the format marker are each read from the newest item stored under their key, and only when that item is live and holds plain values (`ContentAny`, which is what `setAttribute` and `Y.Map.set` write); the value is the item's last. An item of any other kind under the key (a run of letters, an embedded value, old-style JSON, a binary value, a shared type, a sub-document) holds no value, so the attribute or record reads as missing. Yjs and yrs show such items differently, and both readers must give one document.
- An array holds a value of its own at every position: one with a hole or `undefined` in it breaks the rule for `colwidth`, and a `path` with a hole is no path. Only its positions are read; any other key on it is ignored.
- A mark is ON for a letter when the nearest earlier `ContentFormat` with that key holds a plain object (the mark's attributes; `{}` for none), and OFF when it holds anything else, an array or a binary value included, or there is none. Wherever these rules say object they mean a plain one: a keyed value that is not an array, a binary value or another built-in kind. Only its own keys are read, each as the value stored there, so the same object reads the same however a decoder built it (Yjs's second update encoding gives an object with a key named `__proto__` a different prototype; the object is still plain and its other keys still count). Keys that are not exactly a mark name are ignored (no hashed names).
- These rules are about values an update can carry: strings, numbers, booleans, null, BigInts, binary values, arrays and keyed objects of those. A program can hold a value in memory that no update carries as it is: an array that borrows a position from its prototype, an object that runs code when it is read. Writers store plain data (section 4), so no note holds one. If a program stores one anyway, the note it wrote can read one way until it is saved and another way once reopened, and such an object can make the reader throw.
- When `code` is on, every other mark is ignored for that letter.
- A letter's marks are listed in the schema's order: `link`, `highlight`, `bold`, `italic`, `strike`, `underline`; `code` stands alone. Neighbouring letters of one block with the same marks, attributes included after repair, are one text run, also when a skipped item or a formatting item stands between them.
- A BigInt outside the safe integer range, `undefined`, and a shared type stored as a value (a Y.Map, Y.Text or Y.Array) break every rule. A container's type record that is a shared type is not a string.
- Marks apply to letters only. Formatting around a boundary or an inline item means nothing and is not read.

## 3. Reading (total: every sequence and every set of records reads as one valid document)

Implemented by `leavesOfSequence` then `readBodyLeaves`.

0. The sequence is its live items, in order. A deleted item of any kind is not read, also a deleted `ContentFormat`. Skip every item that is not a non-empty letter run (`ContentString`), a `block` element, or an element named after an inline node the schema knows. Skipped items take no part in what follows. An embedded value that is not such an element is skipped also when it is a string, so a reader reads the stored items and not Yjs's delta, which shows such a string as text.
1. Cut the sequence at each boundary. Letters and inline items before the first boundary are a `paragraph` leaf with no path; with none before it, there is no such leaf.
2. A leaf's path: walk its `path` array from the start, for at most 64 entries, keeping a current parent that starts as the top level. Stop at the first entry that is not a string matching the id pattern, or was already used in this path, or has no string under key `<id>`. Otherwise the entry's type is:
   - the one type the parent may hold, when the parent may hold only one (table 3.1: under `bulletList` or `orderedList` it is `listItem`, under `taskList` it is `taskItem`, under `table` it is `tableRow`), whatever the record says;
   - else the string under `<id>`.
   Stop if that type is not a container or the parent may not hold it. Otherwise keep a frame with that type, the id, and for each attribute that type has the value under `<id>.<attribute>`; it becomes the parent.
   So an item always follows its list: a list changed to a to-do list by one person shows every item as a to-do, also one added by someone else at the same moment.
3. Then, while the leaf's type is not allowed under the last kept frame, drop that frame; with none left, a type not allowed at top level becomes `paragraph`.
4. Neighbouring leaves share the container at depth N when their fitted paths name the same id at every depth up to and including N. A container's type and attributes are those of the first leaf that opens it. Leaves that name one id but are not neighbours are in separate containers.
5. When a container closes, if its content does not match its content rule, the missing nodes are added in front: a `listItem` or `taskItem` whose first block is not a `paragraph` gets an empty first `paragraph`. (No other case arises in this schema; a test checks that.)
6. A leaf's content is the letters and inline items up to the next boundary, in order:
   - a `paragraph` or `heading` holds letters with their marks, and inline items;
   - a `codeBlock` holds letters, without marks;
   - the first item the leaf cannot hold (any inline item in a `codeBlock`; anything at all after a `horizontalRule`, `mathBlock` or `rawBlock`), and everything after it up to the next boundary, forms one `paragraph` straight after the leaf, in the same container. Its letters keep their marks, as in any paragraph, also when the leaf was a `codeBlock`.
   So no letter and no known inline item is ever left out.
7. A table's rows are read as stored: rows may hold different numbers of cells, and the reader adds none.
8. No leaves at all read as one empty `paragraph`.

### 3.1 Allowed children

Pinned to the editor's schema by a test (`bodySequenceGrammar.test.ts`, "the schema the format is written against").

BLOCKS = `blockquote`, `bulletList`, `callout`, `codeBlock`, `heading`, `horizontalRule`, `mathBlock`, `orderedList`, `paragraph`, `rawBlock`, `table`, `taskList`.
INLINE = letters, `escapedPunctuation`, `hardBreak`, `image`, `inlineAtom`, `mathInline`, `rawInline`, `wikilink`.

| Parent | May hold |
| --- | --- |
| top level, `blockquote`, `callout`, `listItem`, `taskItem`, `tableCell`, `tableHeader` | BLOCKS |
| `bulletList`, `orderedList` | `listItem` |
| `taskList` | `taskItem` |
| `table` | `tableRow` |
| `tableRow` | `tableCell`, `tableHeader` |
| `paragraph`, `heading` | INLINE |
| `codeBlock` | letters |

## 4. Writing (every writer: the editor adapter, the engine, agents)

- Join: delete the lower block's boundary. Nothing else. (Backspace below an EMPTY line deletes the empty upper line's boundary, as the editor does.)
- Split: insert one boundary at the caret, passing the formatting in force there as the insert's attributes (never `{}`: Yjs would write negation items, and an undo could then change nearby marks). In force means every formatting item before the item the boundary goes after, whatever its value, and none between that item and the next.
- Split at offset 0 of a block that is not empty: insert the new boundary BEFORE the existing one, so the existing boundary, its path and its container stay with the text.
- Changing a block's kind or path: `setAttribute` on the same boundary. Never delete and insert. A writer sets `path` as one whole array.
- A boundary carries every attribute its kind has (`level` for a heading, `language` for a code block) from the moment it has that kind, defaults included, so a later change to one is an overwrite. A change to another kind writes the asked value or the default, never a value left from an earlier time the line had that kind. An attribute of a kind the line no longer has may stay on the boundary; no reader reads it.
- A writer skips a write that would store the value already there.
- A writer stores plain data: a string, number, boolean or null, an array of those with a value of its own at every position, or for a mark an object of those built with no prototype tricks. What it stores must read the same before and after it is encoded.
- Three kinds of block are read with no boundary of their own (rules 3.1, 3.5, 3.6). A writer gives one a boundary, in the same transaction, when a change needs it:
  - text before the first boundary: when its kind or path changes, when it is split at offset 0, and when it is emptied while lines follow. The boundary goes at the start of the sequence;
  - a list item's added first paragraph: when someone types in it. The boundary (a paragraph with the item's path) goes in front of the item's first boundary. When the item's first stored line is deleted or joined into that paragraph, its boundary stays and its type becomes `paragraph`, so the item keeps a line;
  - the paragraph after a block that cannot hold its content: when its block's boundary is deleted, when its block changes kind, and when letters are typed at its start after a code block. The boundary goes in front of its first item.
- A split's new line has the kind the writer's command gives it (an editor's Enter at a heading's end gives a paragraph); a writer with no command of its own copies the line's kind. It copies the line's path, with these cases for a line that sits directly in a list item:
  - the item's first block, split anywhere but offset 0: the new line starts a new item below (fresh id, all its records), and the item's later blocks go with it;
  - the item's first block, not empty, split at offset 0: the new empty line is a new item above; the existing boundary, item and records stay with the text;
  - a later block of the item, split at offset 0: the new empty line stays in the same item, above the block;
  - a later block of the item, split elsewhere: the new line stays in the same item, below;
  - the item's first block, empty: the new line starts a new item below.
- An empty note is one line with no boundary; a split there writes two boundaries.
- No writer inserts or deletes between the two units of a surrogate pair. A split or a delete asked for there is refused.
- Typing: insert letters with the marks the editor gives them.
- Never copy letters.
- A boundary always carries `path`, `[]` for a line in no container, so a later change to it is an overwrite. No writer writes a path longer than 64: a change that would nest a line deeper is refused, since a reader would cut the path.
- Containers:
  - a container keeps its id through a change if any of its leaves survives the change in it;
  - a new container gets a fresh id. The transaction that writes the paths naming it also writes its type record and a record for EVERY attribute of every kind it can become where it stands, with the values it starts with and defaults for the rest. The kinds: `blockquote` and `callout`; `bulletList`, `orderedList` and `taskList`; `listItem` and `taskItem`; `tableCell` and `tableHeader`. (`recordsOfContainer` does this.) Every later change to a record is then an overwrite, also a tick on an item that became a to-do because someone else changed its list;
  - changing a container's type or attribute is one write to its record. Changing a list's kind writes the list's type and the type of each item whose stored type differs, and leaves ticks alone;
  - when a change splits a container (a line lifted from its middle, an item outdented), the first part keeps the id and each later part gets a fresh id and a copy of every record whose key is the old id or starts with the old id and a dot, whatever attribute it names;
  - no writer gives two containers one id. When someone's change leaves one id on two containers (2.2), a writer that changes a record of one of them (a setting, or a type, as a change of a list's kind does for its items) first gives that one a fresh id, a copy of all its records and its leaves' paths, in the same transaction, and writes the change into the copy. A writer that removes the last line between two containers that share an id first gives the later one a fresh id in the same way, so they do not read as one.
- No record is ever deleted.
- No writer repairs what it reads. In particular no editor writes table repairs (`fixTables`) or trailing lines in a live note. How an uneven table is drawn is the editor's business and writes nothing.
- Undo is one `Y.UndoManager` over `[sequence, containers]` with `ignoreRemoteMapChanges: true` and a `deleteFilter` that refuses to delete any item whose parent is `containers` and any attribute of a `block` element, following only the person's own origin. An inline item's attribute is not protected: it may have had no value before a person first set it, and undo then removes it. Without the second, two people's undos of kind changes on one line can leave a heading with no stored level, and a later undo then passes over a step. A boundary's attribute goes only with its boundary. Changes from other people are applied with an origin the history does not follow.
  - Undo of a split deletes its boundary. Undo of a join inserts a new boundary (new id, the attributes the person last saw) at the old place.
  - Undo of a change to a path or a record writes the earlier value back.
  - Undo of the change that made a container puts its lines' paths back and leaves its records for lines other people added to it: as the container was made, or as that same step or someone else last set them.
- The editor adapter proves this undo rule with random runs for 3 to 4 people before anything is built on it. If a case cannot be met inside Yjs's undo, the fallback keeps the stored format: the adapter's history undoes record changes itself (it remembers each changed record's earlier value) and `containers` leaves the `Y.UndoManager`.

## 5. Checks

Implemented for the relay in `bodySequenceIntake.ts` and `liveDocumentValidation.ts`, and tested in `bodySequenceIntake.test.ts`. `bodySequenceChecks.test.ts` records what the checks do with the setting off.

- The relay's setting is `DOHC_RELAY_BODY_SEQUENCE_NOTES`. The relay and each validation worker it starts read it.
  - Set to `1`, the relay registers format-2 notes and takes changes to them.
  - Unset or `0`, a format-2 note is not registered, so it cannot go live, and no check takes a change to one: the room refuses each change at once and stores nothing, and the journal check refuses it. Nothing is deleted. Setting it to `1` again brings back as it was a note that had no unsaved changes.
  - A note with changes the room had taken and not yet saved when the relay restarts with the setting off cannot save them: each save fails in the journal check. Once saves have failed for ten minutes the room pauses the note, with those changes in its copy. They do not come back into the note, also not once the setting is `1` again: the owner's desktop writes the copy as a separate file beside the note.
  - The desktop reads a copy by what it holds, since it has no such setting. It reads the body from `sequence` when the copy says it is format 2 and has no item under `body`. A copy that says so and has items under `body` (a format-1 note that a change marked on a relay from before the marker rule below) is read from `body`, so the file it writes holds what people wrote, not a blank body.
  - One rule changed for a format-1 note, with the setting on or off: the format marker (below).
- Rule for the whole section: nothing intake admits is later refused by the save check, the registration check, or the engine for what its `sequence` or its `containers` hold. A test feeds each later check everything intake admitted, from people's changes and from changes no editor would send.
- For a format-2 note the save and registration checks do not read the written Markdown back. They write it once, for its size and its hash. They check the properties by writing the properties block with no body and reading that back, and the metadata by its own rules. So a raw block at the top that reads as a properties block, a raw inline at the start of the first line that does, and a note marked as using CRLF line ends that has nothing to write, are taken; a format-1 note is still refused for these. The saved file of such a note then reads with properties the live note does not have. A writer rule for a body that starts like a properties block is not part of these checks.
- A later check still refuses, as it does for a format-1 note:
  - capacity, which is measured on the whole note and on everything one save reads: its structs and elements, the size of the Markdown it is written as, how many values its properties hold, and the work of reading the note with the changes being saved (the limits on one change, below, say what the room knows of this and what it does not);
  - metadata: a key no note has, a value its key cannot hold, the file's text kept without both of its hashes, and kept file text that names the note's current Markdown and does not read as it;
  - properties that do not read back the same from the block they are written as.
- Two things make a check fail where it should refuse or take, in both formats. Kept properties text that the properties no longer match makes writing the properties block throw. A code block whose `language` holds U+2028 or U+2029 makes writing its fence throw; the value rule in 2.3 counts only two characters as line breaks.
- No check declares `sequence` or `containers` on a document. Yjs, where a text is declared, deletes formatting items on its own when a delete from someone else arrives (one person bolds a word, another deletes it), and those deletes are in no change. A document that never declares the sequence deletes nothing on its own, so every check reads the stored items and none rebuilds the note to compare. A delete of a formatting item is a delete like any other, whoever sends it.
- An editor declares the sequence, as section 1 says, and stops that cleanup on its page (`transaction._needFormattingCleanup = false` after each transaction). Every page then reads the same as the stored note at all times, also a page that cannot send. A page that let Yjs clean and sent what it deleted would end as the stored note too, but a page that cannot send could show other marks until it loaded the note again.
- Intake (per change, at the room and in the journal check each capture's `admitSubmission` runs). It has no rule across items, and it looks at each struct and each delete range a fixed number of times, with every lookup by halving; a test bounds its steps for a change of tens of thousands of structs.
  - It reads the change from the wire once, as the ordered cut does but hashing nothing and copying no value, then looks at EVERY struct the change adds, where Yjs placed it. One the same change also deletes may arrive as `ContentDeleted` or `GC`, or as a keyed `ContentAny` longer than 1 whose earlier values are the deleted ones (Yjs merges them on a reconnect); what can still be read of it is checked like any other value. An item that lands as a collected struct, because its parent arrived collected, is refused, as the cut refuses it.
  - A change whose reading is more work than the policy allows, or that puts a property deeper than the 128 levels the save reads (maps and lists inside each other, and the value inside them), is refused for capacity, not as a broken change. The journal check answers `capacity-refused`. `liveEditRefusal` gives the room the same reason, and for a limit on one change a sentence naming it; the room calls `liveEditFitsCopy` and answers `invalid-update` for every refusal until it reads the reason.
  - It reads the note's format from its copy; a format-1 note takes no item under `sequence` or `containers`, a format-2 note none under `body`.
  - The format marker. A format-2 note takes no change that adds or deletes an item under `meta.schemaVersion`, also one that writes the value already there; it becomes format 2 only by being registered with the marker. A format-1 note, in a room, takes one item there only when it has none, holding the number 1, and no change that replaces or deletes the one it has. This is a change to format-1 intake. Before it the room took such a change and passed it on, every page then read the note by the new marker, and only the save refused it. The marker's writers are the engine and the importer: in a note's first state (`markdownToYDoc`, `fresh_successor_base`, the engine's first rewrite of an empty note) and where a note has none (`missing_schema_version_update`, `replace_frontmatter_for_fold`). None replaces or deletes it.
  - Under `sequence`: `ContentString`; `ContentFormat` whose key is exactly a mark name; `ContentType` `XmlElement` named `block` or an inline node; nothing keyed.
  - Under such an element: only keyed items; a live one is `ContentAny` of length 1 whose key is an attribute that name has (`block`: `type`, `path`, `level`, `language`, `tex`, `source`); no unkeyed child.
  - Under `containers`: only keyed items; a live one is `ContentAny` of length 1 whose key is `<id>` or `<id>.<attribute>` with `<attribute>` from the list in 2.2.
  - Under `frontmatter` and `meta`: what a format-1 note takes there, and each metadata value is one its key can hold. A nested map or list takes items only where it hangs under `frontmatter`.
  - A keyed item has no right origin (Yjs never writes one), and a keyed struct longer than 1 has every value but its last deleted by the same change.
  - Every value is JSON-like (null, boolean, finite number, string, array, plain object; in `ContentAny` also a BigInt in int64; none in a `ContentFormat`, whose value Yjs's v1 update encoding, the one dohc uses, cannot carry a BigInt in, and no negative zero there), at most 128 levels deep, with no key named `__proto__` and no key twice in one object. How many values one change may hold is a limit of the room only (next point).
  - Limits on one change, at the room only (`liveEditRefusal`). They are per change. The journal check has none of them, because the room saves several changes merged into one and a limit there would refuse a save of changes each of which the room took.
    - A change holds at most 100,000 values (`BODY_SEQUENCE_CHANGE_MAX_VALUES`). A value is a null, a boolean, a number, a string, an array or an object, counted once each wherever it sits. Measured in single changes an editor sends: a pasted table of 1,000 cells holds 10,201; 10,000 lines written at once 20,000; a line 64 containers deep 322; a cell with 1,000 column widths 1,001; and the densest change that fits the 2 MiB a relay takes, 6,800 to-dos each with a link, 88,404. The save reads each value 4 times, and 7 times in a mark, and counts to 5,000,000, so one change's values are at most 700,000 of that count. The save of a change at the limit took 0.5 to 1.5 seconds where measured, against a 10 second limit.
    - A change holds at most a quarter of the structs the save counts (100,000 under the worker's policy), because the save reads each struct of a change 4 times, and weighs at most what a whole note may (280,000: one for each struct and 6 more for each element). A change past either could not be saved into an empty note.
    - A change past one of these is refused with `capacity-refused` from a plain count, before it is read, and the refusal names the limit, its unit and what the change holds. A change of 100,000 bytes or fewer cannot be past any of them and is not counted.
    - The room then reads the change once under the save's policy divided by how often the save reads each thing (4 for structs and their groups and for deletes, 7 for values and bytes of text), so each of the save's counts has room for the change itself. A test compares the save's own counters with the read's. The note and the other changes of the same save share those counts.
    - Cost, measured on one machine: a typed letter takes the room's check 12 microseconds, against 8 for a format-1 note. A change of 10,000 lines takes it 70 to 110 milliseconds against 25 to 33, and the largest honest change, 6,800 to-dos with links in 2 MiB, 230 milliseconds, where a plain apply takes 45 and the save 2.7 seconds. The difference from a format-1 note is one strict read of the change, which a format-1 note's check leaves to the save. A change of 1,900,000 values is refused in 23 milliseconds; before these limits the room took 3.4 seconds to take it.
    - What the room still does not know, so a change it takes can be refused at save for capacity: the rest of the save. The room saves one sender's run of changes as one, cut by bytes only (`nextSave`, up to the largest update the engine passes on), so several changes each within the limits can together pass the save's counts: 14 changes of 90,000 values are 5,040,000 reads. To close this the room would keep, for its unsaved changes, the sums the save counts (structs, values in and outside marks, bytes of text, deletes) and cut a save where a sum would pass the policy. Also not known to the room: the save's sorting work, which is not a count of what a change holds (10,000 lines in one change use 28 million of its 100 million index operations, 6,800 to-dos with links 47 million); the structs, weight and properties of the note the change lands in; and the size of the written Markdown (a line of 2,097,000 letters is a change under 2 MiB that the save refuses).
    - A format-1 note has the same gap and none of these limits: 400,000 nulls in one property are taken by the room and refused at save.
  - The journal check reads these from the wire. The room first trims a change to what the note lacks, and Yjs writes each value again as it does. In a `ContentAny` value Yjs drops a `__proto__` key and keeps the last of two equal keys, and the room stores that rewrite. In a `ContentFormat` value Yjs keeps an own `__proto__` key, so the room refuses the change; it keeps the last of two equal keys, writes a negative zero as zero and a number too large to keep as null, and the room stores those rewrites.
  - No string anywhere (a letter run, a value, a key) holds a lone surrogate; no struct starts or ends, no delete range as the change wrote it starts or ends (also two ranges that meet there and together cover the pair), and no item is placed, between the two units of a surrogate pair. Yjs writes U+FFFD for each half of a pair an item is placed inside.
- Registration checks a format-2 note's whole first state by the same rules, item by item, except that the state is where the marker is written. A state with a map under `containers`, an embedded value under `sequence`, or anything under `body` is refused.
- Activation checks a whole history. Every entry of it gets the format guard and the intake rules, not only the last: the first as a whole state, by the rules registration uses, and each later one as a change.
- Known difference: the room's check derives its limits from the validation worker's default work policy, because the room passes none; `liveEditRefusal` takes one. A relay configured with a smaller policy takes at the room a change its save then refuses for capacity.
- A format-1 note's checks are otherwise unchanged. They still refuse a history in which Yjs cleaned formatting.
- Old clients: today's editor binding, opened on a format-2 note, writes nothing as it opens, and intake refuses every edit it makes (`bodySequenceOldEditor.test.ts`).
- Engine: the same reading rules in Rust, giving the existing `MarkdownNode` tree, pinned byte for byte against TypeScript on the shared fixtures. The engine's reader process runs the journal check with the setting off, and its own reading of a file saved outside dohc is format 1 only.
- Before the engine writes this format, its Yjs library needs one patch: `clean_format_gap` (`vendor/yrs-0.27.3/src/types/text.rs`) scans past an embedded element as if it were not content, where Yjs stops. A local delete in the engine can then remove the formatting items on both sides of a boundary, and a letter someone types plain after that boundary at the same moment comes out marked. `crates/yrs-interop/tests/body_sequence.rs` records today's behaviour and must flip. The engine writes marks with attributed inserts, not `Text::format`, whose right edge differs from Yjs's.

## 6. Known behaviour

Accepted:
- Two people who both undo the same join leave one empty line.
- One person lifts a line out of the middle of a quote, callout or list while another adds to its end: the note shows two containers with the same settings, and a later change to one of them gives it its own id (2.2). While one id is on two containers: a line someone adds to the one being changed at that same moment stays on the old id and shows as a third container; two people changing different settings of the same one at the same moment each give it a fresh id, and one of the two settings wins.
- A writer that gives the later half of a split container a fresh id rewrites the path of every line in that half; someone changing one of those lines' paths at the same moment may have that change overwritten.
- Undoing the change that made a quote, callout or list does not unwrap lines someone else added to it since; those stay in it, with its settings.
- Two people changing one list's kind at the same moment: one kind wins, and every item follows it. Undoing a kind change puts back the kind the person had, even if someone changed it since.
- As in Yjs today: when other people's changes have already removed everything a step did (a letter typed and since deleted by someone else, or a change to the kind or path of a line someone has since removed), undo passes over that step and undoes the one before it. In 399,562 undos and redos by 2 to 4 people this happened 1,218 times, each time for a step with nothing left to undo.
- With `ignoreRemoteMapChanges`, undoing a change to an attribute, a record or a path puts back the value the person had before it, even if someone changed it since, and redoing it writes back the value that undo replaced. A boundary or inline item restored by undo has the attributes the person last saw (someone else's change to it at the same moment is lost with the delete).
- Two people changing one line's path at the same moment: one whole path wins.
- An editor can put a mark on an inline item or on a code block's letters; the format reads none there, and the editor is shown the reading.
- Changing a code block to another kind turns each line break in it into a hard break, and back: the editor's own conversion, which replaces those items.
- Two people who each give the text before the first boundary a boundary at the same moment leave an empty line above it, and a letter one of them types at that line's start at that moment can stay as its own paragraph above.
- Rarely an undo reports a change and changes nothing a person can see, without passing to the step before: its step changed a line that someone has since removed. Seen twice in 317,916 undos.
- A setting changed while someone else lifts a line out of the middle of that container shows on the first part only; the later part has the copy made when it was split.
- Records are never deleted, so a note keeps the records of every container it ever had. Measured with random runs: about 27 bytes for each record no line names; a quote, callout or list leaves 4 when it goes and a list item 2; one person wrapping and lifting 2,000 times left 1,486 such records, 41 KB. Nothing removes them yet, and removing them is not safe while an undo or an offline change can still name them.
- A letter typed in an empty line that someone joins away at the same moment lands at the end of the line above.

Unchanged from today (Yjs inside one text), now also reachable across lines:
- One person bolds a word while another deletes it: Yjs would delete a formatting item on the page that receives the delete, in no change. Editors stop that cleanup, and the checks take the history either way (section 5).
- Bold ranges applied at the same moment that overlap can end shorter than either.
- Two people undoing the same deletion of text restore it twice.
- When a join or a delete removes the last item inside a marked range, Yjs drops the range; a letter someone else types or restores there at the same moment is plain. Undoing the join brings the mark back.

Real on Yjs's default undo, avoided by section 4's undo setting, and pinned in `bodySequence.model.test.ts`. Format 1 had both (#4431):
- change a line's kind, join it away in the same undo step, undo: the restored attribute lands under the deleted boundary, and other people, and the same note reopened, differ for good;
- undo of a delete after someone changed the item: the item comes back empty.
