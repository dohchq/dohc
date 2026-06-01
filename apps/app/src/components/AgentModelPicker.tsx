import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
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

export function agentSelectionToConvexArgs(
  selection: AgentModelPickerSelection,
) {
  return {
    agentProviderId: selection.providerId,
    agentModel: selection.model,
    ...(selection.reasoningEffort
      ? { agentReasoningEffort: selection.reasoningEffort }
      : {}),
  }
}

export type AgentModelPickerModel = {
  id: string
  label: string
  contextWindowTokens?: number
  maxContextWindowTokens?: number
  effectiveContextWindowPercent?: number
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
  defaultReasoningEffort: AgentReasoningEffort | null
  models: AgentModelPickerModel[]
}

const REASONING_LABELS: Record<AgentReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
}

const POPOVER_EDGE_GAP = 14
const POPOVER_TRIGGER_GAP = 10
const POPOVER_MAX_WIDTH = 560

type PopoverFrame = {
  left: number
  width: number
  bottom?: number
  top?: number
  placement: 'above' | 'below'
}

function popoverFrameForTrigger(
  rect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): PopoverFrame {
  const width = Math.max(
    0,
    Math.min(POPOVER_MAX_WIDTH, viewportWidth - POPOVER_EDGE_GAP * 2),
  )
  const maxLeft = Math.max(POPOVER_EDGE_GAP, viewportWidth - width - POPOVER_EDGE_GAP)
  const left = Math.round(
    Math.min(Math.max(POPOVER_EDGE_GAP, rect.left), maxLeft),
  )

  if (rect.top > viewportHeight / 2) {
    return {
      left,
      width,
      bottom: Math.round(viewportHeight - rect.top + POPOVER_TRIGGER_GAP),
      placement: 'above',
    }
  }

  return {
    left,
    width,
    top: Math.round(rect.bottom + POPOVER_TRIGGER_GAP),
    placement: 'below',
  }
}

function modelLabel(
  providers: ReadonlyArray<AgentProviderSnapshot>,
  selection: AgentModelPickerSelection | null,
) {
  const provider = providers.find((p) => p.providerId === selection?.providerId)
  const model = provider?.models.find((m) => m.id === selection?.model)
  return model?.label ?? selection?.model ?? 'Model'
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}m`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

function modelContextLabel(model: AgentModelPickerModel): string | null {
  if (!model.contextWindowTokens) return null
  const base = `${formatContextTokens(model.contextWindowTokens)} context`
  if (
    model.maxContextWindowTokens &&
    model.maxContextWindowTokens > model.contextWindowTokens
  ) {
    return `${base} · up to ${formatContextTokens(model.maxContextWindowTokens)}`
  }
  return base
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
        : provider.defaultReasoningEffort &&
          model.reasoningEfforts.includes(provider.defaultReasoningEffort)
        ? provider.defaultReasoningEffort
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
  const [popoverFrame, setPopoverFrame] = useState<PopoverFrame | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [focusedModelId, setFocusedModelId] = useState<string | null>(null)
  const provider = selectedProvider(providers, selection)
  const selectedModel = provider?.models.find((m) => m.id === selection?.model)
  const [focusedProviderId, setFocusedProviderId] = useState<string | null>(null)
  const activeProvider =
    providers.find((p) => p.providerId === focusedProviderId) ??
    provider ??
    providers[0] ??
    null
  const activeProviderReady = activeProvider?.status === 'ready'
  const activeSelectedModel =
    activeProvider?.providerId === selection?.providerId ? selectedModel : null
  const activeReasoningModel =
    activeSelectedModel ??
    activeProvider?.models.find((model) => model.id === activeProvider.defaultModel) ??
    activeProvider?.models.find((model) => model.recommended) ??
    activeProvider?.models[0] ??
    null
  const activeReasoningEffort =
    activeSelectedModel && selection?.reasoningEffort
      ? selection.reasoningEffort
      : activeProvider?.defaultReasoningEffort &&
        activeReasoningModel?.reasoningEfforts.includes(
          activeProvider.defaultReasoningEffort,
        )
      ? activeProvider.defaultReasoningEffort
      : activeReasoningModel?.reasoningEfforts.includes('xhigh')
      ? 'xhigh'
      : activeReasoningModel?.reasoningEfforts.at(-1)
  const readyProviders = providers.filter((p) => p.status === 'ready')
  const canChoose = !disabled && providers.length > 0

  function updatePopoverFrame() {
    if (typeof window === 'undefined') return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPopoverFrame(
      popoverFrameForTrigger(rect, window.innerWidth, window.innerHeight),
    )
  }

  function togglePicker() {
    if (!canChoose) return
    if (open) {
      setOpen(false)
      return
    }
    updatePopoverFrame()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    setFocusedProviderId(provider?.providerId ?? providers[0]?.providerId ?? null)
  }, [open, provider?.providerId, providers])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    updatePopoverFrame()
    window.addEventListener('resize', updatePopoverFrame)
    window.addEventListener('scroll', updatePopoverFrame, true)
    return () => {
      window.removeEventListener('resize', updatePopoverFrame)
      window.removeEventListener('scroll', updatePopoverFrame, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return

    const focusTarget =
      popoverRef.current?.querySelector<HTMLElement>(
        'input[placeholder="Search models"]',
      ) ??
      popoverRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ??
      popoverRef.current
    focusTarget?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (
        document.activeElement instanceof Node &&
        popoverRef.current?.contains(document.activeElement)
      ) {
        triggerRef.current?.focus()
      }
    }
  }, [open])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return

    function closeFromOutsidePointer(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      const path =
        typeof event.composedPath === 'function' ? event.composedPath() : []
      const insideTrigger =
        triggerRef.current &&
        (triggerRef.current.contains(target) || path.includes(triggerRef.current))
      const insidePopover =
        popoverRef.current &&
        (popoverRef.current.contains(target) || path.includes(popoverRef.current))

      if (!insideTrigger && !insidePopover) setOpen(false)
    }

    document.addEventListener('pointerdown', closeFromOutsidePointer, true)
    return () => {
      document.removeEventListener('pointerdown', closeFromOutsidePointer, true)
    }
  }, [open])

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase()
    const models = activeProvider?.models ?? []
    if (!q) return models
    return models.filter((model) => {
      const providerLabel = activeProvider?.displayName.toLowerCase() ?? ''
      const contextLabel = modelContextLabel(model)?.toLowerCase() ?? ''
      return (
        model.label.toLowerCase().includes(q) ||
        model.id.toLowerCase().includes(q) ||
        contextLabel.includes(q) ||
        providerLabel.includes(q)
      )
    })
  }, [activeProvider, query])

  useEffect(() => {
    if (!open) return
    const selectedInList =
      activeSelectedModel &&
      filteredModels.some((model) => model.id === activeSelectedModel.id)
        ? activeSelectedModel.id
        : null
    setFocusedModelId((current) =>
      current && filteredModels.some((model) => model.id === current)
        ? current
        : selectedInList ?? filteredModels[0]?.id ?? null,
    )
  }, [activeSelectedModel, filteredModels, open])

  function choose(model: AgentModelPickerModel) {
    if (!activeProvider || activeProvider.status !== 'ready') return
    onChange(nextSelectionForModel(activeProvider, model, selection))
  }

  function updateReasoning(reasoningEffort: AgentReasoningEffort) {
    if (!activeProvider || !activeReasoningModel?.supportsReasoning) return
    const base =
      activeSelectedModel && selection
        ? selection
        : nextSelectionForModel(activeProvider, activeReasoningModel, selection)
    onChange({ ...base, reasoningEffort })
  }

  function focusModelAt(index: number) {
    const model = filteredModels[index]
    if (!model) return
    setFocusedModelId(model.id)
    popoverRef.current
      ?.querySelector<HTMLButtonElement>(`[data-agent-model-index="${index}"]`)
      ?.focus()
  }

  function onPopoverKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      if (event.key === 'Enter' && focusedModelId) {
        const model = filteredModels.find(
          (candidate) => candidate.id === focusedModelId,
        )
        if (model && document.activeElement?.tagName !== 'INPUT') {
          event.preventDefault()
          choose(model)
        }
      }
      return
    }
    if (filteredModels.length < 1) return
    event.preventDefault()
    const currentIndex = Math.max(
      0,
      filteredModels.findIndex((model) => model.id === focusedModelId),
    )
    const direction = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex =
      (currentIndex + direction + filteredModels.length) % filteredModels.length
    focusModelAt(nextIndex)
  }

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePicker}
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

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
          />
          <div
            ref={popoverRef}
            onKeyDown={onPopoverKeyDown}
            className="fixed z-40 grid max-w-[calc(100vw-28px)] grid-cols-[154px_minmax(0,1fr)] overflow-hidden rounded-xl border border-rule-strong bg-elevated shadow-modal"
            style={{
              left: popoverFrame?.left ?? 14,
              width: popoverFrame?.width ?? 560,
              ...(popoverFrame?.placement === 'below'
                ? { top: popoverFrame.top ?? 72 }
                : { bottom: popoverFrame?.bottom ?? 72 }),
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
                      {!ready && (
                        <span
                          className="rounded-full bg-hover px-1.5 py-0.5 text-[9px] font-semibold text-ink-faint"
                          title={`Set ${candidate.missingEnvVar ?? 'the provider key'}`}
                        >
                          Set key
                        </span>
                      )}
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

              {activeProvider && !activeProviderReady && (
                <div className="mt-2 rounded-lg border border-rule bg-panel/70 px-2.5 py-2 text-[11.5px] leading-snug text-ink-dim">
                  <span className="font-medium text-ink">
                    {activeProvider.displayName} needs a server key.
                  </span>{' '}
                  Set {activeProvider.missingEnvVar ?? 'the provider key'} to enable
                  these models.
                </div>
              )}

              {activeProviderReady && activeReasoningModel?.supportsReasoning && (
                <div className="mt-2 rounded-lg border border-rule bg-panel/50 p-1.5">
                  <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                    <Brain className="size-3" strokeWidth={1.8} />
                    Reasoning
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {activeReasoningModel.reasoningEfforts.map((effort) => {
                      const active = activeReasoningEffort === effort
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
                <div
                  className="max-h-64 overflow-y-auto"
                  role="listbox"
                  aria-label="models"
                >
                  {filteredModels.map((model, index) => {
                    const checked =
                      selection?.providerId === activeProvider?.providerId &&
                      selection?.model === model.id
                    const disabledModel = !activeProviderReady
                    const contextLabel = modelContextLabel(model)
                    const highlighted = model.id === focusedModelId
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => choose(model)}
                        disabled={disabledModel}
                        role="option"
                        aria-selected={highlighted}
                        data-agent-model-index={index}
                        className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                          checked || highlighted
                            ? 'bg-hover text-ink-strong'
                            : 'text-ink-dim hover:bg-hover hover:text-ink'
                        }`}
                      >
                        <Zap className="size-3.5 shrink-0 text-ink-faint" strokeWidth={1.8} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">
                            {model.label}
                          </span>
                          {contextLabel && (
                            <span className="mt-0.5 block truncate text-[10.5px] font-medium text-ink-faint">
                              {contextLabel}
                            </span>
                          )}
                        </span>
                        {model.recommended && (
                          <span className="rounded-md border border-rule bg-panel px-1.5 py-0.5 text-[9.5px] font-semibold text-ink-faint">
                            Recommended
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
          </>,
          document.body,
        )}
    </div>
  )
}
