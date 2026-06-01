function encodeBase64(value: string): string {
  if (typeof btoa === 'function') {
    let binary = ''
    for (const byte of new TextEncoder().encode(value)) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64')
  }
  throw new Error('No base64 encoder available')
}

function decodeBase64(value: string): string {
  if (typeof atob === 'function') {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64').toString('utf8')
  }
  throw new Error('No base64 decoder available')
}

export function encodeViewRef(packageRoot: string): string {
  return encodeBase64(packageRoot)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function decodeViewRef(ref: string): string | null {
  const clean = (ref ?? '').trim()
  if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean)) return null
  try {
    const base64 = clean.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    return decodeBase64(padded)
  } catch {
    return null
  }
}
