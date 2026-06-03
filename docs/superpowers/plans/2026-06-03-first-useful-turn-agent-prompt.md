# First Useful Turn Agent Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dohc's agent diagnose vague workspace-building requests before creating artifacts, and teach it to choose markdown, html, `.views`, entities, skills, or commands based on the user's workflow problem.

**Architecture:** This is a focused prompt-contract change. `apps/app/convex/a1SystemPrompt.test.ts` locks the new instructions, and `apps/app/convex/agent.ts` adds a compact first-useful-turn section plus a tracking section refresh.

**Tech Stack:** Convex agent prompt, TypeScript, Vitest, pnpm.

---

## File Structure

- Modify `apps/app/convex/a1SystemPrompt.test.ts`: add prompt-contract tests for diagnosis-first vague requests and medium selection.
- Modify `apps/app/convex/agent.ts`: add the first-useful-turn prompt section and update tracking guidance to defer creation until enough context exists.

---

### Task 1: Add Failing Prompt-Contract Tests

**Files:**
- Modify: `apps/app/convex/a1SystemPrompt.test.ts`
- Test: `apps/app/convex/a1SystemPrompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside `describe('buildSystemPrompt (H-1 / A1)', () => { ... })`, after the existing current-system-model test:

```ts
  it('teaches diagnosis-first first turns for vague workspace requests', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('FIRST USEFUL TURN FOR VAGUE WORKSPACE REQUESTS')
    expect(personal).toContain('the first useful turn is diagnosis')
    expect(personal).toContain('Ask 3-5 compact, domain-specific questions')
    expect(personal).toContain('before creating files')
    expect(personal).toContain('unless the user already gave enough concrete context')
    expect(personal).toContain('source data, workflow loop, and next user decision')
    expect(personal).toContain('do not create a dashboard, html atom, or custom view yet')
  })

  it('teaches the agent to choose the right dohc medium for the problem', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('Choose the dohc medium from the job')
    expect(personal).toContain('Markdown atom (`.md`)')
    expect(personal).toContain('default canonical source')
    expect(personal).toContain('Entities')
    expect(personal).toContain('repeated records')
    expect(personal).toContain('HTML atom (`.html`)')
    expect(personal).toContain('polished read-only')
    expect(personal).toContain('Folder-local `.views/<name>/` app')
    expect(personal).toContain('interactive workflow surface')
    expect(personal).toContain('Skill')
    expect(personal).toContain('reusable process')
    expect(personal).toContain('Command')
    expect(personal).toContain('explicit shortcut')
    expect(personal).toContain('Markdown source comes before interfaces')
    expect(personal).toContain('Do not create a view just because the user asked for "help"')
  })
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
pnpm --filter @dohc/app exec vitest run convex/a1SystemPrompt.test.ts
```

Expected: FAIL because the prompt does not yet contain the new first-useful-turn and medium-selection phrases.

---

### Task 2: Patch the Agent Prompt

**Files:**
- Modify: `apps/app/convex/agent.ts`
- Test: `apps/app/convex/a1SystemPrompt.test.ts`

- [ ] **Step 1: Add the first-useful-turn prompt section**

Insert this section in `SYSTEM_PROMPT` after the current default-loop paragraph and before `## TRACKING / IMPROVEMENT PROJECTS`:

```md
## FIRST USEFUL TURN FOR VAGUE WORKSPACE REQUESTS

When the user makes a vague workspace-building request like "help me
with my training routine", "help me organize clients", "make me a
dashboard", or "set up my workflow", do not rush into file creation.
For these requests, the first useful turn is diagnosis: understand the
job the workspace must do before choosing files or views.

In MAINTENANCE, inspect relevant existing atoms/entities first when
the request names a recognizable area. Then classify the job: routine,
tracker, project cockpit, knowledge base, habit loop, decision system,
CRM-like workflow, review cadence, report, dashboard, or interactive
operating surface.

Ask 3-5 compact, domain-specific questions before creating files,
unless the user already gave enough concrete context. Cover only what
changes the structure you will build: desired outcome, current
baseline, constraints, failure history, and the feedback loop or next
decision the workspace should improve.

Before you create a dashboard, html atom, or custom view, you must be
able to name the source data, workflow loop, and next user decision it
supports. If you cannot, do not create a dashboard, html atom, or
custom view yet. Ask intake questions and propose the source model
instead.

Choose the dohc medium from the job:
- Markdown atom (`.md`) — default canonical source for notes, plans,
  logs, templates, routines, reviews, and source-of-truth prose.
- Entities — repeated records such as people, clients, projects,
  exercises, habits, leads, or anything that needs flexible querying.
- HTML atom (`.html`) — polished read-only report, dashboard,
  briefing, or one-pager over existing source data.
- Folder-local `.views/<name>/` app — interactive workflow surface,
  kanban, form-like cockpit, buttons/actions, filters, or repeat-use
  app behavior.
- Skill — reusable process the user liked and wants to repeat.
- Command — explicit shortcut fired from slash or the palette.

Hard rules: Markdown source comes before interfaces. HTML and `.views`
are views over source state, never the canonical source. Do not create
a view just because the user asked for "help". If no workflow loop
exists yet, start with intake and markdown source structure.
```

- [ ] **Step 2: Refresh the tracking/improvement section**

Update `## TRACKING / IMPROVEMENT PROJECTS` so it refers to the first-useful-turn rules and says vague tracking/training asks should ask intake questions before writing files.

- [ ] **Step 3: Run the targeted test to verify it passes**

Run:

```bash
pnpm --filter @dohc/app exec vitest run convex/a1SystemPrompt.test.ts
```

Expected: PASS.

---

### Task 3: Verify and Commit

**Files:**
- Modify: `apps/app/convex/a1SystemPrompt.test.ts`
- Modify: `apps/app/convex/agent.ts`
- Modify: `docs/superpowers/plans/2026-06-03-first-useful-turn-agent-prompt.md`

- [ ] **Step 1: Run targeted verification**

Run:

```bash
pnpm --filter @dohc/app exec vitest run convex/a1SystemPrompt.test.ts
```

Expected: PASS.

- [ ] **Step 2: Inspect the diff**

Run:

```bash
git diff -- apps/app/convex/a1SystemPrompt.test.ts apps/app/convex/agent.ts docs/superpowers/plans/2026-06-03-first-useful-turn-agent-prompt.md
```

Expected: Diff only includes the plan, prompt-contract tests, and prompt text changes.

- [ ] **Step 3: Stage only implementation files**

Run:

```bash
git add apps/app/convex/a1SystemPrompt.test.ts apps/app/convex/agent.ts docs/superpowers/plans/2026-06-03-first-useful-turn-agent-prompt.md
```

Expected: Existing unrelated app UI changes remain unstaged.

- [ ] **Step 4: Commit**

Run:

```bash
git commit -m "feat(agent): improve first useful workspace turns"
```

Expected: Commit succeeds with only the prompt/test/plan files.

---

## Self-Review

- Spec coverage: covers diagnosis-first behavior, medium selection, tracking example, tests, and no new primitives.
- Placeholder scan: no placeholders.
- Type consistency: no new runtime types or function signatures.
