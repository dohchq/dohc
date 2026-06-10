// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileTypeView } from '../components/FileTypeView'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

describe('type-specific file views', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderFile(props: React.ComponentProps<typeof FileTypeView>) {
    act(() => {
      root.render(React.createElement(FileTypeView, props))
    })
  }

  it('opens csv as a data view instead of the markdown editor', () => {
    renderFile({
      path: 'finance/ledger.csv',
      mediaType: 'text/csv',
      extension: 'csv',
      body: 'date,merchant,amount\n2026-06-01,Atome,26262\n',
    })

    expect(container.querySelector('[data-testid="file-view-csv"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="atom-editor"]')).toBeNull()
    expect(container.textContent).toContain('Atome')
  })

  it('opens txt as a plain text view', () => {
    renderFile({
      path: 'notes/plain.txt',
      mediaType: 'text/plain',
      extension: 'txt',
      body: 'plain words',
    })

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Plain text file contents"]',
    )
    expect(textarea?.value).toBe('plain words')
  })

  it('opens json as formatted code', () => {
    renderFile({
      path: 'data/profile.json',
      mediaType: 'application/json',
      extension: 'json',
      body: '{"name":"Ice","ok":true}',
    })

    const code = container.querySelector<HTMLElement>('[data-language="json"]')
    expect(code?.textContent).toContain('"name": "Ice"')
  })

  it('opens pdf in a file preview shell', () => {
    renderFile({
      path: 'docs/brief.pdf',
      mediaType: 'application/pdf',
      extension: 'pdf',
      assetUrl: 'https://assets.example.test/brief.pdf',
    })

    expect(container.querySelector('[data-testid="file-view-pdf"]')).not.toBeNull()
    expect(container.querySelector('object[type="application/pdf"]')).not.toBeNull()
  })

  it('opens images in an image preview shell', () => {
    renderFile({
      path: 'uploads/receipt.png',
      mediaType: 'image/png',
      extension: 'png',
      assetUrl: 'https://assets.example.test/receipt.png',
    })

    const image = container.querySelector<HTMLImageElement>('img')
    expect(image?.alt).toBe('uploads/receipt.png')
  })

  it('opens audio in an audio preview shell', () => {
    renderFile({
      path: 'voice/memo.m4a',
      mediaType: 'audio/mp4',
      extension: 'm4a',
      assetUrl: 'https://assets.example.test/memo.m4a',
    })

    expect(container.querySelector('[data-testid="file-view-audio"]')).not.toBeNull()
    expect(container.querySelector('audio[controls]')).not.toBeNull()
  })
})
