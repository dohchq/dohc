import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'
import type {
  AtomAccessInput,
  HocuspocusAcl,
  WorkspaceAuthzVersionInput,
} from './hooks.js'
import type { CollabActorKind } from './auth.js'

type ConvexAclArgs = {
  serverToken: string
  workspaceId: string
  userId: string
  atomId: string
  actorKind: CollabActorKind
  authzVersion: number
}

type ConvexAclResult = {
  workspaceAuthzVersion: number
  canRead: boolean
  canWrite: boolean
}

type ConvexAclClient = {
  query(
    query: FunctionReference<'query', 'public', ConvexAclArgs, ConvexAclResult>,
    args: ConvexAclArgs,
  ): Promise<ConvexAclResult>
}

const checkAtomAccess = makeFunctionReference<
  'query',
  ConvexAclArgs,
  ConvexAclResult
>('hocuspocusAuth:checkAtomAccess')

export function createConvexAcl(options: {
  convexUrl: string
  serverToken: string
  client?: ConvexAclClient
}): HocuspocusAcl {
  const client =
    options.client ??
    new ConvexHttpClient(options.convexUrl, {
      logger: false,
      skipConvexDeploymentUrlCheck: true,
    })

  async function check(
    input: WorkspaceAuthzVersionInput | AtomAccessInput,
  ): Promise<ConvexAclResult> {
    return await client.query(checkAtomAccess, {
      serverToken: options.serverToken,
      workspaceId: input.workspaceId,
      userId: input.userId,
      atomId: input.atomId,
      actorKind: input.actorKind,
      authzVersion: input.authzVersion,
    })
  }

  return {
    async getWorkspaceAuthzVersion(input) {
      return (await check(input)).workspaceAuthzVersion
    },
    async canReadAtom(input) {
      return (await check(input)).canRead
    },
    async canWriteAtom(input) {
      return (await check(input)).canWrite
    },
  }
}
