RESTORE VIABLE WITH CONSTRAINTS

# Stop-and-restore prototype result

The same-document forward restore converged and kept the complete restore-point text. It did not recover legitimate edits that V had already deleted, and the edits that survived did not keep their original positions. A successor lineage stayed clean only when it refused and reset every old-lineage client.

## Test setup

The prototype ran on Node v24.16.0 with Yjs 13.6.30. One host `Y.Doc` accepted updates from A, B, and V. Each client edited the same `Y.Text` from the same start-of-round state. The host accepted each round's three updates in an interleaved order, then broadcast them.

- 30 rounds
- First destructive V batch in round 18
- Restore point at server sequence 55
- 91 journal entries and 5,145 bytes of Yjs update payload before restore
- 2,220 characters at the restore point
- 280 visible characters immediately before restore
- 36 legitimate A/B operations after the restore point, totalling 900 inserted characters
- 24 accepted operations with 480 characters
- 12 unsynced operations with 420 characters

The journal stored the update bytes, server sequence, author, and timestamp outside the document. Recovery counts use Yjs struct IDs and visible struct intervals. They do not depend on finding marker strings in the final text.

## Restore measurements

| Shape | Restore-point text after reconnect | Legitimate work recovered | Client convergence | V reconnect |
| --- | ---: | ---: | --- | --- |
| Update on the same document | 2,220 of 2,220 characters | 420 of 900 characters, 12 of 36 operations | A and B converged without a reset | A 172-byte post-fence delta was refused; host state did not change |
| Successor with enforced lineage | 2,220 of 2,220 characters | 0 of 900 characters, 0 of 36 operations | A and B converged after an automatic hard reset | Old lineage refused; host state did not change |
| Successor with direct old-lineage merge, unsafe control | 48 of 2,220 restore-point characters remained | 481 of 900 characters, 15 full and 1 partial operation | A and B converged to the wrong state | V's direct delta was refused, but A had already carried V's state back |

Same-document recovery by author:

| Author | Post-point operations | Post-point characters | Full operations recovered | Characters recovered | Characters lost |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 18 | 450 | 6 | 210 | 240 |
| B | 18 | 450 | 6 | 210 | 240 |
| Total | 36 | 900 | 12 | 420 | 480 |

All 24 accepted post-point operations, 480 characters, had already been deleted by later V updates. Yjs deletions are permanent for those structs. The forward restore could not make them visible again. All 12 unsynced operations, 420 characters, survived because the restore transaction had never seen their structs.

The 420 recovered characters occupied positions 0 through 419 in the final 2,640-character document. They had been authored at other positions. The content survived, but its placement did not.

## Successor lineage result

The safe successor replayed journal entries through sequence 55 and added a marker for `lineage-2`, whose parent was `lineage-1`. It refused A's 1,058-byte stale-lineage delta, B's 1,050-byte delta, and V's 720-byte delta. Automatic reset made both legitimate clients converge, but it discarded all 900 post-point characters.

The unsafe control accepted A's stale-lineage delta. That one reconnect carried inserted structs first recorded as follows:

| Original author | Inserted characters carried by A |
| --- | ---: |
| V | 912 |
| B | 240 |
| A, already accepted | 240 |
| A, previously unsynced | 210 |

The delta also carried a delete set with 3,332 character intervals. Applying it deleted 2,172 of the 2,220 restore-point characters and left 171 visible characters from V's destructive batches. A and B converged, but convergence did not preserve the restore.

The V fence checks the sender. It cannot remove V structs and delete sets that an allowed client learned before the fence and later retransmits.

## Offline editor edge case

A stayed offline from the restore point through the whole vandalism and restore. A made 40 local operations with 1,800 inserted characters.

| Shape | Characters recovered | Operations recovered | What A saw |
| --- | ---: | ---: | --- |
| Update on the same document | 1,800 of 1,800 | 40 of 40 | A converged on a 4,440-character document. A's recovered work occupied positions 0 through 1,799, before the restored text. |
| Successor with enforced lineage | 0 of 1,800 | 0 of 40 | The old lineage was refused. After automatic reset, A saw the 2,220-character restore point. |
| Successor exception that accepts this offline delta | 1,800 of 1,800 | 40 of 40 | A converged, and no destructive V characters entered the successor. |

The exception worked because this A replica had never received a post-point update. Its 2,581-byte delta had no delete set. The server cannot infer that safety from the old lineage alone. An online A replica used the same lineage but carried V's destructive state.

## Attribution

The journal covered 100% of visible character structs in every measured final document when the reader decoded updates and assigned each struct ID range to its first journal author.

For the same-document shape, direct authorship after restore was:

- A: 210 characters
- B: 210 characters
- `OWNER_RESTORE`: 2,220 characters

The restore transaction reinserted the restore-point text, so Yjs identifies the owner as the direct author of those 2,220 new characters. Replaying the journal through sequence 55 recovered the source breakdown for that text: owner 1,320, A 360, B 360, and V 180. Mapping those source regions onto the restore update requires the restore-point sequence and positional mapping. The update journal does not preserve that distinction inside the new Yjs structs by itself.

A state-vector reconnect update can repeat old structs and delete sets. The journal must retain first-seen struct ID provenance. Assigning the complete reconnect delta to its transport author would have mislabeled 912 V characters and 240 B characters as A in the unsafe control.

## Benchmark

The benchmark kept a 50,000-character document at a fixed length while three clients produced 3,000 accepted journal updates, including the initial 50,000-character update.

| Measurement | Result |
| --- | ---: |
| Wall time | 172.4 ms |
| Raw Yjs update bytes | 127,641 bytes |
| Mean update payload | 42.547 bytes |
| Framed journal estimate | 333,538 bytes |
| Final convergence | Yes |

The framed estimate includes each update, a four-byte update-length field, and newline-delimited JSON for sequence, author, and timestamp. It excludes database pages, indexes, replication overhead, and filesystem allocation. The whole prototype run, including both restore shapes and the edge case, took 223.5 ms.

## Sharpest failure

An allowed stale client can reintroduce a fenced participant's accepted Yjs history. In this run, A's first successor reconnect re-deleted 97.8% of the restored baseline. Transport authorization passed because A sent the delta. A principal fence does not identify the authors inside a merged Yjs state update.

Hard lineage refusal prevents that failure but turns every old client into a reset. It lost 100% of the legitimate post-point and offline work in this prototype. Same-document restore avoided resurrection, but surviving offline inserts moved to the start of the document. Character recovery was not placement recovery.

## Favored forward-restore shape

The evidence favors update-on-same-doc.

It kept all restore-point characters, accepted uncontaminated new structs from A and B, converged without resetting them, and refused V's new updates. The same lineage made old V deletes harmless against the new owner restore structs because those delete sets did not include the new struct IDs.

This shape has three constraints:

1. The owner action must revoke or downgrade V before it writes the restore update. Every later V update must fail at commit.
2. The product must treat all accepted work after the restore point as lost unless a separate recovery tool reconstructs it. The test lost all 480 such characters.
3. Surviving unsynced work needs review or explicit reapplication. Yjs convergence preserved its bytes but moved them to a different location.

The successor shape is cleaner only if the product chooses isolation over local continuity and resets every old-lineage client. Direct Yjs merge from an old lineage is not a safe recovery path.

The prototype code was throwaway and is not retained; this result and the lane brief (share-links campaign ledger) are sufficient to re-create the drill for the Phase 4 gate.
