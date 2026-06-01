import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useNotice } from './NoticeCenter'

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
})
