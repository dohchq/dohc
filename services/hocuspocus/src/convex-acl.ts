// Phase 13: delete with Convex
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'
import type {
  AtomBodyCacheProjectionInput,
  AtomBodyCacheProjectionResult,
  AtomAccessInput,
  AtomCreateInput,
  AtomCreateResult,
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
  userId: string
  atomId: string
  actorKind: CollabActorKind
  authzVersion: number
}

type ConvexBootstrapResult = {
  markdown: string
  path?: string
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
  mutation(
    mutation:
      | FunctionReference<
          'mutation',
          'public',
          ConvexBodyCacheProjectionArgs,
          AtomBodyCacheProjectionResult
        >
      | FunctionReference<
          'mutation',
          'public',
          ConvexAtomCreateArgs,
          AtomCreateResult
        >,
    args: ConvexBodyCacheProjectionArgs | ConvexAtomCreateArgs,
  ): Promise<AtomBodyCacheProjectionResult | AtomCreateResult>
}

type ConvexBodyCacheProjectionArgs = AtomBodyCacheProjectionInput & {
  serverToken: string
}

type ConvexAtomCreateArgs = AtomCreateInput & {
  serverToken: string
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

const setBodyCache = makeFunctionReference<
  'mutation',
  ConvexBodyCacheProjectionArgs,
  AtomBodyCacheProjectionResult
>('hocuspocusAuth:setBodyCache')

const createAtom = makeFunctionReference<
  'mutation',
  ConvexAtomCreateArgs,
  AtomCreateResult
>('hocuspocusAuth:createAtom')

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
        userId: input.userId,
        atomId: input.atomId,
        actorKind: input.actorKind,
        authzVersion: input.authzVersion,
      })) as ConvexBootstrapResult
    },
    async setAtomBodyCache(input) {
      return (await client.mutation(setBodyCache, {
        serverToken: options.serverToken,
        workspaceId: input.workspaceId,
        atomId: input.atomId,
        markdown: input.markdown,
        projectionHash: input.projectionHash,
        schemaVersion: input.schemaVersion,
        ydocStateVector: input.ydocStateVector,
        lastEditedByUserId: input.lastEditedByUserId ?? undefined,
        projectedAt: input.projectedAt,
      })) as AtomBodyCacheProjectionResult
    },
    async createAtom(input) {
      return (await client.mutation(createAtom, {
        serverToken: options.serverToken,
        workspaceId: input.workspaceId,
        path: input.path,
        content: input.content,
        userId: input.userId,
        actorKind: input.actorKind,
        authzVersion: input.authzVersion,
      })) as AtomCreateResult
    },
  }
}
