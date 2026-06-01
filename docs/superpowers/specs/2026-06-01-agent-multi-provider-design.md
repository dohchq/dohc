# Agent Multi-Provider Design

Date: 2026-06-01

## Decision

dohc will add a provider spine with simple model selection UI. Providers are configured by the server through environment variables or deployment config. The product UI lets users choose among configured providers and models, set a workspace default, and keep each chat thread bound to its chosen provider/model.

This is not a full provider settings center. The MVP does not include provider CRUD, browser-side API keys, custom endpoint setup, favorites, hidden models, drag ordering, or multi-account management.

## Reference

[pingdotgg/t3code](https://github.com/pingdotgg/t3code) is the reference implementation for the interaction model:

- Provider instances are routing keys, separate from provider driver kinds.
- Models are choices inside a provider instance.
- The composer shows a compact active model control.
- The picker is fast, keyboard-friendly, searchable, grouped by provider, and shows status quietly.
- Configuration and secrets do not leak into normal chat flow.

dohc should borrow the clarity of T3 Code's picker without copying its full provider settings center.

## Goals

- Support OpenAI and Anthropic direct providers.
- Make OpenAI the first starter preset when `OPENAI_API_KEY` is configured.
- Make Anthropic available when `ANTHROPIC_API_KEY` is configured.
- Preserve self-hosting simplicity: operators set env vars, users pick from available models.
- Store workspace default provider/model and thread provider/model.
- Keep model/provider choice visible and easy in the composer.
- Centralize provider-specific safety behavior so skill/command turn gates stay correct.

## Non-Goals

- No in-app provider setup page for MVP.
- No browser-side provider secrets.
- No OpenRouter/LiteLLM/vLLM/Ollama implementation in this pass.
- No advanced per-model tuning beyond the reasoning menu for models where dohc supports it.
- No user-facing model zoo of unconfigured providers.

## Provider Model

The backend exposes configured provider instances. A provider instance has:

- `providerInstanceId`: stable routing key, such as `openai` or `anthropic`.
- `driver`: implementation kind, such as `openai` or `anthropic`.
- `displayName`: user-facing label, such as `OpenAI` or `Claude`.
- `status`: `ready`, `missing_key`, or `unsupported`.
- `models`: curated model list for the instance.

The first implementation can derive instances from env vars:

- `OPENAI_API_KEY` enables the `openai` instance.
- `ANTHROPIC_API_KEY` enables the `anthropic` instance.
- `DOHC_DEFAULT_PROVIDER` optionally picks a configured default.
- `DOHC_DEFAULT_MODEL` optionally picks a valid model for that provider.

If no provider is configured, the agent composer shows a calm disabled state explaining which server env vars are needed.

## Data Flow

Workspace settings store the default provider instance and model. Thread refs store the selected provider instance and model for that chat thread.

New chat creation:

1. Read the workspace default provider/model.
2. Fall back to the server default configured provider/model.
3. Persist the selected provider/model on `threadRefs`.

Sending a message:

1. Client sends the selected provider instance and model only when the user changed it.
2. Server validates that the provider exists, is configured, and supports dohc agent turns.
3. Server updates the thread selection before streaming.
4. Server constructs the language model through the provider registry.

Existing chats:

- If a thread has a provider/model, use it.
- If not, fall back to workspace default and server default without mutating history until the next send or explicit default action.

## Composer UX

The chat composer gets a compact model control inspired by T3 Code and Codex:

- Normal label: `OpenAI · GPT-5.5 · Extra High` or `Claude · Sonnet`.
- It sits near the project/environment control and status pills.
- It is disabled while a turn is sending or streaming.
- It remains small in the default composer state.

Opening the control shows a two-part picker:

- Left: provider rail with configured providers.
- Right: searchable model list for the selected provider.
- Reasoning choices appear for supported models: Low, Medium, High, Extra High.
- Selected provider/model/reasoning have checkmarks.
- Unavailable providers are hidden by default, or disabled only when needed for a no-provider diagnostic.
- A small action lets the user set the current provider/model as the workspace default.

Keyboard expectations:

- Arrow keys move through visible rows.
- Enter selects.
- Escape closes.
- Search filters by provider name and model name.

The UI should use dohc's warm paper + graphite system and feel quiet, dense, and operational. It should not look like a marketing panel or an admin dashboard.

## Provider Safety

Provider-specific behavior belongs in the registry, not scattered through `agent.ts`.

Each provider adapter must expose whether it supports:

- tool calls
- forced tool choice
- no parallel tool calls for skill/command entry turns
- structured object generation for onboarding questions

For MVP, only models that satisfy the required agent-turn safety contract are selectable for normal agent turns. If a provider cannot express no-parallel-tool behavior natively, the adapter must either provide an equivalent guard or mark the model unavailable.

`buildPrepareStep` continues to decide which tools are legal. The provider adapter only translates provider options, such as Anthropic's no-parallel-tool setting or the OpenAI equivalent supported by the AI SDK.

## Testing

Backend tests:

- provider registry derives OpenAI and Anthropic from env/config
- invalid provider/model selections are rejected
- new threads persist selected provider/model
- existing ownership and workspace gates still fail closed
- skill-fire and command-fire prepare-step behavior remains unchanged

Frontend tests:

- picker renders configured providers and models
- selecting a model updates the draft thread selection
- existing thread shows its persisted provider/model
- set-as-default action updates the workspace default
- no-provider state is clear and non-crashing

Live eval:

- Keep inline atom eval provider-aware, but do not require live provider keys for unit tests.
- The eval runner should report which provider/model was used.

## Rollout

1. Add provider registry and direct OpenAI/Anthropic adapters.
2. Add provider/model fields to thread refs and workspace defaults.
3. Thread provider selection through create-thread and send-message flows.
4. Replace hardcoded Anthropic model usage in the agent and onboarding question generation.
5. Add the compact composer picker.
6. Update eval env names and docs.

## Open Later

- OpenAI-compatible provider instance for OpenRouter, LiteLLM, vLLM, and internal gateways.
- Ollama/local provider.
- In-app provider settings center if users need browser-managed provider setup.
- Favorites, hidden models, custom ordering, and multiple accounts.
