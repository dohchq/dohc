import { defineApp } from 'convex/server'
import agent from '@convex-dev/agent/convex.config'
import workOSAuthKit from '@convex-dev/workos-authkit/convex.config'
// M1 (multiplayer-and-h-followups §8) — ProseMirror sync component.
// Stores snapshots + deltas for collaborative document state with
// optimistic step reconciliation. The transport spike
// (docs/development/transport-spike-result.md) ruled in favor of
// this over y-websocket: native Convex auth + first-class
// server-side `transform` for AI editing (M3) + no extra infra.
import prosemirrorSync from '@convex-dev/prosemirror-sync/convex.config'

const app = defineApp()
app.use(agent)
app.use(workOSAuthKit)
app.use(prosemirrorSync)

export default app
