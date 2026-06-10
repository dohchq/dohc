import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react'
import { useConvex } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { resolveScopeRelativePath } from '../lib/appPaths'
import {
  makeAppRpcError,
  makeAppRpcSuccess,
  parseAppRpcRequest,
  type AppRpcOp,
  type AppRpcRequest,
  type AppRpcResponse,
} from './sdkProtocol'

export const APP_START_TIMEOUT_MS = 2500
export const APP_ACTION_EVENT = 'dohc:app-action'
export const APP_AGENT_CONFIRMATION_REQUIRED = 'app-agent-confirmation-required'
const APP_ACTION_DIALOG_FOCUS_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function appActionDetail(
  packageRoot: string,
  operation: AppRpcOp,
  target?: string,
) {
  return {
    packageRoot,
    operation,
    target: target ?? null,
    timestamp: Date.now(),
  }
}

export function appWorkspaceArgs(
  activeWorkspaceId: string | undefined,
): { activeWorkspaceId?: string } {
  return activeWorkspaceId === undefined ? {} : { activeWorkspaceId }
}

export type AppAgentRunRequest = {
  prompt: string
  sources?: string[]
  originatingApp: string
  titleHint: string
}

type AppActionRequest = Extract<AppRpcRequest, { op: 'dohc.actions.run' }>
type AppAgentRequest = Extract<AppRpcRequest, { op: 'dohc.agent.run' | 'dohc.patch.propose' }>

type AppAgentAuthorization =
  | {
      ok: true
      operation: 'dohc.agent.run' | 'dohc.patch.propose'
      prompt: string
      sources: string[]
      requiresConfirmation: true
    }
  | {
      ok: false
      code: string
      message: string
    }

type PendingAppAction = {
  request: AppActionRequest
  resolve: (response: AppRpcResponse) => void
}

type PendingAppAgent = {
  request: AppAgentRequest
  handoff: Extract<AppAgentAuthorization, { ok: true }>
  resolve: (response: AppRpcResponse) => void
}

type PendingAppActionState = {
  id: string
  name: string
  inputSummary: string
  status: 'confirming' | 'running'
}

export function summarizeAppActionInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) return 'No input'
  try {
    const summary = JSON.stringify(input)
    return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary
  } catch {
    return 'Input unavailable'
  }
}

export function appAgentConfirmationText({
  packageRoot,
  handoff,
}: {
  packageRoot: string
  handoff: Extract<AppAgentAuthorization, { ok: true }>
}): string {
  const prompt = handoff.prompt.trim() || APP_AGENT_CONFIRMATION_REQUIRED
  return [
    `App: ${packageRoot}`,
    `Operation: ${handoff.operation}`,
    handoff.sources.length > 0
      ? ['Sources:', ...handoff.sources.map((source) => `- ${source}`)].join('\n')
      : 'Sources: none',
    '',
    'Prompt submitted after confirmation:',
    prompt,
  ].join('\n')
}

export function nextAppActionDialogFocusIndex({
  activeIndex,
  itemCount,
  shiftKey,
}: {
  activeIndex: number
  itemCount: number
  shiftKey: boolean
}): number | null {
  if (itemCount <= 0) return null
  if (shiftKey) return activeIndex <= 0 ? itemCount - 1 : null
  return activeIndex < 0 || activeIndex >= itemCount - 1 ? 0 : null
}

function focusableDialogElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(APP_ACTION_DIALOG_FOCUS_SELECTOR),
  ).filter((element) => !element.hasAttribute('disabled'))
}

export function AppActionConfirmationDialog({
  title,
  pendingAction,
  titleId,
  descriptionId,
  confirmButtonRef,
  onCancel,
  onConfirm,
  onKeyDown,
}: {
  title: string
  pendingAction: PendingAppActionState
  titleId: string
  descriptionId: string
  confirmButtonRef?: Ref<HTMLButtonElement>
  onCancel: () => void
  onConfirm: () => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      data-app-action-scrim="true"
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-10 flex items-start justify-center bg-paper/70 px-4 pt-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-lg rounded-lg border border-rule bg-surface px-3 py-3 text-[12px] text-ink-dim shadow-sm"
      >
        <p id={titleId} className="font-medium text-ink-strong">
          Run app action?
        </p>
        <p id={descriptionId} className="mt-1">
          {title} wants to run <span className="font-medium text-ink-strong">{pendingAction.name}</span>.
        </p>
        <p
          tabIndex={0}
          className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-rule bg-paper px-2 py-1 font-mono text-[11px]"
        >
          {pendingAction.inputSummary}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pendingAction.status === 'running'}
            className="rounded border border-rule px-2 py-1 text-ink-strong disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            disabled={pendingAction.status === 'running'}
            className="rounded bg-ink-strong px-2 py-1 text-paper disabled:opacity-50"
          >
            {pendingAction.status === 'running' ? 'Running...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AppRuntimeHost({
  packageRoot,
  scopePath,
  writeScopes,
  title,
  srcDoc,
  onOpenSource,
  onRunAgent,
}: {
  packageRoot: string
  scopePath: string
  writeScopes: string[]
  title: string
  srcDoc: string
  onOpenSource: (path: string) => void
  onRunAgent?: (request: AppAgentRunRequest) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const startedRef = useRef(false)
  const convex = useConvex()
  // Undefined intentionally means the caller's personal workspace; Convex
  // requireWorkspace(ctx, undefined) derives that server-side from auth.
  const activeWorkspaceId = useActiveWorkspaceId()
  const workspaceArgs = useMemo(
    () => appWorkspaceArgs(activeWorkspaceId),
    [activeWorkspaceId],
  )
  const [timedOut, setTimedOut] = useState(false)
  const pendingActionRef = useRef<PendingAppAction | null>(null)
  const pendingAgentRef = useRef<PendingAppAgent | null>(null)
  const confirmActionButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAppActionState | null>(null)
  const [pendingAgent, setPendingAgent] = useState<PendingAppActionState | null>(null)
  const actionDialogTitleId = useId()
  const actionDialogDescriptionId = useId()

  useEffect(() => {
    startedRef.current = false
    setTimedOut(false)
    setPendingAction(null)
    setPendingAgent(null)
    const timeout = window.setTimeout(() => {
      if (!startedRef.current) setTimedOut(true)
    }, APP_START_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [srcDoc])

  useEffect(() => {
    return () => {
      const pending = pendingActionRef.current
      if (pending) {
        pendingActionRef.current = null
        pending.resolve(
          makeAppRpcError(
            pending.request.id,
            'app-reloaded',
            'The app was reloaded before the action was confirmed.',
          ),
        )
      }
      const pendingAgent = pendingAgentRef.current
      if (!pendingAgent) return
      pendingAgentRef.current = null
      pendingAgent.resolve(
        makeAppRpcError(
          pendingAgent.request.id,
          'app-reloaded',
          'The app was reloaded before the agent request was confirmed.',
        ),
      )
    }
  }, [srcDoc])

  useEffect(() => {
    if (!pendingAction && !pendingAgent) return

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const timeout = window.setTimeout(() => {
      confirmActionButtonRef.current?.focus()
    }, 0)

    return () => {
      window.clearTimeout(timeout)
      const previous = previousFocusRef.current
      previousFocusRef.current = null
      if (previous && document.contains(previous)) {
        previous.focus()
      }
    }
  }, [pendingAction?.id, pendingAgent?.id])

  const recordAction = useCallback(
    (operation: AppRpcOp, target?: string) => {
      window.dispatchEvent(
        new CustomEvent(APP_ACTION_EVENT, {
          detail: appActionDetail(packageRoot, operation, target),
        }),
      )
    },
    [packageRoot],
  )

  const authorizeAgentRequest = useCallback(
    async (request: AppAgentRequest): Promise<AppAgentAuthorization> => {
      if (request.op === 'dohc.agent.run') {
        return await convex.query(api.appAgent.authorizeRun, {
          packageRoot,
          prompt: request.args.prompt,
          ...(request.args.sources === undefined ? {} : { sources: request.args.sources }),
          ...workspaceArgs,
        }) as AppAgentAuthorization
      }
      return await convex.query(api.appAgent.authorizePatch, {
        packageRoot,
        path: request.args.path,
        summary: request.args.summary,
        patch: request.args.patch,
        ...workspaceArgs,
      }) as AppAgentAuthorization
    },
    [convex, packageRoot, workspaceArgs],
  )

  const requestActionConfirmation = useCallback(
    (request: AppActionRequest): Promise<AppRpcResponse> => {
      if (pendingActionRef.current || pendingAgentRef.current) {
        return Promise.resolve(
          makeAppRpcError(
            request.id,
            'action-pending',
            'Another app request is waiting for confirmation.',
          ),
        )
      }
      return new Promise((resolve) => {
        pendingActionRef.current = { request, resolve }
        setPendingAction({
          id: request.id,
          name: request.args.name,
          inputSummary: summarizeAppActionInput(request.args.input),
          status: 'confirming',
        })
      })
    },
    [],
  )

  const requestAgentConfirmation = useCallback(
    (
      request: AppAgentRequest,
      handoff: Extract<AppAgentAuthorization, { ok: true }>,
    ): Promise<AppRpcResponse> => {
      if (pendingActionRef.current || pendingAgentRef.current) {
        return Promise.resolve(
          makeAppRpcError(
            request.id,
            'action-pending',
            'Another app request is waiting for confirmation.',
          ),
        )
      }
      return new Promise((resolve) => {
        pendingAgentRef.current = { request, handoff, resolve }
        setPendingAgent({
          id: request.id,
          name: request.op === 'dohc.agent.run' ? 'Ask agent' : 'Propose patch',
          inputSummary: appAgentConfirmationText({ packageRoot, handoff }),
          status: 'confirming',
        })
      })
    },
    [packageRoot],
  )

  const cancelPendingAction = useCallback(() => {
    const pending = pendingActionRef.current
    if (!pending) return
    pendingActionRef.current = null
    setPendingAction(null)
    pending.resolve(
      makeAppRpcError(
        pending.request.id,
        'cancelled',
        'The app action was cancelled.',
      ),
    )
  }, [])

  const cancelPendingAgent = useCallback(() => {
    const pending = pendingAgentRef.current
    if (!pending) return
    pendingAgentRef.current = null
    setPendingAgent(null)
    pending.resolve(
      makeAppRpcError(
        pending.request.id,
        'cancelled',
        'The app agent request was cancelled.',
      ),
    )
  }, [])

  const confirmPendingAction = useCallback(async () => {
    const pending = pendingActionRef.current
    if (!pending) return
    setPendingAction((current) =>
      current && current.id === pending.request.id
        ? { ...current, status: 'running' }
        : current,
    )
    try {
      recordAction('dohc.actions.run', pending.request.args.name)
      const result = await convex.action(api.appData.runAction, {
        packageRoot,
        name: pending.request.args.name,
        ...(pending.request.args.input === undefined
          ? {}
          : { input: pending.request.args.input }),
        clientMutationId: pending.request.id,
        ...workspaceArgs,
      })
      pending.resolve(makeAppRpcSuccess(pending.request.id, result))
    } catch {
      pending.resolve(
        makeAppRpcError(
          pending.request.id,
          'internal-error',
          'The app action could not be completed.',
        ),
      )
    } finally {
      if (pendingActionRef.current?.request.id === pending.request.id) {
        pendingActionRef.current = null
      }
      setPendingAction(null)
    }
  }, [convex, packageRoot, recordAction, workspaceArgs])

  const confirmPendingAgent = useCallback(async () => {
    const pending = pendingAgentRef.current
    if (!pending) return
    setPendingAgent((current) =>
      current && current.id === pending.request.id
        ? { ...current, status: 'running' }
        : current,
    )
    try {
      const fresh = await authorizeAgentRequest(pending.request)
      if (!fresh.ok) {
        pending.resolve(makeAppRpcError(pending.request.id, fresh.code, fresh.message))
        return
      }
      if (!onRunAgent) {
        pending.resolve(
          makeAppRpcError(
            pending.request.id,
            'app-agent-not-available',
            'The agent is not available in this host.',
          ),
        )
        return
      }
      recordAction(fresh.operation, fresh.sources[0])
      onRunAgent({
        prompt: fresh.prompt,
        sources: fresh.sources,
        originatingApp: packageRoot,
        titleHint: title,
      })
      pending.resolve(makeAppRpcSuccess(pending.request.id, { ok: true }))
    } catch {
      pending.resolve(
        makeAppRpcError(
          pending.request.id,
          'internal-error',
          'The app agent request could not be completed.',
        ),
      )
    } finally {
      if (pendingAgentRef.current?.request.id === pending.request.id) {
        pendingAgentRef.current = null
      }
      setPendingAgent(null)
    }
  }, [authorizeAgentRequest, onRunAgent, packageRoot, recordAction, title])

  const onPendingActionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const status = pendingAction?.status ?? pendingAgent?.status
      if (event.key === 'Escape' && status !== 'running') {
        event.preventDefault()
        event.stopPropagation()
        if (pendingAction) cancelPendingAction()
        else cancelPendingAgent()
        return
      }
      if (event.key !== 'Tab') return

      const elements = focusableDialogElements(event.currentTarget)
      if (elements.length === 0) {
        event.preventDefault()
        return
      }

      const first = elements[0]!
      const active = document.activeElement
      const activeIndex = active instanceof HTMLElement ? elements.indexOf(active) : -1
      const targetIndex = nextAppActionDialogFocusIndex({
        activeIndex,
        itemCount: elements.length,
        shiftKey: event.shiftKey,
      })
      if (targetIndex !== null) {
        event.preventDefault()
        const target = elements[targetIndex] ?? first
        target.focus()
      }
    },
    [cancelPendingAction, cancelPendingAgent, pendingAction, pendingAgent?.status],
  )

  const runRequest = useCallback(
    async (request: AppRpcRequest): Promise<AppRpcResponse> => {
      try {
        const requestId = request.id
        switch (request.op) {
          case 'dohc.collection.list':
            if (request.args.database) {
              return makeAppRpcSuccess(
                request.id,
                await convex.query(api.databaseFiles.appCollectionRows, {
                  packageRoot,
                  databasePath: request.args.database,
                  collection: request.args.name,
                  ...(request.args.query === undefined ? {} : { query: request.args.query }),
                  ...workspaceArgs,
                }),
              )
            }
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.collectionData.list, {
                packageRoot,
                collection: request.args.name,
                ...(request.args.query === undefined ? {} : { query: request.args.query }),
                ...workspaceArgs,
              }),
            )
          case 'dohc.collection.get':
            if (request.args.database) {
              return makeAppRpcSuccess(
                request.id,
                await convex.query(api.databaseFiles.appCollectionRow, {
                  packageRoot,
                  databasePath: request.args.database,
                  collection: request.args.name,
                  id: request.args.id,
                  ...workspaceArgs,
                }),
              )
            }
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.collectionData.get, {
                packageRoot,
                collection: request.args.name,
                id: request.args.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.collection.insert':
            if (request.args.database) {
              recordAction(request.op, request.args.name)
              return makeAppRpcSuccess(
                request.id,
                await convex.mutation(api.databaseOps.appApply, {
                  packageRoot,
                  databasePath: request.args.database,
                  operationId: request.id,
                  op: 'insert',
                  collection: request.args.name,
                  table: request.args.name,
                  payload: request.args.record,
                  ...(request.args.expectedVersion === undefined ? {} : { expectedVersion: request.args.expectedVersion }),
                  ...workspaceArgs,
                }),
              )
            }
            recordAction(request.op, request.args.name)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runCollectionMutation, {
                packageRoot,
                collection: request.args.name,
                op: 'insert',
                record: request.args.record,
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.collection.update':
            if (request.args.database) {
              recordAction(request.op, request.args.name)
              return makeAppRpcSuccess(
                request.id,
                await convex.mutation(api.databaseOps.appApply, {
                  packageRoot,
                  databasePath: request.args.database,
                  operationId: request.id,
                  op: 'update',
                  collection: request.args.name,
                  table: request.args.name,
                  rowId: request.args.id,
                  payload: request.args.patch,
                  ...(request.args.expectedVersion === undefined ? {} : { expectedVersion: request.args.expectedVersion }),
                  ...workspaceArgs,
                }),
              )
            }
            recordAction(request.op, request.args.name)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runCollectionMutation, {
                packageRoot,
                collection: request.args.name,
                op: 'update',
                id: request.args.id,
                patch: request.args.patch,
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.collection.upsert':
            if (request.args.database) {
              recordAction(request.op, request.args.name)
              return makeAppRpcSuccess(
                request.id,
                await convex.mutation(api.databaseOps.appApply, {
                  packageRoot,
                  databasePath: request.args.database,
                  operationId: request.id,
                  op: 'upsert',
                  collection: request.args.name,
                  table: request.args.name,
                  rowId: request.args.id,
                  payload: request.args.record,
                  ...(request.args.expectedVersion === undefined ? {} : { expectedVersion: request.args.expectedVersion }),
                  ...workspaceArgs,
                }),
              )
            }
            recordAction(request.op, request.args.name)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runCollectionMutation, {
                packageRoot,
                collection: request.args.name,
                op: 'upsert',
                id: request.args.id,
                record: request.args.record,
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.collection.delete':
            if (request.args.database) {
              recordAction(request.op, request.args.name)
              return makeAppRpcSuccess(
                request.id,
                await convex.mutation(api.databaseOps.appApply, {
                  packageRoot,
                  databasePath: request.args.database,
                  operationId: request.id,
                  op: 'delete',
                  collection: request.args.name,
                  table: request.args.name,
                  rowId: request.args.id,
                  payload: {},
                  ...(request.args.expectedVersion === undefined ? {} : { expectedVersion: request.args.expectedVersion }),
                  ...workspaceArgs,
                }),
              )
            }
            recordAction(request.op, request.args.name)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runCollectionMutation, {
                packageRoot,
                collection: request.args.name,
                op: 'delete',
                id: request.args.id,
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.doc.get':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.appData.getAtom, {
                packageRoot,
                path: request.args.path,
                ...workspaceArgs,
              }),
            )
          case 'dohc.doc.set':
            recordAction(request.op, request.args.path)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runDocMutation, {
                packageRoot,
                op: 'set',
                path: request.args.path,
                key: request.args.key,
                value: request.args.value,
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.doc.append':
            recordAction(request.op, request.args.path)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runDocMutation, {
                packageRoot,
                op: 'append',
                path: request.args.path,
                markdown: request.args.markdown,
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.doc.replaceText':
            recordAction(request.op, request.args.path)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runDocMutation, {
                packageRoot,
                op: 'replaceText',
                path: request.args.path,
                find: request.args.find,
                with: request.args.with,
                ...(request.args.occurrence === undefined ? {} : { occurrence: request.args.occurrence }),
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.doc.section.append':
            recordAction(request.op, request.args.path)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runDocMutation, {
                packageRoot,
                op: 'section.append',
                path: request.args.path,
                heading: request.args.heading,
                markdown: request.args.markdown,
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.doc.section.replace':
            recordAction(request.op, request.args.path)
            return makeAppRpcSuccess(
              request.id,
              await convex.action(api.appData.runDocMutation, {
                packageRoot,
                op: 'section.replace',
                path: request.args.path,
                heading: request.args.heading,
                markdown: request.args.markdown,
                clientMutationId: request.id,
                ...workspaceArgs,
              }),
            )
          case 'dohc.sources.list':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.appData.listSources, {
                packageRoot,
                ...request.args,
                ...workspaceArgs,
              }),
            )
          case 'dohc.atom.get':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.appData.getAtom, {
                packageRoot,
                ...request.args,
                ...workspaceArgs,
              }),
            )
          case 'dohc.fields.query':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.appData.queryFields, {
                packageRoot,
                ...request.args,
                ...workspaceArgs,
              }),
            )
          case 'dohc.database.tables':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.databaseFiles.appTables, {
                packageRoot,
                path: request.args.path,
                ...workspaceArgs,
              }),
            )
          case 'dohc.database.query':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.databaseFiles.appQuery, {
                packageRoot,
                path: request.args.path,
                sql: request.args.sql,
                ...(request.args.params === undefined ? {} : { params: request.args.params }),
                ...workspaceArgs,
              }),
            )
          case 'dohc.database.table.list':
            return await runRequest({
              id: request.id,
              op: 'dohc.collection.list',
              args: {
                name: request.args.table,
                database: request.args.path,
                ...(request.args.query === undefined ? {} : { query: request.args.query }),
              },
            })
          case 'dohc.database.table.get':
            return await runRequest({
              id: request.id,
              op: 'dohc.collection.get',
              args: {
                name: request.args.table,
                id: request.args.id,
                database: request.args.path,
              },
            })
          case 'dohc.database.table.insert':
            return await runRequest({
              id: request.id,
              op: 'dohc.collection.insert',
              args: {
                name: request.args.table,
                record: request.args.record,
                database: request.args.path,
                ...(request.args.expectedVersion === undefined ? {} : { expectedVersion: request.args.expectedVersion }),
              },
            })
          case 'dohc.database.table.update':
            return await runRequest({
              id: request.id,
              op: 'dohc.collection.update',
              args: {
                name: request.args.table,
                id: request.args.id,
                patch: request.args.patch,
                database: request.args.path,
                ...(request.args.expectedVersion === undefined ? {} : { expectedVersion: request.args.expectedVersion }),
              },
            })
          case 'dohc.database.table.upsert':
            return await runRequest({
              id: request.id,
              op: 'dohc.collection.upsert',
              args: {
                name: request.args.table,
                id: request.args.id,
                record: request.args.record,
                database: request.args.path,
                ...(request.args.expectedVersion === undefined ? {} : { expectedVersion: request.args.expectedVersion }),
              },
            })
          case 'dohc.database.table.delete':
            return await runRequest({
              id: request.id,
              op: 'dohc.collection.delete',
              args: {
                name: request.args.table,
                id: request.args.id,
                database: request.args.path,
                ...(request.args.expectedVersion === undefined ? {} : { expectedVersion: request.args.expectedVersion }),
              },
            })
          case 'dohc.asset.resolve':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.assets.resolveAppAsset, {
                packageRoot,
                assetId: request.args.assetId as never,
                ...workspaceArgs,
              }),
            )
          case 'dohc.presence.list':
            return makeAppRpcSuccess(request.id, { ok: true, users: [] })
          case 'dohc.imports.list':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.appData.listImports, {
                packageRoot,
                ...workspaceArgs,
              }),
            )
          case 'dohc.exports.list':
            return makeAppRpcSuccess(
              request.id,
              await convex.query(api.appData.listExports, {
                packageRoot,
                ...workspaceArgs,
              }),
            )
          case 'dohc.source.open': {
            const result = await convex.query(api.appData.getAtom, {
              packageRoot,
              path: request.args.path,
              ...workspaceArgs,
            })
            if (result.ok) onOpenSource(result.atom.path)
            return makeAppRpcSuccess(request.id, result)
          }
          case 'dohc.agent.run':
            {
              const authorization = await authorizeAgentRequest(request)
              if (!authorization.ok) {
                return makeAppRpcError(request.id, authorization.code, authorization.message)
              }
              return await requestAgentConfirmation(request, authorization)
            }
          case 'dohc.actions.run':
            return await requestActionConfirmation(request)
          case 'dohc.patch.propose': {
            const authorization = await authorizeAgentRequest(request)
            if (!authorization.ok) {
              return makeAppRpcError(request.id, authorization.code, authorization.message)
            }
            return await requestAgentConfirmation(request, authorization)
          }
          default:
            return makeAppRpcError(
              requestId,
              'unsupported-operation',
              'This app operation is not supported.',
            )
        }
      } catch {
        return makeAppRpcError(
          request.id,
          'internal-error',
          'The app request could not be completed.',
        )
      }
    },
    [
      convex,
      onOpenSource,
      packageRoot,
      recordAction,
      authorizeAgentRequest,
      requestAgentConfirmation,
      requestActionConfirmation,
      workspaceArgs,
    ],
  )

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (
        event.data &&
        typeof event.data === 'object' &&
        (event.data as { type?: unknown }).type === 'dohc.ready'
      ) {
        startedRef.current = true
        setTimedOut(false)
        return
      }
      const request = parseAppRpcRequest(event.data)
      if (!request) return
      void runRequest(request).then((response) => {
        iframeRef.current?.contentWindow?.postMessage(response, '*')
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [runRequest])

  return (
    <div className="relative min-h-0 flex-1">
      <iframe
        ref={iframeRef}
        title={`${title} app`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="absolute inset-0 size-full border-0 bg-surface"
      />
      {timedOut && (
        <div className="absolute inset-x-4 top-4 rounded-lg border border-rule bg-surface px-3 py-2 text-[12px] text-ink-dim shadow-sm">
          <p className="font-medium text-ink-strong">This app did not start.</p>
          <p className="mt-0.5">
            Open source or ask dohc to repair it.
          </p>
        </div>
      )}
      {pendingAction && (
        <AppActionConfirmationDialog
          title={title}
          pendingAction={pendingAction}
          titleId={actionDialogTitleId}
          descriptionId={actionDialogDescriptionId}
          confirmButtonRef={confirmActionButtonRef}
          onCancel={cancelPendingAction}
          onConfirm={() => {
            void confirmPendingAction()
          }}
          onKeyDown={onPendingActionKeyDown}
        />
      )}
      {pendingAgent && (
        <AppActionConfirmationDialog
          title={title}
          pendingAction={pendingAgent}
          titleId={actionDialogTitleId}
          descriptionId={actionDialogDescriptionId}
          confirmButtonRef={confirmActionButtonRef}
          onCancel={cancelPendingAgent}
          onConfirm={() => {
            void confirmPendingAgent()
          }}
          onKeyDown={onPendingActionKeyDown}
        />
      )}
    </div>
  )
}

export function canWriteRequestedPath(
  scopePath: string,
  writeScopes: string[],
  requestedPath: string,
): boolean {
  if (writeScopes.length === 0) return false
  const resolved = resolveScopeRelativePath(scopePath, requestedPath)
  if (resolved === null) return false
  return writeScopes.some((scope) => pathInAppScope(resolved, scope))
}

function appScopeHasGlob(value: string): boolean {
  return /[?*\[]/.test(value)
}

function appGlobMatchesPath(glob: string, path: string): boolean {
  if (!appScopeHasGlob(glob)) return path === glob
  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`${source}$`).test(path)
}

function pathInAppScope(path: string, scope: string): boolean {
  if (scope === '') return true
  if (appScopeHasGlob(scope)) return appGlobMatchesPath(scope, path)
  return path === scope || path.startsWith(`${scope}/`)
}
