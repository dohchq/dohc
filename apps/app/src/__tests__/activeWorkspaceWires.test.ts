import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// org-plan §5 Phase B.3 — FRONTEND-side audit-by-grep.
//
// The backend phaseBC.test.ts asserts every public fn taking an
// `activeWorkspaceId` arg routes it through `requireWorkspace`. This
// file is the complement: every frontend CALLER of the 4 §5
// non-defaultable surfaces (evalFormulas, evalQueryBlocks,
// getRenderable, ensureThread/listMessages thread surface) MUST pass
// `activeWorkspaceId` from `useActiveWorkspaceId()`. A forgotten
// thread-through silently degrades an org user to personal-default
// data — the exact §5 privacy bug.

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) =>
  readFileSync(resolve(__dirname, '../../src/', rel), 'utf8')

const EDITOR = read('components/AtomEditor.tsx')
const HTML_FRAME = read('components/HtmlAtomFrame.tsx')
const ATOM_VIEW = read('components/AtomView.tsx')
const CHAT = read('components/Chat.tsx')
const ONBOARDING = read('components/Onboarding.tsx')
const APP = read('routes/_app.tsx')
const R_ROUTE = read('routes/r/$atomId.tsx')
const GRAPH_VIEW = read('components/GraphView.tsx')

describe('frontend §5 wiring — every CRITICAL caller threads activeWorkspaceId', () => {
  it('AtomEditor passes activeWorkspaceId to evalFormulas + evalQueryBlocks', () => {
    expect(EDITOR).toMatch(
      /useActiveWorkspaceId[\s\S]{0,200}from\s+['"](?:@\/lib|\.\.\/lib)\/active-workspace['"]/,
    )
    expect(EDITOR).toMatch(
      /api\.formulaEval\.evalFormulas[\s\S]{0,200}activeWorkspaceId/,
    )
    expect(EDITOR).toMatch(
      /api\.queries\.evalQueryBlocks[\s\S]{0,600}activeWorkspaceId/,
    )
  })

  it('HtmlAtomFrame passes activeWorkspaceId AND appends ?w= to the iframe URL', () => {
    expect(HTML_FRAME).toMatch(
      /useActiveWorkspaceId[\s\S]{0,200}from\s+['"](?:@\/lib|\.\.\/lib)\/active-workspace['"]/,
    )
    expect(HTML_FRAME).toMatch(
      /api\.formulaEval\.evalFormulas[\s\S]{0,200}activeWorkspaceId/,
    )
    // Iframe URL forwards the active workspace so the server route
    // (/r/<atomId>) can pass it through. Without this, the iframe's
    // SSR-rendered HTML would silently resolve formulas against the
    // caller's personal workspace even in an org context.
    expect(HTML_FRAME).toMatch(/\?v=\$\{nonce\}\$\{wParam\}/)
  })

  it('AtomView reads and writes the open path in the active workspace', () => {
    expect(ATOM_VIEW).toMatch(
      /useActiveWorkspaceId[\s\S]{0,200}from\s+['"](?:@\/lib|\.\.\/lib)\/active-workspace['"]/,
    )
    expect(ATOM_VIEW).toMatch(
      /api\.atoms\.getByPath,\s*[\s\S]{0,120}activeWorkspaceId/,
    )
    expect(ATOM_VIEW).toMatch(
      /api\.atoms\.idAdvisory,\s*[\s\S]{0,120}activeWorkspaceId/,
    )
    expect(ATOM_VIEW).toMatch(/upsert\(\{[\s\S]{0,160}activeWorkspaceId/)
    expect(ATOM_VIEW).toMatch(/workspaceId:\s*activeWorkspaceId\s*\?\?\s*identity\.workspaceId/)
  })

  it('Chat + Onboarding pass activeWorkspaceId to listMessages', () => {
    expect(CHAT).toMatch(
      /useActiveWorkspaceId[\s\S]{0,200}from\s+['"](?:@\/lib|\.\.\/lib)\/active-workspace['"]/,
    )
    expect(CHAT).toMatch(
      /api\.agent\.listMessages,\s*[\s\S]{0,200}activeWorkspaceId/,
    )
    expect(ONBOARDING).toMatch(
      /api\.agent\.listMessages,\s*[\s\S]{0,200}activeWorkspaceId/,
    )
  })

  it('Chat + Onboarding ALSO pass activeWorkspaceId to the action surfaces (sendMessage, startOnboarding)', () => {
    // org-plan §5 — Phase B.3 action-bridge: sendMessage/startOnboarding
    // route through _resolveWorkspaceForCaller. Without the frontend
    // wire, the action defaults to personal and _assertOwnThread fails
    // when the thread is bound to an org workspace — chat broken in
    // org context. This regression is the bug we just fixed.
    expect(CHAT).toMatch(/sendMessage\([\s\S]{0,300}activeWorkspaceId/)
    expect(ONBOARDING).toMatch(
      /startOnboarding\([\s\S]{0,200}activeWorkspaceId/,
    )
  })

  it('ensureThread callers (_app + Onboarding) pass activeWorkspaceId', () => {
    expect(APP).toMatch(/ensureThread\(\{\s*activeWorkspaceId\s*\}\)/)
    expect(ONBOARDING).toMatch(/ensureThread\(\{\s*activeWorkspaceId\s*\}\)/)
  })

  it('FileTree share indicators come from owner share ids scoped to the active workspace', () => {
    expect(APP).toMatch(
      /api\.atomShares\.listSharedFileIds,\s*\{\s*activeWorkspaceId\s*,?\s*\}/,
    )
    expect(APP).toMatch(/sharedByMeFileIds=\{sharedByMeFileIds\s*\?\?\s*\[\]\}/)
  })

  it('GraphView reads every graph slice from the active workspace with no company selector/form', () => {
    expect(GRAPH_VIEW).toMatch(
      /useActiveWorkspaceId[\s\S]{0,200}from\s+['"](?:@\/lib|\.\.\/lib)\/active-workspace['"]/,
    )
    expect(GRAPH_VIEW).toMatch(
      /api\.graph\.personalGraph,\s*\{\s*activeWorkspaceId\s*\}/,
    )
    expect(GRAPH_VIEW).toMatch(
      /api\.graph\.sharedGraph,\s*\{\s*activeWorkspaceId\s*\}/,
    )
    expect(GRAPH_VIEW).toMatch(
      /api\.graph\.companyGraph,\s*\{\s*activeWorkspaceId\s*\}/,
    )
    expect(GRAPH_VIEW).not.toMatch(/<OrgBar\b/)
    expect(GRAPH_VIEW).not.toMatch(/setScope|scope ===|My files|Shared with me|Company/)
  })

  it('GraphView keeps the empty-state fallback visible after the renderer loads', () => {
    expect(GRAPH_VIEW).toMatch(
      /!\s*FG\s*\|\|\s*!\s*ready\s*\|\|\s*data\.nodes\.length\s*===\s*0/,
    )
  })

  it('/r/<atomId> route reads ?w= and forwards to getRenderable + evalFormulas', () => {
    expect(R_ROUTE).toMatch(/searchParams\.get\(['"]w['"]\)/)
    // Both server-side queries receive the URL-derived activeWorkspaceId.
    expect(R_ROUTE).toMatch(
      /api\.htmlAtoms\.getRenderable,\s*\{[\s\S]{0,200}activeWorkspaceId/,
    )
    expect(R_ROUTE).toMatch(
      /api\.formulaEval\.evalFormulas,\s*\{[\s\S]{0,200}activeWorkspaceId/,
    )
  })
})
