# Drag revision footprint

The focused test models one element dragged for five seconds at 60 updates per second. It writes 300 full element revisions through `insertElementRevision`.

On 2026-08-12, Yjs 13.6.30 encoded the resulting document as 13,112 bytes. The live revision map contained one revision because each transaction removed the observed revision that its new snapshot dominated. The encoded update still includes the Yjs history needed to merge offline work.

This measurement records the current cost. It does not set a rejection limit.
