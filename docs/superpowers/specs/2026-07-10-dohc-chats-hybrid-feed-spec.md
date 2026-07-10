# dohc Chats — Hybrid Feed Spec

Status: foundational direction, rev 2 (supersedes the interface/organization
sections of the exploratory design; data model reconciled against the shipped
engine; incorporates multi-agent review findings)
Date: 2026-07-10
Refines: `docs/superpowers/specs/2026-06-23-dohc-chats-design.md`
Companions: `2026-07-10-dohc-chats-agent-runner-spec.md` (dispatch),
`2026-07-10-dohc-chats-cli-spec.md` (agent interface)

## Summary

dohc Chats is a **channel-organized feed where humans and agents collaborate**.
Each channel holds a feed of **posts**; each post opens into a **comment
thread**. The visual language is a **hybrid**: soft comment bubbles for warmth
rendered entirely in dohc's paper + graphite + mono system with a serif post
title. Agents are first-class participants; posts attach to real workspace
objects.

The framing that makes this core to dohc rather than a bolted-on chat UI:
**humans steer, agents report, work is attached, everything is text.** For the
solo user, the feed is not social media — it is the morning report of what
their agents did and the queue of decisions that need them. Humans and agents
share the same primitives with different defaults, so a second human joining
later is just another actor, not a new system.

This spec locks the product shape and UI. Dispatch (how a message makes an
agent work) and the agent interface (CLI) are specified in the companion
specs. Chat rides the existing transport: local SQLite engine + append-only
replication log + sync relay. That is not an open question — it is shipped
(through MU-C6) and this design extends it.

## Decisions locked

1. **Organize by channel.** Channels are few, stable, and **user-created
   only** — agents create posts and comments, never channels.
2. **A channel is a feed of posts;** a post opens into a comment tree.
3. **Comments nest 3 levels, then flatten** with a `↳ replying to <name>` tag;
   long branches collapse behind "continue this thread →". No mainstream tool
   does infinite nesting; three levels preserves useful branching
   (question → answer → confirm) while staying phone-legible.
4. **True parent is stored; the depth cap is presentation only.** The real
   `parentMessageId` is always persisted; render depth is a view decision.
5. **Visual style: the hybrid.** Bubbles in the `--bubble` warm-paper surface,
   serif post titles, mono metadata, graphite active states, quiet reaction
   pills. Approachable without reading as a social-media clone.
6. **Agents are first-class.** Agent content renders as `<User Name>'s agent`
   with an agent-tinted bubble edge and `agent` badge. Agent messages carry a
   run chip linking to the run record (report in chat, trace behind the chip —
   never transcript streaming).
7. **`needs decision` is a typed, per-message state, not a label.** A
   decision is a record on the triggering message (`open | resolved`, with
   the resolving message id), and a message carries at most one decision
   record. A post or report that raises several independent decisions does so
   by posting several `--needs-decision` messages, one per decision; v1 has no
   `decisionId`. The thread renders needs-decision while any decision on it is
   open. The leave transition has explicit producers on both actor surfaces:
   the CLI's `--resolve <message>` on `reply` (the resolving reply is the
   recorded leaving message) and a UI resolve gesture on the decision chip;
   anyone who can post in the thread may resolve. The cross-channel queue of
   open decisions is the future inbox — the type exists from day one so it
   can be queried, even though the inbox surface comes later.
8. **Posts attach to work** via source-context chips. v1 targets files
   (extending the shipped `LinkedChatFileRef` pattern to per-message links);
   versions, agent runs, and decisions follow. Every attached object is
   re-authorized/redacted per the base design's shared-channel and
   secret-redaction rules before render, search, notification, projection, or
   export.
9. **Reactions ride the shipped model.** `ChatReaction` (message-keyed,
   tombstoned set — MU-C2) is unchanged; a *post's* reactions are reactions on
   its opening message. No re-keying.
10. **DMs are a running stream, not a feed — and the agent-DM is a new
    kind.** The post+comment shape is for channels; DM conversations keep
    the linear message stream (resolving former open question 2). But
    "DM-your-agent" cannot ride today's DM primitive: shipped DMs are
    human-to-human and grant-based (email recipient → relay grant), and an
    agent has no relay identity to grant to. The agent-DM is a distinct
    `ChatChannelKind: "agent"` — auto-provisioned, owner-only, never
    share-granted, replicating over the owner's own-device lane — defined in
    the runner spec (decision 4). Projection defaults and presence scoping
    key on the new kind, not on `kind:"dm"`.
11. **Three surfaces, one style:** channel feed, opened thread, and a
    narrow/mobile-ready layout — all in the same paper+graphite bubble
    language. Honesty about "mobile": no phone client exists — the desktop
    app is the only shipped client and workspace-api is auth-only — so v1
    ships the narrow layout in the desktop renderer, and the actual phone
    client is a separate deferred client workstream (auth, relay
    append/pull, push notifications, chip rendering, decision submission).
    The "decide from your phone" flagship claim is gated on that spec; the
    dispatch loop is built so the phone plugs in unchanged.

## Data model (reconciled with the shipped engine)

Extends the shipped primitives in `packages/workspace-contracts/src/engine.ts`
/ `packages/workspace-engine/src/linkedChatStore.ts`: `ChatChannel`,
`ChatThread`, `ChatMessage`, `ChatReaction`, `ChatThreadReadState`. All remain
workspace-scoped. (The earlier draft named `ThreadMessage` / `ThreadActivity`
/ `ThreadLink` from the exploratory design; the first is really `ChatMessage`
and the other two were never built — what follows is honest about what is new.)

- **Post = `ChatThread`** (channel-owned side of the existing exactly-one-owner
  invariant). The post's body is its opening `ChatMessage`; "title optional,
  first line becomes it" is already shipped behavior for untitled channel
  threads.
- **Comment = `ChatMessage` + new optional `parentMessageId`** forming the
  tree (`null` → top-level). **New:** column, replication-op field, and
  tree-aware rendering. Ordering: the shipped `message_order` is
  receiver-local (concurrent appends can order differently per replica), so
  render order and read cursors use one deterministic comparator on every
  replica — `(createdAtMs, messageId)`, both already replicated. True
  parents keep the tree causal regardless of clock skew; a Lamport/HLC
  coordinate is a later upgrade, not v1.
- **Decision records = new per-message state** (`open | resolved`, with the
  resolving message id) on the triggering `ChatMessage`; a thread's rendered
  state and the future inbox aggregate its open decisions (decision 7).
- **Attachments = per-message work links**, file-only v1, generalizing
  `LinkedChatFileRef` (target kinds `version | agentRun | decision` are
  additive later). **New entity**; must pass the relay `shareFilter` and
  redaction rules like everything else that crosses a share.
- **Reactions = shipped `ChatReaction`**, unchanged (decision 9).
- **Author = shipped `ChatActor`** (`kind: human | agent`), with
  `authorUserId` relay-verified for signed-in sends; agent labels resolve to
  `<User Name>'s agent`. `kind` is a persisted, behavior-bearing client
  claim (badge, rendering, per-actor read state) — spoofing it grants
  nothing since both hands share one verified `authorUserId`, and no gate or
  consent logic may key on the badge.
- **Read state = `ChatThreadReadState`**, extended to per-actor cursors so
  the agent has its own (required by `dohc chat inbox`). Display only:
  dispatch acking is the runner spec's durable ledger, never this cursor.

Honest scope note: this is real feature work across the store, replication
ops, relay share filter, redaction, and `ChatsView` — an evolution of a
hardened multi-user subsystem, not a minimal extension. It is also a
migration, not greenfield: the desktop already ships a renderer-side agent
dispatch path (mention roster → `handleAgentMentioned` → ACP session
drivers) and an `agentNotifications` "Addressed to me" inbox. The runner
spec's migration section retires the former; the latter's ask/needs-input
types map onto per-message decision records before being deprecated. The
saving grace is that the shipped shape (channel → thread → messages) is
already the feed's skeleton.

## Behavior rules

- **Posting is an action** (activity + notifications + read state), never a
  raw file write — for humans via UI and agents via CLI alike.
- **Channels:** created/archived by users only.
- **Nesting:** cap = 3 on render; deeper replies flatten with `replying to`.
  v1 renders *flat with `replying to` tags* (the cap-1 degenerate case) while
  storing true parents; indentation arrives with the polish pass.
- **Collapse:** any comment subtree can collapse (Hide/Show N replies).
- **Agent authorship:** distinct rendering, run chip, `needs decision` chips.
- **Ordering:** `New` only in v1. `Top` sorting needs volume that doesn't
  exist pre-launch; the sequence model already supports adding it later.
- **Source context:** re-authorized/redacted per the base design before any
  surface (render, search, notification, projection, export).

## Files & projection (direction locked, details in a future spec)

Chat becomes part of the text workspace through **curated, receiver-side
projection**, not a bulk mirror:

- **Bookmarks project.** Bookmarking a message / thread / channel / person
  materializes it as markdown in the bookmarker's workspace — optionally
  *into* a chosen folder, so a thread becomes ambient context for the project
  it concerns.
- **Rules automate.** A workspace-scoped, user-editable rules file (text)
  drives automatic projection. Defaults on: **agent DM threads** (they are
  task logs — the highest-value memory chat generates) and **resolved
  needs-decision outcomes**. Everything else off by default.
- **Receiver-side only.** No sender ever materializes files in someone else's
  workspace.
- **Projected files are read-only** with a provenance header (source thread,
  last-updated); live projections update debounced; snapshots say "as of
  <time>". Un-bookmarking archives rather than deletes. Writes go through the
  CLI/UI only — projection must never become a raw-body write path.
- **Revocation is honest, not magical.** The base design's revoke/expiry
  invalidation covers server-held projections only; files already on a
  receiver's disk are outside it, and dohc cannot un-write what a viewer
  legitimately received (the same honesty as export). What dohc does
  guarantee: every projection update re-checks the source grant, so a
  revoked share stops receiving new content and the file is stamped "stale —
  source access revoked as of <time>"; the provenance header records the
  source grant id; a connected client best-effort archives the projected
  file on revoke; and onward-sharing a projected file re-checks the source
  grant as a speed bump — copy-paste defeats it, so it is documented as
  courtesy, never as a security boundary.
- **`dohc chat export` covers authorized chat objects**, on demand, as plain
  markdown with only re-authorized, redacted metadata. It explicitly excludes
  owner-private run records, raw harness logs, and local-only traces. Curation
  solves signal-to-noise; export guarantees authorized chat data is not held
  hostage without turning private execution artifacts into chat exports.

## Surfaces

- **Feed** — channel header + "start a post" composer + post cards (serif
  title, excerpt, work chips, reaction pills, comment count). No participant
  faces in v1 (team furniture; returns when there are teams).
- **Thread** — post rendered document-style, then the bubble comment tree and
  a composer.
- **Narrow/mobile layout** — single-column feed + thread in the desktop
  renderer; the flatten rule is what keeps deep discussion legible at phone
  widths. The dedicated phone client is a separate deferred workstream
  (decision 11).

Reference prototype: the "dohc Chats — hybrid: feed, thread, mobile" Artifact
(exploratory, not canonical).

## Deferred

- **Channel subscriptions / standing instructions** (agent follows a channel
  with a skill) — the automation story; phase 2 of the runner spec.
- **Cross-channel inbox** built on the needs-decision type.
- **`Top` ranking, participant faces, nested-indent rendering** — post-launch
  polish.
- **Attachment kinds beyond files** (version, agentRun, decision targets).
- **The phone client** — a net-new client workstream (auth, relay
  append/pull, push notifications, chip rendering, decision submission),
  specified separately; gates the "decide from your phone" flagship claim.
- **Held-for-review agent posts** in shared channels (skill-turn gate applied
  to chat) — matters when a second human arrives.
- **Citation/transclusion and thread→doc/skill promotion** — deliberately
  parked until real threads make someone want them.
- **Projection spec details** (file layout, rules format, redaction pass).

## Open questions

1. Reaction set: fixed quick-set vs. open emoji.
2. Does a comment's work-attachment surface on the parent post card, or stay
   local to the comment?

(Resolved since the first draft: posts about nothing are allowed and attach
to nothing; DMs are streams — decision 10.)

## First slice

1. Channels (create, list) — user-made only. *(shipped)*
2. Channel feed of posts; create a post (title optional, first line becomes
   it). *(UI reorganization of `ChatsView`; model shipped)*
3. Open a post → comments; `parentMessageId` stored; flat render with
   `replying to` tags.
4. Reactions on posts (= opening message) and comments. *(mostly shipped)*
5. Per-message decision records + chip + resolve (CLI `--resolve`, UI
   gesture); map the shipped `agentNotifications` ask types onto them.
6. Attach a file to a post/comment; work chip opens it.
7. Agent posts and comments via the CLI, rendered as `<User Name>'s agent`
   with run chip — see companion specs for the dispatch loop.
8. Narrow-layout parity for feed + thread (desktop renderer; phone client
   deferred).

This slice, plus the runner and CLI first slices, proves the full loop:
DM or mention your agent → it works in the workspace → it reports in the
feed with chips → you decide. The phone client, when it ships, plugs into
the same loop as just another sender/decider surface.
