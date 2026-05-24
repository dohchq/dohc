// M1 step 2 (multiplayer-and-h-followups §8) — the Milkdown adapter
// for @convex-dev/prosemirror-sync. The package ships Tiptap +
// BlockNote wrappers but not Milkdown — Milkdown's Crepe preset is
// just a ProseMirror schema with custom plugins, so this is the
// thin orchestration that makes it work:
//
//   1. Bootstrap: load the snapshot (or null) + replay any deltas
//      via the package's existing useInitialState hook (editor-
//      agnostic — returns plain ProseMirror JSON).
//   2. Local edits: prosemirror-collab's `collab()` plugin marks
//      transactions as sendable; we read them and POST to
//      api.prosemirror.submitSteps. On `needs-rebase` we pull
//      server steps via getSteps and re-apply locally.
//   3. Remote edits: poll latestVersion via useQuery (Convex is
//      already reactive — the query auto-rerenders); on bump,
//      fetch + apply via receiveTransaction.
//
// Frontend behavior is STAGED behind a `multiplayer: boolean` opt-
// in flag on AtomEditor (next sub-commit) — this file only exports
// the building blocks; mounting it into Crepe is the integration
// step. So importing this module is a no-op until something calls
// the hook.

import { useEffect, useRef, useState } from 'react'
import { useConvex, useMutation, useQuery } from 'convex/react'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import {
  collab,
  receiveTransaction,
  sendableSteps,
  getVersion,
} from 'prosemirror-collab'
import { Step } from '@milkdown/kit/prose/transform'
import type { Node, Schema } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Transaction } from '@milkdown/kit/prose/state'
import { api } from '../../convex/_generated/api'

// The collab plugin key — exported so the AtomEditor integration
// can find this plugin on the editor view (e.g. to read version
// during debugging).
export const collabPluginKey = new PluginKey('dohcCollab')

// Per-tab client id. Sent with every step submission so the server
// can attribute steps to their origin (and so we can ignore our
// own steps when they echo back through getSteps).
function makeClientId(): string {
  // Crypto-random — collisions across tabs would mis-attribute
  // steps. crypto.randomUUID() is supported in all our target
  // browsers (modern evergreen).
  return crypto.randomUUID()
}

// The state the hook owns: snapshot + version (the bootstrap), plus
// connection status. `ready=true` means the bootstrap finished and
// the editor can mount with `initialDoc`.
export type CollabBootstrap = {
  ready: boolean
  loading: boolean
  initialDoc: Node | null
  initialVersion: number
  error: string | null
}

// Fetch the latest snapshot, build a ProseMirror Node out of it,
// and replay any deltas past that snapshot's version. Pure helper
// — used both by the React hook (mount-time bootstrap) and by
// tests that want a deterministic doc-state setup.
//
// NOTE: this is a thin client of the SAME endpoints the
// useInitialState hook uses; we re-implement here so the bootstrap
// shape is exactly what Milkdown's parser/serializer expects (a
// real Node, not Tiptap-flavored JSON).
export async function bootstrapDocFromSync({
  convex,
  docId,
  schema,
}: {
  convex: ReturnType<typeof useConvex>
  docId: string
  schema: Schema
}): Promise<{ doc: Node | null; version: number }> {
  // Load the latest snapshot. Server returns either {content,
  // version} or null (no snapshot yet — fresh doc). The package's
  // generated return type doesn't quite line up with what we use
  // (it's structurally the same shape but with stricter typing
  // around the JSON), so we narrow via an explicit cast at the
  // wire boundary.
  const snapshot = (await convex.query(api.prosemirror.getSnapshot, {
    id: docId,
  })) as { content: string | object; version?: number } | null
  let doc: Node | null = null
  let version = 0
  if (snapshot && snapshot.content) {
    try {
      const json =
        typeof snapshot.content === 'string'
          ? JSON.parse(snapshot.content)
          : snapshot.content
      doc = schema.nodeFromJSON(json)
      version = snapshot.version ?? 0
    } catch (e) {
      // Corrupt snapshot ⇒ behave as if no snapshot existed; the
      // editor will mount with an empty doc and the first user
      // edit will create a fresh history.
      return { doc: null, version: 0 }
    }
  }
  // Replay any steps past the snapshot version (the package's
  // server pruning keeps snapshots + the latest deltas; we want
  // the post-replay state to match what every other client sees).
  const stepRows = await convex.query(api.prosemirror.getSteps, {
    id: docId,
    version,
  })
  if (doc && stepRows.steps.length > 0) {
    for (const raw of stepRows.steps) {
      try {
        const step = Step.fromJSON(schema, JSON.parse(raw))
        const result = step.apply(doc)
        if (result.doc) {
          doc = result.doc
          version++
        }
      } catch {
        // A bad step is a contract violation, not a transient
        // error — better to surface a corrupt-doc state than to
        // silently apply a half-replayed history.
        return { doc, version: -1 }
      }
    }
  }
  return { doc, version }
}

// Build the prosemirror-collab plugin instance wired with the
// matching clientId and starting version. The integration plugin
// (returned by useCollabSync) wraps this with the Convex submit
// orchestration.
export function makeCollabPlugin({
  startVersion,
  clientId,
}: {
  startVersion: number
  clientId: string
}): Plugin {
  return collab({ version: startVersion, clientID: clientId })
}

// THE plugin factory the editor adds via prosePluginsCtx. Two
// responsibilities:
//   1. On every transaction, check sendableSteps(state) and submit
//      to Convex (`submitSteps`). On `needs-rebase`, pull server
//      steps and apply locally (receiveTransaction) before retry.
//   2. The remote-pull side lives in the React hook (useQuery on
//      latestVersion + a useEffect that fetches getSteps).
//
// This is a SEPARATE plugin from the prosemirror-collab plugin
// itself — collab() owns the version state, this one owns the
// network bridge. They cooperate through sendableSteps()/getVersion().
//
// M1 step 3 sub-commit 3.6.4 — also drives periodic snapshot
// submission (codex 4th-pass concern #3). Without it, the editor
// only calls submitSteps; the server's onSnapshot only fires at
// bootstrap, so projections never happen during normal editing.
// The snapshot debounce fires ~5s after the last edit (coalesces
// bursts); each fire posts the current doc JSON via the
// onSubmitSnapshot callback.
export function makeSyncBridgePlugin({
  docId,
  clientId,
  onSubmit,
  onRebase,
  onSubmitSnapshot,
}: {
  docId: string
  clientId: string
  // Async because submitSteps is a Convex mutation. The plugin
  // doesn't know about Convex directly — the parent hook injects
  // the IO via these callbacks (keeps the plugin testable in
  // isolation and avoids coupling to the React/Convex runtime).
  onSubmit: (args: {
    version: number
    steps: object[]
  }) => Promise<{ status: 'synced' } | { status: 'needs-rebase' }>
  onRebase: () => Promise<void>
  /** Optional snapshot-submit callback. When provided, the plugin
   *  debounces ~5s after the last update + submits the current
   *  doc JSON as a snapshot. Server-side onSnapshot then schedules
   *  the projection. When undefined, snapshot submission is
   *  disabled (back-compat for tests / unit usage). */
  onSubmitSnapshot?: (args: {
    version: number
    content: string
  }) => Promise<void>
}): Plugin {
  return new Plugin({
    key: new PluginKey('dohcSyncBridge'),
    view(view: EditorView) {
      let inFlight = false
      let pendingNotify = false

      // M1 step 3.6.4 — snapshot-submission debounce. Cleared on
      // every update; re-armed by the same update. After 5000ms
      // of editor idleness the snapshot fires.
      const SNAPSHOT_DEBOUNCE_MS = 5000
      let snapshotTimer: ReturnType<typeof setTimeout> | null = null
      let snapshotInFlight = false
      let lastSubmittedSnapshotVersion = -1

      async function trySubmit() {
        if (inFlight) {
          // Already submitting — coalesce: the in-flight call
          // will re-check sendableSteps after it finishes.
          pendingNotify = true
          return
        }
        const sendable = sendableSteps(view.state)
        if (!sendable) return
        inFlight = true
        try {
          const result = await onSubmit({
            version: sendable.version,
            steps: sendable.steps.map((s) => s.toJSON()),
          })
          if (result.status === 'needs-rebase') {
            // Pull server steps and reapply locally — collab() needs
            // them applied through receiveTransaction so it can
            // re-rebase the pending local steps.
            await onRebase()
          }
        } catch {
          // A throw is a real outage (auth revoked, network down,
          // server 500). Leave inFlight false → the next local
          // edit triggers a retry. The user keeps editing locally;
          // their changes are not lost (they live in pending).
        } finally {
          inFlight = false
          if (pendingNotify) {
            pendingNotify = false
            // Re-trigger in case more steps arrived during the
            // in-flight window. Microtask defer so we don't
            // recurse synchronously.
            queueMicrotask(() => void trySubmit())
          }
        }
      }

      // Snapshot submission. Three serial guards (M1 step 3.6.5
      // codex 5th-pass BLOCKER #1):
      //   - sendableSteps(view.state) === null
      //     pending local steps means the doc contains state
      //     PAST getVersion(view.state); submitting now would
      //     send {version: N, content: doc-at-N+k} → server
      //     stores a corrupt snapshot; the next client to
      //     bootstrap deserializes content-at-N+k as version N
      //     and diverges on the first edit
      //   - inFlight === false (step submission in flight)
      //     once submitSteps acks, view.state advances; same
      //     desync as above if we snapshot between submit + ack
      //   - snapshotInFlight === false
      //     serializes; never two snapshot mutations racing
      // If any guard fails, skip + re-arm (caller will fire
      // another armSnapshotDebounce on the next update; if the
      // editor is idle, the destroyFlush path below catches it).
      async function trySubmitSnapshot() {
        if (!onSubmitSnapshot) return
        if (snapshotInFlight) return
        // Codex 5th-pass BLOCKER #1: refuse to submit while pending
        // steps exist. Re-arm so the next idle period retries
        // after submitSteps has acked.
        if (sendableSteps(view.state)) {
          armSnapshotDebounce()
          return
        }
        if (inFlight) {
          armSnapshotDebounce()
          return
        }
        const currentVersion = getVersion(view.state)
        if (currentVersion <= lastSubmittedSnapshotVersion) return
        snapshotInFlight = true
        try {
          // Capture content + version IN THE SAME tick to prevent
          // a transaction landing between toJSON + getVersion.
          // (Both are sync reads of plugin state; same task tick
          // gives an atomic view.)
          const docJson = view.state.doc.toJSON()
          const versionAtSnapshot = getVersion(view.state)
          // Double-check the guards held through the sync block.
          // If sendableSteps appeared during a hypothetical
          // re-entrant update, abort + re-arm.
          if (sendableSteps(view.state)) {
            armSnapshotDebounce()
            return
          }
          await onSubmitSnapshot({
            version: versionAtSnapshot,
            content: JSON.stringify(docJson),
          })
          lastSubmittedSnapshotVersion = versionAtSnapshot
        } catch {
          // Snapshot failures are non-fatal — the server keeps
          // accepting our steps; the next snapshot retries. No
          // user-visible disruption.
        } finally {
          snapshotInFlight = false
        }
      }

      function armSnapshotDebounce() {
        if (!onSubmitSnapshot) return
        if (snapshotTimer !== null) clearTimeout(snapshotTimer)
        snapshotTimer = setTimeout(() => {
          snapshotTimer = null
          void trySubmitSnapshot()
        }, SNAPSHOT_DEBOUNCE_MS)
      }

      // First pass: there may already be sendable steps (e.g. if
      // the user pasted before this plugin mounted).
      void trySubmit()
      // Also arm snapshot debounce so an editor that boots with
      // content (e.g. paste-on-open) eventually projects without
      // requiring a user keystroke.
      armSnapshotDebounce()

      return {
        update(_view, _prevState) {
          void trySubmit()
          armSnapshotDebounce()
        },
        destroy() {
          // M1 step 3.6.5 codex 5th-pass BLOCKER #2: FLUSH the
          // pending snapshot before tearing down (was: clear).
          // Tab close, navigation away, doc switch all hit this
          // path; without the flush, atoms.body stays stale at
          // the last projected version even when there are
          // unsubmitted snapshots pending.
          //
          // CAVEAT: we still can't await an async snapshot
          // submission from a sync destroy callback. We fire-and-
          // forget the submission; the page may unload before it
          // completes (browser will best-effort POST in beforeunload).
          // The server-side _cleanupIdleSessions path catches the
          // residual case: when the doc's session count drops to
          // zero, it schedules a final projection. See
          // collabPresence.ts updates for that part.
          if (snapshotTimer !== null) {
            clearTimeout(snapshotTimer)
            snapshotTimer = null
            void trySubmitSnapshot()
          }
        },
      }
    },
  })
}

// Apply a batch of server-side steps to the editor view. Uses
// prosemirror-collab's `receiveTransaction` so the collab plugin's
// version state stays consistent with the server. Returns the
// number of steps applied.
export function applyRemoteSteps({
  view,
  rawSteps,
  clientIds,
}: {
  view: EditorView
  rawSteps: string[]
  clientIds: Array<string | number>
}): number {
  if (rawSteps.length === 0) return 0
  const schema = view.state.schema
  const steps = rawSteps.map((raw) => Step.fromJSON(schema, JSON.parse(raw)))
  view.dispatch(receiveTransaction(view.state, steps, clientIds))
  return steps.length
}

// THE React hook — orchestrates the bootstrap + the remote-pull
// loop. Returns the snapshot bootstrap once it resolves; the
// editor mounts using `initialDoc` + `initialVersion` and ALSO
// adds the two plugins (collab + syncBridge).
//
// Wire-up (in the parent component):
//   const sync = useCollabSync({docId, schema})
//   if (!sync.ready) return <Skeleton />
//   // pass sync.initialDoc / sync.initialVersion to the editor's
//   // initial state; add sync.plugins to prosePluginsCtx
export function useCollabSync({
  docId,
  schema,
  enabled = true,
}: {
  docId: string | null
  schema: Schema | null
  enabled?: boolean
}): {
  bootstrap: CollabBootstrap
  plugins: Plugin[] | null
  clientId: string
} {
  const convex = useConvex()
  // Stable per-mount client id (the editor uses it to mark its own
  // steps so the remote-pull loop can ignore them).
  const clientIdRef = useRef<string>('')
  if (!clientIdRef.current) clientIdRef.current = makeClientId()
  const clientId = clientIdRef.current

  const [bootstrap, setBootstrap] = useState<CollabBootstrap>({
    ready: false,
    loading: true,
    initialDoc: null,
    initialVersion: 0,
    error: null,
  })

  // Bootstrap: fetch initial doc + version on mount (or when docId
  // changes). The effect's cleanup short-circuits stale loads if
  // the user switches docs mid-fetch.
  useEffect(() => {
    if (!enabled || !docId || !schema) {
      setBootstrap({
        ready: !enabled,
        loading: false,
        initialDoc: null,
        initialVersion: 0,
        error: null,
      })
      return
    }
    let cancelled = false
    setBootstrap((s) => ({ ...s, loading: true, ready: false }))
    bootstrapDocFromSync({ convex, docId, schema })
      .then(({ doc, version }) => {
        if (cancelled) return
        if (version === -1) {
          setBootstrap({
            ready: false,
            loading: false,
            initialDoc: null,
            initialVersion: 0,
            error: 'Failed to replay document history.',
          })
          return
        }
        setBootstrap({
          ready: true,
          loading: false,
          initialDoc: doc,
          initialVersion: version,
          error: null,
        })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setBootstrap({
          ready: false,
          loading: false,
          initialDoc: null,
          initialVersion: 0,
          // Auth errors here are common (Convex rethrows
          // checkRead's message verbatim). Surface to caller.
          error: msg,
        })
      })
    return () => {
      cancelled = true
    }
  }, [convex, docId, schema, enabled])

  // The two plugins are STABLE once bootstrap completes (their
  // version state lives in plugin state, mutated through
  // dispatch). Re-instantiate ONLY when the docId changes (a doc
  // switch resets everything).
  const pluginsRef = useRef<{ docId: string; plugins: Plugin[] } | null>(null)
  let plugins: Plugin[] | null = null
  if (enabled && docId && bootstrap.ready) {
    if (pluginsRef.current?.docId !== docId) {
      pluginsRef.current = {
        docId,
        plugins: [
          makeCollabPlugin({
            startVersion: bootstrap.initialVersion,
            clientId,
          }),
          makeSyncBridgePlugin({
            docId,
            clientId,
            // submitSteps is a mutation — the bridge calls it via
            // the captured convex client. (Closing over the
            // current docId is safe — the ref above resets the
            // plugin set on doc change.)
            onSubmit: async ({ version, steps }) => {
              const result = await convex.mutation(api.prosemirror.submitSteps, {
                id: docId,
                version,
                clientId,
                steps: steps.map((s) => JSON.stringify(s)),
              })
              return result as { status: 'synced' } | { status: 'needs-rebase' }
            },
            onRebase: async () => {
              // Caller of useCollabSync owns the remote-pull
              // effect (it has access to the live EditorView via
              // the React tree). We just clear inFlight here;
              // the next render's effect re-applies via
              // applyRemoteSteps. Keeping rebase pulling OUT of
              // the plugin keeps the plugin synchronous-safe.
            },
            // M1 step 3.6.4 — periodic snapshot submission
            // (codex 4th-pass concern #3). The server's onSnapshot
            // only fires when a snapshot is committed; without
            // this the projection writer would only run at
            // bootstrap. Plugin debounces ~5s of editor idleness
            // then posts the current doc JSON.
            onSubmitSnapshot: async ({ version, content }) => {
              await convex.mutation(api.prosemirror.submitSnapshot, {
                id: docId,
                version,
                content,
              })
            },
          }),
        ],
      }
    }
    plugins = pluginsRef.current.plugins
  } else {
    pluginsRef.current = null
  }

  // Remote-pull loop: subscribe to latestVersion via useQuery
  // (Convex reactivity drives the re-render). The effect below
  // owns the actual step-fetch + apply — we expose a refetch
  // function the caller invokes when latestVersion bumps.
  //
  // NOTE: this hook returns the plugins + bootstrap; the caller
  // is responsible for mounting them into the editor (via Crepe's
  // prosePluginsCtx) AND for owning the EditorView ref so the
  // remote-pull effect can call applyRemoteSteps. The remote-
  // pull useEffect lives in the AtomEditor integration (next
  // sub-commit) because it needs the EditorView reference.
  // Exposing it from here would require a getView callback which
  // the parent doesn't have until the editor mounts.

  return {
    bootstrap,
    plugins,
    clientId,
  }
}

// Companion useQuery hook the integration uses to subscribe to
// the remote version stream. Keeps the Convex reactivity in one
// place; returns the current server version, which jumps when
// another tab/peer submits steps. The integration's useEffect
// compares this to getVersion(state) and pulls + applies.
export function useRemoteVersion(docId: string | null): number | undefined {
  // Pass 'skip' when no docId — Convex's idiom for conditional
  // queries (the hook re-subscribes when docId becomes non-null).
  // latestVersion may return null when the doc has no snapshot
  // yet — collapse null → undefined so the caller's diff logic
  // can treat "no doc" and "no version yet" identically.
  const v = useQuery(
    api.prosemirror.latestVersion,
    docId ? { id: docId } : 'skip',
  )
  return v == null ? undefined : v
}

// M1 step 3.8.1.0 — companion query subscription for the
// collabDocs row state. Drives three downstream client behaviors
// that the AtomEditor integration consumes:
//
//   - `frozen: true` → render a "reload to continue" banner
//     (real conflict: 3.7 case A; client must reload, not retry)
//   - `needsRebootstrap: true` → tear down sync session + re-call
//     bootstrapSnapshotFromAtomBody with fresh atoms.body
//     (3.7 case B; gentle auto-rebuild after OOB write while
//     PM was idle)
//   - `projectedVersion` → debug telemetry (UI may show "synced
//     N seconds ago")
//
// AUTH NOTE: the server query (collabBootstrap.getCollabDocState)
// gates on P1 read access. Non-readers see `exists: false` instead
// of a denial (defense-in-depth against existence oracle leaks).
//
// SHAPE NOTE: returns `undefined` while the query loads (Convex's
// idiom) and `null` when the query is skipped (no docId). The
// `exists: false` variant means "query ran successfully, no row
// (or no access)". Caller should treat undefined + null + exists:
// false ALL as "no actionable state" (the editor renders as if
// nothing's happening).
export type CollabDocState =
  | { exists: false }
  | {
      exists: true
      frozen: boolean
      needsRebootstrap: boolean
      lastConflictAt: number | null
      projectedVersion: number
    }

export function useCollabDocState(
  docId: string | null,
  activeWorkspaceId: string | undefined,
): CollabDocState | undefined | null {
  // 'skip' when no docId — same idiom as useRemoteVersion.
  return useQuery(
    api.collabBootstrap.getCollabDocState,
    docId ? { docId, activeWorkspaceId } : 'skip',
  )
}

// M1 step 3.8.1.4 — client-side SHA-256, used to compute the CAS
// witness (`clientBodyHash`) that bootstrapSnapshotFromAtomBody
// requires. The server runs the same algorithm via Convex's V8
// crypto.subtle; browser support is universal in our targets.
//
// Why hex (not base64): matches server convention in
// convex/atomWriter.ts:sha256Hex so client + server hashes compare
// as strings. The whole point is bit-for-bit equality.
async function sha256HexClient(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}

// M1 step 3.8.1.4 — client-side bootstrap mutation orchestration.
// Codex 7th-pass [P1] #1: the prior client tier shipped UI for
// frozen + needsRebootstrap signals but NEVER actually invoked
// bootstrapSnapshotFromAtomBody. The collabDocs row was never
// created server-side, projection writer had no baseline to bind
// to, and needsRebootstrap could not be cleared — the
// rebootstrap-overlay reload loop would never converge.
//
// FIX: actually call the mutation. Once per docId per mount.
// The caller (AtomEditor) fires this AFTER Crepe mounts, when
// `pmJsonStr` becomes available (Crepe parses the markdown body
// → PM JSON internally; we extract via editorViewCtx).
//
// LIFECYCLE — exactly one in-flight call per docId:
//   - phase:'idle'    → not enabled OR pmJsonStr not yet captured
//   - phase:'pending' → mutation in flight
//   - phase:'ok'      → server bootstrapped (or already had row);
//                       caller is now safe to install collab
//                       plugins. AtomEditor's late-install effect
//                       MUST gate on this phase.
//   - phase:'error'   → recovery is a manual reload (UI shows
//                       overlay with a reload button + auto-reload
//                       after a short delay). We intentionally do
//                       not retry body-changed or pm-body-mismatch
//                       from this hook: the PM JSON Crepe parsed
//                       is fixed to the body it mounted with, and
//                       re-bootstrap with mismatched JSON would
//                       loop pm-body-mismatch. Reload re-parses.
//                       'frozen' is a distinct phase below so the
//                       caller can route to the frozen banner
//                       instead of the generic error overlay.
//   - phase:'frozen'  → server's collabDocs.frozen=true (3.9.5
//                       FIX #4 made bootstrap return this reason
//                       directly). UI shows frozen banner; user
//                       reloads after resolving externally.
//
// IDEMPOTENCY: a ref tracks "have we fired for this (docId,
// pmJsonStr) pair yet?" — re-renders don't re-fire. Switching
// docId resets via the dep array; switching pmJsonStr (e.g. if
// the caller re-extracted) also re-fires. In practice the caller
// extracts pmJsonStr once at mount + holds it stable for the
// lifetime of the editor, so a single firing is the norm.
export type CollabBootstrapMutationState =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'ok'; alreadyBootstrapped: boolean }
  | { phase: 'frozen' }
  | {
      phase: 'error'
      reason:
        | 'body-changed'
        | 'invalid-pm-json'
        | 'atom-not-found'
        | 'pm-body-mismatch'
        | 'network'
      message?: string
    }

export function useCollabBootstrapMutation({
  docId,
  body,
  pmJsonStr,
  activeWorkspaceId,
  enabled,
}: {
  docId: string | null
  /** atoms.body (markdown). Hashed with SHA-256 → clientBodyHash. */
  body: string | null
  /** PM JSON the editor parsed from `body`. Caller extracts via
   *  crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.doc.toJSON())
   *  in an after-mount effect. Stringified here to match the
   *  mutation's wire format. Pass null until Crepe has mounted +
   *  the JSON is captured. */
  pmJsonStr: string | null
  activeWorkspaceId: string | undefined
  enabled: boolean
}): CollabBootstrapMutationState {
  const bootstrapMutation = useMutation(
    api.collabBootstrap.bootstrapSnapshotFromAtomBody,
  )
  const [state, setState] = useState<CollabBootstrapMutationState>({
    phase: 'idle',
  })
  // Idempotency key — refire ONLY when docId changes (switching
  // atoms). Codex 8th-pass [P1] #3: keying on (pmJsonStr, body)
  // too caused bootstrap to refire whenever the parent's `value`
  // prop changed (e.g. when a projection write updated atom.body
  // and Convex's reactive query pushed the new body). The refire
  // would send the OLD pmJsonStr (Crepe didn't reparse) with the
  // NEW body hash → server's PM↔body binding check rejects with
  // pm-body-mismatch → BootstrapErrorOverlay shows on a happily-
  // bootstrapped session. Wrong.
  //
  // Correct semantics: bootstrap is one-shot per docId per mount.
  // Once it succeeds, never refire. If body changes happen later,
  // they flow through the projection writer + (potentially)
  // needsRebootstrap signal — the dedicated path for body drift,
  // NOT the bootstrap mutation. Switching atoms unmounts the
  // editor entirely (parent re-keys), giving us a fresh mount
  // where the new docId triggers a fresh bootstrap.
  const firedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !docId) {
      // Multiplayer disabled or docId cleared. Reset everything:
      //
      // - firedForRef: codex 9th-pass [P2]. If we don't clear,
      //   then re-enabling with the SAME docId would skip the
      //   bootstrap (firedForRef.current === docId early-return)
      //   even though state was reset to idle. The hook would
      //   look stuck in idle forever.
      //
      // - state: collapse to idle so any caller-side branches
      //   (BootstrapErrorOverlay rendering, setReadonly gate)
      //   see a coherent "not bootstrapping right now" signal
      //   instead of leftover phase=='ok' from the prior atom.
      firedForRef.current = null
      setState({ phase: 'idle' })
      return
    }
    if (!pmJsonStr || body === null) {
      // Enabled but waiting for Crepe to mount + extract PM JSON.
      // Don't reset firedForRef here — we may have already
      // bootstrapped on a previous render where pmJsonStr was
      // briefly null due to a parent re-render.
      return
    }
    // Already fired for this docId? Don't refire. body changes
    // don't matter; pmJsonStr is captured ONCE per mount.
    if (firedForRef.current === docId) return
    firedForRef.current = docId
    let cancelled = false
    setState({ phase: 'pending' })
    ;(async () => {
      try {
        const clientBodyHash = await sha256HexClient(body)
        if (cancelled) return
        const result = await bootstrapMutation({
          docId,
          pmJsonStr,
          clientBodyHash,
          activeWorkspaceId,
        })
        if (cancelled) return
        if (result.ok) {
          setState({
            phase: 'ok',
            alreadyBootstrapped: result.alreadyBootstrapped,
          })
          return
        }
        // result.ok === false — surface the reason.
        if (result.reason === 'frozen') {
          setState({ phase: 'frozen' })
          return
        }
        setState({ phase: 'error', reason: result.reason })
      } catch (e) {
        if (cancelled) return
        const message = e instanceof Error ? e.message : String(e)
        setState({ phase: 'error', reason: 'network', message })
      }
    })()
    return () => {
      cancelled = true
    }
    // deps: pmJsonStr is here so the effect fires the FIRST time
    // it transitions from null → non-null (Crepe finished
    // mounting). Once fired, firedForRef short-circuits further
    // invocations for this docId.
  }, [enabled, docId, pmJsonStr, body, activeWorkspaceId, bootstrapMutation])

  return state
}

// M1 step 3.8.2.3 — REMOTE-CURSOR DECORATION PLUGIN.
//
// Renders other tabs' carets inside the editor, fulfilling
// M1+M2 acceptance criterion #1 ("two browser sessions on
// same atom: both cursors visible"). The plugin keeps a Set
// of remote cursor positions in its state; AtomEditor refreshes
// the state via dispatchTransaction when its useQuery returns
// fresh data.
//
// Position interpretation: PM doc-relative offsets at the
// snapshot version the remote tab last synced. Under concurrent
// editing, positions may briefly desync until the next remote-
// pull (when our local doc state advances + the remote tab's
// cursor advances too). Documented v1 limitation; proper
// step-mapping is M2 follow-up.
//
// Decoration: a 2px-wide inline widget at the cursor position
// + an absolutely-positioned label below it carrying the
// userId/displayName. Color is derived from userId via a stable
// hash → HSL so the same user gets the same color across tabs.
export type RemoteCursor = {
  clientId: string
  userId: string
  cursorPos: number
}

const remoteCursorsKey = new PluginKey<RemoteCursor[]>('dohcRemoteCursors')

// Hash a string to a stable hue 0-360. Doesn't need to be
// cryptographic — just spread the keyspace so distinct users
// get distinct colors. Simple FNV-1a-ish mix.
function hueFromString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 360
}

export function makeRemoteCursorsPlugin(): Plugin {
  return new Plugin<RemoteCursor[]>({
    key: remoteCursorsKey,
    state: {
      init: () => [],
      apply: (tr, current) => {
        // Caller dispatches a transaction with a meta key when
        // useQuery returns fresh cursor data. Falls through to
        // the current state when no meta is set (preserves
        // cursors across local edits — they're stale-but-shown
        // until the next React render's update).
        const next = tr.getMeta(remoteCursorsKey)
        return Array.isArray(next) ? (next as RemoteCursor[]) : current
      },
    },
    props: {
      decorations: (state) => {
        const cursors = remoteCursorsKey.getState(state) ?? []
        if (cursors.length === 0) return DecorationSet.empty
        const docSize = state.doc.content.size
        const decos: Decoration[] = []
        for (const c of cursors) {
          // Clamp positions defensively — a stale snapshot can
          // produce a cursorPos past the current doc size.
          if (c.cursorPos < 0 || c.cursorPos > docSize) continue
          const hue = hueFromString(c.userId)
          const color = `hsl(${hue} 70% 45%)`
          const caret = document.createElement('span')
          caret.className = 'dohc-remote-caret'
          caret.style.cssText = `display:inline-block;width:0;border-left:2px solid ${color};margin-left:-1px;height:1.1em;vertical-align:text-bottom;pointer-events:none;position:relative;`
          // Label that floats below the caret with the userId.
          // Truncated to keep the badge small; full id in title.
          const label = document.createElement('span')
          label.textContent = c.userId.slice(0, 8)
          label.style.cssText = `position:absolute;top:1.2em;left:-1px;background:${color};color:white;padding:1px 4px;font-size:9px;line-height:1.2;border-radius:2px;white-space:nowrap;font-family:system-ui,sans-serif;`
          label.title = c.userId
          caret.appendChild(label)
          decos.push(
            Decoration.widget(c.cursorPos, caret, {
              key: `remote-cursor-${c.clientId}`,
              side: 1,
              ignoreSelection: true,
              stopEvent: () => false,
            }),
          )
        }
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

/** Dispatch fresh cursor data into a mounted editor's plugin
 *  state. Call from AtomEditor when useQuery returns updates. */
export function applyRemoteCursors(
  view: EditorView,
  cursors: RemoteCursor[],
): void {
  const tr = view.state.tr.setMeta(remoteCursorsKey, cursors)
  view.dispatch(tr)
}

// M1 step 3.8.2.3 — local-selection observer plugin. Watches
// the editor's selection; on change, debounces 150ms then fires
// a callback with the new head position. AtomEditor wires the
// callback to recordCollabPresence with cursorPos set.
export function makeLocalCursorObserverPlugin({
  onCursorChange,
}: {
  onCursorChange: (pos: number | null) => void
}): Plugin {
  return new Plugin({
    key: new PluginKey('dohcLocalCursor'),
    view() {
      let timer: ReturnType<typeof setTimeout> | null = null
      let lastReportedPos: number | null = null
      return {
        update(view, prevState) {
          // Skip if selection didn't change (the editor fires
          // update on every transaction; we only care when
          // selection.head moved).
          if (
            view.state.selection.head === prevState.selection.head &&
            view.state.selection.anchor === prevState.selection.anchor
          ) {
            return
          }
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = null
            const pos = view.state.selection.head
            if (pos === lastReportedPos) return
            lastReportedPos = pos
            onCursorChange(pos)
          }, 150)
        },
        destroy() {
          if (timer !== null) clearTimeout(timer)
        },
      }
    },
  })
}

// Re-imports of decoration types used above. Kept at the bottom
// next to their consumer for locality; prosemirror-view types
// are already pulled in via @milkdown/kit/prose/view (see top
// of file).
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

// Re-export getVersion so the integration can compare without
// pulling prosemirror-collab directly.
export { getVersion } from 'prosemirror-collab'
