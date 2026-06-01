import { describe, expect, it } from 'vitest'
import { isDialogFocusableCandidate } from './dialog-focus'

function elementLike({
  disabled = false,
  ariaHidden,
}: {
  disabled?: boolean
  ariaHidden?: string | null
}) {
  return {
    hasAttribute: (name: string) => name === 'disabled' && disabled,
    getAttribute: (name: string) =>
      name === 'aria-hidden' ? (ariaHidden ?? null) : null,
  } as HTMLElement
}

describe('dialog focus candidates', () => {
  it('keeps aria-hidden=false elements inside the focus trap', () => {
    expect(
      isDialogFocusableCandidate(elementLike({ ariaHidden: 'false' })),
    ).toBe(true)
    expect(
      isDialogFocusableCandidate(elementLike({ ariaHidden: 'true' })),
    ).toBe(false)
    expect(isDialogFocusableCandidate(elementLike({ disabled: true }))).toBe(
      false,
    )
  })
})
