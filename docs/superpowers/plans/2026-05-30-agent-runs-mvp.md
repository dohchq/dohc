# Agent Runs MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dohc's MVP center on agent work runs: onboarding creates a source-backed `home.html` cockpit plus inspectable run notes, and the app shell can toggle between Agent and Files.

**Architecture:** Reuse atoms as the durable primitive instead of adding schema. A Setup Run is a markdown atom under `.runs/`, source files stay editable markdown, and the cockpit is a sandboxed `.html` atom backed by source metadata and live formulas. The shell gets an Agent mode that reuses the existing chat pipeline and keeps side-chat available in Files mode.

**Tech Stack:** TanStack Start + React 19, Convex, Convex Agent, Vitest, Tailwind v4 tokens.

---

### Task 1: Lock The New Onboarding Floor With Tests

**Files:**
- Modify: `apps/app/convex/onboarding.test.ts`
- Modify: `apps/app/src/__tests__/onboardingSetupFirst.test.ts`

- [ ] **Step 1: Write failing backend expectations**

Change the onboarding completion tests so `_complete` only succeeds after the workspace has:
`.context/me.md`, at least one real markdown source, a source-backed `home.html`, and `.runs/setup.md`.

- [ ] **Step 2: Write failing prompt/copy expectations**

Update the setup-first test to expect `home.html`, `.runs/setup.md`, Setup Run language, and the no-fake-data rule.

- [ ] **Step 3: Run targeted tests and confirm RED**

Run:

```bash
pnpm --filter @dohc/app test convex/onboarding.test.ts src/__tests__/onboardingSetupFirst.test.ts
```

Expected: tests fail because the product still accepts a markdown dashboard and the prompt does not require Setup Run artifacts.

### Task 2: Implement Setup Run Progress And Completion

**Files:**
- Modify: `apps/app/convex/onboarding.ts`
- Modify: `apps/app/convex/agent.ts`

- [ ] **Step 1: Extend `OnboardingProgress`**

Add `sourceCount`, `hasCockpitView`, `hasSetupRun`, `cockpitPath`, and `runPath`, preserving `hasDashboardWithQuery`/`dashboardPath` as compatibility aliases for current UI consumers.

- [ ] **Step 2: Detect source-backed cockpits**

Treat `.html` atoms named `home.html`, `dashboard.html`, or `cockpit.html` as cockpit candidates only when they have `sources:` metadata and live braces/formulas in the body.

- [ ] **Step 3: Detect setup run atoms**

Treat `.runs/setup.md` or `runs/setup.md` as the inspectable Setup Run artifact when it contains objective, sources, view, and next-action sections.

- [ ] **Step 4: Update completion invariant**

Require identity, at least one real source atom, source-backed cockpit, and setup run before `finish_onboarding`.

- [ ] **Step 5: Update the agent prompt**

Rewrite the onboarding section so dohc creates source markdown first, then `home.html`, then `.runs/setup.md`, and only then calls `finish_onboarding`.

- [ ] **Step 6: Run targeted tests and confirm GREEN**

Run:

```bash
pnpm --filter @dohc/app test convex/onboarding.test.ts src/__tests__/onboardingSetupFirst.test.ts
```

Expected: targeted tests pass.

### Task 3: Add Agent Mode To The Shell

**Files:**
- Create: `apps/app/src/components/AgentRunRail.tsx`
- Modify: `apps/app/src/components/ActivityBar.tsx`
- Modify: `apps/app/src/components/Chat.tsx`
- Modify: `apps/app/src/components/HtmlAtomFrame.tsx`
- Modify: `apps/app/src/routes/_app.tsx`
- Add: `apps/app/src/__tests__/agentModeShell.test.ts`

- [ ] **Step 1: Write failing shell test**

Assert the activity bar exposes Agent, Files, and Graph; `_app.tsx` renders an Agent view; and Chat supports `mode="primary"` while preserving side dock usage.

- [ ] **Step 2: Add ActivityBar Agent item**

Expose Agent beside Files and Graph, with shareable public routes for `/agent`,
`/files`, and `/graph`. Keep any existing internal Files implementation key as
a compatibility detail rather than a user-facing contract.

- [ ] **Step 3: Make Chat reusable as primary or side panel**

Add `mode?: 'side' | 'primary'` and adjust layout classes, empty state, and tool cards without changing send/list message behavior.

- [ ] **Step 4: Add `AgentRunRail`**

Render Progress, Sources, Review, and Collaboration rails from current atom paths. Keep it read-only and derived from existing workspace state.

- [ ] **Step 5: Wire `_app.tsx` modes**

Default the workspace to Agent mode unless an atom URL/onboarding handoff is active. Files mode keeps the file tree/editor and optional side chat. Agent mode shows primary chat plus the run rail.

- [ ] **Step 6: Run targeted frontend tests**

Run:

```bash
pnpm --filter @dohc/app test src/__tests__/agentModeShell.test.ts src/__tests__/commandPalette.test.ts src/__tests__/f1ChatBusy.test.ts
```

Expected: targeted frontend tests pass.

### Task 4: Verify The Slice

**Files:**
- No new files.

- [ ] **Step 1: Typecheck**

Run:

```bash
pnpm --filter @dohc/app typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 2: Full app test suite**

Run:

```bash
pnpm --filter @dohc/app test
```

Expected: all app tests pass or any pre-existing failures are documented.
