import type { Id } from '../../convex/_generated/dataModel'

export type StorageUploadProgress = {
  loaded: number
  total: number
  percent: number
}

export type StorageUploadOptions = {
  mediaType: string
  timeoutMs?: number
  onProgress?: (progress: StorageUploadProgress) => void
}

export function uploadBlobToStorageUrl(
  uploadUrl: string,
  file: File,
  { mediaType, timeoutMs = uploadTimeoutMs(file.size), onProgress }: StorageUploadOptions,
): Promise<Id<'_storage'>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', uploadUrl)
    xhr.timeout = timeoutMs
    xhr.setRequestHeader('Content-Type', mediaType)

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      onProgress?.({
        loaded: event.loaded,
        total: event.total,
        percent: Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))),
      })
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed (${xhr.status})`))
        return
      }

      try {
        const parsed = JSON.parse(xhr.responseText || '{}') as {
          storageId?: Id<'_storage'>
        }
        if (!parsed.storageId) throw new Error('Upload response missing storageId')
        onProgress?.({ loaded: file.size, total: file.size, percent: 100 })
        resolve(parsed.storageId)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Invalid upload response'))
      }
    }

    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.ontimeout = () => reject(new Error('Upload timed out'))
    xhr.send(file)
  })
}

export function uploadTimeoutMs(sizeBytes: number): number {
  return Math.min(10 * 60_000, Math.max(45_000, Math.ceil(sizeBytes / 64)))
}
