/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { jwtVerify } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const WORKSPACE = 'ws_owner'
const GRANTEE = 'ws_grantee'
const JWT_SECRET = 'test-secret-with-enough-entropy-for-hs256'

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Convex collab token minting', () => {
  it('rejects unauthenticated callers', async () => {
    const t = convexTest(schema, modules)
    vi.stubEnv('HOCUSPOCUS_JWT_SECRET', JWT_SECRET)

    await expect(t.action(api.auth.getCollabToken, {})).rejects.toThrow(
      /authenticated/i,
    )
  })

  it('mints a 5-minute user collab token for the authenticated workspace', async () => {
    const t = convexTest(schema, modules)
    vi.stubEnv('HOCUSPOCUS_JWT_SECRET', JWT_SECRET)

    const token = await t
      .withIdentity({ subject: WORKSPACE })
      .action(api.auth.getCollabToken, {})
    const { payload } = await jwtVerify(token, secretKey(JWT_SECRET))

    expect(payload).toMatchObject({
      sub: WORKSPACE,
      ws: WORKSPACE,
      actorKind: 'user',
      authzVersion: 1,
    })
    expect(typeof payload.iat).toBe('number')
    expect(typeof payload.exp).toBe('number')
    expect((payload.exp as number) - (payload.iat as number)).toBe(5 * 60)
  })

  it('can mint a caller-identity token scoped to a shared owner workspace', async () => {
    const t = convexTest(schema, modules)
    vi.stubEnv('HOCUSPOCUS_JWT_SECRET', JWT_SECRET)

    const token = await t
      .withIdentity({ subject: GRANTEE })
      .action(api.auth.getCollabToken, { workspaceId: WORKSPACE })
    const { payload } = await jwtVerify(token, secretKey(JWT_SECRET))

    expect(payload).toMatchObject({
      sub: GRANTEE,
      ws: WORKSPACE,
      actorKind: 'user',
      authzVersion: 1,
    })
  })
})
