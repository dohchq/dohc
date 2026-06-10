export function mediaTypeForWorkspacePath(path: string): string | null {
  const clean = path.toLowerCase()
  if (clean.endsWith('.png')) return 'image/png'
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg'
  if (clean.endsWith('.pdf')) return 'application/pdf'
  if (clean.endsWith('.m4a')) return 'audio/mp4'
  if (clean.endsWith('.csv')) return 'text/csv'
  if (clean.endsWith('.txt')) return 'text/plain'
  if (clean.endsWith('.json')) return 'application/json'
  if (clean.endsWith('.sqlite') || clean.endsWith('.db')) {
    return 'application/vnd.sqlite3'
  }
  return null
}
