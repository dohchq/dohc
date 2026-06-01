import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  Pin,
  Search,
  Zap,
} from 'lucide-react'

export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export type AgentModelPickerSelection = {
  providerId: string
  model: string
  reasoningEffort?: AgentReasoningEffort
}

export type AgentModelPickerModel = {
  id: string
  label: string
  supportsReasoning: boolean
  reasoningEfforts: AgentReasoningEffort[]
  recommended?: boolean
}

export type AgentProviderSnapshot = {
  providerId: string
  displayName: string
  accentColor: string
  status: 'ready' | 'missing_key'
  missingEnvVar: string | null
  defaultModel: string
  models: AgentModelPickerModel[]
}

const REASONING_LABELS: Record<AgentReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
}

function modelLabel(
  providers: ReadonlyArray<AgentProviderSnapshot>,
  selection: AgentModelPickerSelection | null,
) {
  const provider = providers.find((p) => p.providerId === selection?.providerId)
  const model = provider?.models.find((m) => m.id === selection?.model)
  return model?.label ?? selection?.model ?? 'Model'
}

function selectedProvider(
  providers: ReadonlyArray<AgentProviderSnapshot>,
  selection: AgentModelPickerSelection | null,
) {
  return (
    providers.find((p) => p.providerId === selection?.providerId) ??
    providers.find((p) => p.status === 'ready') ??
    providers[0] ??
    null
  )
}

function nextSelectionForModel(
  provider: AgentProviderSnapshot,
  model: AgentModelPickerModel,
  current: AgentModelPickerSelection | null,
): AgentModelPickerSelection {
  const reasoningEffort =
    model.supportsReasoning
      ? current?.reasoningEffort &&
        model.reasoningEfforts.includes(current.reasoningEffort)
        ? current.reasoningEffort
        : model.reasoningEfforts.includes('xhigh')
        ? 'xhigh'
        : model.reasoningEfforts.at(-1)
      : undefined
  return {
    providerId: provider.providerId,
    model: model.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

export function AgentModelPicker({
  providers,
  selection,
  disabled = false,
  onChange,
  onSetDefault,
}: {
  providers: ReadonlyArray<AgentProviderSnapshot>
  selection: AgentModelPickerSelection | null
  disabled?: boolean
  onChange: (selection: AgentModelPickerSelection) => void
  onSetDefault?: (selection: AgentModelPickerSelection) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [popoverFrame, setPopoverFrame] = useState<{
    left: number
    bottom: number
    width: number
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const provider = selectedProvider(providers, selection)
  const selectedModel = provider?.models.find((m) => m.id === selection?.model)
  const [focusedProviderId, setFocusedProviderId] = useState<string | null>(null)
  const activeProvider =
    providers.find((p) => p.providerId === focusedProviderId) ??
    provider ??
    providers[0] ??
    null
  const activeSelectedModel =
    activeProvider?.providerId === selection?.providerId ? selectedModel : null
  const readyProviders = providers.filter((p) => p.status === 'ready')
  const canChoose = !disabled && providers.length > 0

  useEffect(() => {
    if (!open) return
    setFocusedProviderId(provider?.providerId ?? providers[0]?.providerId ?? null)
  }, [open, provider?.providerId, providers])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(560, window.innerWidth - 28)
    const left = Math.min(Math.max(14, rect.left), window.innerWidth - width - 14)
    setPopoverFrame({
      left,
      width,
      bottom: window.innerHeight - rect.top + 8,
    })
  }, [open])

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase()
    const models = activeProvider?.models ?? []
    if (!q) return models
    return models.filter((model) => {
      const providerLabel = activeProvider?.displayName.toLowerCase() ?? ''
      return (
        model.label.toLowerCase().includes(q) ||
        model.id.toLowerCase().includes(q) ||
        providerLabel.includes(q)
      )
    })
  }, [activeProvider, query])

  function choose(model: AgentModelPickerModel) {
    if (!activeProvider || activeProvider.status !== 'ready') return
    onChange(nextSelectionForModel(activeProvider, model, selection))
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function updateReasoning(reasoningEffort: AgentReasoningEffort) {
    if (!selection || !selectedModel?.supportsReasoning) return
    onChange({ ...selection, reasoningEffort })
  }

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => canChoose && setOpen((value) => !value)}
        disabled={!canChoose}
        className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-rule bg-panel/70 px-2.5 text-[10.5px] font-medium text-ink-dim shadow-xs transition hover:border-rule-strong hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
        title={
          provider
            ? `${provider.displayName} · ${modelLabel(providers, selection)}`
            : 'No model provider configured'
        }
        aria-label="Choose model"
      >
        <Zap className="size-3 shrink-0 text-ink-faint" strokeWidth={1.9} />
        <span className="min-w-0 truncate">{modelLabel(providers, selection)}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-faint" strokeWidth={1.9} />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
          />
          <div
            className="fixed z-40 grid max-w-[calc(100vw-28px)] grid-cols-[154px_minmax(0,1fr)] overflow-hidden rounded-xl border border-rule-strong bg-elevated shadow-modal"
            style={{
              left: popoverFrame?.left ?? 14,
              bottom: popoverFrame?.bottom ?? 72,
              width: popoverFrame?.width ?? 560,
            }}
          >
            <div className="border-r border-rule bg-panel/60 p-2">
              <div className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Provider
              </div>
              <div className="space-y-1">
                {providers.map((candidate) => {
                  const active = candidate.providerId === activeProvider?.providerId
                  const ready = candidate.status === 'ready'
                  return (
                    <button
                      key={candidate.providerId}
                      type="button"
                      onClick={() => {
                        setFocusedProviderId(candidate.providerId)
                        setQuery('')
                      }}
                      className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                        active
                          ? 'bg-elevated text-ink shadow-xs'
                          : 'text-ink-dim hover:bg-hover hover:text-ink'
                      }`}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: candidate.accentColor }}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                        {candidate.displayName}
                      </span>
                      <span
                        className={`size-1.5 rounded-full ${
                          ready ? 'bg-success' : 'bg-ink-ghost'
                        }`}
                        title={ready ? 'Ready' : candidate.missingEnvVar ?? 'Missing key'}
                      />
                    </button>
                  )
                })}
              </div>
              {readyProviders.length === 0 && (
                <div className="mt-2 rounded-lg border border-rule bg-elevated px-2.5 py-2 text-[11.5px] leading-snug text-ink-faint">
                  Set OPENAI_API_KEY or ANTHROPIC_API_KEY.
                </div>
              )}
            </div>

            <div className="min-w-0 p-2.5">
              <label className="flex h-9 items-center gap-2 rounded-lg border border-rule bg-panel px-2.5 text-ink-dim focus-within:border-rule-strong">
                <Search className="size-3.5 shrink-0" strokeWidth={1.8} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search models"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
                />
              </label>

              {activeSelectedModel?.supportsReasoning && selection && (
                <div className="mt-2 rounded-lg border border-rule bg-panel/50 p-1.5">
                  <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                    <Brain className="size-3" strokeWidth={1.8} />
                    Reasoning
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {activeSelectedModel.reasoningEfforts.map((effort) => {
                      const active = selection.reasoningEffort === effort
                      return (
                        <button
                          key={effort}
                          type="button"
                          onClick={() => updateReasoning(effort)}
                          className={`h-8 rounded-md px-2 text-[11.5px] font-medium transition-colors ${
                            active
                              ? 'bg-ink-strong text-surface'
                              : 'text-ink-dim hover:bg-hover hover:text-ink'
                          }`}
                        >
                          {REASONING_LABELS[effort]}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="mt-2">
                <div className="flex items-center justify-between gap-3 px-1.5 pb-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                    Model
                  </span>
                  {selection && onSetDefault && (
                    <button
                      type="button"
                      onClick={() => onSetDefault(selection)}
                      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium text-ink-faint hover:bg-hover hover:text-ink"
                    >
                      <Pin className="size-3" strokeWidth={1.8} />
                      Default
                    </button>
                  )}
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {filteredModels.map((model) => {
                    const checked =
                      selection?.providerId === activeProvider?.providerId &&
                      selection?.model === model.id
                    const disabledModel = activeProvider?.status !== 'ready'
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => choose(model)}
                        disabled={disabledModel}
                        className={`flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                          checked
                            ? 'bg-hover text-ink-strong'
                            : 'text-ink-dim hover:bg-hover hover:text-ink'
                        }`}
                      >
                        <Zap className="size-3.5 shrink-0 text-ink-faint" strokeWidth={1.8} />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                          {model.label}
                        </span>
                        {model.recommended && (
                          <span className="rounded-md border border-rule bg-panel px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                            Rec
                          </span>
                        )}
                        {checked && (
                          <Check className="size-4 shrink-0 text-accent" strokeWidth={2} />
                        )}
                      </button>
                    )
                  })}
                  {filteredModels.length === 0 && (
                    <div className="px-2.5 py-6 text-center text-[12px] text-ink-faint">
                      No models match.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
