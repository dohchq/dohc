import { defineApp } from 'convex/server'
import agent from '@convex-dev/agent/convex.config'
import workOSAuthKit from '@convex-dev/workos-authkit/convex.config'

const app = defineApp()
app.use(agent)
app.use(workOSAuthKit)

export default app
