import { SignJWT, jwtVerify } from 'jose'

export const COLLAB_TOKEN_TTL_SECONDS = 5 * 60

export type CollabActorKind = 'user' | 'agent'

export type CollabTokenInput = {
  sub: string
  ws: string
  actorKind: CollabActorKind
  authzVersion: number
}

export type VerifiedCollabToken = CollabTokenInput & {
  iat: number
  exp: number
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

export async function mintCollabToken(
  payload: CollabTokenInput,
  secret: string,
  now = new Date(),
): Promise<string> {
  const issuedAt = seconds(now)

  return new SignJWT({
    sub: payload.sub,
    ws: payload.ws,
    actorKind: payload.actorKind,
    authzVersion: payload.authzVersion,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + COLLAB_TOKEN_TTL_SECONDS)
    .sign(secretKey(secret))
}

export async function verifyCollabToken(
  token: string,
  secret: string,
  now = new Date(),
): Promise<VerifiedCollabToken> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    currentDate: now,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes('"exp"')) {
      throw new Error('Collab token expired')
    }
    throw error
  })

  if (
    typeof payload.sub !== 'string' ||
    typeof payload.ws !== 'string' ||
    (payload.actorKind !== 'user' && payload.actorKind !== 'agent') ||
    typeof payload.authzVersion !== 'number' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    throw new Error('Invalid collab token payload')
  }

  return {
    sub: payload.sub,
    ws: payload.ws,
    actorKind: payload.actorKind,
    authzVersion: payload.authzVersion,
    iat: payload.iat,
    exp: payload.exp,
  }
}
