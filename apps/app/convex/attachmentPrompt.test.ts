import { describe, expect, it } from 'vitest'
import {
  attachmentReferenceBlock,
  inlineAttachmentBlock,
} from './attachmentPrompt'

describe('attachment prompt context', () => {
  it('summarizes CSV files instead of inlining every row into the model prompt', () => {
    const text = [
      'account;category;amount',
      ...Array.from({ length: 40 }, (_, index) =>
        `Account ${index};Food;${index + 1}`,
      ),
    ].join('\n')

    const output = inlineAttachmentBlock({
      assetId: 'asset_csv',
      filename: 'wallet_records.csv',
      mediaType: 'text/csv',
      text,
    })

    expect(output).toContain('CSV preview: 40 rows, 3 columns')
    expect(output).toContain('Showing first 12 rows only')
    expect(output).toContain(
      'Full file is available through read_asset with assetId asset_csv.',
    )
    expect(output).toContain('Account 10;Food;11')
    expect(output).not.toContain('Account 39;Food;40')
    expect(output).not.toContain('the full file is attached separately')
  })

  it('keeps a compact read_asset reference for files that are not inlined', () => {
    const output = attachmentReferenceBlock({
      assetId: 'asset_large',
      filename: 'big-wallet.csv',
      mediaType: 'text/csv',
      size: 512_000,
    })

    expect(output).toContain('name="big-wallet.csv"')
    expect(output).toContain('assetId="asset_large"')
    expect(output).toContain(
      'Full file is available through read_asset with assetId asset_large.',
    )
    expect(output).not.toContain('Account 39')
  })

  it('describes raster image attachments as vision input', () => {
    const output = attachmentReferenceBlock({
      assetId: 'asset_image',
      filename: 'receipt.png',
      mediaType: 'image/png',
      size: 42_000,
      vision: true,
    })

    expect(output).toContain('name="receipt.png"')
    expect(output).toContain('This image is also attached for vision input.')
    expect(output).not.toContain('read_asset')
  })

  it('keeps unsupported binary media saved without claiming text readability', () => {
    const output = attachmentReferenceBlock({
      assetId: 'asset_video',
      filename: 'demo.mp4',
      mediaType: 'video/mp4',
      size: 2_000_000,
      readable: false,
    })

    expect(output).toContain('name="demo.mp4"')
    expect(output).toContain(
      'This attachment is saved, but this media type is not readable as text yet.',
    )
    expect(output).not.toContain('read_asset')
  })
})
