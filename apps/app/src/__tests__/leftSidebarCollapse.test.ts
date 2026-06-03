import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (path: string) =>
  readFileSync(resolve(__dirname, '../../src', path), 'utf8')

const APP = read('routes/_app.tsx')
const ACTIVITY = read('components/ActivityBar.tsx')

describe('left sidebar collapse shell behavior', () => {
  it('persists collapse state, exposes an activity-rail toggle, and auto-collapses selected views', () => {
    expect(ACTIVITY).toContain('PanelLeftClose')
    expect(ACTIVITY).toContain('PanelLeftOpen')
    expect(ACTIVITY).toContain('sidebarCollapsed')
    expect(ACTIVITY).toContain('onToggleSidebar')
    expect(ACTIVITY).toContain('aria-label={sidebarCollapsed ?')

    expect(APP).toContain('LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY')
    expect(APP).toContain('dohc-left-sidebar-collapsed')
    expect(APP).toContain('leftSidebarCollapsed')
    expect(APP).toContain('setLeftSidebarCollapsed')
    expect(APP).toContain('sidebarCollapsed={leftSidebarCollapsed}')
    expect(APP).toContain('onToggleSidebar={toggleLeftSidebar}')
    expect(APP).toContain('const leftColumn = leftSidebarCollapsed ? null')
    expect(APP).toContain('setLeftSidebarCollapsed(true)')
    expect(APP).toContain('!leftSidebarCollapsed && (')
  })
})
