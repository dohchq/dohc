# How many changes one share submit carries

Decision record for [#799](https://github.com/dohc-ai/dohc/issues/799).
Measured against `e261f82c`. This is the "record the evidence" half of the
`AGENTS.md` rule *Measure limits that reject work*.

**Decision: one submit carries 2,500 net-changed files, and the granter's
review loads a file's content only when the granter opens that file.**

---

## Why the old number rejected healthy work

`#794` bounded a submit at 500, derived from `MAX_OPS_PER_REQUEST` — the page
size of the replication lane. Nothing measured what a person actually changes.

Measured from this repository's own history, which is agent-built work of the
kind dohc is for. 573 commits sampled.

Files changed per commit:

| p50 | p90 | p99 | max |
| --: | --: | --: | --: |
| 4 | 18 | 83 | 158 |

No single commit comes near 500. But a submit is not a commit. It is the net
change set since the last press:

| window | net changed files |
| --- | --: |
| 1 day | 62 |
| 3 days | 331 |
| **7 days** | **519** — over the old bound |
| 14 days | 733 |
| last 100 commits | 688 |
| **whole repo — first share of a repo-sized folder** | **1,434** |

A folder selector reaches this in one step. `MAX_SHARE_PATHS` bounds selector
*entries*, not files, and matching is a prefix test, so one entry like `docs`
grants every descendant.

**Healthy work reaches 1,434 files. The bound sat at 500, inside that range.**

## What the relay actually costs

Driven through the real routes at growing op counts, with a corpus modelled on
this repository (1,434 files, 47-character paths, 18.9 KB mean file).

| ops | submit body | submit | relay stalled | insert txn | review GET | review body | accept |
| --: | --: | --: | --: | --: | --: | --: | --: |
| 100 | 38 KB | 10 ms | 15 ms | 5 ms | 4 ms | 35 KB | 11 ms |
| 500 | 191 KB | 25 ms | 24 ms | 9 ms | 18 ms | 174 KB | 45 ms |
| 1,000 | 383 KB | 55 ms | 54 ms | 9 ms | 34 ms | 348 KB | 96 ms |
| 2,500 | 959 KB | 111 ms | 110 ms | 12 ms | 78 ms | 871 KB | 179 ms |
| 5,000 | 1.87 MB | 259 ms | 259 ms | 14 ms | 212 ms | 1.70 MB | 465 ms |

One change on the wire is 393 bytes. Everything is linear; there is no knee.

- **Body size never binds.** The HTTP front door caps a body at 21 MiB, which
  admits about 55,000 changes.
- **The write lock is not the cost.** `BEGIN IMMEDIATE` around the proposal
  insert holds for 14 ms at 5,000 changes.
- **What blocks is the whole handler.** `node:sqlite` is synchronous and the
  relay is one process, so stall tracks wall time almost exactly. The cost is
  per-op validation, not the commit.
- **Accept is the most expensive step** and applies every change in one
  transaction.

## The cliff was the review, not the relay

| cliff | height | kind |
| --- | --: | --- |
| **Granter review dialog** | **500** | **hard** — the dialog could not open |
| Sequential blob upload | ~2,500 | soft — user patience |
| Relay CPU | ~10,000–20,000 | soft — single-process blocking |

The review read carried both sides' full text for every file. At 500 files that
is about **19 MB** in one IPC message, plus 500 concurrent relay blob fetches
and 500 local file reads — and the bound check that would have refused an
oversized body ran *after* all of that work. Rows were not virtualized, and
each carried up to 800 diff lines.

The relay was comfortable at 5,000 the whole time. **500 was protecting a
renderer that had been written to the relay's paging number.**

## What shipped

1. **`MAX_SHARE_PROPOSAL_OPS = 2,500`**, in
   `packages/security-contract/src/shareProposalBound.ts`, enforced by the
   relay's proposal route and by the engine's submit scan. It is 1.7x above the
   measured healthy maximum and leaves 4x margin below where the relay starts
   to cost real time.
2. **`MAX_OPS_PER_REQUEST` stays 500** and keeps its two log routes. A submit is
   one user act carrying one intent; a page is a page. Raising the page size
   would only lengthen every replication stall.
3. **The review reads metadata only** — paths, drift, operation, size. A file's
   two sides arrive through `readShareProposalFileContent` when the granter
   opens that file, served by a new single-op relay route so one expand does
   not re-serve every op of every open proposal.
4. **Over the bound is still not a refusal.** The recipient's scan stops at the
   bound, sends what it holds, and reports that more is waiting.

### Review data at 2,500 files

| | before | after |
| --- | --: | --: |
| IPC payload to open the review | ~95 MB (projected; refused in practice) | **871 KB** |
| Relay fetches to open the review | 2,500 blob GETs | **1 proposal read** |
| Local file reads to open the review | 2,500 | **0** |
| Diff lines rendered on open | up to 2,000,000 | **0** |
| Cost of reading ONE file | — | **2 relay fetches + 1 local read** |

The IPC figures measure the read that OPENS a review, not a file read. Opening
one file costs two relay round trips — its op row, then its after-blob — and one
local read of the granter's own copy, and it carries only that file's two sides.
The 871 KB is the relay's own measured listing body at 2,500 ops; the IPC rows
carry the same fields minus the ones the surface does not render.

The granter's polled listing is separate again: it carries counts, so a tick
costs no per-file work at all.

## Not chased

**The recipient's share-blob upload route is superlinear.** Per-blob cost went
4.2 → 5.0 → 6.9 → **21.1 ms** at 500 / 1,000 / 2,500 / 5,000 blobs, while the
granter's own blob PUT stayed flat at 4.2–4.9 ms. It is the only non-linear
cost found.

The measurement cannot separate route cost from database growth: the recipient
always uploads into a database the granter has already filled. The candidate
cause is the per-upload allowlist scan over the log. Uploads are sequential and
land before the submit regardless of the op bound, so at 2,500 files this is
roughly a minute of relay CPU either way.

**Recorded, not fixed.** It needs its own measurement, and it is not what this
change is about.
