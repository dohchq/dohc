# Edit access is multiplayer co-editing, not proposals

Edit access originally never wrote the granter's files: every outside change arrived as a proposal to accept or decline. We retired that invariant for live documents. Edit, for named recipients and link holders alike, means real-time co-editing where edits land in the shared document directly. Clicking "send changes" per edit is not the multiplayer experience dohc claims.

The retirement is conditional on the safeguards existing, not asserted: server-minted principals with durable provenance that survives Y.Doc compaction and settlement, commit-time grant and generation checks, durable append before acknowledgement, a single fenced session host, and a tested owner "stop and restore" action that can fence a hostile live session and apply a forward whole-document restore. Until stop-and-restore works end to end, Edit does not ship to link holders.

## Consequences

- Change proposals remain the only lane for bulk and file-tree changes; link holders get no file-tree operations. [ADR 0013](0013-named-recipients-with-edit-change-collection-files-directly.md) makes one exception for a Collection's own files, for named recipients and share links with Edit.
- Named-recipient browser Edit ships before anonymous Edit, on the same code path.
- An Edit link in hostile hands can rewrite documents. The answer is restore and rotation, not prevention. Rollback is therefore a hard requirement wherever Edit is offered, and it means a whole-document forward restore, not selective removal of one author's interleaved edits.
- The restore shape is settled by the August 2026 restore prototype: a forward restore on the same lineage keeps the full restore point, refuses the fenced principal, preserves unsynced legitimate work (bytes, possibly repositioned), and structurally protects restored text from stale delete sets. Accepted work the vandal already deleted is not recoverable, and the product says so instead of promising otherwise. One residual hazard is guarded explicitly: a permitted client can carry a fenced author's history inside a merged delta, so the host checks merged stale deltas against the journal after a restore.
