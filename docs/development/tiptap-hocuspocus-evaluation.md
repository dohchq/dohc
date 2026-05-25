# Tiptap + Hocuspocus vs Milkdown/Crepe + Convex prosemirror-sync

**Date:** 2026-05-25
**Branch:** feat/multiplayer-and-h-followups
**Status:** Evaluated — staying on current stack
**Inputs:** codex consult, Context7 docs for Tiptap + Hocuspocus, 50+ commit history on M1 multiplayer arc

## Question

After the multi-week M1 multiplayer arc (50+ commits, ~10 P1 fixes around bootstrap, CAS, parser divergence, presence), is it worth migrating from Milkdown/Crepe + Convex `prosemirror-sync` to Tiptap + Hocuspocus?

User's framing: "the collaboration isn't working that well" + asked for brutal pros/cons + codex's opinion.

## Verdict

**Stay on the current stack.** Switching now would reset the hardening we've paid for, against an architectural problem that Tiptap+Hocuspocus does NOT actually solve unless we also demote markdown from canonical to projection.

## The current stack

- **Editor:** Milkdown / Crepe (ProseMirror-based)
- **Transport:** `@convex-dev/prosemirror-sync` (delta-sync over Convex mutations/queries)
- **Auth:** Native Convex (every sync mutation runs through `checkRead`/`checkWrite`)
- **Storage:** `atoms.body` markdown as source of truth
- **Presence:** Homegrown — `collabSessions` table + `getCursorsForDoc` query + ~2 ProseMirror plugins (~300 LOC total)
- **Suggestions (M3):** AI agent writes via `suggest_in_doc` tool → decoration plugin renders inline → human accepts/rejects with CAS

## The alternative stack

- **Editor:** Tiptap (also ProseMirror-based)
- **Transport:** Hocuspocus (Y.js CRDT over WebSocket)
- **Auth:** Hocuspocus `onAuthenticate` hook bridging to Convex/WorkOS tokens
- **Storage:** Y.js binary blob (Y.Doc), with markdown as derived projection
- **Presence:** Y.js Awareness via `CollaborationCaret` + `useHocuspocusAwareness`
- **Suggestions:** Would need re-implementation as Tiptap extension + Y.js fragment

## What Tiptap+Hocuspocus actually offers

From Context7 docs:

1. **Per-extension markdown contracts.** Every extension defines `parseMarkdown(token, helpers)` + `renderMarkdown(node, helpers)`. The API is cleaner than wrapping Crepe + remark.

2. **Native presence.** ~5 lines to wire `CollaborationCaret` + Y.js Awareness vs ~300 LOC of homegrown plumbing.

3. **Mature ecosystem.** Bigger plugin library, more StackOverflow surface, used in production by larger apps.

## Why we're NOT switching (codex's correction to my initial take)

I initially proposed a hybrid: swap Crepe → Tiptap, keep prosemirror-sync. Codex pushed back hard and was right:

> **Tiptap does not magically solve markdown round-trip.** If `atoms.body` stays markdown, you still need `markdown → editor doc → collaborative doc → markdown`. Parser/serializer drift remains. Different set of bugs, same class.

The pm-body-mismatch / body-changed loops we just fought were NOT prosemirror-sync's fault. They were Crepe's markdown serializer disagreeing with remark's markdown serializer about the canonical form of `[[wikilinks]]`, frontmatter coordinates, escape rules, etc. As long as `atoms.body` is markdown AND any second consumer (agent tools, search, formulas, `/r`, query blocks) reads markdown, you have TWO serializers in play and they will drift.

Tiptap has a nicer API for defining markdown round-trip per-extension, but it's still YOUR responsibility to keep two serializers in agreement. The bugs would be different bugs, not fewer.

**The only architecture that ACTUALLY eliminates parser divergence is making Y.Doc/editor state canonical and demoting markdown to import/export.** That's a much bigger change than "swap the editor" — every dohc feature that reads `atoms.body` markdown (agent tools, search, formulas, `/r`, AI suggestions) would need to migrate to reading from Y.Doc or a derived projection.

## What we'd lose by switching

- **30+ sub-commits of bootstrap/conflict-resolver/projection hardening** — gone or re-derived
- **Native Convex auth on every sync mutation** — replaced by token bridging through Hocuspocus `onAuthenticate`, with separate revocation story for workspace membership changes
- **`atoms.body` markdown-as-truth storage model** — either dual-write (Y.js + markdown) or migrate everything that reads markdown to read Y.Doc
- **All dohc-specific features** — inline atoms, formulas, wikilinks, query blocks, agent suggestion decorations, file-tree presence integration, frontmatter handling — re-implemented as Tiptap extensions (~2 weeks)
- **Single deploy surface** — Convex only. Hocuspocus needs its own Node service with auth, monitoring, scaling, secrets, deploys
- **Sync durability via Convex mutations** — replaced by Y.js binary persistence (decide: Postgres? Redis? Convex blobs?)

Realistic migration: **3-5 weeks of focused work**, plus regression risk in every custom feature.

## What we'd gain

- Cleaner per-extension markdown API (but doesn't eliminate drift while markdown is canonical)
- 5-line presence wiring instead of 300 LOC (but the 300 LOC already works)
- Larger ecosystem (but most dohc features are custom anyway)
- Better-tested CRDT under high concurrency (but we haven't proven prosemirror-sync is unreliable yet)

## Convergence between codex and my analysis

| Point | Codex | Me | Agreement |
| --- | --- | --- | --- |
| Transport-spike decision still sound | Yes | Yes | ✅ |
| Tiptap solves parser divergence | No — same class of bugs | Initially yes, corrected to no | ✅ (after correction) |
| Presence is "good enough" homegrown | Yes | Yes | ✅ |
| Hocuspocus reintroduces rejected infra | Yes | Yes | ✅ |
| Hybrid (Tiptap + prosemirror-sync) | Costs without removing root cause | Initially proposed, withdrew | ✅ (after correction) |
| Switch now | No | No | ✅ |

## When this decision should be revisited

Switch IF AND ONLY IF one of these becomes true:

1. **Offline-first collab becomes a core requirement.** Y.js handles offline edits + sync-on-reconnect natively; prosemirror-sync doesn't.
2. **We decide Y.Doc/editor state should be canonical** and markdown becomes a projection/export. This is the architectural fork that actually fixes parser divergence — and it's much bigger than an editor swap.
3. **We need rich Awareness semantics** (selections + avatars + viewport + ephemeral metadata + offline indicators) that Convex presence can't reasonably cover. Current need is just cursors + names.
4. **`prosemirror-sync` proves unreliable** under real multi-user browser testing. We haven't proven this — most bugs were parser drift, not transport.

None apply now. The 3.9.25 structural fix (pm-body-mismatch demoted to warning + projection writer's case A/B/C handles drift) means remaining multiplayer work is QA + polish, not architecture.

## What to do instead

1. **Multi-browser QA pass** — open the same doc in 2-3 browsers, edit concurrently, accept/reject AI suggestions, verify cursor presence, frontmatter changes, code blocks, math, wikilinks. Confirm 3.9.25 actually holds in practice.
2. **Add a roundtrip idempotency test suite** for `roundtripMarkdown` covering wikilinks, tables, math, HTML fences, query fences, inline atoms, hardbreaks, lists. (Codex called this out as cheap insurance.)
3. **Watch for the four switch-triggers** above. Don't pre-pay for a migration we may never need.

## References

- `docs/development/transport-spike-result.md` — original transport decision (Convex-native over Hocuspocus)
- `docs/development/multiplayer-and-h-followups-plan.md` — M1 plan + sub-commit log
- `docs/development/multiplayer-m1-step3-architecture.md` — bootstrap/CAS/projection architecture
- Tiptap docs: https://tiptap.dev/docs (via Context7 `/ueberdosis/tiptap-docs`)
- Hocuspocus docs: https://tiptap.dev/docs/hocuspocus

## One-line recommendation

**Keep Convex `prosemirror-sync` and Milkdown/Crepe for now; revisit an editor-only Tiptap migration later, but do not move to Hocuspocus unless you are also willing to make Y.Doc/editor state canonical.**
