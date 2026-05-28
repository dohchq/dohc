# App-wide search — design plan

**Status:** draft / proposal (not yet implemented)
**Goal:** Powerful, workspace-scoped search across **all** documents — by
title *and* full content — where "content" includes markdown prose, the
visible text of `type: html` atoms, and the text inside ASCII
**sketches** (` ```ascii ` fenced blocks). Reactive, fast, and Convex-native.

This plan was researched against the current Convex full-text-search
capabilities (via Context7) and reviewed twice with Codex + subagents.
Decisions and the pitfalls they flagged are recorded inline.

> **Review round 2 corrections (folded in):** (a) `upsertAtomImpl` is **not**
> the only atom write path — `atoms.move`, `folders.move`, and trash
> restore mutate path/body directly, so indexing must be centralized
> through a shared helper, not hooked at one mutation (§5). (b)
> `isSearchable` must **not** be `!isNonDataAtom` — that predicate
> excludes HTML atoms, which we must search; `searchable` gets its own
> rule (§5). (c) `htmlSanitize.ts` is server-only (Node/jsdom), not
> client-only; Convex still needs its own regex stripper. (d) Dropped the
> unused `searchTextTruncated` field; committed the recent-docs empty
> state and the open decisions (§6, §13).

---

## 1. Requirements

**Functional**
- Search the whole workspace from one place (a search surface, e.g. ⌘K).
- Match on **title**, **path/filename**, and **body content**.
- Body content covers all three content shapes, which all live in the
  atom `body` string:
  - markdown prose,
  - raw HTML (`type: html` atoms) — match the *visible text*, not tags,
  - ASCII sketches (` ```ascii ` fenced blocks) — the art *is* text in
    the body, so it is covered for free.
- Results show a **highlighted snippet** of the matched context.
- Selecting a result opens the atom (later: scrolls to / highlights the match).
- **Reactive** — results reflect edits without a manual reindex.

**Non-goals (v1)**
- Semantic / "find what I mean" search (deferred to V3 — see §10).
- Cross-workspace / org-wide search.
- OCR of raster images (we have no raster sketches; ASCII sketches are text).
- Search inside binary attachments.

---

## 2. Current state

- Documents are **atoms**: the Convex `atoms` table
  (`apps/app/convex/schema.ts`). Relevant fields: `workspaceId` (tenancy
  key), `path`, `body` (string), `updatedAt`, `source` (`'user'|'agent'`),
  plus derived `type` (`'html'|'skill'|null`) and a frontmatter-derived
  title.
- **There is no document search today.** The ⌘K palette
  (`apps/app/src/components/CommandPalette.tsx`) only filters *commands*
  and *skills* by title — it never looks at document content.
- All writes funnel through one impl: **`upsertAtomImpl`**
  (`apps/app/convex/atoms.ts:73`), called by the public `upsert`
  mutation, `_upsertInternal` (agent), and `_upsertSystem`. This
  is the single hook point for indexing.
- Pure, server-safe text helpers already exist in
  `apps/app/convex/atomId.ts`: `splitFrontmatter`, `isHtmlAtomBody`,
  `deriveTitle`, and `isNonDataAtom` (the predicate for HTML/skill
  non-data atoms).
- Context atoms such as `me.md` and `intent.md` are user-readable files
  and should remain searchable.

---

## 3. Engine decision

**Decision: Convex native full-text search is the v1 primary engine.**

Why it fits dohc:
- Search lives **beside the data** — no second datastore, no sync
  pipeline, no extra operational surface.
- **Reactive** by default (a `useQuery` over the search re-runs as atoms
  change), which matches the rest of the app.
- **Workspace-scoped** cleanly via a search-index `filterField`.
- Keeps the "own your data / Convex-native" promise credible.
- Handles exactly what semantic search is *bad* at: filenames,
  identifiers, headings, code-ish text, ASCII art, and remembered exact
  phrases.

### Convex FTS — confirmed capabilities & limits (Context7)
- A `searchIndex` has **one** `searchField` and up to **16** `filterFields`.
- **4** search indexes per table; **16** terms per query; **8** filter
  expressions per query; term length capped at **32 chars** (lowercased);
  search scans at most **1024** results.
- Tokenizes on whitespace/punctuation, optimized for English/Latin;
  relevance-ordered with prefix + fuzzy matching on the last term.
- A query: `ctx.db.query("atoms").withSearchIndex("search_text", q => q.search("searchText", terms).eq("workspaceId", ws).eq("searchable", true)).take(40)`.

### Alternatives considered (and when we'd revisit)
| Option | Verdict | Revisit when |
|---|---|---|
| **Convex FTS** (chosen) | v1 primary | — |
| Convex **vector** / first-party **RAG** component | Additive, not primary | V3 semantic layer (§10) |
| Client-side (Orama / FlexSearch) | No | Never a good fit — leaks data to client, tenancy/sharing get awkward, staleness |
| External (Typesense / Meilisearch / Algolia) | Deferred | Workspaces routinely exceed ~tens of thousands of atoms, or we need faceting / full typo-tolerance / custom ranking / the 1024-scan cap starts hiding results. Reach for **Typesense or Meilisearch** first; Algolia only if hosted relevance/ops outweigh data-ownership/cost. |

---

## 4. Data model changes

Convex FTS indexes **one** field, so we maintain a **derived** field on
each atom (chosen over a separate `atomSearch` table for v1 — colocated,
fewer sync failure modes; revisit if/when we need chunking, §10).

Add to `atoms` (`schema.ts`), all optional/additive (back-compatible):

```ts
// derived on write — see §5
searchText: v.optional(v.string()),   // indexed: title×3 + path + plaintext(body)
searchable: v.optional(v.boolean()),  // reserved for future visibility controls
```

Search index:

```ts
.searchIndex("search_text", {
  searchField: "searchText",
  filterFields: ["workspaceId", "searchable"],
  staged: true, // async backfill on an existing table — see §5
})
```

**Title/path ranking.** With a single field we cannot set per-field
boosts, so we (a) **compose** `searchText` with the title repeated **3×**
and the path/basename near the top, and (b) apply a cheap **post-rank** in
the query handler (§6). Repetition only *nudges* Convex relevance (term
frequency is a documented-but-changeable heuristic, not a contract); the
**post-rank is the reliable mechanism** for title priority. (Codex:
two-index merge isn't worth it — Convex relevance scores don't compose
cleanly across indexes.)

**Read-amplification trade-off (accepted for v1).** Because `searchText`
lives on the `atoms` row, `withSearchIndex` loads the **full matched atom
docs** (body + searchText) server-side, even though we only return
`{path, title, snippet}`. That's fine at our scale and keeps v1 to one
field. The escape hatch — and the real reason for **V2** (§10) — is a
compact `atomSearch` table (only the derived fields), which avoids loading
bodies and enables chunking. Adopt it when bodies get large or result
counts grow.

---

## 5. Indexing pipeline

**Compute synchronously, at every write that changes an atom's `path` or
`body`.** Search must be correct immediately after save (async indexing
creates "I just saved it but can't find it" gaps). The new pure helper is
the single source of truth; the work is making sure **every** write site
calls it.

> ⚠️ **`upsertAtomImpl` is NOT the whole write surface** (review round 2).
> It covers content authoring (the `upsert` mutation, `_upsertInternal`
> for the agent, `_upsertSystem` for the loop, `upsertSharedAtom`,
> `setIcon`). But these mutate `path`/`body` **directly**, bypassing it,
> and would leave stale or missing `searchText`:
> - `atoms.move` — insert at the new path + wikilink-cascade body patches
>   on bystander atoms (`atoms.ts:580`, `:673`)
> - `folders.move` — moved-atom inserts + bystander body patches
>   (`folders.ts:326`, `:437`)
> - trash restore — direct re-insert (`trash.ts:156`)
> - body migrations (`atoms.ts:1006`, `skillsMigration.ts:131`) and `seed`
>   (`seed.ts:754`)
>
> **Resolution:** introduce a tiny shared helper
> `withSearchFields(path, body, row)` that returns the row plus
> `{ searchText, searchable }`, and route **every** `ctx.db.insert`/`patch`
> that touches an atom's path or body through it (or call
> `deriveSearchFields` inline at each chokepoint). `setLock`/`setStar` only
> touch flags — no recompute needed. A test should assert no raw atom
> path/body write exists outside the helper (audit-by-grep, like the
> existing `_upsertSystem` audit).

New pure module (server-safe — Convex isolates have **no DOM**):

```ts
// convex/searchText.ts  (pure, unit-testable)
deriveSearchFields(path, body): { searchText: string; searchable: boolean }
```

`searchText` rules:
- Strip frontmatter (`splitFrontmatter`) — but keep the derived title.
- **markdown:** light-strip high-noise syntax; keep heading/list/link/code
  text. Don't over-normalize (real words/filenames help relevance).
- **HTML** (`isHtmlAtomBody`): strip `<script>/<style>/<!--…-->`, then strip
  tags to text and decode entities — **with a regex/parser, not DOMPurify**.
  `htmlSanitize.ts` is a **server-only** Node/jsdom module (not importable
  by Convex); Convex needs its own small stripper. This is *best-effort*
  text, not true browser-visible text — write tests, don't oversell it.
- **ASCII sketches:** keep as-is (it's the content).
- Compose: `` `${title}\n${title}\n${title}\n${basename(path)}\n${path}\n${plaintext}` ``.
- **Cap** plaintext at ~128 KB. Note `searchText` **duplicates** body bytes
  on the same row, so cap matters: a large body + its `searchText` must
  stay under Convex's 1 MB document limit. (Truncate silently — no
  `searchTextTruncated` field in v1; nothing consumes it. Reintroduce it in
  V2 when chunking actually branches on truncation.)

`searchable` rule — **do NOT use `!isNonDataAtom`**: that predicate returns
`true` for HTML atoms (`.html` / `type: html`, `atomId.ts:268`), which we
**must** search. Define it explicitly: `searchable = true` for normal
content atoms **including HTML, markdown, and context files like
`me.md`/`intent.md`**. Compute once here (an indexed `filterField`), never
re-check paths at query time.

**Backfill (existing atoms):**
1. Ship the schema fields (nullable) + the write-site changes (helper at
   every chokepoint).
2. Run a **paginated internal mutation** (`.take(n)` +
   `ctx.scheduler.runAfter(0, …)` self-continue) to **populate**
   `searchText`/`searchable` on existing rows. Batch by **bytes**, not just
   row count — recomputing many large bodies can hit the per-transaction
   byte limit well before the row-count cap.
3. A **`staged: true`** search index only *indexes* what's there — it does
   not compute `searchText`. So: populate (step 2) → let the staged index
   build → only then flip the query (§6) to it. Gate the UI on a completion
   marker.

---

## 6. Query layer

A single workspace-scoped query (`convex/search.ts`):

```ts
export const run = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) => {
    const workspaceId = await requireWorkspace(ctx)   // tenancy, server-derived
    const terms = normalize(query)                    // lowercase; ≤16 terms; trim
    if (!terms) return []
    const rows = await ctx.db.query("atoms")
      .withSearchIndex("search_text", q =>
        q.search("searchText", terms).eq("workspaceId", workspaceId).eq("searchable", true))
      .take(40)
    return postRank(rows, query).map(r => ({
      atomId: extractFrontmatterId(r.body), path: r.path,
      title: deriveTitle(r.body, r.path), type: r.type,
      updatedAt: r.updatedAt, snippet: makeSnippet(r, terms),  // §7
    }))
  },
})
```

- **`workspaceId` filter is mandatory** — never search globally and filter
  client-side (§9).
- **`normalize`** lowercases, splits, caps at 16 terms (Convex limit;
  pasted prose/prompts otherwise overflow), and trims tokens. Long
  identifiers (>32 chars) still match by prefix.
- **`postRank`** re-orders the FTS results: exact title match → title
  prefix → path/basename match → title contains all terms → else FTS
  order. Blunt but effective for title priority. **Caveat:** post-rank only
  re-orders the rows FTS already returned in the top `.take(40)` — it can't
  rescue a title hit that ranked below the cutoff. The 3× title composition
  is what gets those hits *into* the 40; accept slightly imperfect recall,
  or raise the take.
- Returns **only** `{path/atomId, title, type, updatedAt, snippet}` — never
  full bodies for every hit (Codex pitfall). The matched docs are already
  loaded by the query, so the snippet is computed without extra reads.
- **Empty / too-short query → recent docs (v1 requirement).** Empty or
  1-char / punctuation-only input short-circuits *before* the index and
  returns the N most-recently-updated searchable atoms (a `by_workspace`
  index ordered by `updatedAt`). A search box that opens to a blank void
  feels broken; recent-docs is the highest perceived-quality-per-effort win.
- **Very broad queries** (`"the"`, `"project"`): rely on relevance + the
  top-N cap and show a "refine" hint — the 1024-scan cap means very broad
  queries can hide later docs.

---

## 7. Snippets & highlighting

Convex returns rows, not highlighted snippets — generate them ourselves.

- For each top-N row, compute a snippet **server-side** from the matched
  text: find the first/best occurrence of the query terms, take a ~160–240
  char window around it. If the match was in the title/path, snippet that.
- **Match the way Convex tokenizes**, or highlights will look broken: split
  on whitespace/punctuation, lowercase, and treat the **last term as a
  prefix** (Convex prefix-matches it). Naive whole-string `indexOf` will
  miss/mis-highlight stemmed and prefix matches.
- Return the snippet as **escaped text + match offsets** (or pre-split
  `{before, match, after}` segments). The client highlights with markup —
  **never inject raw HTML** from document content.
- Compute the snippet from a **clean plaintext** window, not from the
  indexed `searchText` (which repeats the title and is noisy). For v1,
  derive that window from the row's `body` on demand (the row is already
  loaded). If snippet cost/quality needs it later, store a clean
  `searchPlaintext` field — deferred to keep v1 to one new indexed field.

---

## 8. UI / UX

- **Surface:** extend the existing ⌘K palette with a document-search mode
  (it currently does commands only), or add a dedicated **Search** view in
  the activity bar / a `⌘⇧F` "search in files". Recommendation: a
  dedicated search mode so document results don't crowd command results.
- **Results:** reactive (`useQuery(api.search.run, { query })`), debounced
  input. Each row: type/emoji icon + **title** + dim **path** +
  highlighted **snippet** + a small `html`/`skill` badge. Group or label
  by result kind (user docs vs system) if needed.
- **Open:** Enter opens the atom (reuse `onOpenAtom`). Follow-up:
  scroll-to + highlight the match in the editor (Milkdown/CodeMirror) —
  larger, deferred.
- Keyboard nav + empty/zero-result states, consistent with the palette.

---

## 9. Security & scoping

- `workspaceId` is a **filterField** on the index and an `.eq()` on every
  query; tenancy is derived server-side via `requireWorkspace`. **Never**
  search globally then filter on the client, and never return a snippet
  before authorization.
- **System/reserved atoms** are excluded via the `searchable` flag, not
  ad-hoc path checks at the call site.
- **Shared-with-me** documents are *not* the same as `workspaceId` — they
  come from `atomShares`. Searching them is a **separate access-aware
  path** (or an explicit searchable-ACL), deliberately **out of v1 scope**.
  Do not fake it with the single workspace filter.

---

## 10. Phasing

- **V1 — keyword (this plan):** `atoms.searchText` FTS, `workspaceId` +
  `searchable` filters, derive plaintext on write, capped index,
  title/path boosting via composition + post-rank, server-side snippets,
  ⌘K/search-view UI.
- **V2 — chunking (if large docs hurt quality):** an `atomSearchChunks`
  table (multiple search records per atom) for per-section results and to
  dodge the single-doc length/relevance limits.
- **V3 — semantic hybrid:** add embeddings (Convex `vectorIndex`, action
  context only, or the first-party **RAG** component) **over chunks**, also
  `workspaceId`-filtered. Combine with keyword via reciprocal-rank fusion:
  `score = kw/(k+kwRank) + sem/(k+vecRank)`, then title/recency boosts.
  Keyword stays required; semantic is additive. Vector results must
  respect tenancy before any content is revealed.

---

## 11. Risks & pitfalls (watch list)

- **Incomplete indexing (top risk):** missing a write site — `atoms.move`,
  `folders.move`, trash restore, migrations, seed — leaves stale/missing
  `searchText` after renames/moves/restores. Centralize via the shared
  helper + an audit-by-grep test (§5).
- **`searchable` mis-defined:** `!isNonDataAtom` would exclude HTML atoms
  (and not exclude `me.md`/`intent.md`). Use the explicit rule (§5).
- Indexing raw HTML without stripping `script`/`style`/tag noise → garbage matches.
- Letting generated/system noise dominate → fixed by `searchable` when a
  concrete hidden system artifact exists.
- Trying to make Convex FTS behave like Algolia (complex field boosting) — don't; use composition + post-rank.
- Forgetting **path/filename** search.
- The **1024-scan cap** hides later docs on very broad queries; the
  **16-term cap** truncates pasted prose; the **32-char term cap** hurts
  hashes/long URLs — normalize queries and message "refine".
- Storage: derived text duplicates body; cap it, and don't double-store
  unless snippets demand it.
- Sending full bodies per result (perf) — return snippets only.
- Shipping semantic as v1 while still lacking exact search.
- No backfill story for existing atoms.

---

## 12. Testing

- **Unit (pure):** `deriveSearchFields` for md / HTML / ascii / frontmatter
  / 128 KB cap; `searchable` (**includes** HTML + `me.md`/`intent.md`
  and former map paths);
  `normalize` (16-term cap, lowercase, doesn't throw on pasted prose);
  `postRank` ordering; `makeSnippet` window + escaping + prefix-on-last-term.
- **Integration (`convexTest`):** seed atoms across workspaces → assert
  search is workspace-scoped, ranks title matches first, finds text inside an ascii sketch and inside an HTML atom's
  visible text, empty/short query returns recent docs, and a **rename
  (`atoms.move`) updates `searchText`** (the write-surface regression test).
- **Audit:** grep-test that no atom path/body `insert`/`patch` exists
  outside the shared search-fields helper.
- **Security:** explicit cross-tenant isolation test (workspace A's query
  never returns workspace B's atoms or snippets).

---

## 13. Open questions

**Resolved (review round 2):**
- ~~Search surface~~ → **dedicated Search view** (don't crowd the command palette).
- ~~Shared-with-me in v1?~~ → **own-workspace only**; shared-with-me is a separate access path, V2+.
- ~~`searchPlaintext` field now?~~ → **No** — compute the snippet window from `body` on demand in v1.
- ~~Title repetition count~~ → **3×**.

**Still open:**
1. Snippet fidelity: is one window enough, or do we want multiple match windows per result?
2. Editor "scroll-to-and-highlight match" — v1 or follow-up? (Recommend follow-up.)
3. Should `skills/*` atoms be searchable? (Lean: searchable — they're real content.)

---

## 14. Rough sequencing

1. `convex/searchText.ts` (`deriveSearchFields`: `searchText` + `searchable`) + unit tests.
2. Schema fields; route **every** atom path/body write through the shared
   helper (`upsertAtomImpl`, `atoms.move`, `folders.move`, trash restore,
   migrations, seed) + the audit-by-grep test.
3. Backfill internal mutation (byte-batched); run it; add `search_text`
   staged index; verify it builds before the UI reads it.
4. `convex/search.ts` `run` query (workspace + searchable filters,
   normalize, post-rank, snippets, empty→recent) + tests.
5. Dedicated Search view with debounced reactive results + highlighting + recent-docs empty state.
6. Cross-tenant security test + rename-reindex regression test; QA across md / html / ascii.
7. (Later) V2 chunking, V3 semantic hybrid.
