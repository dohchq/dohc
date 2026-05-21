import { createStart } from '@tanstack/react-start'
import { authkitMiddleware } from '@workos/authkit-tanstack-react-start'

// Global request middleware. AuthKit handles WorkOS sealed-session
// refresh + access-token rotation. Available everywhere via the
// request handlers + server functions.
export const startInstance = createStart(() => ({
  requestMiddleware: [authkitMiddleware()],
}))
