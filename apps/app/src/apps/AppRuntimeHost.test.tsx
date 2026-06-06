import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'AppRuntimeHost.tsx'), 'utf8')

describe('AppRuntimeHost full SDK dispatch', () => {
  it('routes document SDK calls through appData document APIs', () => {
    expect(source).toContain("case 'dohc.doc.get'")
    expect(source).toContain('api.appData.getAtom')
    expect(source).toContain("case 'dohc.doc.set'")
    expect(source).toContain("case 'dohc.doc.append'")
    expect(source).toContain("case 'dohc.doc.replaceText'")
    expect(source).toContain("case 'dohc.doc.section.append'")
    expect(source).toContain("case 'dohc.doc.section.replace'")
    expect(source).toContain('api.appData.runDocMutation')
  })

  it('routes asset resolution through the workspace asset resolver', () => {
    expect(source).toContain("case 'dohc.asset.resolve'")
    expect(source).toContain('api.assets.resolveAsset')
  })

  it('forwards structured app context to agent handoffs', () => {
    expect(source).toContain('originatingApp: packageRoot')
    expect(source).toContain('titleHint: title')
    expect(source).toContain('sources: request.args.sources')
  })
})
