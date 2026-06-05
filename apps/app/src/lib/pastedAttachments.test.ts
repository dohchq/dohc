import { describe, expect, it } from 'vitest'
import {
  assetMarkdownReference,
  attachmentKindForType,
  formatAttachmentSize,
  isInlineTextType,
  parseAssetHref,
} from './pastedAttachments'

describe('pasted attachment helpers', () => {
  it('classifies media by MIME type with file as the safe fallback', () => {
    expect(attachmentKindForType('image/png')).toBe('image')
    expect(attachmentKindForType('video/mp4')).toBe('video')
    expect(attachmentKindForType('audio/mpeg')).toBe('audio')
    expect(attachmentKindForType('application/pdf')).toBe('file')
    expect(attachmentKindForType('')).toBe('file')
  })

  it('only inlines small text-like source files into agent prompts', () => {
    expect(isInlineTextType('text/plain', 'notes.txt')).toBe(true)
    expect(isInlineTextType('text/csv', 'clients.csv')).toBe(true)
    expect(isInlineTextType('application/json', 'data.json')).toBe(true)
    expect(isInlineTextType('application/toml', 'settings.toml')).toBe(true)
    expect(isInlineTextType('image/svg+xml', 'diagram.svg')).toBe(true)
    expect(isInlineTextType('', '.env')).toBe(true)
    expect(isInlineTextType('', '.env.local')).toBe(true)
    expect(isInlineTextType('', 'Dockerfile')).toBe(true)
    expect(isInlineTextType('', 'Dockerfile.prod')).toBe(true)
    expect(isInlineTextType('', 'script.py')).toBe(true)
    expect(isInlineTextType('', 'deploy.sh')).toBe(true)
    expect(isInlineTextType('', 'README.md')).toBe(true)
    expect(isInlineTextType('image/png', 'screenshot.png')).toBe(false)
    expect(isInlineTextType('application/pdf', 'deck.pdf')).toBe(false)
    expect(isInlineTextType('audio/mpeg', 'voice.mp3')).toBe(false)
    expect(
      isInlineTextType(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'book.xlsx',
      ),
    ).toBe(false)
  })

  it('formats compact file sizes for attachment chips', () => {
    expect(formatAttachmentSize(42)).toBe('42 B')
    expect(formatAttachmentSize(2048)).toBe('2 KB')
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('renders stable dohc asset markdown references without raw storage URLs', () => {
    expect(
      assetMarkdownReference({
        kind: 'image',
        assetId: 'asset_abc',
        label: 'Screenshot',
      }),
    ).toBe('![Screenshot](dohc-asset:image/asset_abc)')
    expect(
      assetMarkdownReference({
        kind: 'audio',
        assetId: 'asset_voice',
        label: 'Voice memo',
      }),
    ).toBe('[Voice memo](dohc-asset:audio/asset_voice)')
    expect(
      assetMarkdownReference({
        kind: 'video',
        assetId: 'asset_demo',
        label: 'Demo',
      }),
    ).toBe('[Demo](dohc-asset:video/asset_demo)')
  })

  it('parses stable dohc asset hrefs', () => {
    expect(parseAssetHref('dohc-asset:image/asset_abc')).toEqual({
      kind: 'image',
      assetId: 'asset_abc',
    })
    expect(parseAssetHref('https://example.com/image.png')).toBeNull()
  })
})
