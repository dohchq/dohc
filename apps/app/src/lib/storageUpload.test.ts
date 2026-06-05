import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadBlobToStorageUrl, uploadTimeoutMs } from './storageUpload'

class MockXMLHttpRequest {
  static latest: MockXMLHttpRequest | null = null

  upload = {} as { onprogress?: (event: ProgressEvent) => void }
  timeout = 0
  status = 0
  responseText = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  headers = new Map<string, string>()
  method = ''
  url = ''
  body: unknown = null

  constructor() {
    MockXMLHttpRequest.latest = this
  }

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value)
  }

  send(body: unknown) {
    this.body = body
  }
}

describe('storage uploads', () => {
  const realXMLHttpRequest = globalThis.XMLHttpRequest

  afterEach(() => {
    globalThis.XMLHttpRequest = realXMLHttpRequest
    MockXMLHttpRequest.latest = null
  })

  it('uploads with content type and reports progress before resolving the storage id', async () => {
    globalThis.XMLHttpRequest =
      MockXMLHttpRequest as unknown as typeof XMLHttpRequest
    const progress = vi.fn()
    const file = new Blob(['a,b\n1,2\n'], { type: 'text/csv' }) as File

    const promise = uploadBlobToStorageUrl('https://upload.example', file, {
      mediaType: 'text/csv',
      onProgress: progress,
    })
    const xhr = MockXMLHttpRequest.latest!
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent)
    xhr.status = 200
    xhr.responseText = JSON.stringify({ storageId: 'storage_123' })
    xhr.onload?.()

    await expect(promise).resolves.toBe('storage_123')
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('https://upload.example')
    expect(xhr.headers.get('Content-Type')).toBe('text/csv')
    expect(xhr.body).toBe(file)
    expect(progress).toHaveBeenCalledWith({ loaded: 5, total: 10, percent: 50 })
    expect(progress).toHaveBeenLastCalledWith({
      loaded: file.size,
      total: file.size,
      percent: 100,
    })
  })

  it('rejects timed out uploads instead of spinning forever', async () => {
    globalThis.XMLHttpRequest =
      MockXMLHttpRequest as unknown as typeof XMLHttpRequest
    const promise = uploadBlobToStorageUrl(
      'https://upload.example',
      new Blob(['csv'], { type: 'text/csv' }) as File,
      { mediaType: 'text/csv', timeoutMs: 1 },
    )
    MockXMLHttpRequest.latest!.ontimeout?.()

    await expect(promise).rejects.toThrow('Upload timed out')
  })

  it('scales timeout for larger files while keeping a floor for small CSVs', () => {
    expect(uploadTimeoutMs(1024)).toBe(45_000)
    expect(uploadTimeoutMs(100 * 1024 * 1024)).toBe(10 * 60_000)
  })
})
