import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildViewBundle,
  MAX_VIEW_BUNDLE_BYTES,
  MAX_VIEW_SOURCE_BYTES,
  MAX_VIEW_SOURCE_FILES,
} from '../views/buildViewBundle.server'
import {
  canWriteRequestedPath,
  summarizeViewActionInput,
  viewActionDetail,
  viewWorkspaceArgs,
  VIEW_ACTION_DIALOG_FOCUS_SELECTOR,
  VIEW_ACTION_EVENT,
  VIEW_START_TIMEOUT_MS,
} from '../views/ViewRuntimeHost'
import { buildViewShell } from '../views/viewShell'
import { validateBundleViewInput } from '../views/buildViewBundle.functions'

describe('folder views performance and safety guards', () => {
  it('enforces source file count and UTF-8 byte caps during bundling', async () => {
    const tooManyFiles = Array.from({ length: MAX_VIEW_SOURCE_FILES + 1 }, (_, i) => ({
      relativePath: `src/${i}.ts`,
      body: `export const value${i} = ${i}`,
    }))
    tooManyFiles.push({ relativePath: 'src/App.tsx', body: 'console.log(1)' })

    await expect(buildViewBundle({
      entry: 'src/App.tsx',
      files: tooManyFiles,
    })).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: 'too-many-files' }],
    })

    await expect(buildViewBundle({
      entry: 'src/App.tsx',
      files: [
        {
          relativePath: 'src/App.tsx',
          body: '💥'.repeat(Math.floor(MAX_VIEW_SOURCE_BYTES / 4) + 1),
        },
      ],
    })).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: 'source-too-large' }],
    })
  })

  it('enforces byte caps at the server-function input boundary', () => {
    expect(() =>
      validateBundleViewInput({
        entry: 'src/App.tsx',
        files: [
          {
            relativePath: 'src/App.tsx',
            body: '💥'.repeat(Math.floor(MAX_VIEW_SOURCE_BYTES / 4) + 1),
          },
        ],
      }),
    ).toThrow(/too large/i)

    expect(() =>
      validateBundleViewInput({
        entry: 'src/App.tsx',
        files: [
          {
            relativePath: 'src/App.tsx',
            body: 'a'.repeat(MAX_VIEW_SOURCE_BYTES / 2),
          },
          {
            relativePath: 'src/extra.ts',
            body: 'b'.repeat(MAX_VIEW_SOURCE_BYTES / 2 + 1),
          },
        ],
      }),
    ).toThrow(/too large/i)
  })

  it('warns view authors toward batched SDK reads in the runtime shell', () => {
    const shell = buildViewShell({ title: 'Perf' })
    expect(shell).toContain('more than 50 SDK calls in one frame')
    expect(shell).toContain('batch with fields.query or sources.list')
  })

  it('keeps reviewed write actions scoped and locally auditable', () => {
    expect(canWriteRequestedPath('clients/acme', ['clients/acme/tasks.md'], 'tasks.md')).toBe(true)
    expect(canWriteRequestedPath('clients/acme', ['clients/acme/tasks.md'], '../other.md')).toBe(false)
    expect(canWriteRequestedPath('clients/acme', [], 'tasks.md')).toBe(false)

    expect(VIEW_ACTION_EVENT).toBe('dohc:view-action')
    expect(VIEW_START_TIMEOUT_MS).toBeGreaterThanOrEqual(1000)
    expect(viewActionDetail('.views/home', 'dohc.patch.propose', 'tasks.md')).toMatchObject({
      packageRoot: '.views/home',
      operation: 'dohc.patch.propose',
      target: 'tasks.md',
    })
    expect(summarizeViewActionInput(undefined)).toBe('No input')
    expect(summarizeViewActionInput({ source: 'button' })).toBe('{"source":"button"}')
    expect(summarizeViewActionInput({ value: 'x'.repeat(220) })).toHaveLength(180)
    expect(VIEW_ACTION_DIALOG_FOCUS_SELECTOR).toContain('button:not([disabled])')
    expect(VIEW_ACTION_DIALOG_FOCUS_SELECTOR).toContain('[tabindex]')
  })

  it('keeps the view action confirmation overlay modal for keyboard users', () => {
    const source = readFileSync(
      new URL('../views/ViewRuntimeHost.tsx', import.meta.url),
      'utf8',
    )

    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain('onKeyDown={onPendingActionKeyDown}')
    expect(source).toContain('confirmActionButtonRef.current?.focus()')
    expect(source).toContain('previous.focus()')
  })

  it('omits personal workspace args instead of sending explicit undefined', () => {
    expect(viewWorkspaceArgs(undefined)).toEqual({})
    expect(viewWorkspaceArgs('ws_active')).toEqual({ activeWorkspaceId: 'ws_active' })
  })

  it('keeps the bundle output budget explicit for the runtime frame', () => {
    expect(MAX_VIEW_BUNDLE_BYTES).toBeGreaterThan(MAX_VIEW_SOURCE_BYTES)
  })
})
