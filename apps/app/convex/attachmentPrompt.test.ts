import { describe, expect, it } from 'vitest'
import { inlineAttachmentBlock } from './attachmentPrompt'

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
    expect(output).toContain('Account 10;Food;11')
    expect(output).not.toContain('Account 39;Food;40')
  })
})
