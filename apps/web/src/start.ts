import { createStart } from '@tanstack/react-start'

// Global request setup. Auth is Better Auth cookie sessions on the
// cloud API origin — no request middleware needed in the web shell.
export const startInstance = createStart(() => ({}))
