import { createServerFn } from '@tanstack/react-start'
import {
  MAX_VIEW_SOURCE_FILES,
  type ViewSourceFile,
} from './buildViewBundle.shared'

type BundleViewInput = { entry: string; files: ViewSourceFile[] }

// validateBundleViewInput owns the RPC shape and MAX_VIEW_SOURCE_FILES cap.
// Per-file and total MAX_VIEW_SOURCE_BYTES limits stay in the Convex source
// query and buildViewBundle.server where the file payloads are assembled.
function validateBundleViewInput(input: unknown): BundleViewInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid view bundle input.')
  }
  const value = input as Record<string, unknown>
  if (typeof value.entry !== 'string') {
    throw new Error('Invalid view entry.')
  }
  if (!Array.isArray(value.files)) {
    throw new Error('Invalid view files.')
  }
  if (value.files.length > MAX_VIEW_SOURCE_FILES) {
    throw new Error('Too many view files.')
  }
  return {
    entry: value.entry,
    files: value.files.map((file) => {
      if (!file || typeof file !== 'object' || Array.isArray(file)) {
        throw new Error('Invalid view file.')
      }
      const row = file as Record<string, unknown>
      if (typeof row.relativePath !== 'string' || typeof row.body !== 'string') {
        throw new Error('Invalid view file.')
      }
      return { relativePath: row.relativePath, body: row.body }
    }),
  }
}

export const bundleViewServer = createServerFn({ method: 'POST' })
  .inputValidator(validateBundleViewInput)
  .handler(async ({ data }) => {
    const { buildViewBundle } = await import('./buildViewBundle.server')
    return await buildViewBundle(data)
  })
