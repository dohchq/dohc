import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const REPO = join(ROOT, '..', '..')

function app(path: string): string {
  return join(ROOT, path)
}

function repo(path: string): string {
  return join(REPO, path)
}

describe('plugin system removal', () => {
  it('does not ship plugin runtime, catalog, bridge, or SDK package', () => {
    const removedPaths = [
      app('src/components/PluginPanel.tsx'),
      app('src/plugins'),
      app('convex/catalog.ts'),
      app('convex/plugins.ts'),
      app('convex/pluginBridge.ts'),
      repo('packages/plugin-sdk'),
      repo('docs/development/plugin-sdk.md'),
    ]

    expect(
      removedPaths.filter((path) => existsSync(path)),
      'plugin-system paths should stay removed',
    ).toEqual([])
  })

  it('does not expose plugin navigation, commands, or package dependencies', () => {
    const appPackage = JSON.parse(readFileSync(app('package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(appPackage.dependencies).not.toHaveProperty('@dohc/plugin-sdk')

    const activityBar = readFileSync(app('src/components/ActivityBar.tsx'), 'utf8')
    expect(activityBar).not.toContain('Plugins')
    expect(activityBar).not.toContain('Puzzle')

    const appRoute = readFileSync(app('src/routes/_app.tsx'), 'utf8')
    expect(appRoute).not.toContain('PluginPanel')
    expect(appRoute).not.toContain('BUILD_PLUGIN_PROMPT')

    const commandPalette = readFileSync(
      app('src/components/CommandPalette.tsx'),
      'utf8',
    )
    expect(commandPalette).not.toContain('usePlugins')
    expect(commandPalette).not.toContain('open-marketplace')
  })
})
