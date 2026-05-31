import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function isDialogFocusableCandidate(el: HTMLElement): boolean {
  return (
    !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
  )
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isDialogFocusableCandidate)
}

export function useDialogFocus<T extends HTMLElement = HTMLElement>({
  open = true,
  initialFocusRef,
  onEscape,
}: {
  open?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  onEscape?: () => void
}) {
  const dialogRef = useRef<T | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    if (!dialog) return
    const target = initialFocusRef?.current ?? focusableWithin(dialog)[0] ?? dialog
    target.focus({ preventScroll: true })
    return () => {
      const previous = previousFocusRef.current
      if (previous && document.contains(previous)) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [initialFocusRef, open])

  const onDialogKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault()
        onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = focusableWithin(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    },
    [onEscape],
  )

  return { dialogRef, onDialogKeyDown }
}
