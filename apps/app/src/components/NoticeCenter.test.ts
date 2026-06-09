import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ShieldCheck } from 'lucide-react'
import { noticeIconForTone, useNotice } from './NoticeCenter'

function UsesNotice() {
  useNotice()
  return createElement('span')
}

describe('useNotice', () => {
  it('fails loudly outside NoticeProvider', () => {
    expect(() => renderToStaticMarkup(createElement(UsesNotice))).toThrow(
      /useNotice.*NoticeProvider/,
    )
  })

  it('has a distinct approval notice tone', () => {
    expect(noticeIconForTone('approval')).toBe(ShieldCheck)
  })
})
