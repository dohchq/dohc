# dohc Apps, SDK, SQLite, And Agent Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current read-mostly `.views` layer with first-class `.apps`: interactive dohc workspace apps that can read, write, mutate markdown/documents, operate over SQLite-backed databases, and be tested/iterated by agents before users see weak output.

**Architecture:** `.apps/<name>/` packages are sandboxed web apps stored in the workspace. Apps import a polished virtual SDK, `@dohc/app`, that exposes document, collection, database, asset, agent, and test APIs. App code never talks to Convex/raw storage directly; it sends capability-scoped requests to the host, which enforces workspace auth, app manifest scopes, locks, sharing boundaries, review gates, and provenance. App collaboration happens through canonical shared workspace sources, not local browser state: when one permitted collaborator mutates a document, collection, or database, other permitted collaborators receive live updates through the host. SQLite becomes both a first-class user-facing data-file type rendered through dohc Studio and a derived indexing engine for fast collection queries.

**Tech Stack:** React/TanStack app shell, Convex, WorkOS auth, Hocuspocus/Y.Doc semantic writes, Convex storage for binary database blobs, SQLite service or WASM engine, sandboxed iframes, postMessage RPC, Vitest/convex-test, Playwright-backed app testing service.

---

## GPT-5.5 One-Shot Handoff Pack

**Purpose:** Increase the odds that a strong coding agent can execute this plan in one long, disciplined run without drifting, hand-waving tests, or producing a partial implementation that only looks complete.

### Research basis

This handoff follows current OpenAI guidance for GPT-5.5 and agentic coding workflows:

- GPT-5.5 works best with outcome-first prompts: describe the desired end state, constraints, evidence, and final output rather than over-prescribing every tiny reasoning step.
- For complex coding workflows, be explicit about reuse, delegation, tests, acceptance criteria, and when the agent should continue versus ask for help.
- For tool-heavy or long-running workflows, visible preambles and phase-aware progress updates help keep intermediate work distinct from final answers.
- Prompt and agent behavior should be evaluated with representative, edge, and adversarial tests, including tool-selection and tool-argument correctness.

Primary references:

- OpenAI GPT-5.5 prompt guidance: `https://developers.openai.com/api/docs/guides/prompt-guidance?model=gpt-5.5`
- OpenAI latest model guide: `https://developers.openai.com/api/docs/guides/latest-model`
- OpenAI prompt engineering guide: `https://developers.openai.com/api/docs/guides/prompt-engineering`
- OpenAI evaluation best practices: `https://developers.openai.com/api/docs/guides/evaluation-best-practices`
- OpenAI trace grading guide: `https://developers.openai.com/api/docs/guides/trace-grading`

### Runtime notes

The user decides model and runtime configuration. This plan should not prescribe model settings.

Do not ask the model to reveal chain-of-thought. Ask it to show concise progress updates, test evidence, and decisions.

If the runtime supports Responses API `phase`, preserve phase metadata for intermediate assistant updates. If a run compacts or resumes, keep this handoff pack and the plan path in the resumed prompt so behavior does not drift.

### Copy-paste prompt for the implementing agent

Use this prompt as the user/developer handoff to GPT-5.5:

```text
You are implementing dohc's first-class Apps platform. This is a high-risk, high-leverage systems change. Work from the repository root on branch codex/onboarding-improvements-fixes.

Outcome:
Implement the plan in docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.md so dohc has collaborative, secure, testable .apps powered by @dohc/app, readable source-backed collections, first-class SQLite database files, and an agent-testable app runtime. Generated apps must be useful and persistent, not fake UI.

Read first:
1. AGENTS.md
2. apps/app/AGENTS.md
3. apps/app/convex/_generated/ai/guidelines.md before editing Convex code
4. docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.md

Non-negotiables:
- Do not weaken authorization, ownership, sharing boundaries, locks, review gates, or app trust.
- Browser/app callers are never trusted to provide user identity, workspace identity, or permissions.
- App manifests define maximum read/write scopes only; they are never permissions by themselves.
- App trust is per user and per manifest write key.
- App state that matters must persist through dohc docs, collections, or databases.
- Do not CRDT-sync raw SQLite bytes.
- Do not preserve .views/@dohc/view as product language except migration compatibility.
- Do not finish a phase without failing-first tests, targeted test passes, and relevant cross-cutting security/collaboration regression passes.
- If a test named in the plan does not exist, create it. Do not skip it.

Execution mode:
- Start with a short preamble naming the first concrete step.
- Work phase by phase in plan order.
- Before coding each phase, inspect the existing implementation and write the smallest phase execution map.
- Implement in narrow vertical slices that compile and test independently.
- After each phase, update docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.execution-log.md with:
  - files changed
  - tests added
  - commands run
  - failures fixed
  - remaining risk
- Keep going without asking for user input unless blocked by missing external secrets/services, contradictory product requirements, or a security decision the plan explicitly leaves open.

Completion contract:
- Do not stop working because the plan is long, context is large, or a phase is partially complete.
- Do not treat "good enough", "mostly passing", "core pieces implemented", or "remaining work is follow-up" as a successful terminal state.
- Keep implementing, testing, debugging, and updating the execution log until every phase is complete and Phase 12 full verification passes.
- If the runtime interrupts, compacts, or resumes the task, read the execution log and continue from the first incomplete phase.
- If a test fails, fix the failure or prove it is caused by an external blocker; do not remove, weaken, or skip the test to move forward.
- If a named test or helper does not exist, create the missing test or helper rather than treating the plan as aspirational.

Testing:
- Add/update failing tests before production code.
- Run the nearest tests after each change.
- Run the phase verification command before leaving a phase.
- Run cross-cutting security/collaboration tests after touching auth, manifests, runtime RPC, source writes, SQLite, or onboarding.
- Run full Phase 12 verification before final answer.

Quality bar:
- Generated finance tracker fixture must add expenses, categorize transactions, mark reviewed, persist, reload, and pass test_app.
- App tester must catch blank renders, fake primary buttons, placeholder metrics over real data, and missing persistence.
- Collaboration tests must prove permitted users see shared updates and unauthorized users do not see private data.
- SQLite tests must prove transactional row operations, operation logs, version conflicts, and no raw-byte CRDT sync.

Stop conditions:
- Stop only if the same blocker remains after three concrete attempts, continuing would require violating a non-negotiable, or an external service/secret/user decision is genuinely required.
- Time, context pressure, test volume, large diff size, or implementation difficulty are not stop conditions.
- When blocked, report the exact blocker, attempts made, files inspected, and the smallest decision/input needed.

Final response:
- Do not send a final "done" response until all phases are complete, the execution log is complete, the self-grade rubric is all `2`, and Phase 12 full verification passes.
- If blocked, do not frame the work as complete. Say `blocked`, list incomplete phases, list attempts made, and name the smallest required decision/input.
- Include changed file summary, tests run, failing tests if any, manual/browser smoke results, self-grade table, and remaining risks.
```

### One-shot execution shape

The implementing agent should treat this as one long run with twelve phase gates, not twelve unrelated projects.

Run shape:

```text
1. Context read
2. Repo inventory
3. Phase 1 implementation + tests + log
4. Phase 2 implementation + tests + log
5. Phase 3 implementation + tests + log
6. Phase 3A implementation + tests + log
7. Continue through Phase 12
8. Full verification
9. Self-grade
10. Final answer
```

### Resume protocol

If the implementation run is interrupted or resumed:

1. Read `docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.execution-log.md`.
2. Read this plan's acceptance criteria and the first incomplete phase.
3. Inspect the working tree with `git status --short`.
4. Run the nearest test for the first incomplete or recently changed area.
5. Continue implementation from that point.

Never restart from scratch unless the user explicitly asks. Never declare completion from memory; completion requires fresh verification evidence.

If the run uses subagents, use them for independent audits and test generation, not for unsynchronized edits to the same files. Good subagent tasks:

- security/authz audit of app manifest and RPC paths.
- SQLite operation-log and conflict-model review.
- app tester/browser quality review.
- onboarding regression review.
- generated finance tracker acceptance review.

### Anti-drift rules

The implementing agent must not:

- rename concepts differently from this plan.
- turn pseudo-test helper names into TODOs instead of implementing test harness helpers.
- pass tests by weakening assertions.
- delete existing user work or unrelated changes.
- replace source-backed apps with static HTML reports.
- accept placeholder UI because the app "technically renders."
- treat app-local React state as persisted business state.
- skip browser/runtime tests because unit tests passed.
- call a phase complete with only TypeScript passing.
- bury failed verification in a long final response.

### Self-grade rubric before final

Before final response, grade the implementation with this rubric:

| Area | 0 | 1 | 2 |
|---|---|---|---|
| Architecture | missing or conflicting primitives | partial `.apps`/SDK implementation | coherent `.apps`, `app.json`, `@dohc/app` system |
| Persistence | fake/local state remains | some app actions persist | primary actions persist through docs/collections/databases |
| Security | trust/auth bypass possible | partial checks | server-derived auth, scopes, trust, locks, review gates enforced |
| Collaboration | single-user only | partial live updates | permitted collaborators see updates; unauthorized users denied |
| SQLite | opaque or unsafe | read-only or partial writes | Studio, row ops, op log, version/conflict tests |
| Agent testing | absent | static only | static, SDK simulation, browser, screenshot, persistence checks |
| Onboarding | known regressions remain | partial fixes | no flashes, real run starts, attachments supported, generated app tested |
| Verification | weak/manual only | targeted tests pass | phase + cross-cutting + full verification passes |

Final is allowed only when every row is `2`, or when incomplete rows are explicitly listed as remaining work with concrete blockers.

## Executive Decisions

1. **Rename the primitive from views to apps.**
   - New folder convention: `.apps/<app-name>/`.
   - New manifest: `app.json`.
   - New SDK import: `@dohc/app`.
   - Old `.views`, `view.json`, and `@dohc/view` are not the product language anymore. Keep a short migration bridge only long enough to convert existing packages.

2. **Make the SDK app-first, not markdown-surgery-first.**
   - Main API: `dohc.collection(...)`, `useCollection(...)`, `dohc.doc(...)`, `useDoc(...)`, `dohc.database(...)`.
   - Low-level operations like `insertAfterHeading` must not be the main developer-facing shape.
   - App authors should write code that feels closer to Drizzle, Lodash, or a good document DB SDK than a markdown parser.

3. **Keep sources readable when the source is text.**
   - Markdown tables, markdown cards, YAML, CSV, and JSONL stay clean and inspectable.
   - Visible IDs are allowed and preferred over hidden comments.
   - No hidden magic comments for row identity.

4. **Support SQLite as a first-class database file.**
   - SQLite is not forced into `atoms.body`.
   - SQLite files are binary workspace files with a dohc Studio viewer/editor.
   - Collaboration happens through row/table operations and an operation log, not raw SQLite byte CRDT.

5. **Use SQLite as an internal derived index too.**
   - dohc can parse markdown/CSV/YAML/etc into fast derived indexes.
   - Source files remain canonical for text-backed collections.
   - Derived SQLite indexes are rebuildable.

6. **Make apps testable by agents.**
   - Agents need a `test_app` tool.
   - The tool should compile the app, mount it in a controlled browser, inject a fake or real SDK, click through app flows, inspect screenshots/DOM, and report failures.
   - Onboarding cannot finish with untested or obviously fake apps.

7. **Make collaboration source-level and secure by default.**
   - Apps are collaborative because they read and write shared workspace documents, collections, and databases.
   - Apps are not collaborative because app code gets broad access to a user session or workspace. It does not.
   - Every app read/write is server-scoped to the active workspace, the signed-in user, folder/file permissions, share boundaries, app manifest scopes, locks, review gates, and per-user app trust.
   - Personal workspaces remain private unless the user explicitly shares workspace content. Sharing an app does not grant access to sources outside that app's manifest and the viewer's own permissions.

8. **Treat tests as implementation gates, not cleanup.**
   - Every phase starts by writing failing tests for the contract being introduced.
   - Every mutation path gets positive tests, denied-access tests, malformed-input tests, idempotency tests, and concurrency/conflict tests.
   - Every app runtime feature gets unit tests, host/RPC tests, browser-style tests, and regression tests for the onboarding failures that motivated this work.
   - A phase is not done until its nearest tests pass, full typecheck passes, and the cross-cutting security/collaboration regression suite passes.

---

## Testing Doctrine

This plan is large enough that testing must be part of the architecture. Every implementer must follow this doctrine for every task.

### Definition of done for every implementation step

Before marking any checkbox complete:

1. Add or update a failing test that proves the behavior or bug.
2. Run that test and confirm it fails for the expected reason.
3. Implement the smallest production change that makes it pass.
4. Run the nearest targeted test file and confirm it passes.
5. Run the phase-level verification command if the step touches a public contract, auth boundary, persistence path, collaboration behavior, app runtime, SQLite, Hocuspocus, or onboarding.
6. Add a regression test for any bug discovered during implementation.
7. Record any intentionally deferred test with a reason in the plan before moving on. Do not silently skip tests.

### Required test layers

Use all layers that apply to a change:

| Layer | Purpose | Examples |
|---|---|---|
| Unit | Pure functions and small adapters | path parsing, manifest normalization, markdown table parsing, SQL operation validation |
| Contract | Public SDK/RPC shape | `@dohc/app` payload validation, stable error codes, backwards-compatible aliases |
| Convex integration | Auth, workspace scoping, persistence | app trust, source permissions, collection mutations, database operation logs |
| Hocuspocus integration | Canonical text writes | row replacement, section append, conflict behavior, lock/review gates |
| Browser/runtime | Sandboxed app behavior | postMessage bridge, disabled direct storage/session access, visible UI updates |
| Collaboration | Multi-user behavior | per-user trust, live updates, denied reads for partial access, conflict retries |
| Security | Abuse and privacy boundaries | path traversal, unknown RPC, prototype payloads, cross-workspace reads, cookie/session access |
| Migration | Old data still opens safely | `.views` to `.apps`, `view.json` to `app.json`, old imports warning |
| Regression | Known failure modes never return | CSV dumped into chat, agent not starting, blank md flashes, fake finance tracker zeros |
| End-to-end | User-real workflows | onboarding CSV -> generated app -> `test_app` -> add/categorize/reload |
| Performance | Large/realistic data stays usable | 1k, 10k, 100k rows where relevant; markdown vs SQLite thresholds |
| Failure injection | Partial outages are understandable | SQLite worker down, Hocuspocus offline, stale DB version, malformed app manifest |

### Required negative tests

Every read/write capability must prove denial cases:

- wrong workspace.
- signed-out user.
- user without folder/file access.
- path outside manifest scope.
- path traversal like `../`.
- manifest allows path but user permissions do not.
- user permissions allow path but manifest does not.
- trust granted for old manifest key.
- trust granted by another user.
- locked source.
- review-gated source.
- stale source revision or database version.
- duplicate collection ID.
- malformed payload.
- unknown RPC method.
- oversized payload.

### Required app quality tests

Every generated or fixture app must pass:

- compile/typecheck.
- static app validator.
- SDK simulation test.
- browser render test with screenshot.
- no blank canvas/page.
- no fake placeholder metrics when source data exists.
- every visible primary button either persists through `dohc.collection`, `dohc.doc`, `dohc.database`, opens a source, or intentionally calls `dohc.agent.run`.
- reload persistence test.
- manifest `tests` pass through `test_app`.

### Required security tests for sandboxed apps

The browser/runtime test suite must prove:

- app iframe cannot read `document.cookie`.
- app iframe cannot access parent DOM.
- app iframe cannot access WorkOS/session tokens.
- app iframe cannot call Convex directly.
- app iframe cannot use localStorage/sessionStorage as a host bridge.
- app iframe cannot make arbitrary network calls unless a future manifest capability explicitly allows it.
- unknown `postMessage` RPC methods are rejected.
- RPC responses never include sources outside allowed permissions.

### Required collaboration tests

Every collaborative source type must prove:

- two permitted users see the same source-backed app data.
- a write by one permitted user updates the other user's subscribed app state.
- a user with app access but without source access sees a clear denied/partial state.
- one user's app trust grant does not authorize another user.
- simultaneous writes either merge cleanly or return a clear conflict error.
- presence never leaks email/private identity beyond workspace member visibility rules.

### Required SQLite tests

SQLite work must prove:

- a valid SQLite file opens in Studio.
- invalid SQLite files fail safely with a readable diagnostic.
- schema introspection is correct.
- row insert/update/delete operations are transactional.
- failed operations leave the previous database version intact.
- `databaseOps` records actor, table, row, payload, and version.
- concurrent writes are serialized or rejected with `database-version-conflict`.
- raw SQLite bytes are never CRDT-synced.
- generated SQLite-backed apps can query and mutate rows through `dohc.database`/`dohc.collection`.

### Required onboarding regression tests

Before any onboarding change ships, prove:

- clicking Continue from the final onboarding step goes directly to the active agent chat without flashing intermediate setup/new-chat screens.
- the onboarding-created chat actually starts an agent run.
- supported file attachments are converted to model-supported inputs or source references.
- CSV/text files are summarized as attachments, not dumped into visible chat output.
- model selector and permissions selector remain usable for the next message while an onboarding run is active.
- generated app-like setups call `test_app` and cannot finish with a fake/read-only/placeholder app.

### Phase gate

Each phase must end with a short verification note in the PR/body:

```text
Phase N verification:
- New tests added:
- Targeted tests run:
- Cross-cutting tests run:
- Manual/browser smoke:
- Known remaining risk:
```

`Known remaining risk` cannot be empty by default. If there is truly no known remaining risk, write `none found after the above verification`.

## Target Developer Experience

### App package

```text
finance/
  .apps/
    tracker/
      app.json
      src/App.tsx
      src/styles.css
  transactions/
    2026-06.md
  categories.md
  rules.md
  ledger.sqlite
```

### App manifest

```json
{
  "title": "Finance Tracker",
  "entry": "src/App.tsx",
  "read": ["."],
  "write": ["transactions/**", "categories.md", "rules.md", "ledger.sqlite"],
  "collections": {
    "transactions": {
      "source": "transactions/*.md",
      "format": "markdown-table",
      "key": "ID"
    },
    "ledger": {
      "source": "ledger.sqlite",
      "format": "sqlite",
      "table": "transactions",
      "key": "id"
    }
  },
  "tests": [
    {
      "name": "add expense",
      "steps": [
        { "click": "text=Add expense" },
        { "fill": "input[name=merchant]", "value": "Grab" },
        { "fill": "input[name=amount]", "value": "420" },
        { "click": "text=Save" }
      ],
      "expect": [
        { "collection": "transactions", "where": { "merchant": "Grab", "amount": 420 } }
      ]
    }
  ]
}
```

### App code

```tsx
import { useCollection, dohc } from '@dohc/app'

export default function App() {
  const transactions = useCollection('transactions', {
    orderBy: [{ field: 'Date', direction: 'desc' }],
    limit: 100,
  })

  async function addExpense(input: {
    merchant: string
    amount: number
    category: string
  }) {
    await dohc.collection('transactions').insert({
      Date: new Date().toISOString().slice(0, 10),
      Merchant: input.merchant,
      Amount: input.amount,
      Category: input.category,
      Reviewed: 'No',
    })
  }

  async function markReviewed(id: string) {
    await dohc.collection('transactions').update(id, { Reviewed: 'Yes' })
  }

  return null
}
```

### Human-readable markdown table source

```md
# June 2026 Transactions

| ID | Date | Account | Merchant | Category | Amount | Reviewed | Notes |
|---|---|---|---|---|---:|---|---|
| txn_2026_06_06_grab_001 | 2026-06-06 | BPI Platinum | Grab | Transport | 420.00 | No | commute |
```

### Human-readable document editing source

```ts
const plan = dohc.doc('finance/plan.md')

await plan.set('status', 'active')
await plan.section('Review Notes').append('- Groceries are trending high this week.')
await plan.replaceText({
  find: 'Review cadence: monthly',
  with: 'Review cadence: weekly',
})
```

---

## Non-Goals For The First Full Apps Milestone

- Do not CRDT-sync raw SQLite bytes.
- Do not make `actions.run` the main app mutation model.
- Do not hide record IDs in HTML comments.
- Do not let app code import Convex directly.
- Do not let app code write outside `app.json.write`.
- Do not preserve `.views` as a long-term synonym in prompts/docs. Use it only as a migration path.
- Do not build one hardcoded finance tracker into dohc. Build primitives so the agent can create many finance trackers well.

---

## Phase 1: Rename Views To Apps

**Purpose:** Align the primitive name with the product promise.

**Files:**
- Modify: `apps/app/package.json`
- Modify: `apps/app/convex/viewPaths.ts`
- Modify: `apps/app/convex/viewPaths.test.ts`
- Rename/create: `apps/app/convex/appPaths.ts`
- Rename/create: `apps/app/convex/apps.ts`
- Rename/create: `apps/app/convex/appData.ts`
- Rename/create: `apps/app/src/apps/*`
- Modify: `apps/app/src/components/ViewFrame.tsx`
- Modify: `apps/app/src/components/ViewsSidebar.tsx`
- Modify: `apps/app/src/components/CommandPalette.tsx`
- Modify: `apps/app/src/routes/_app.w.$wsId.views.tsx`
- Modify: `apps/app/src/routes/_app.w.$wsId.v.$viewRef.tsx`
- Modify: `apps/app/convex/agent.ts`
- Modify: `apps/app/convex/onboarding.ts`
- Modify: `docs/product/spec.md`
- Modify: `docs/security/authz-boundaries.md`

### Steps

- [ ] Rename the private web package from `@dohc/app` to `@dohc/web` so the virtual app SDK can own `@dohc/app`.

Run:

```bash
cd "$(git rev-parse --show-toplevel)"
rg -n '@dohc/app|--filter @dohc/app|filter @dohc/app' .
```

Expected: all build/test scripts and docs that depend on the package name are visible.

- [ ] Replace internal package references and scripts with `@dohc/web`.

Expected: `pnpm --filter @dohc/web test ...` works wherever old commands used `@dohc/app`.

- [ ] Introduce `.apps` path parsing while keeping `.views` parser only for migration tests.

New cases:

```ts
expect(parseAppPath('finance/.apps/tracker/src/App.tsx')).toMatchObject({
  scopePath: 'finance',
  packageRoot: 'finance/.apps/tracker',
  appName: 'tracker',
})
expect(parseAppPath('finance/.views/tracker/src/App.tsx')).toBeNull()
```

- [ ] Rename UI labels from “Views” to “Apps”.

Examples:

```text
Apps
Open app
Open app source
App not found
```

- [ ] Rename backend API surface in code from `views`/`viewData` to `apps`/`appData`.

Keep compatibility wrappers only if needed by generated route code during transition. The product-facing route should become `/w/:wsId/apps` and `/w/:wsId/a/:appRef`.

- [ ] Add a one-time migration helper that converts:

```text
.views/<name>/view.json -> .apps/<name>/app.json
folder/.views/<name>/view.json -> folder/.apps/<name>/app.json
```

The migration should refuse if the target `.apps` path already exists.

- [ ] Update prompt/onboarding language so new generated work uses `.apps`, `app.json`, and `@dohc/app`.

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/typescript/bin/tsc --noEmit
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/viewPaths.test.ts \
  convex/views.test.ts \
  src/__tests__/viewsShell.test.ts \
  src/__tests__/commandPalette.test.ts \
  convex/a1SystemPrompt.test.ts \
  convex/onboarding.test.ts
```

Expected: updated tests pass under the new app naming.

---

## Phase 2: Define The `@dohc/app` SDK Contract

**Purpose:** Make app code delightful and powerful.

**Files:**
- Create: `apps/app/src/apps/sdkProtocol.ts`
- Create: `apps/app/src/apps/virtualDohcAppSdk.ts`
- Create: `apps/app/src/apps/appShell.ts`
- Create: `apps/app/src/apps/appSdkTypes.ts`
- Test: `apps/app/src/apps/sdkProtocol.test.ts`
- Test: `apps/app/src/apps/virtualDohcAppSdk.test.ts`
- Test: `apps/app/src/apps/appShell.test.ts`

### SDK namespaces

```ts
import {
  dohc,
  useCollection,
  useDoc,
  useDatabase,
  useAgentRun,
} from '@dohc/app'
```

Expose:

```ts
dohc.collection(name)
dohc.doc(path)
dohc.database(path)
dohc.asset(assetId)
dohc.agent.run(args)
dohc.patch.propose(args)
dohc.source.open(args)
```

Hooks:

```ts
useCollection(name, query?)
useDoc(path)
useDatabase(path)
useAgentRun()
```

### Collection API

```ts
type Collection = {
  list(query?: CollectionQuery): Promise<CollectionRow[]>
  get(id: string): Promise<CollectionRow | null>
  insert(record: Record<string, unknown>): Promise<{ ok: true; id: string }>
  update(id: string, patch: Record<string, unknown>): Promise<{ ok: true }>
  upsert(id: string, record: Record<string, unknown>): Promise<{ ok: true; id: string }>
  delete(id: string): Promise<{ ok: true }>
}
```

`delete` is allowed only for explicit app write scopes and should be confirm-tiered by the host unless the manifest marks the collection as low-risk.

### Document API

```ts
type DohcDoc = {
  get(): Promise<{ path: string; body: string; frontmatter: Record<string, string> }>
  set(key: string, value: string | number | boolean): Promise<{ ok: true }>
  append(markdown: string): Promise<{ ok: true }>
  replaceText(args: { find: string; with: string; occurrence?: number }): Promise<{ ok: true }>
  section(heading: string): {
    append(markdown: string): Promise<{ ok: true }>
    replace(markdown: string): Promise<{ ok: true }>
  }
}
```

`section(...).append(...)` may internally use Hocuspocus `insertAfterHeading`, but that is not the public primitive.

### Database API

```ts
type DohcDatabase = {
  tables(): Promise<Array<{ name: string; columns: DatabaseColumn[] }>>
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  table(name: string): Collection
}
```

SQL execution must be scoped and safe. Arbitrary destructive SQL should not run from app code without a declared capability.

### Steps

- [ ] Write protocol tests for all new RPC operations.

Required operations:

```text
dohc.collection.list
dohc.collection.get
dohc.collection.insert
dohc.collection.update
dohc.collection.upsert
dohc.collection.delete
dohc.doc.get
dohc.doc.set
dohc.doc.append
dohc.doc.replaceText
dohc.doc.section.append
dohc.doc.section.replace
dohc.database.tables
dohc.database.query
dohc.source.open
dohc.agent.run
dohc.patch.propose
```

- [ ] Validate RPC payloads before they reach Convex.

Validation rules:

- all args are plain objects.
- no prototype-shaped payloads.
- paths are relative and non-empty.
- collection names match `^[A-Za-z][A-Za-z0-9_.-]{0,127}$`.
- SQL text is a string but execution safety is enforced server-side.
- scalar values are JSON-compatible, with max payload limits.

- [ ] Implement the virtual SDK with stable friendly errors.

Bad SDK calls should throw readable errors:

```text
dohc.collection("transactions").insert failed: app is not allowed to write collection "transactions".
```

- [ ] Keep `@dohc/view` as a temporary virtual alias that logs/returns a migration warning in dev builds.

The agent prompt must not generate new `@dohc/view` imports.

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  src/apps/sdkProtocol.test.ts \
  src/apps/virtualDohcAppSdk.test.ts \
  src/apps/appShell.test.ts
```

---

## Phase 3: App Manifest, Scopes, And Trust

**Purpose:** Let apps be powerful without becoming silent arbitrary scripts.

**Files:**
- Create/modify: `apps/app/convex/apps.ts`
- Create: `apps/app/convex/appManifest.ts`
- Create: `apps/app/convex/appTrust.ts`
- Modify: `apps/app/convex/schema.ts`
- Test: `apps/app/convex/apps.test.ts`
- Test: `apps/app/convex/appTrust.test.ts`

### Manifest schema

```ts
type AppManifest = {
  title: string
  entry: string
  read: string[]
  write: string[]
  collections?: Record<string, CollectionConfig>
  databases?: Record<string, DatabaseConfig>
  network?: false
  agent?: string[]
  tests?: AppTestSpec[]
}
```

### Trust model

First write from an app requires user trust for the current manifest write key.

Trust key:

```ts
JSON.stringify({
  packageRoot,
  write: sortedWriteScopes,
  collections: normalizedCollectionWriteTargets,
  databases: normalizedDatabaseWriteTargets,
})
```

Changing `app.json.write`, collection sources, or database write targets invalidates trust.

### Steps

- [ ] Add `appTrust` table.

```ts
appTrust: defineTable({
  workspaceId: v.string(),
  userId: v.string(),
  packageRoot: v.string(),
  trustKey: v.string(),
  grantedAt: v.number(),
}).index('by_user_app', ['workspaceId', 'userId', 'packageRoot'])
```

- [ ] Parse `app.json` with strict validation.

Invalid manifests should render an app diagnostic, not execute.

- [ ] Resolve collection and database configs relative to app scope.

Rules:

- `read` and `write` paths are scope-relative.
- collection source paths must be inside `read`.
- collection mutation targets must be inside `write`.
- SQLite database sources must be inside `read`; mutating tables requires the DB path inside `write`.

- [ ] Add host trust prompt.

Prompt copy:

```text
Finance Tracker wants to write to:
- finance/transactions/**
- finance/categories.md
- finance/ledger.sqlite

This app can only write inside these scopes. Changing app.json resets this permission.
```

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/apps.test.ts \
  convex/appTrust.test.ts
```

---

## Phase 3A: Collaborative Apps, Privacy, And Security

**Purpose:** Ensure apps can be used by multiple people without weakening dohc's private-by-default workspace model.

**Files:**
- Create: `apps/app/convex/appCollaboration.ts`
- Create: `apps/app/convex/appSecurity.ts`
- Modify: `apps/app/convex/appManifest.ts`
- Modify: `apps/app/convex/appTrust.ts`
- Modify: `apps/app/convex/appData.ts`
- Modify: `apps/app/src/apps/appSdkTypes.ts`
- Modify: `apps/app/src/apps/AppRuntimeHost.tsx`
- Test: `apps/app/convex/appCollaboration.test.ts`
- Test: `apps/app/convex/appSecurity.test.ts`
- Test: `apps/app/src/apps/AppRuntimeHost.collaboration.test.tsx`

### Collaboration model

Apps collaborate through shared sources:

```text
Collaborator A opens finance/.apps/tracker
  -> SDK subscribes to transactions collection
Collaborator B opens the same app
  -> SDK subscribes to the same permitted collection
Collaborator A adds an expense
  -> server validates auth, app trust, share/folder/file permissions, locks, review gates
  -> canonical source changes
  -> source change invalidates app query
  -> both collaborators see the new row
```

App-local React state is allowed for UI state only: selected tab, temporary form draft, expanded rows, and filters. Business state must live in canonical dohc sources.

### Privacy model

Apps must not broaden access.

Rules:

- The browser never supplies trusted `userId`, `workspaceId`, or permission claims.
- The host derives the actor and active workspace server-side.
- `app.json.read` is a maximum possible read set, not a grant by itself.
- `app.json.write` is a maximum possible write set, not a grant by itself.
- A user can read/write only if their normal workspace/folder/file permissions allow it.
- App trust is per user and per manifest trust key.
- Trust granted by one collaborator does not grant trust for another collaborator.
- Private personal workspaces stay private unless the user explicitly shares workspace content.
- Sharing an app package does not expose sources outside the package's manifest and the viewer's normal permissions.

### Security model

Sandbox rules:

```text
iframe sandbox:
  allow-scripts
  no allow-same-origin by default
  no direct Convex client
  no WorkOS/session token access
  no document.cookie access
  no localStorage/sessionStorage bridge
  no arbitrary network unless manifest network capability is explicitly added later
```

RPC rules:

- The app can call only registered `@dohc/app` RPC methods.
- Every payload is schema-validated.
- Every path is normalized and checked against traversal.
- Every read/write is checked against manifest scope and actual user permissions.
- Every mutation includes `clientMutationId` for idempotency.
- Every write records actor, app package root, operation, target, timestamp, and source revision/database version.
- Destructive operations require either soft-delete or host confirmation.
- SQL writes are limited to validated row/table operations unless an explicit advanced capability is added.

### Presence

Add optional presence to the SDK:

```ts
type AppPresenceUser = {
  id: string
  name: string
  color: string
}

function usePresence(): {
  users: AppPresenceUser[]
}
```

Presence is display-only. Presence does not affect authorization.

### Conflict behavior

Text-backed collection writes:

- optimistic UI may update immediately.
- server applies canonical Hocuspocus/Y.Doc mutation.
- if the source changed in a conflicting way, the mutation returns `source-conflict`.
- app receives a refreshed collection snapshot and can retry or show a clear error.

SQLite-backed writes:

- operations are serialized per database file.
- every operation includes expected database version unless it is append-only.
- failed version checks return `database-version-conflict`.
- successful operations append to `databaseOps`.

### Steps

- [ ] Add tests proving app manifest scope is not enough to read a source.

Test case:

```ts
it('denies app read when manifest allows the path but user cannot read the folder', async () => {
  const result = await readViaApp({
    actor: 'viewer-without-finance-access',
    packageRoot: 'finance/.apps/tracker',
    manifestRead: ['finance/**'],
    path: 'finance/transactions/2026-06.md',
  })

  expect(result).toMatchObject({
    ok: false,
    code: 'source-read-not-authorized',
  })
})
```

- [ ] Add tests proving app trust is per user.

Test case:

```ts
it('does not reuse another collaborator app trust grant', async () => {
  await grantAppTrust({
    actor: 'alice',
    packageRoot: 'finance/.apps/tracker',
    write: ['finance/transactions/**'],
  })

  const result = await writeViaApp({
    actor: 'bob',
    packageRoot: 'finance/.apps/tracker',
    collection: 'transactions',
    op: 'insert',
    record: { Merchant: 'Grab', Amount: 420 },
  })

  expect(result).toMatchObject({
    ok: false,
    code: 'app-trust-required',
  })
})
```

- [ ] Add tests proving two permitted collaborators see the same collection after a write.

Test case:

```ts
it('broadcasts collection changes to permitted collaborators', async () => {
  const alice = subscribeViaApp({
    actor: 'alice',
    packageRoot: 'finance/.apps/tracker',
    collection: 'transactions',
  })
  const bob = subscribeViaApp({
    actor: 'bob',
    packageRoot: 'finance/.apps/tracker',
    collection: 'transactions',
  })

  await writeViaApp({
    actor: 'alice',
    packageRoot: 'finance/.apps/tracker',
    collection: 'transactions',
    op: 'insert',
    record: { Merchant: 'Grab', Amount: 420, Reviewed: 'No' },
  })

  await expect(alice.latest()).resolves.toContainEqual(expect.objectContaining({ Merchant: 'Grab' }))
  await expect(bob.latest()).resolves.toContainEqual(expect.objectContaining({ Merchant: 'Grab' }))
})
```

- [ ] Add `usePresence()` to the virtual SDK and host bridge.

Presence payload must omit emails unless the workspace settings already expose emails in the member list.

- [ ] Add app runtime security tests.

Required assertions:

```text
app cannot access document.cookie
app cannot import Convex client directly
app cannot call unknown RPC method
app cannot read outside manifest read
app cannot write outside manifest write
app cannot write a source the actor cannot normally edit
app cannot reuse another user trust grant
```

- [ ] Add provenance records for app writes.

Every app write should be inspectable as:

```ts
{
  actorUserId: string
  workspaceId: string
  packageRoot: string
  operation: 'collection.insert' | 'collection.update' | 'doc.set' | 'database.row.update'
  targetPath: string
  targetId?: string
  sourceRevision?: string
  databaseVersion?: number
  clientMutationId: string
  createdAt: number
}
```

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/appCollaboration.test.ts \
  convex/appSecurity.test.ts \
  src/apps/AppRuntimeHost.collaboration.test.tsx
```

---

## Phase 4: Collection Source Adapters

**Purpose:** Let apps use database-like APIs while source files stay clean.

**Files:**
- Create: `apps/app/convex/collectionAdapters.ts`
- Create: `apps/app/convex/collectionData.ts`
- Create: `apps/app/convex/collectionMarkdownTable.ts`
- Create: `apps/app/convex/collectionMarkdownCards.ts`
- Create: `apps/app/convex/collectionCsv.ts`
- Create: `apps/app/convex/collectionJsonl.ts`
- Create: `apps/app/convex/collectionYaml.ts`
- Test: matching `*.test.ts` files.

### Supported adapters

1. `markdown-table`
   - Best for flat readable data: tasks, transactions, CRM rows.
   - Requires visible key column.

2. `markdown-cards`
   - Best for richer records with prose.
   - Example heading: `## txn_123 — Grab`.

3. `csv`
   - Best for large imports/exports and flat data.
   - Editing should preserve headers and quote correctly.

4. `jsonl`
   - Best for event logs and machine-heavy append-only records.
   - Human-readable enough but not the default for personal work.

5. `yaml`
   - Best for rules/config/settings.

6. `sqlite`
   - Best for serious app data, large tables, relations, and fast queries.

### Markdown table rules

Readable source:

```md
# June 2026 Transactions

| ID | Date | Account | Merchant | Category | Amount | Reviewed | Notes |
|---|---|---|---|---|---:|---|---|
| txn_2026_06_06_grab_001 | 2026-06-06 | BPI Platinum | Grab | Transport | 420.00 | No | commute |
```

Rules:

- IDs are visible.
- Column order is preserved.
- Unknown extra columns are preserved.
- Updates rewrite only the target row when possible.
- Inserts append to the configured table or month file.
- No hidden row comments.

### Steps

- [ ] Implement parser/formatter interfaces.

```ts
type CollectionAdapter = {
  list(config, sources): CollectionRow[]
  insert(config, sources, record): CollectionMutationPlan
  update(config, sources, id, patch): CollectionMutationPlan
  delete(config, sources, id): CollectionMutationPlan
}
```

- [ ] Implement `markdown-table` first.

Tests:

- parse rows.
- preserve visible ID.
- insert row.
- update one row.
- reject missing key column.
- reject ambiguous duplicate ID.

- [ ] Implement `markdown-cards`.

Tests:

- parse headings as record IDs.
- preserve prose fields.
- append a new card.
- update a key-value line.

- [ ] Implement `csv`.

Tests:

- parse quoted values.
- preserve headers.
- append rows.
- update row by ID.

- [ ] Add read-only parsing for `jsonl` and `yaml`; defer mutation until after markdown/csv prove stable.

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/collectionMarkdownTable.test.ts \
  convex/collectionMarkdownCards.test.ts \
  convex/collectionCsv.test.ts \
  convex/collectionAdapters.test.ts
```

---

## Phase 5: Collection Mutations Through Canonical Writes

**Purpose:** Apply collection operations back to source files safely.

**Files:**
- Modify: `apps/app/convex/appData.ts`
- Modify: `apps/app/convex/collectionData.ts`
- Modify: `apps/app/convex/viewData.ts` only if old view APIs still need compatibility.
- Test: `apps/app/convex/appData.collectionMutations.test.ts`
- Test: `services/hocuspocus/src/semantic-api.test.ts`

### Strategy

Text-backed collection mutations produce a `CollectionMutationPlan`:

```ts
type CollectionMutationPlan =
  | { kind: 'createAtom'; path: string; body: string }
  | { kind: 'replaceText'; path: string; expectedText: string; replacement: string }
  | { kind: 'appendSection'; path: string; heading: string; markdown: string }
```

The public SDK never sees `appendSection`. The server uses it internally to map readable collection operations to Hocuspocus semantic writes.

### Steps

- [ ] Add `api.appData.runCollectionMutation`.

Args:

```ts
{
  packageRoot: string
  collection: string
  op: 'insert' | 'update' | 'upsert' | 'delete'
  id?: string
  record?: Record<string, unknown>
  patch?: Record<string, unknown>
  clientMutationId: string
  activeWorkspaceId?: string
}
```

- [ ] Enforce:

  - authenticated user.
  - workspace derived server-side.
  - app manifest valid.
  - app trust granted.
  - collection source inside read scope.
  - mutation target inside write scope.
  - `canWriteAtomPath`.
  - lock/review gate compatibility.

- [ ] Apply text mutations through Hocuspocus semantic APIs.

Use:

- `createAtom` for new source docs.
- `createAnchorsForText` + `replaceRange` for row/card replacement.
- `insertAfterHeading` internally for section appends.

- [ ] Return precise errors to app code.

Examples:

```text
collection-write-not-granted
collection-row-not-found
collection-duplicate-id
semantic-backend-offline
```

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/appData.collectionMutations.test.ts \
  convex/collectionMarkdownTable.test.ts

cd "$(git rev-parse --show-toplevel)"
npx -y node@24 node_modules/vitest/vitest.mjs run services/hocuspocus/src/semantic-api.test.ts
```

---

## Phase 6: SQLite As A First-Class File Type

**Purpose:** Let dohc support serious database-backed apps and Notion-like databases.

**Files:**
- Modify: `apps/app/convex/schema.ts`
- Create: `apps/app/convex/databaseFiles.ts`
- Create: `apps/app/convex/databaseOps.ts`
- Create: `apps/app/convex/databaseSchema.ts`
- Create: `apps/app/src/components/DatabaseStudio.tsx`
- Create: `apps/app/src/components/DatabaseTableGrid.tsx`
- Modify: `apps/app/src/components/FileTree.tsx`
- Modify: `apps/app/src/components/AtomView.tsx`
- Test: `apps/app/convex/databaseFiles.test.ts`
- Test: `apps/app/convex/databaseOps.test.ts`
- Test: `apps/app/src/__tests__/databaseStudio.test.tsx`

### Storage model

SQLite must not live in `atoms.body`. Add first-class database files:

```ts
databaseFiles: defineTable({
  workspaceId: v.string(),
  path: v.string(),
  storageId: v.id('_storage'),
  filename: v.string(),
  size: v.number(),
  sha256: v.optional(v.string()),
  schemaHash: v.optional(v.string()),
  version: v.number(),
  createdByUserId: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index('by_workspace_path', ['workspaceId', 'path'])
```

Operation log:

```ts
databaseOps: defineTable({
  workspaceId: v.string(),
  databasePath: v.string(),
  operationId: v.string(),
  actorUserId: v.string(),
  op: v.string(),
  table: v.string(),
  rowId: v.optional(v.string()),
  payload: v.any(),
  appliedAt: v.number(),
}).index('by_database', ['workspaceId', 'databasePath'])
```

### SQLite sync rule

Do not CRDT-sync raw SQLite bytes.

Use:

```text
App/User operation
  -> server validation
  -> SQL transaction
  -> new SQLite snapshot/version
  -> databaseOps append
  -> clients refresh affected queries
```

### SQLite Studio

When a user opens `finance/ledger.sqlite`, dohc shows:

- table list
- schema
- grid view
- record detail drawer
- filters/sorts
- safe row edits
- import/export
- SQL tab for technical users
- operation history/provenance

### Steps

- [ ] Extend the file tree to include `databaseFiles` alongside text atoms.

SQLite files should appear as normal workspace files with a database icon.

- [ ] Add `databaseFiles.create` from uploaded SQLite or generated app data.

MIME/extensions:

```text
application/vnd.sqlite3
application/x-sqlite3
.sqlite
.sqlite3
.db
```

- [ ] Add read-only Studio first.

Use a local/browser SQLite engine for display if possible. If browser-only loading is too limited, create a small Node service later in Phase 7.

- [ ] Add safe row-level editing through `databaseOps`.

Do not allow arbitrary destructive SQL from a non-technical app button.

- [ ] Add backup/version handling.

Every write increments `databaseFiles.version`. Failed SQLite apply must leave the old version untouched.

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/databaseFiles.test.ts \
  convex/databaseOps.test.ts \
  src/__tests__/databaseStudio.test.tsx
```

---

## Phase 7: SQLite Engine And Derived Indexes

**Purpose:** Use SQLite for performance without making opaque DB files the only source option.

**Files:**
- Create: `services/sqlite-worker/package.json`
- Create: `services/sqlite-worker/src/server.ts`
- Create: `services/sqlite-worker/src/sqliteEngine.ts`
- Create: `apps/app/convex/collectionIndex.ts`
- Test: `services/sqlite-worker/src/sqliteEngine.test.ts`
- Test: `apps/app/convex/collectionIndex.test.ts`

### Engine options

Evaluate during implementation:

1. **Node service with SQLite library**
   - Best for server-side transactions and Playwright test harness.
   - Most reliable for shared workspace DB writes.

2. **WASM SQLite in browser**
   - Good for read-only Studio previews.
   - Not enough for canonical shared writes.

3. **Convex action + WASM SQLite**
   - Possible but risky due to runtime/package constraints.

Recommendation: add a small SQLite worker service, similar in spirit to Hocuspocus, for canonical DB operations.

### Derived indexes

Use SQLite for:

- parsed collection rows from markdown/CSV/YAML/JSONL.
- field indexes.
- app query acceleration.
- search/filter/sort/group projections.

Derived indexes are rebuildable.

Source-backed collection flow:

```text
Text source changes
  -> parser detects collection rows
  -> derived SQLite index updates
  -> apps query fast index
```

### Steps

- [ ] Build the SQLite worker preflight endpoint.

```http
GET /preflight
```

Response:

```json
{ "ok": true, "service": "dohc-sqlite-worker", "sqlite": true }
```

- [ ] Add query endpoint for read-only SQL against a database file.

- [ ] Add transaction endpoint for validated row operations.

- [ ] Add index rebuild endpoint for text-backed collections.

- [ ] Add Convex action wrappers that call the worker and enforce auth before sending work.

Verification:

```bash
cd "$(git rev-parse --show-toplevel)"
npx -y node@24 node_modules/vitest/vitest.mjs run services/sqlite-worker/src/sqliteEngine.test.ts

cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts convex/collectionIndex.test.ts
```

---

## Phase 8: App Runtime Host

**Purpose:** Route SDK calls from sandboxed apps to the right backend capability.

**Files:**
- Create/rename: `apps/app/src/apps/AppRuntimeHost.tsx`
- Create/rename: `apps/app/src/components/AppFrame.tsx`
- Test: `apps/app/src/apps/AppRuntimeHost.test.tsx`
- Test: `apps/app/src/__tests__/appsShell.test.tsx`

### Runtime responsibilities

- Build app source with the virtual `@dohc/app` SDK.
- Mount app in sandboxed iframe.
- Validate all postMessage RPC payloads.
- Attach active workspace and package root server-side.
- Enforce trust prompt before writes.
- Route:
  - collection reads/writes to `appData`.
  - doc reads/writes to `appData`.
  - database reads/writes to `databaseFiles`/SQLite worker.
  - asset reads to existing asset resolver.
  - agent handoffs to Agent Chat.
  - patch proposals to review/agent flow.

### Steps

- [ ] Rename old `ViewRuntimeHost` to `AppRuntimeHost`.

- [ ] Add routing cases for all SDK RPC operations.

- [ ] Add better source-context forwarding for `dohc.agent.run`.

Agent run should include:

```ts
{
  prompt,
  sources,
  originatingApp: packageRoot,
  titleHint,
}
```

- [ ] Keep app controls enabled while a run is active unless that control would conflict with the active mutation.

- [ ] Record auditable app actions.

Event detail:

```ts
{
  packageRoot,
  operation,
  target,
  timestamp,
}
```

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  src/apps/AppRuntimeHost.test.tsx \
  src/__tests__/appsShell.test.tsx
```

---

## Phase 9: Agent-Testable Apps

**Purpose:** Let the agent test and iterate app output like Codex tests code.

**Files:**
- Create: `services/app-tester/package.json`
- Create: `services/app-tester/src/server.ts`
- Create: `services/app-tester/src/runAppTest.ts`
- Create: `services/app-tester/src/appTestSdk.ts`
- Create: `apps/app/convex/appTesting.ts`
- Modify: `apps/app/convex/agent.ts`
- Modify: `apps/app/convex/onboarding.ts`
- Test: `services/app-tester/src/runAppTest.test.ts`
- Test: `apps/app/convex/appTesting.test.ts`
- Test: `apps/app/convex/a1SystemPrompt.test.ts`
- Test: `apps/app/convex/onboarding.test.ts`

### Test levels

1. **Static quality check**
   - app compiles.
   - imports `@dohc/app`, not `@dohc/view`.
   - uses source-backed APIs.
   - no fake placeholder metrics when source data exists.
   - mutation UI calls collection/doc/database APIs.

2. **SDK simulation test**
   - run app in a fake workspace SDK.
   - seed source files/collections.
   - click controls.
   - assert SDK calls and resulting fake state.

3. **Browser test**
   - Playwright opens the sandboxed app.
   - captures screenshots.
   - checks no blank render, no overlapping critical UI, no obvious placeholder output.
   - runs manifest `tests`.

4. **Workspace integration smoke**
   - optional local/dev flow that runs against real app data and verifies source files/database rows changed.

### Agent tool

Add:

```ts
test_app({
  packageRoot: string,
  mode?: 'static' | 'browser' | 'integration'
})
```

Output:

```text
app test failed: finance/.apps/tracker
- compile: ok
- source-backed data: failed; collection "transactions" has 790 rows but app rendered 0
- mutation: failed; Add expense button did not call dohc.collection(...).insert
- screenshot: attached
```

### Onboarding gate

`finish_onboarding` must refuse if:

- app-like setup created an app but `test_app` has not passed.
- app has forms/buttons but no persistent writes.
- app rendered placeholder/dash/zero metrics while uploaded data exists.
- app uses old `.views`/`@dohc/view`.

### Steps

- [ ] Implement pure static validator first.

- [ ] Add Playwright app-tester service.

- [ ] Add manifest-driven test runner.

- [ ] Give agent `test_app`.

- [ ] Update prompts:

```text
Before finish_onboarding, run test_app on every generated app and fix failures.
```

Verification:

```bash
cd "$(git rev-parse --show-toplevel)"
npx -y node@24 node_modules/vitest/vitest.mjs run services/app-tester/src/runAppTest.test.ts

cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/appTesting.test.ts \
  convex/a1SystemPrompt.test.ts \
  convex/onboarding.test.ts
```

---

## Phase 10: Finance Tracker Acceptance Fixture

**Purpose:** Ensure the original failure mode cannot recur.

**Files:**
- Create: `apps/app/convex/appFinanceTracker.acceptance.test.ts`
- Create: `apps/app/src/apps/fixtures/financeTrackerApp.ts`

### Fixture requirements

Seed:

```text
finance/transactions/2026-06.md
finance/categories.md
finance/rules.md
finance/.apps/tracker/app.json
finance/.apps/tracker/src/App.tsx
```

The generated app must:

- read real transaction rows.
- render non-placeholder totals.
- add an expense.
- categorize/recategorize a transaction.
- mark a transaction reviewed.
- persist changes into the markdown table source.
- pass `test_app`.

Add a second fixture using:

```text
finance/ledger.sqlite
finance/.apps/tracker/app.json
finance/.apps/tracker/src/App.tsx
```

The SQLite version must:

- open in Database Studio.
- query rows through `useCollection('ledger')`.
- insert/update through database operations.
- log `databaseOps`.

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts convex/appFinanceTracker.acceptance.test.ts
```

---

## Phase 11: Migration And Prompt Cleanup

**Purpose:** Stop generating old patterns.

**Files:**
- Modify: `apps/app/convex/agent.ts`
- Modify: `apps/app/src/components/Onboarding.tsx`
- Modify: `apps/app/convex/onboarding.ts`
- Modify: `apps/app/convex/a1SystemPrompt.test.ts`
- Modify: `apps/app/src/__tests__/onboardingSetupFirst.test.ts`
- Modify: `docs/product/spec.md`

### Prompt rules

The system prompt should say:

```text
Apps are interactive workspace tools stored in .apps/<name>.
Use @dohc/app.
Use collections for structured app data.
Use docs for targeted markdown document edits.
Use SQLite-backed collections for serious app data when markdown tables would be too small/slow.
Never create fake app controls that only mutate React state.
Run test_app and fix failures before finish_onboarding.
```

Finance playbook:

```text
For a finance tracker, create a mutable ledger source, categories/rules source, and .apps/tracker app. The app must support adding an expense, categorizing transactions, marking review state, filtering, and surfacing next money decisions. Use markdown-table for small readable ledgers or sqlite for heavier ledgers. Test it before finishing.
```

### Steps

- [ ] Remove prompt language that says app actions must hand off to Agent/proposed patches by default.

- [ ] Add language that normal deterministic app controls should use `dohc.collection`, `dohc.doc`, or `dohc.database`.

- [ ] Keep `dohc.agent.run` for judgment-heavy tasks only:

```text
analyze, summarize, suggest, draft, investigate, plan
```

- [ ] Keep `dohc.patch.propose` for risky/ambiguous reviewed edits.

- [ ] Keep `actions.run`, `field.increment`, and `field.set` only as deprecated/simple legacy action APIs.

They should not be recommended to generated apps unless the use case is truly a tiny declared counter/toggle.

Verification:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/a1SystemPrompt.test.ts \
  src/__tests__/onboardingSetupFirst.test.ts \
  convex/onboarding.test.ts
```

---

## Phase 12: Full Verification

**Purpose:** Prove the system works across contracts, persistence, collaboration, privacy, generated app quality, and realistic user flows before this branch is considered shippable.

Run:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/typescript/bin/tsc --noEmit
```

Run targeted app tests:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  src/apps/sdkProtocol.test.ts \
  src/apps/virtualDohcAppSdk.test.ts \
  src/apps/AppRuntimeHost.test.tsx \
  src/apps/AppRuntimeHost.collaboration.test.tsx \
  convex/apps.test.ts \
  convex/appTrust.test.ts \
  convex/appCollaboration.test.ts \
  convex/appSecurity.test.ts \
  convex/appData.collectionMutations.test.ts \
  convex/collectionMarkdownTable.test.ts \
  convex/collectionMarkdownCards.test.ts \
  convex/collectionCsv.test.ts \
  convex/databaseFiles.test.ts \
  convex/databaseOps.test.ts \
  convex/appTesting.test.ts \
  convex/appFinanceTracker.acceptance.test.ts \
  convex/a1SystemPrompt.test.ts \
  convex/onboarding.test.ts
```

Run cross-cutting security, privacy, and authorization tests:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/appSecurity.test.ts \
  convex/appTrust.test.ts \
  convex/appCollaboration.test.ts \
  convex/authzBoundaries.test.ts \
  src/apps/AppRuntimeHost.collaboration.test.tsx \
  src/apps/AppRuntimeHost.security.test.tsx
```

Expected:

```text
PASS: app manifest scope never grants access by itself
PASS: per-user app trust enforced
PASS: app iframe cannot access host session/cookies/storage bridges
PASS: unknown RPC and path traversal payloads rejected
PASS: cross-workspace reads/writes denied
```

Run generated app quality tests:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/appTesting.test.ts \
  convex/appFinanceTracker.acceptance.test.ts \
  convex/onboardingGeneratedAppQuality.test.ts
```

Expected:

```text
PASS: generated apps compile
PASS: generated apps render nonblank UI
PASS: generated apps use source-backed SDK APIs
PASS: generated apps persist primary actions
PASS: generated apps fail validation when they render placeholder metrics over real data
```

Run onboarding regression tests:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/onboarding.test.ts \
  src/__tests__/onboardingSetupFirst.test.ts \
  src/__tests__/onboardingNoIntermediateFlash.test.ts \
  src/__tests__/onboardingAttachments.test.ts \
  src/__tests__/skillTurnGateApplied.test.ts
```

Expected:

```text
PASS: final Continue starts the agent run
PASS: no setup/new-chat screen flashes before the created chat
PASS: CSV/text attachments are summarized and passed as source references
PASS: supported binary attachments are handled without model-unsupported file parts
PASS: next-message model and permission controls stay usable
```

Run service tests:

```bash
cd "$(git rev-parse --show-toplevel)"
npx -y node@24 node_modules/vitest/vitest.mjs run \
  services/hocuspocus/src/semantic-api.test.ts \
  services/sqlite-worker/src/sqliteEngine.test.ts \
  services/app-tester/src/runAppTest.test.ts
```

Run SQLite failure and concurrency tests:

```bash
cd "$(git rev-parse --show-toplevel)"
npx -y node@24 node_modules/vitest/vitest.mjs run \
  services/sqlite-worker/src/sqliteEngine.test.ts \
  services/sqlite-worker/src/sqliteEngine.concurrency.test.ts \
  services/sqlite-worker/src/sqliteEngine.failureInjection.test.ts

cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/databaseFiles.test.ts \
  convex/databaseOps.test.ts \
  convex/databaseOps.concurrency.test.ts
```

Expected:

```text
PASS: invalid SQLite fails safely
PASS: failed writes leave old DB version intact
PASS: concurrent writes serialize or return database-version-conflict
PASS: operation log records actor, table, row, payload, and version
PASS: raw SQLite bytes are never sent through Y.Doc/CRDT paths
```

Run app tester/browser service:

```bash
cd "$(git rev-parse --show-toplevel)"
npx -y node@24 node_modules/vitest/vitest.mjs run \
  services/app-tester/src/runAppTest.test.ts \
  services/app-tester/src/runAppTest.browser.test.ts \
  services/app-tester/src/runAppTest.screenshot.test.ts
```

Expected:

```text
PASS: app tester reports compile failures clearly
PASS: app tester catches blank renders
PASS: app tester catches fake primary buttons
PASS: app tester captures screenshots for failed browser tests
PASS: app tester verifies persisted collection/database mutations
```

Run realistic data/performance tests:

```bash
cd "$(git rev-parse --show-toplevel)/apps/app"
npx -y node@24 ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  convex/collectionMarkdownTable.performance.test.ts \
  convex/collectionCsv.performance.test.ts \
  convex/collectionIndex.performance.test.ts \
  convex/appFinanceTracker.largeCsv.acceptance.test.ts
```

Expected thresholds:

```text
1k markdown rows: parse/query under 250ms in test environment
10k CSV rows: parse/index under 1500ms in test environment
100k SQLite rows: indexed query under 250ms in test environment
large CSV onboarding: no visible chat dump, attachment summary under 200 visible words
```

Manual smoke:

1. Create a finance tracker from onboarding with a CSV.
2. Confirm dohc creates `finance/.apps/tracker`.
3. Confirm app passes `test_app`.
4. Add an expense.
5. Confirm source markdown table or SQLite row changes.
6. Categorize a transaction.
7. Reload the workspace.
8. Confirm the app shows persisted state.
9. Open the backing source file/database and confirm it is readable/editable through the right dohc surface.
10. Open the same app as a second permitted collaborator and confirm updates appear live.
11. Open the same app as a collaborator without finance-source permission and confirm the app shows denied/partial state instead of leaking data.
12. Revoke app trust or change `app.json.write` and confirm writes require trust again.

---

## Acceptance Criteria

- New generated interactive surfaces use `.apps`, `app.json`, and `@dohc/app`.
- Existing `.views` packages can be migrated, but new prompts do not produce `.views`.
- App SDK exposes collection, doc, database, asset/source, agent, and patch capabilities.
- Normal app actions persist through `dohc.collection`, `dohc.doc`, or `dohc.database`.
- Multiple permitted collaborators can use the same app at the same time and see shared source changes live.
- App trust is per user, per app, and per manifest write key; one collaborator cannot grant another collaborator write trust.
- App manifests never broaden access beyond normal workspace, folder, file, lock, share, and review-gate permissions.
- App code cannot access WorkOS sessions, Convex clients, cookies, local storage bridges, or sources outside approved SDK RPC calls.
- Markdown-backed collections stay human-readable with visible IDs.
- SQLite files open in dohc Studio and support table browsing/editing.
- SQLite collaboration uses operations/logs, not raw-byte CRDT sync.
- Derived SQLite indexes accelerate collection queries while source remains canonical where applicable.
- Agents can run `test_app`, see concrete failures, and iterate.
- Onboarding cannot finish with untested, placeholder, read-only, or fake-control apps.
- Finance tracker acceptance fixture proves add/categorize/review flows persist.
- Every phase has new failing-first tests, targeted verification, and cross-cutting regression coverage before being marked complete.
- Security, privacy, collaboration, migration, failure-injection, browser/runtime, and performance suites exist and pass for their relevant phases.
- Known onboarding regressions are covered permanently: intermediate screen flashes, non-starting agent runs, unsupported file parts, CSV chat dumps, blank markdown flashes, and fake generated apps.
- Any skipped or deferred test is explicitly recorded with a reason; silent test gaps are not acceptable.
- The implementing agent follows the GPT-5.5 one-shot handoff pack: context read first, phase-by-phase execution, execution log updates, self-grade rubric, and no final “done” claim without full verification or explicit blockers.
- The implementing agent keeps working until the plan is 100% complete and freshly verified, unless a true blocker is reached under the stop conditions.
- Partial implementation, partial test success, context pressure, long runtime, or large diffs are not acceptable terminal states.
- If interrupted or compacted, the implementation resumes from the execution log and first incomplete phase rather than restarting or finalizing.

---

## Open Product Questions To Resolve During Execution

1. Should `@dohc/app` be only a virtual SDK import inside sandbox apps, or should we publish a real package for external app authors later?
2. Should SQLite-backed collections be recommended during onboarding immediately, or only after markdown-table app generation is stable?
3. Should app delete operations default to a confirmation modal or use soft-delete rows first?
4. Should Database Studio expose SQL editing to all users or hide it behind an advanced/source mode?

These questions do not block Phase 1-5. They matter most before SQLite write support and public app-author docs ship.

---

## Superseded Plan

This plan replaces `2026-06-05-dohc-view-markdown-app-write-api.md`. The old plan was too narrow: it kept the view terminology, exposed implementation-shaped document APIs, and did not include SQLite or agent browser-style testing.

## Self-Review

- Spec coverage: covers app rename, SDK design, readable text collections, SQLite as file/index engine, app testing, onboarding gates, and prompt cleanup.
- Testing coverage: requires failing-first task tests, negative auth/security tests, collaboration tests, generated app browser tests, SQLite failure/concurrency tests, onboarding regression tests, performance tests, and manual smoke.
- Agent handoff coverage: includes a GPT-5.5-ready copy-paste prompt, runtime notes without prescribed model settings, completion contract, resume protocol, stop conditions, anti-drift rules, execution log requirement, and self-grade rubric.
- Placeholder scan: no `TBD` or undefined “later” requirements in executable phases.
- Type consistency: uses `.apps`, `app.json`, `@dohc/app`, `collection`, `doc`, and `database` consistently.
- Scope check: large but intentionally staged; Phase 1-5 can ship app-grade markdown collection workflows before SQLite and app tester services are complete.
