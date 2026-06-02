import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentProviderOptions,
  assertAgentSelectionReady,
  listAgentProviderSnapshots,
  resolveAgentSelection,
  toStoredAgentSelection,
  validateAgentSelection,
} from './agentProviders'

describe('agent provider registry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('lists direct OpenAI and Anthropic providers in OpenAI-first order', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test')

    const providers = listAgentProviderSnapshots()

    expect(providers.map((p) => p.providerId)).toEqual(['openai', 'anthropic'])
    expect(providers[0]).toMatchObject({
      providerId: 'openai',
      displayName: 'OpenAI',
      status: 'ready',
    })
    expect(providers[0].models.map((m) => m.id)).toContain('gpt-5.5')
    expect(providers[1].models.map((m) => m.id)).toContain('claude-opus-4-8')
    expect(providers[1].models[0]).toMatchObject({
      id: 'claude-opus-4-8',
      recommended: true,
      supportsReasoning: true,
    })
    expect(providers[1].defaultReasoningEffort).toBe('high')
  })

  it('publishes dohc-style per-model context stats instead of one blanket default', () => {
    const providers = listAgentProviderSnapshots()
    const openai = providers.find((provider) => provider.providerId === 'openai')
    const anthropic = providers.find((provider) => provider.providerId === 'anthropic')

    expect(
      openai?.models.find((model) => model.id === 'gpt-5.3-codex-spark'),
    ).toMatchObject({
      contextWindowTokens: 128_000,
      maxContextWindowTokens: 128_000,
      effectiveContextWindowPercent: 95,
    })
    expect(openai?.models.find((model) => model.id === 'gpt-5.4')).toMatchObject({
      contextWindowTokens: 272_000,
      maxContextWindowTokens: 1_000_000,
      effectiveContextWindowPercent: 95,
    })
    expect(
      anthropic?.models.find((model) => model.id === 'claude-opus-4-8'),
    ).toMatchObject({
      contextWindowTokens: 200_000,
      maxContextWindowTokens: 1_000_000,
    })
  })

  it('surfaces missing-key status instead of hiding provider diagnostics', () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')

    expect(listAgentProviderSnapshots()).toMatchObject([
      { providerId: 'openai', status: 'missing_key', missingEnvVar: 'OPENAI_API_KEY' },
      {
        providerId: 'anthropic',
        status: 'missing_key',
        missingEnvVar: 'ANTHROPIC_API_KEY',
      },
    ])
  })

  it('resolves OpenAI as the self-host default when no env preference is set', () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('DOHC_DEFAULT_PROVIDER', '')
    vi.stubEnv('DOHC_DEFAULT_MODEL', '')

    expect(resolveAgentSelection(null, null, null)).toMatchObject({
      providerId: 'openai',
      model: 'gpt-5.5',
    })
  })

  it('applies workspace, thread, and request selections with request taking priority', () => {
    const selection = resolveAgentSelection(
      { agentProviderId: 'anthropic', agentModel: 'claude-sonnet-4-6' },
      { agentProviderId: 'openai', agentModel: 'gpt-5.4' },
      { agentProviderId: 'openai', agentModel: 'gpt-5.5', agentReasoningEffort: 'high' },
    )

    expect(selection).toEqual({
      providerId: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    })
  })

  it('does not add reasoning defaults to non-reasoning models', () => {
    expect(
      resolveAgentSelection(null, null, {
        agentProviderId: 'anthropic',
        agentModel: 'claude-haiku-4-5',
      }),
    ).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('rejects invalid explicit request providers in strict resolution', () => {
    expect(() =>
      resolveAgentSelection(null, null, {
        agentProviderId: 'not-real',
        agentModel: 'gpt-5.5',
      }),
    ).toThrow(/Unknown provider "not-real"/)
  })

  it('omits stored reasoning effort when no reasoning was selected', () => {
    expect(
      toStoredAgentSelection({
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    ).toEqual({
      agentProviderId: 'anthropic',
      agentModel: 'claude-haiku-4-5',
    })
  })

  it('rejects unknown models for known providers', () => {
    expect(() =>
      validateAgentSelection({ providerId: 'openai', model: 'not-real' }),
    ).toThrow(/Unknown model/)
  })

  it('rejects reasoning for non-reasoning provider models', () => {
    expect(() =>
      validateAgentSelection({
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
        reasoningEffort: 'high',
      }),
    ).toThrow(/does not support reasoning/)
  })

  it('selects non-reasoning models without inheriting a reasoning effort', () => {
    expect(
      resolveAgentSelection(null, null, {
        agentProviderId: 'anthropic',
        agentModel: 'claude-haiku-4-5',
      }),
    ).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('builds provider-specific no-parallel options for entry steps', () => {
    expect(
      agentProviderOptions(
        { providerId: 'anthropic', model: 'claude-sonnet-4-6' },
        true,
      ),
    ).toEqual({
      anthropic: { disableParallelToolUse: true },
    })

    expect(
      agentProviderOptions(
        {
          providerId: 'anthropic',
          model: 'claude-opus-4-8',
          reasoningEffort: 'high',
        },
        true,
      ),
    ).toEqual({
      anthropic: {
        disableParallelToolUse: true,
        thinking: { type: 'adaptive' },
        effort: 'high',
      },
    })

    expect(
      agentProviderOptions(
        { providerId: 'openai', model: 'gpt-5.5', reasoningEffort: 'xhigh' },
        true,
      ),
    ).toEqual({
      openai: { parallelToolCalls: false, reasoningEffort: 'xhigh' },
    })
  })

  it('clamps extra-high reasoning before sending Claude provider options', () => {
    expect(
      agentProviderOptions(
        {
          providerId: 'anthropic',
          model: 'claude-opus-4-8',
          reasoningEffort: 'xhigh',
        },
        false,
      ),
    ).toEqual({
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: 'high',
      },
    })
  })

  it('fails clearly before a selected provider streams without its env key', () => {
    vi.stubEnv('OPENAI_API_KEY', '')

    expect(() =>
      assertAgentSelectionReady({ providerId: 'openai', model: 'gpt-5.5' }),
    ).toThrow(/OPENAI_API_KEY/)
  })
})
