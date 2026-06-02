import { createServerFn } from '@tanstack/react-start'
import {
  MAX_VIEW_SOURCE_BYTES,
  MAX_VIEW_SOURCE_FILES,
  type ViewSourceFile,
} from './buildViewBundle.shared'

type BundleViewInput = { entry: string; files: ViewSourceFile[] }
const textEncoder = new TextEncoder()

// validateBundleViewInput is the last guard before server bundling, so it owns
// both the RPC shape and source package caps for direct callers.
export function validateBundleViewInput(input: unknown): BundleViewInput {
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
  let totalBytes = 0
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
      const bodyBytes = textEncoder.encode(row.body).byteLength
      if (bodyBytes > MAX_VIEW_SOURCE_BYTES) {
        throw new Error('View source file is too large.')
      }
      totalBytes += bodyBytes
      if (totalBytes > MAX_VIEW_SOURCE_BYTES) {
        throw new Error('View source package is too large.')
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
