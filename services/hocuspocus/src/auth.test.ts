import { describe, expect, it } from 'vitest'
import {
  COLLAB_TOKEN_TTL_SECONDS,
  mintCollabToken,
  verifyCollabToken,
} from './auth.js'

const secret = 'test-secret-with-enough-entropy-for-hs256'
const issuedAt = new Date('2026-05-25T12:00:00.000Z')

describe('collab token auth', () => {
  it('mints a 5-minute token with the v2 collab claims', async () => {
    const token = await mintCollabToken(
      {
        sub: 'user_123',
        ws: 'workspace_abc',
        actorKind: 'user',
        authzVersion: 7,
      },
      secret,
      issuedAt,
    )

    const payload = await verifyCollabToken(token, secret, issuedAt)

    expect(payload).toMatchObject({
      sub: 'user_123',
      ws: 'workspace_abc',
      actorKind: 'user',
      authzVersion: 7,
    })
    expect(payload.exp - payload.iat).toBe(COLLAB_TOKEN_TTL_SECONDS)
  })

  it('rejects tokens signed with a different secret', async () => {
    const token = await mintCollabToken(
      {
        sub: 'agent_1',
        ws: 'workspace_abc',
        actorKind: 'agent',
        authzVersion: 1,
      },
      secret,
      issuedAt,
    )

    await expect(verifyCollabToken(token, 'wrong-secret', issuedAt)).rejects.toThrow()
  })

  it('rejects expired tokens', async () => {
    const token = await mintCollabToken(
      {
        sub: 'user_123',
        ws: 'workspace_abc',
        actorKind: 'user',
        authzVersion: 7,
      },
      secret,
      issuedAt,
    )

    await expect(
      verifyCollabToken(token, secret, new Date('2026-05-25T12:05:01.000Z')),
    ).rejects.toThrow(/expired/i)
  })
})
