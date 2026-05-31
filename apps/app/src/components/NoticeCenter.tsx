import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Info,
  X,
} from 'lucide-react'

type NoticeTone = 'info' | 'success' | 'danger'

type NoticeInput = {
  tone?: NoticeTone
  title: string
  detail?: string
  timeoutMs?: number
}

type Notice = Required<Pick<NoticeInput, 'tone' | 'title'>> &
  Pick<NoticeInput, 'detail'> & {
    id: number
    timeoutMs: number
  }

type NoticeApi = {
  notify: (notice: NoticeInput) => void
  success: (title: string, detail?: string) => void
  error: (title: string, detail?: string) => void
  info: (title: string, detail?: string) => void
}

const NoticeContext = createContext<NoticeApi | null>(null)

export function useNotice(): NoticeApi {
  const ctx = useContext(NoticeContext)
  if (!ctx) {
    throw new Error('useNotice must be used within a NoticeProvider')
  }
  return ctx
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])
  const nextNoticeId = useRef(0)

  const remove = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id))
  }, [])

  const notify = useCallback((input: NoticeInput) => {
    nextNoticeId.current += 1
    const id = nextNoticeId.current
    const next: Notice = {
      id,
      tone: input.tone ?? 'info',
      title: input.title,
      detail: input.detail,
      timeoutMs: input.timeoutMs ?? (input.tone === 'danger' ? 6500 : 4200),
    }
    setNotices((current) => [...current.slice(-1), next])
  }, [])

  const api = useMemo<NoticeApi>(
    () => ({
      notify,
      success: (title, detail) => notify({ tone: 'success', title, detail }),
      error: (title, detail) => notify({ tone: 'danger', title, detail }),
      info: (title, detail) => notify({ tone: 'info', title, detail }),
    }),
    [notify],
  )

  return (
    <NoticeContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {notices.map((notice) => (
          <NoticeCard
            key={notice.id}
            notice={notice}
            onClose={remove}
          />
        ))}
      </div>
    </NoticeContext.Provider>
  )
}

function NoticeCard({
  notice,
  onClose,
}: {
  notice: Notice
  onClose: (id: number) => void
}) {
  useEffect(() => {
    const timeoutId = window.setTimeout(() => onClose(notice.id), notice.timeoutMs)
    return () => window.clearTimeout(timeoutId)
  }, [notice.id, notice.timeoutMs, onClose])

  const Icon =
    notice.tone === 'success'
      ? CheckCircle2
      : notice.tone === 'danger'
        ? AlertCircle
        : Info
  const toneClass =
    notice.tone === 'success'
      ? 'text-success'
      : notice.tone === 'danger'
        ? 'text-danger'
        : 'text-ink-dim'

  return (
    <div
      role={notice.tone === 'danger' ? 'alert' : 'status'}
      aria-live={notice.tone === 'danger' ? 'assertive' : 'polite'}
      className="pointer-events-auto flex min-w-0 items-start gap-2 rounded-lg border border-rule bg-elevated/95 px-3 py-2.5 text-ink shadow-md backdrop-blur"
    >
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${toneClass}`} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-ink-strong">
          {notice.title}
        </div>
        {notice.detail && (
          <div className="mt-0.5 line-clamp-3 text-[11.5px] leading-snug text-ink-dim">
            {notice.detail}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onClose(notice.id)}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        aria-label="Dismiss notice"
      >
        <X className="size-3" strokeWidth={2} />
      </button>
    </div>
  )
}
