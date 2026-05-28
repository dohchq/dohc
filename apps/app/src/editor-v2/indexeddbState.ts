type IDBFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<Array<{ name?: string | null }>>
}

const CACHE_MARKER_PREFIX = 'dohc:yjs-cache:'

function cacheMarkerKey(documentName: string): string {
  return `${CACHE_MARKER_PREFIX}${documentName}`
}

export function markIndexeddbYDocState(documentName: string): void {
  try {
    localStorage.setItem(cacheMarkerKey(documentName), '1')
  } catch {
    /* ignore disabled/quota-limited storage */
  }
}

export async function hasIndexeddbYDocState(
  documentName: string,
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false

  const idb = indexedDB as IDBFactoryWithDatabases
  if (typeof idb.databases !== 'function') {
    try {
      return localStorage.getItem(cacheMarkerKey(documentName)) === '1'
    } catch {
      return false
    }
  }

  const databases = await idb.databases()
  if (!databases.some((database) => database.name === documentName)) {
    return false
  }

  return new Promise((resolve) => {
    const request = idb.open(documentName)
    request.onerror = () => resolve(false)
    request.onsuccess = () => {
      const db = request.result
      try {
        if (!db.objectStoreNames.contains('updates')) {
          db.close()
          resolve(false)
          return
        }

        const transaction = db.transaction('updates', 'readonly')
        const countRequest = transaction.objectStore('updates').count()
        countRequest.onerror = () => resolve(false)
        countRequest.onsuccess = () => resolve(countRequest.result > 0)
        transaction.oncomplete = () => db.close()
        transaction.onerror = () => db.close()
        transaction.onabort = () => db.close()
      } catch {
        db.close()
        resolve(false)
      }
    }
  })
}
