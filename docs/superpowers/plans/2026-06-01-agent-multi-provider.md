# Agent Multi-Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct OpenAI + Anthropic model selection with workspace defaults, thread-bound choices, and a compact Codex/T3-style composer picker.

**Architecture:** A small provider registry owns provider/model metadata, environment detection, selection validation, model construction, and provider-specific safety options. Convex persists only routing fields on `threadRefs` and `workspaceSettings`; the frontend reads provider snapshots and sends the selected routing fields with each turn.

**Tech Stack:** Convex, @convex-dev/agent, AI SDK v6, @ai-sdk/openai, @ai-sdk/anthropic, React, TanStack Start, Vitest.

---

## File Structure

- Create `apps/app/convex/agentProviders.ts`: provider registry, model lists, env-key status, selection validation, server default resolution, AI SDK model factory, provider options.
- Modify `apps/app/package.json` and `pnpm-lock.yaml`: add `@ai-sdk/openai`.
- Modify `apps/app/convex/schema.ts`: add optional agent provider/model fields to `threadRefs` and `workspaceSettings`.
- Modify `apps/app/convex/agent.ts`: replace hard-coded Anthropic model usage with provider selection; add provider list/default mutations; persist per-thread selection.
- Create `apps/app/src/components/AgentModelPicker.tsx`: compact searchable provider/model/reasoning picker.
- Modify `apps/app/src/components/Chat.tsx`: accept provider snapshots/selection props, render the picker in `ComposerStatusStrip`, and include provider args in `sendMessage`.
- Modify `apps/app/src/routes/_app.tsx`: query provider snapshots/default, track selected thread/draft model, pass selection to Chat and thread creation.
- Modify `apps/app/src/components/AgentChatSidebar.tsx`: extend `AgentThreadSummary` type with optional provider fields.
- Modify tests under `apps/app/convex/*.test.ts` and `apps/app/src/__tests__/*.test.ts`: lock registry behavior, persistence, and UI wiring.
- Modify `.env.example`: document direct-provider env vars.

## Task 1: Install OpenAI SDK

- [ ] **Step 1: Add direct OpenAI provider package**

Run:

```bash
npx pnpm@10.24.0 --filter @dohc/app add @ai-sdk/openai@3.0.67
```

Expected: `apps/app/package.json` includes `@ai-sdk/openai`, and `pnpm-lock.yaml` changes. A Node engine warning is acceptable in this workspace because the shell Node is older than the repo engine range.

## Task 2: Provider Registry

**Files:**
- Create: `apps/app/convex/agentProviders.ts`
- Test: `apps/app/convex/agentProviders.test.ts`

- [ ] **Step 1: Write the registry tests**

Create tests that assert:

```ts
expect(listAgentProviderSnapshots().map((p) => p.providerId)).toEqual([
  'openai',
  'anthropic',
])
expect(resolveAgentSelection({}, undefined, undefined)).toMatchObject({
  providerId: 'openai',
  model: 'gpt-5.5',
})
expect(() =>
  validateAgentSelection({ providerId: 'openai', model: 'not-real' }),
).toThrow(/Unknown model/)
expect(agentProviderOptions({ providerId: 'anthropic', model: 'claude-sonnet-4-6' }, true)).toEqual({
  anthropic: { disableParallelToolUse: true },
})
```

- [ ] **Step 2: Implement the registry**

Add a focused module exporting:

```ts
export type AgentProviderId = 'openai' | 'anthropic'
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
export type AgentModelSelection = {
  providerId: AgentProviderId
  model: string
  reasoningEffort?: AgentReasoningEffort
}

export function listAgentProviderSnapshots(): AgentProviderSnapshot[] { ... }
export function resolveAgentSelection(
  threadSelection?: Partial<AgentModelSelection> | null,
  workspaceSelection?: Partial<AgentModelSelection> | null,
  requestSelection?: Partial<AgentModelSelection> | null,
): AgentModelSelection { ... }
export function validateAgentSelection(selection: AgentModelSelection): AgentModelSelection { ... }
export function createAgentLanguageModel(selection: AgentModelSelection): LanguageModel { ... }
export function agentProviderOptions(selection: AgentModelSelection, disableParallelTools: boolean): Record<string, unknown> | undefined { ... }
```

Use OpenAI-first precedence when `OPENAI_API_KEY` exists, Anthropic fallback when only `ANTHROPIC_API_KEY` exists, and keep provider entries visible with `status: 'missing_key'` so self-hosters get an obvious diagnostic.

- [ ] **Step 3: Run registry tests**

Run:

```bash
npx pnpm@10.24.0 --filter @dohc/app test -- convex/agentProviders.test.ts
```

Expected: registry tests pass.

## Task 3: Convex Persistence And Streaming

**Files:**
- Modify: `apps/app/convex/schema.ts`
- Modify: `apps/app/convex/agent.ts`
- Modify: `apps/app/convex/agent.test.ts`
- Modify: `apps/app/src/__tests__/prepareStep.test.ts`

- [ ] **Step 1: Add failing persistence tests**

Extend `agent.test.ts` to seed:

```ts
await ctx.db.insert('threadRefs', {
  workspaceId: A,
  threadId: 'tA',
  agentProviderId: 'anthropic',
  agentModel: 'claude-opus-4-7',
  agentReasoningEffort: 'medium',
  updatedAt: 10,
})
```

Assert `listThreads` returns those fields, and add a workspace default mutation assertion:

```ts
await t.withIdentity({ subject: A }).mutation(api.agent.setAgentWorkspaceDefault, {
  agentProviderId: 'openai',
  agentModel: 'gpt-5.5',
  agentReasoningEffort: 'high',
})
const providers = await t.withIdentity({ subject: A }).query(api.agent.listAgentProviders, {})
expect(providers.workspaceDefault).toMatchObject({
  providerId: 'openai',
  model: 'gpt-5.5',
  reasoningEffort: 'high',
})
```

- [ ] **Step 2: Add schema fields**

Add optional fields:

```ts
agentProviderId: v.optional(v.string()),
agentModel: v.optional(v.string()),
agentReasoningEffort: v.optional(
  v.union(v.literal('low'), v.literal('medium'), v.literal('high'), v.literal('xhigh')),
),
```

to both `threadRefs` and `workspaceSettings`.

- [ ] **Step 3: Wire agent actions**

Update `agent.ts` so:

```ts
languageModel: defaultAgentLanguageModel(),
```

`sendMessage` accepts `agentProviderId`, `agentModel`, `agentReasoningEffort`, resolves selection from thread/workspace/request, patches the thread row, and streams with:

```ts
model: createAgentLanguageModel(selection),
prepareStep: buildPrepareStep(ctx, threadId, messageId, entry, selection),
```

`buildPrepareStep` calls `agentProviderOptions(selection, true)` for skill/command entry modes.

- [ ] **Step 4: Add provider public endpoints**

Add:

```ts
export const listAgentProviders = query({ ... })
export const setAgentWorkspaceDefault = mutation({ ... })
```

Both must derive `workspaceId` server-side via `requireWorkspace`, not trust client identity.

- [ ] **Step 5: Run backend tests**

Run:

```bash
npx pnpm@10.24.0 --filter @dohc/app test -- convex/agentProviders.test.ts convex/agent.test.ts src/__tests__/prepareStep.test.ts
```

Expected: backend and structural prepare-step tests pass.

## Task 4: Composer Picker UI

**Files:**
- Create: `apps/app/src/components/AgentModelPicker.tsx`
- Modify: `apps/app/src/components/Chat.tsx`
- Modify: `apps/app/src/routes/_app.tsx`
- Modify: `apps/app/src/components/AgentChatSidebar.tsx`
- Modify: `apps/app/src/__tests__/agentModeShell.test.ts`

- [ ] **Step 1: Add shell wiring tests**

Assert source contains:

```ts
expect(APP).toContain('api.agent.listAgentProviders')
expect(APP).toContain('setAgentWorkspaceDefault')
expect(APP).toContain('agentProviderId')
expect(CHAT).toContain('AgentModelPicker')
expect(CHAT).toContain('agentProviderId: agentSelection.providerId')
expect(AGENT_MODEL_PICKER).toContain('Reasoning')
expect(AGENT_MODEL_PICKER).toContain('Search models')
```

- [ ] **Step 2: Build `AgentModelPicker`**

Create a focused popover component with:

```ts
export type AgentModelPickerSelection = {
  providerId: string
  model: string
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
}
```

Use a trigger pill with a provider/model label, a left provider rail, a search input, a model list with checkmarks, and a compact Reasoning section shown when the selected model supports reasoning.

- [ ] **Step 3: Wire Chat**

Extend `Chat` props with provider data and `onAgentSelectionChange`. Add the picker to `ComposerStatusStrip`, and include selection fields in all `sendMessage` calls:

```ts
agentProviderId: agentSelection.providerId,
agentModel: agentSelection.model,
agentReasoningEffort: agentSelection.reasoningEffort,
```

- [ ] **Step 4: Wire App state**

Query `api.agent.listAgentProviders`, derive the active selection from active thread or workspace default, keep a draft selection for new chats, pass selection to `createAgentThread`, and expose a “make default” callback via `api.agent.setAgentWorkspaceDefault`.

- [ ] **Step 5: Run UI wiring tests**

Run:

```bash
npx pnpm@10.24.0 --filter @dohc/app test -- src/__tests__/agentModeShell.test.ts src/__tests__/agentChatSidebar.test.ts
```

Expected: shell tests pass and no legacy select-based model UI appears.

## Task 5: Docs And Verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document env vars**

Add:

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DOHC_DEFAULT_PROVIDER=openai
DOHC_DEFAULT_MODEL=gpt-5.5
```

Keep this direct-provider only; do not add OpenRouter/custom base URL bloat in this MVP.

- [ ] **Step 2: Run final checks**

Run:

```bash
npx pnpm@10.24.0 --filter @dohc/app typecheck
npx pnpm@10.24.0 --filter @dohc/app test -- convex/agentProviders.test.ts convex/agent.test.ts src/__tests__/prepareStep.test.ts src/__tests__/agentModeShell.test.ts src/__tests__/agentChatSidebar.test.ts
git diff --check
```

Expected: typecheck passes, targeted tests pass, and whitespace check passes. Note any Node engine warnings separately from failures.

