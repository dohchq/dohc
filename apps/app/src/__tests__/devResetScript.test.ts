import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP = resolve(__dirname, '../..')
const REPO = resolve(APP, '../..')

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    scripts?: Record<string, string>
  }
}

describe('development reset script', () => {
  it('is exposed from both the repo root and app package', () => {
    const rootPackage = readJson(resolve(REPO, 'package.json'))
    const appPackage = readJson(resolve(APP, 'package.json'))

    expect(rootPackage.scripts?.['reset:dev']).toBe(
      'node scripts/reset-dev-data.mjs',
    )
    expect(appPackage.scripts?.['reset:dev']).toBe(
      'node ../../scripts/reset-dev-data.mjs',
    )
  })

  it('hard-gates destructive Convex and WorkOS cleanup', () => {
    const source = readFileSync(resolve(REPO, 'scripts/reset-dev-data.mjs'), 'utf8')

    expect(source).toContain('WIPE_DEV_DATA')
    expect(source).toContain('internal.devReset.wipeAllData')
    expect(source).toContain('done === false')
    expect(source).toContain('--force-production-reset')
    expect(source).toContain('CONVEX_DEPLOYMENT')
    expect(source).toContain('NEXT_PUBLIC_CONVEX_URL')
    expect(source).toContain('@workos-inc/node')
    expect(source).toContain('WORKOS_API_KEY')
    expect(source).toContain('WORKOS_CLIENT_ID')
    expect(source).toContain('listUsers')
    expect(source).toContain('deleteUser')
    expect(source).toContain('listOrganizationMemberships')
    expect(source).toContain('deleteOrganizationMembership')
    expect(source).toContain('listOrganizations')
    expect(source).toContain('deleteOrganization')
    expect(source).toContain('--email')
    expect(source).toContain('--email-domain')
    expect(source).toContain('--workos-user-id')
    expect(source).toContain('At least one WorkOS identity selector')
  })
})
