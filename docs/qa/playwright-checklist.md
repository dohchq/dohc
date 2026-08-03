# Visual QA checklist

Run the desktop E2E suite or a focused Playwright spec:

```bash
pnpm test:desktop:e2e
pnpm --filter @dohc/desktop exec node scripts/run-playwright.mjs \
  --config playwright.config.ts e2e/sites-preview.spec.ts
```

## Viewports

- 390×900
- 768×1024
- 1440×900
- 1728×1117

## Core states

- First run and workspace selection
- No file selected
- Markdown editor and source editor
- Search, graph, history, versions, and conflicts
- Sites list and preview
- Chat, channels, direct messages, and agent runs
- Share creation, received shares, and mounted shares
- Settings, light theme, dark theme, and reduced motion

## Checks

- No clipped logos, controls, or text.
- No horizontal overflow.
- Focus rings remain visible.
- Keyboard navigation reaches every action.
- Body text meets contrast requirements.
- Loading and error states explain the next action.
- A slow response from another workspace never repaints the current workspace.
- Site previews cannot gain workspace authority without the host bridge.
- Secret paths never appear in search, history, export, or share flows.
