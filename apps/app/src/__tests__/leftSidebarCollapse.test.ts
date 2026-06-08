import React, { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { ActivityBar, type ActivityView } from '../components/ActivityBar'

type ButtonElement = ReactElement<{
  'aria-label'?: string
  onClick?: () => void
}>

function findButtonByLabel(
  node: ReactNode,
  label: string,
): ButtonElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButtonByLabel(child, label)
      if (found) return found
    }
    return null
  }
  if (!isValidElement(node)) return null
  const props = node.props as {
    'aria-label'?: string
    children?: ReactNode
  }
  if (node.type === 'button' && props['aria-label'] === label) {
    return node as ButtonElement
  }
  return findButtonByLabel(props.children, label)
}

describe('left sidebar collapse shell behavior', () => {
  it('preserves collapse state while opening another activity view', () => {
    let view: ActivityView = 'atom'
    let sidebarCollapsed = true
    const render = () =>
      ActivityBar({
        view,
        onSelect: (next: ActivityView) => {
          view = next
        },
        sidebarCollapsed,
        onToggleSidebar: () => {
          sidebarCollapsed = !sidebarCollapsed
        },
      })

    const tree = render()
    const appsButton = findButtonByLabel(tree, 'Apps')
    expect(appsButton).not.toBeNull()

    appsButton?.props.onClick?.()

    expect(view).toBe('views')
    expect(sidebarCollapsed).toBe(true)
    expect(findButtonByLabel(render(), 'Show sidebar')).not.toBeNull()
  })
})
