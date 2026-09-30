// Each delivery layer bounds its retained originals separately. The renderer
// and main cross IPC; the adapter retains encoded wire requests for retries.
export const YDOC_PENDING_MAX_BYTES = 32 * 1024 * 1024;
export const YDOC_PENDING_MAX_RECORDS = 4096;
