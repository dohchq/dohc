import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'

// emoji-icons — a Notion-style in-app emoji picker (search, categories,
// skin tones) via emoji-mart. The picker + its data are lazy-loaded
// (client-only, ~hundreds of KB) so they never hit the SSR bundle and
// only load when the picker opens.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PickerComponent = ComponentType<any>

function resolveTheme(): 'light' | 'dark' | 'auto' {
  if (typeof document === 'undefined') return 'auto'
  const t = document.documentElement.getAttribute('data-theme')
  return t === 'dark' || t === 'light' ? t : 'auto'
}

export function EmojiPicker({
  onPick,
  onClear,
  onClose,
}: {
  title?: string
  current?: string | null
  onPick: (emoji: string) => void
  onClear: () => void
  onClose: () => void
}) {
  const [Picker, setPicker] = useState<PickerComponent | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([
      import('@emoji-mart/react'),
      import('@emoji-mart/data'),
    ]).then(([picker, d]) => {
      if (!alive) return
      setPicker(() => picker.default as unknown as PickerComponent)
      setData(d.default)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-backdrop/40"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <div className="mb-1.5 flex justify-end">
          <button
            type="button"
            onClick={onClear}
            className="rounded-md bg-surface/90 px-2 py-1 text-[11.5px] text-ink-dim shadow-sm hover:text-ink-strong"
          >
            Remove icon
          </button>
        </div>
        {Picker && data ? (
          <Picker
            data={data}
            theme={resolveTheme()}
            previewPosition="none"
            autoFocus
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onEmojiSelect={(e: any) => {
              if (e?.native) onPick(e.native)
            }}
          />
        ) : (
          <div className="grid h-[360px] w-[352px] place-items-center rounded-xl border border-rule bg-surface text-sm text-ink-faint">
            loading emojis…
          </div>
        )}
      </div>
    </div>
  )
}
