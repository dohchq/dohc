import { createServerFn } from '@tanstack/react-start'
import { buildViewBundle, MAX_VIEW_SOURCE_FILES } from './buildViewBundle'

type BundleViewInput = {
  entry: string
  files: Array<{ relativePath: string; body: string }>
}

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
    return await buildViewBundle(data)
  })
