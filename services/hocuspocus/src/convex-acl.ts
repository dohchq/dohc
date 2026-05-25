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

type ConvexBootstrapArgs = {
  serverToken: string
  workspaceId: string
  atomId: string
}

type ConvexBootstrapResult = {
  markdown: string
} | null

type ConvexAclClient = {
  query(
    query:
      | FunctionReference<'query', 'public', ConvexAclArgs, ConvexAclResult>
      | FunctionReference<
          'query',
          'public',
          ConvexBootstrapArgs,
          ConvexBootstrapResult
        >,
    args: ConvexAclArgs | ConvexBootstrapArgs,
  ): Promise<ConvexAclResult | ConvexBootstrapResult>
}

const checkAtomAccess = makeFunctionReference<
  'query',
  ConvexAclArgs,
  ConvexAclResult
>('hocuspocusAuth:checkAtomAccess')

const loadAtomBootstrap = makeFunctionReference<
  'query',
  ConvexBootstrapArgs,
  ConvexBootstrapResult
>('hocuspocusAuth:loadAtomBootstrap')

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
    return (await client.query(checkAtomAccess, {
      serverToken: options.serverToken,
      workspaceId: input.workspaceId,
      userId: input.userId,
      atomId: input.atomId,
      actorKind: input.actorKind,
      authzVersion: input.authzVersion,
    })) as ConvexAclResult
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
    async loadAtomBootstrap(input) {
      return (await client.query(loadAtomBootstrap, {
        serverToken: options.serverToken,
        workspaceId: input.workspaceId,
        atomId: input.atomId,
      })) as ConvexBootstrapResult
    },
  }
}
