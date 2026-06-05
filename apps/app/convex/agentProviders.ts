import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import type { LanguageModelV3 } from '@ai-sdk/provider'

export const AGENT_PROVIDER_IDS = ['openai', 'anthropic'] as const
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number]

export const AGENT_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const
export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number]

export type AgentModelSelection = {
  providerId: AgentProviderId
  model: string
  reasoningEffort?: AgentReasoningEffort
}

export type StoredAgentSelection = {
  agentProviderId: AgentProviderId
  agentModel: string
  agentReasoningEffort?: AgentReasoningEffort
}

export type AgentSelectionInput = {
  providerId?: string | null
  model?: string | null
  reasoningEffort?: string | null
  agentProviderId?: string | null
  agentModel?: string | null
  agentReasoningEffort?: string | null
}

export type AgentProviderModel = {
  id: string
  label: string
  contextWindowTokens: number
  maxContextWindowTokens?: number
  effectiveContextWindowPercent?: number
  supportsReasoning: boolean
  reasoningEfforts: AgentReasoningEffort[]
  recommended?: boolean
}

export type AgentProviderSnapshot = {
  providerId: AgentProviderId
  driver: AgentProviderId
  displayName: string
  accentColor: string
  status: 'ready' | 'missing_key'
  missingEnvVar: string | null
  defaultModel: string
  defaultReasoningEffort: AgentReasoningEffort | null
  models: AgentProviderModel[]
}

type AgentProviderDefinition = {
  providerId: AgentProviderId
  driver: AgentProviderId
  displayName: string
  accentColor: string
  envVar: string
  defaultModel: string
  defaultReasoningEffort?: AgentReasoningEffort
  models: AgentProviderModel[]
}

const OPENAI_REASONING: AgentReasoningEffort[] = [
  'low',
  'medium',
  'high',
]

const ANTHROPIC_REASONING: AgentReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

const OPENAI_EFFECTIVE_CONTEXT_PERCENT = 95
const OPENAI_128K_CONTEXT = {
  contextWindowTokens: 128_000,
  maxContextWindowTokens: 128_000,
  effectiveContextWindowPercent: OPENAI_EFFECTIVE_CONTEXT_PERCENT,
}
const OPENAI_272K_CONTEXT = {
  contextWindowTokens: 272_000,
  maxContextWindowTokens: 272_000,
  effectiveContextWindowPercent: OPENAI_EFFECTIVE_CONTEXT_PERCENT,
}
const OPENAI_1M_CONTEXT = {
  contextWindowTokens: 272_000,
  maxContextWindowTokens: 1_000_000,
  effectiveContextWindowPercent: OPENAI_EFFECTIVE_CONTEXT_PERCENT,
}
const ANTHROPIC_200K_CONTEXT = {
  contextWindowTokens: 200_000,
  maxContextWindowTokens: 200_000,
}
const ANTHROPIC_1M_CONTEXT = {
  contextWindowTokens: 200_000,
  maxContextWindowTokens: 1_000_000,
}

const PROVIDERS: AgentProviderDefinition[] = [
  {
    providerId: 'openai',
    driver: 'openai',
    displayName: 'OpenAI',
    accentColor: '#111827',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.5',
    defaultReasoningEffort: 'high',
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        ...OPENAI_272K_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: OPENAI_REASONING,
        recommended: true,
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        ...OPENAI_1M_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: OPENAI_REASONING,
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        ...OPENAI_272K_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: OPENAI_REASONING,
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        ...OPENAI_272K_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: OPENAI_REASONING,
      },
      {
        id: 'gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        ...OPENAI_128K_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: OPENAI_REASONING,
      },
      {
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        ...OPENAI_272K_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: OPENAI_REASONING,
      },
    ],
  },
  {
    providerId: 'anthropic',
    driver: 'anthropic',
    displayName: 'Anthropic',
    accentColor: '#9a6a45',
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-4-8',
    defaultReasoningEffort: 'high',
    models: [
      {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        ...ANTHROPIC_1M_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: ANTHROPIC_REASONING,
        recommended: true,
      },
      {
        id: 'claude-opus-4-7',
        label: 'Claude Opus 4.7',
        ...ANTHROPIC_1M_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: ANTHROPIC_REASONING,
      },
      {
        id: 'claude-opus-4-6',
        label: 'Claude Opus 4.6',
        ...ANTHROPIC_1M_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: ANTHROPIC_REASONING,
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
        ...ANTHROPIC_1M_CONTEXT,
        supportsReasoning: true,
        reasoningEfforts: ANTHROPIC_REASONING,
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        ...ANTHROPIC_200K_CONTEXT,
        supportsReasoning: false,
        reasoningEfforts: [],
      },
    ],
  },
]

function envValue(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function isProviderId(value: unknown): value is AgentProviderId {
  return (
    typeof value === 'string' &&
    (AGENT_PROVIDER_IDS as readonly string[]).includes(value)
  )
}

function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return (
    typeof value === 'string' &&
    (AGENT_REASONING_EFFORTS as readonly string[]).includes(value)
  )
}

function providerById(providerId: AgentProviderId): AgentProviderDefinition {
  return PROVIDERS.find((provider) => provider.providerId === providerId)!
}

function providerForModel(model: string): AgentProviderDefinition | null {
  return (
    PROVIDERS.find((provider) =>
      provider.models.some((providerModel) => providerModel.id === model),
    ) ?? null
  )
}

function modelForSelection(selection: AgentModelSelection): AgentProviderModel {
  const provider = providerById(selection.providerId)
  const model = provider.models.find(
    (candidate) => candidate.id === selection.model,
  )
  if (!model) {
    throw new Error(
      `Unknown model "${selection.model}" for provider ${provider.displayName}.`,
    )
  }
  return model
}

function providerStatus(
  provider: AgentProviderDefinition,
): AgentProviderSnapshot['status'] {
  return envValue(provider.envVar) ? 'ready' : 'missing_key'
}

function rawProviderId(input?: AgentSelectionInput | null): string | null {
  return input?.providerId ?? input?.agentProviderId ?? null
}

function rawModel(input?: AgentSelectionInput | null): string | null {
  return input?.model ?? input?.agentModel ?? null
}

function rawReasoningEffort(input?: AgentSelectionInput | null): string | null {
  return input?.reasoningEffort ?? input?.agentReasoningEffort ?? null
}

function defaultProvider(): AgentProviderDefinition {
  const envProvider = envValue('DOHC_DEFAULT_PROVIDER')
  if (isProviderId(envProvider)) return providerById(envProvider)
  const ready = PROVIDERS.find((provider) => providerStatus(provider) === 'ready')
  return ready ?? PROVIDERS[0]
}

export function listAgentProviderSnapshots(): AgentProviderSnapshot[] {
  return PROVIDERS.map((provider) => {
    const status = providerStatus(provider)
    return {
      providerId: provider.providerId,
      driver: provider.driver,
      displayName: provider.displayName,
      accentColor: provider.accentColor,
      status,
      missingEnvVar: status === 'missing_key' ? provider.envVar : null,
      defaultModel: provider.defaultModel,
      defaultReasoningEffort: provider.defaultReasoningEffort ?? null,
      models: provider.models,
    }
  })
}

export function validateAgentSelection(
  selection: AgentModelSelection,
): AgentModelSelection {
  if (!isProviderId(selection.providerId)) {
    throw new Error(`Unknown provider "${String(selection.providerId)}".`)
  }
  const model = modelForSelection(selection)
  const reasoningEffort = selection.reasoningEffort
  if (reasoningEffort !== undefined) {
    if (!isReasoningEffort(reasoningEffort)) {
      throw new Error(`Unknown reasoning effort "${String(reasoningEffort)}".`)
    }
    if (!model.supportsReasoning) {
      throw new Error(`${model.label} does not support reasoning controls.`)
    }
    if (!model.reasoningEfforts.includes(reasoningEffort)) {
      throw new Error(
        `${model.label} does not support reasoning effort "${reasoningEffort}".`,
      )
    }
  }
  return selection
}

export function resolveServerDefaultSelection(): AgentModelSelection {
  const provider = defaultProvider()
  const envModel = envValue('DOHC_DEFAULT_MODEL')
  const model =
    envModel && provider.models.some((candidate) => candidate.id === envModel)
      ? envModel
      : provider.defaultModel
  const base: AgentModelSelection = {
    providerId: provider.providerId,
    model,
  }
  if (provider.defaultReasoningEffort) {
    base.reasoningEffort = provider.defaultReasoningEffort
  }
  return validateAgentSelection(base)
}

function applySelectionPatch(
  base: AgentModelSelection,
  patch?: AgentSelectionInput | null,
  strict = false,
): AgentModelSelection {
  if (!patch) return base
  const requestedModel = rawModel(patch)?.trim()
  const requestedProvider = rawProviderId(patch)?.trim()
  if (strict && requestedProvider && !isProviderId(requestedProvider)) {
    throw new Error(`Unknown provider "${requestedProvider}".`)
  }
  const inferredProvider = requestedModel ? providerForModel(requestedModel) : null
  const providerId = isProviderId(requestedProvider)
    ? requestedProvider
    : inferredProvider?.providerId ?? base.providerId
  const provider = providerById(providerId)
  const providerChanged = providerId !== base.providerId
  const model =
    requestedModel || (providerChanged ? provider.defaultModel : base.model)
  const providerModel =
    provider.models.find((candidate) => candidate.id === model) ?? null
  const reasoningRaw = rawReasoningEffort(patch)?.trim()
  if (strict && reasoningRaw && !isReasoningEffort(reasoningRaw)) {
    throw new Error(`Unknown reasoning effort "${reasoningRaw}".`)
  }
  const selection: AgentModelSelection = {
    providerId,
    model,
  }

  if (
    providerModel?.supportsReasoning &&
    isReasoningEffort(reasoningRaw) &&
    providerModel.reasoningEfforts.includes(reasoningRaw)
  ) {
    selection.reasoningEffort = reasoningRaw
  } else if (
    providerModel?.supportsReasoning &&
    !providerChanged &&
    base.reasoningEffort &&
    providerModel.reasoningEfforts.includes(base.reasoningEffort)
  ) {
    selection.reasoningEffort = base.reasoningEffort
  } else if (
    providerModel?.supportsReasoning &&
    provider.defaultReasoningEffort &&
    providerModel.reasoningEfforts.includes(provider.defaultReasoningEffort)
  ) {
    selection.reasoningEffort = provider.defaultReasoningEffort
  }

  try {
    return validateAgentSelection(selection)
  } catch (error) {
    if (strict) throw error
    return base
  }
}

export function resolveAgentSelection(
  threadSelection?: AgentSelectionInput | null,
  workspaceSelection?: AgentSelectionInput | null,
  requestSelection?: AgentSelectionInput | null,
): AgentModelSelection {
  const workspaceResolved = applySelectionPatch(
    resolveServerDefaultSelection(),
    workspaceSelection,
    false,
  )
  const threadResolved = applySelectionPatch(
    workspaceResolved,
    threadSelection,
    false,
  )
  return applySelectionPatch(threadResolved, requestSelection, true)
}

export function assertAgentSelectionReady(selection: AgentModelSelection) {
  const provider = providerById(selection.providerId)
  if (providerStatus(provider) !== 'ready') {
    throw new Error(
      `${provider.displayName} is not configured. Set ${provider.envVar} on the server to use ${provider.displayName} models.`,
    )
  }
}

export function createAgentLanguageModel(
  selection: AgentModelSelection,
): LanguageModelV3 {
  validateAgentSelection(selection)
  if (selection.providerId === 'openai') return openai(selection.model)
  return anthropic(selection.model)
}

export function defaultAgentLanguageModel(): LanguageModelV3 {
  return createAgentLanguageModel(resolveServerDefaultSelection())
}

export function agentProviderOptions(
  selection: AgentModelSelection,
  disableParallelTools: boolean,
): Record<string, Record<string, unknown>> | undefined {
  const model = modelForSelection(selection)
  if (selection.providerId === 'anthropic') {
    const anthropicOptions: Record<string, unknown> = {}
    if (disableParallelTools) anthropicOptions.disableParallelToolUse = true
    if (model.supportsReasoning && selection.reasoningEffort) {
      anthropicOptions.thinking = { type: 'adaptive' }
      anthropicOptions.effort =
        model.id.startsWith('claude-') && selection.reasoningEffort === 'xhigh'
          ? 'high'
          : selection.reasoningEffort
    }
    return Object.keys(anthropicOptions).length > 0
      ? { anthropic: anthropicOptions }
      : undefined
  }

  const openaiOptions: Record<string, unknown> = {}
  if (disableParallelTools) openaiOptions.parallelToolCalls = false
  if (model.supportsReasoning && selection.reasoningEffort) {
    openaiOptions.reasoningEffort = selection.reasoningEffort
  }
  return Object.keys(openaiOptions).length > 0
    ? { openai: openaiOptions }
    : undefined
}

export function toStoredAgentSelection(
  selection: AgentModelSelection,
): StoredAgentSelection {
  return {
    agentProviderId: selection.providerId,
    agentModel: selection.model,
    ...(selection.reasoningEffort
      ? { agentReasoningEffort: selection.reasoningEffort }
      : {}),
  }
}
