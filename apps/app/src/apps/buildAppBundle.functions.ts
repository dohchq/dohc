import { createServerFn } from '@tanstack/react-start'
import {
  MAX_APP_SOURCE_BYTES,
  MAX_APP_SOURCE_FILES,
  type AppSourceFile,
} from './buildAppBundle.shared'

type BundleAppInput = { entry: string; files: AppSourceFile[] }
const textEncoder = new TextEncoder()

// validateBundleAppInput is the last guard before server bundling, so it owns
// both the RPC shape and source package caps for direct callers.
export function validateBundleAppInput(input: unknown): BundleAppInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid app bundle input.')
  }
  const value = input as Record<string, unknown>
  if (typeof value.entry !== 'string') {
    throw new Error('Invalid app entry.')
  }
  if (!Array.isArray(value.files)) {
    throw new Error('Invalid app files.')
  }
  if (value.files.length > MAX_APP_SOURCE_FILES) {
    throw new Error('Too many app files.')
  }
  let totalBytes = 0
  return {
    entry: value.entry,
    files: value.files.map((file) => {
      if (!file || typeof file !== 'object' || Array.isArray(file)) {
        throw new Error('Invalid app file.')
      }
      const row = file as Record<string, unknown>
      if (typeof row.relativePath !== 'string' || typeof row.body !== 'string') {
        throw new Error('Invalid app file.')
      }
      const bodyBytes = textEncoder.encode(row.body).byteLength
      if (bodyBytes > MAX_APP_SOURCE_BYTES) {
        throw new Error('App source file is too large.')
      }
      totalBytes += bodyBytes
      if (totalBytes > MAX_APP_SOURCE_BYTES) {
        throw new Error('App source package is too large.')
      }
      return { relativePath: row.relativePath, body: row.body }
    }),
  }
}

export const validateBundleViewInput = validateBundleAppInput

export const bundleAppServer = createServerFn({ method: 'POST' })
  .inputValidator(validateBundleAppInput)
  .handler(async ({ data }) => {
    const { buildAppBundle } = await import('./buildAppBundle.server')
    return await buildAppBundle(data)
  })
