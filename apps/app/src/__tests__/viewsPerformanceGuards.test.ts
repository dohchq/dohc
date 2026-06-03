import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  buildViewBundle,
  MAX_VIEW_BUNDLE_BYTES,
  MAX_VIEW_SOURCE_BYTES,
  MAX_VIEW_SOURCE_FILES,
} from '../views/buildViewBundle.server'
import {
  canWriteRequestedPath,
  nextViewActionDialogFocusIndex,
  summarizeViewActionInput,
  ViewActionConfirmationDialog,
  viewActionDetail,
  viewWorkspaceArgs,
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
  })

  it('renders the view action confirmation as a modal scrim', () => {
    const html = renderToStaticMarkup(
      createElement(ViewActionConfirmationDialog, {
        title: 'Home',
        pendingAction: {
          id: 'view-action-1',
          name: 'setStatus',
          inputSummary: '{"value":"done"}',
          status: 'confirming',
        },
        titleId: 'action-title',
        descriptionId: 'action-description',
        onCancel: () => {},
        onConfirm: () => {},
        onKeyDown: () => {},
      }),
    )

    expect(html).toContain('data-view-action-scrim="true"')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="action-title"')
    expect(html).toContain('aria-describedby="action-description"')
    expect(html).toContain('setStatus')
    expect(html).toContain('{&quot;value&quot;:&quot;done&quot;}')
  })

  it('wraps focus inside the view action dialog', () => {
    expect(nextViewActionDialogFocusIndex({
      activeIndex: 2,
      itemCount: 3,
      shiftKey: false,
    })).toBe(0)
    expect(nextViewActionDialogFocusIndex({
      activeIndex: 0,
      itemCount: 3,
      shiftKey: true,
    })).toBe(2)
    expect(nextViewActionDialogFocusIndex({
      activeIndex: -1,
      itemCount: 3,
      shiftKey: false,
    })).toBe(0)
    expect(nextViewActionDialogFocusIndex({
      activeIndex: 1,
      itemCount: 3,
      shiftKey: false,
    })).toBeNull()
  })

  it('omits personal workspace args instead of sending explicit undefined', () => {
    expect(viewWorkspaceArgs(undefined)).toEqual({})
    expect(viewWorkspaceArgs('ws_active')).toEqual({ activeWorkspaceId: 'ws_active' })
  })

  it('keeps the bundle output budget explicit for the runtime frame', () => {
    expect(MAX_VIEW_BUNDLE_BYTES).toBeGreaterThan(MAX_VIEW_SOURCE_BYTES)
  })
})
