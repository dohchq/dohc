import { useEffect, useState } from 'react'
import { AsciiSketcher } from './AsciiSketcher'

export function AsciiSketchModal({
  onClose,
  onInsert,
  initialText,
  initialLanguage,
}: {
  onClose: () => void
  onInsert: (text: string, language?: string) => void
  /** Pre-seed the canvas with this ASCII content — parsed into one text
   *  shape per non-empty line so the user can edit/move/delete the lines
   *  or draw over them. */
  initialText?: string
  initialLanguage?: string
}) {
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // F11 / cmd-shift-f toggles fullscreen
      if (
        e.key === 'F11' ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f')
      ) {
        e.preventDefault()
        setFullscreen((f) => !f)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className={`modal-backdrop sketch-backdrop${fullscreen ? ' sketch-backdrop-fullscreen' : ''}`}
      onClick={onClose}
    >
      <div
        className={`modal-panel sketch-modal${fullscreen ? ' sketch-modal-fullscreen' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sketch-modal-header">
          <span className="sketch-modal-title">ASCII sketch</span>
          <div className="sketch-modal-header-actions">
            <button
              type="button"
              className="sketch-modal-fullscreen-toggle"
              onClick={() => setFullscreen((f) => !f)}
              title={fullscreen ? 'exit fullscreen (F11)' : 'fullscreen (F11)'}
              aria-label={fullscreen ? 'exit fullscreen' : 'fullscreen'}
            >
              {fullscreen ? '⊟' : '⛶'}
            </button>
            <button
              type="button"
              className="sketch-modal-close"
              onClick={onClose}
              aria-label="close"
            >
              ×
            </button>
          </div>
        </div>
        <AsciiSketcher
          onCancel={onClose}
          onInsert={onInsert}
          initialText={initialText}
          initialLanguage={initialLanguage}
        />
      </div>
    </div>
  )
}
