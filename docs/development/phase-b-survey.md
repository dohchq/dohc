# Phase B survey — activeWorkspaceId threading

Generated from Explore-agent fan-out search. Use this as the source of truth for the Phase B edit set.

## A. The 4 NON-DEFAULTABLE surfaces (org-plan §5)
MUST throw if `activeWorkspaceId` is not supplied (silently defaulting to personal would render org content against personal data — a privacy bug).

| File | Function | Line |
|------|----------|------|
| `convex/queries.ts` | `evalQueryBlocks` | 222 |
| `convex/formulaEval.ts` | `evalFormulas` | 269 |
| `convex/htmlAtoms.ts` | `getRenderable` | 27 |
| `convex/agent.ts` | `ensureThread` | 1567 |
| `convex/agent.ts` | `sendMessage` | 1816 |
| `convex/agent.ts` | `startOnboarding` | 1944 |
| `convex/agent.ts` | `listMessages` | 2040 |

Two add-ons the survey caught: `sendMessage` + `listMessages` + `startOnboarding` are all thread-touching so they live with the agent-thread "surface."

## B. IMPORTANT surfaces (optional arg; default-to-personal OK)

### atoms.ts
- `list:309` (R), `getByPath:362` (R), `idAdvisory:386` (R)
- `upsert:431` (W), `upsertSharedAtom:464` (W), `remove:527` (W), `move:541` (W)
- `setLock:850` (W), `setIcon:880` (W), `setStar:906` (W)

### folders.ts
- `list:42` (R), `create:107` (W), `move:153` (W), `remove:469` (W)
- `setMeta:739` (W), `setStar:821` (W)

### atomShares.ts
- `shareAtom:124` (W), `shareAtomToOrg:170` (W), `unshareAtom:212` (W)
- `listSharedWithMe:248` (R), `listMyShares:282` (R)

### search.ts
- `run:87` (R), `ensureIndexed:130` (W)

### entities.ts
- `list:61` (R), `get:80` (R)

### skills.ts
- `list:33` (R)

### catalog.ts
- `list:501` (R)

### queries.ts
- `run:201` (action — legacy back-compat)

## C. TRIVIAL (stay personal-only, no threading)
- `agent.generateQuestions:1911`
- `graph.personalGraph:60`, `graph.sharedGraph:138`, `graph.companyGraph:229`
- `liveTotals.resolve:120`, `liveTotals.resolveMany:140`
- `onboarding.state:226`, `onboarding.progress:237`, `onboarding.defer:250`
- `plugins.discover:9`, `plugins.listEnabled:23`, `plugins.setEnabled:35`
- All `windows.*` (window-grant sharing already cross-workspace by design)

## D. Frontend callers (need `useActiveWorkspaceId()`)

### CRITICAL callers (must pass once URL routing lands)
| File | Call |
|------|------|
| `src/components/AtomEditor.tsx:987` | `api.formulaEval.evalFormulas`, `evalFormulasShared` |
| `src/components/AtomEditor.tsx:1016` | `api.queries.evalQueryBlocks` |
| `src/components/HtmlAtomFrame.tsx` | `api.formulaEval.evalFormulas` |
| `src/routes/r/$atomId.tsx` | `api.htmlAtoms.getRenderable`, `api.formulaEval.evalFormulas` |
| `src/components/Chat.tsx:~70` | `api.agent.sendMessage`, `api.agent.listMessages` |
| `src/routes/_app.tsx:~171` | `api.agent.ensureThread` |

### IMPORTANT callers
- `src/routes/_app.tsx` — `atoms.*`, `folders.*`, `atomShares.listSharedWithMe`
- `src/components/Chat.tsx` — `skills.list`

## E. Onboarding workspace-kind branch
- `convex/onboarding.ts:74-105` — `progressOf()` hardcodes identity atom to `me.md`; needs branch `(kind === 'org') ? 'company.md' : 'me.md'`.
- `convex/agent.ts:59-503` — system prompt hardcodes personal language ("me.md", "your vault"); needs workspace-kind branches.
- `convex/agent.ts:1944-2020` — `startOnboarding` passes activeWorkspaceId to `ensureThread` and `claimKickoff`.

## F. threadRefs schema
**Already workspace-keyed** (`schema.ts:243-246`): `{workspaceId, threadId}` + `by_workspace`. No schema changes needed; only agent code needs the activeWorkspaceId arg to thread through.

## G. Implementation order (recommended)
1. **B.1 (backend additive):** Add OPTIONAL `activeWorkspaceId` to all 27 surfaces (4 CRITICAL + 23 IMPORTANT). Default-to-personal preserved. Zero frontend breakage.
2. **B.2 (frontend):** `useActiveWorkspaceId()` hook reads from URL `/w/<wsId>/...`; routes updated; callers wired. (Bridges into Phase D.)
3. **B.3 (tighten CRITICAL):** Once all callers pass it, change the 4 CRITICAL surfaces from optional to required + throw-if-missing.
4. **B.4:** Workspace-kind branch in onboarding + agent prompt.
