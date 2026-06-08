export type AppSourceDigestFile = {
  relativePath: string
  body: string
}

export type AppSourceDigestSeed = {
  collections?: Record<string, Array<Record<string, unknown>>>
  docs?: Record<string, string>
  databases?: Record<string, Record<string, Array<Record<string, unknown>>>>
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function computeAppSourceDigest({
  files,
  manifestTrustKey,
  seed,
}: {
  files: AppSourceDigestFile[]
  manifestTrustKey?: string
  seed?: AppSourceDigestSeed
}): Promise<string> {
  const normalized = {
    manifestTrustKey: manifestTrustKey ?? null,
    files: [...files]
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((file) => ({
        relativePath: file.relativePath,
        body: file.body,
      })),
    seed: seed ?? null,
  }
  return `sha256:${await sha256(stableJson(normalized))}`
}
