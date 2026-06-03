import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useConvex } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { resolveScopeRelativePath } from '../lib/viewPaths'
import {
  makeViewRpcError,
  makeViewRpcSuccess,
  parseViewRpcRequest,
  type ViewRpcOp,
  type ViewRpcRequest,
  type ViewRpcResponse,
} from './sdkProtocol'

export const VIEW_START_TIMEOUT_MS = 2500
export const VIEW_ACTION_EVENT = 'dohc:view-action'
export const VIEW_ACTION_DIALOG_FOCUS_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function viewActionDetail(
  packageRoot: string,
  operation: ViewRpcOp,
  target?: string,
) {
  return {
    packageRoot,
    operation,
    target: target ?? null,
    timestamp: Date.now(),
  }
}

export function viewWorkspaceArgs(
  activeWorkspaceId: string | undefined,
): { activeWorkspaceId?: string } {
  return activeWorkspaceId === undefined ? {} : { activeWorkspaceId }
}

type ViewActionRequest = Extract<ViewRpcRequest, { op: 'dohc.actions.run' }>

type PendingViewAction = {
  request: ViewActionRequest
  resolve: (response: ViewRpcResponse) => void
}

type PendingViewActionState = {
  id: string
  name: string
  inputSummary: string
  status: 'confirming' | 'running'
}

export function summarizeViewActionInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) return 'No input'
  try {
    const summary = JSON.stringify(input)
    return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary
  } catch {
    return 'Input unavailable'
  }
}

function focusableDialogElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(VIEW_ACTION_DIALOG_FOCUS_SELECTOR),
  ).filter((element) => !element.hasAttribute('disabled'))
}

export function ViewRuntimeHost({
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
  onRunAgent?: (prompt: string) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const startedRef = useRef(false)
  const convex = useConvex()
  // Undefined intentionally means the caller's personal workspace; Convex
  // requireWorkspace(ctx, undefined) derives that server-side from auth.
  const activeWorkspaceId = useActiveWorkspaceId()
  const workspaceArgs = useMemo(
    () => viewWorkspaceArgs(activeWorkspaceId),
    [activeWorkspaceId],
  )
  const [timedOut, setTimedOut] = useState(false)
  const pendingActionRef = useRef<PendingViewAction | null>(null)
  const actionDialogRef = useRef<HTMLDivElement | null>(null)
  const confirmActionButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingViewActionState | null>(null)
  const actionDialogTitleId = useId()
  const actionDialogDescriptionId = useId()

  useEffect(() => {
    startedRef.current = false
    setTimedOut(false)
    setPendingAction(null)
    const timeout = window.setTimeout(() => {
      if (!startedRef.current) setTimedOut(true)
    }, VIEW_START_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [srcDoc])

  useEffect(() => {
    return () => {
      const pending = pendingActionRef.current
      if (!pending) return
      pendingActionRef.current = null
      pending.resolve(
        makeViewRpcError(
          pending.request.id,
          'view-reloaded',
          'The view was reloaded before the action was confirmed.',
        ),
      )
    }
  }, [srcDoc])

  useEffect(() => {
    if (!pendingAction) return

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
  }, [pendingAction?.id])

  const recordAction = useCallback(
    (operation: ViewRpcOp, target?: string) => {
      window.dispatchEvent(
        new CustomEvent(VIEW_ACTION_EVENT, {
          detail: viewActionDetail(packageRoot, operation, target),
        }),
      )
    },
    [packageRoot],
  )

  const requestActionConfirmation = useCallback(
    (request: ViewActionRequest): Promise<ViewRpcResponse> => {
      if (pendingActionRef.current) {
        return Promise.resolve(
          makeViewRpcError(
            request.id,
            'action-pending',
            'Another view action is waiting for confirmation.',
          ),
        )
      }
      return new Promise((resolve) => {
        pendingActionRef.current = { request, resolve }
        setPendingAction({
          id: request.id,
          name: request.args.name,
          inputSummary: summarizeViewActionInput(request.args.input),
          status: 'confirming',
        })
      })
    },
    [],
  )

  const cancelPendingAction = useCallback(() => {
    const pending = pendingActionRef.current
    if (!pending) return
    pendingActionRef.current = null
    setPendingAction(null)
    pending.resolve(
      makeViewRpcError(
        pending.request.id,
        'cancelled',
        'The view action was cancelled.',
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
      const result = await convex.action(api.viewData.runAction, {
        packageRoot,
        name: pending.request.args.name,
        ...(pending.request.args.input === undefined
          ? {}
          : { input: pending.request.args.input }),
        clientMutationId: pending.request.id,
        ...workspaceArgs,
      })
      pending.resolve(makeViewRpcSuccess(pending.request.id, result))
    } catch {
      pending.resolve(
        makeViewRpcError(
          pending.request.id,
          'internal-error',
          'The view action could not be completed.',
        ),
      )
    } finally {
      if (pendingActionRef.current?.request.id === pending.request.id) {
        pendingActionRef.current = null
      }
      setPendingAction(null)
    }
  }, [convex, packageRoot, recordAction, workspaceArgs])

  const onPendingActionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && pendingAction?.status !== 'running') {
        event.preventDefault()
        event.stopPropagation()
        cancelPendingAction()
        return
      }
      if (event.key !== 'Tab') return

      const elements = focusableDialogElements(event.currentTarget)
      if (elements.length === 0) {
        event.preventDefault()
        return
      }

      const first = elements[0]!
      const last = elements[elements.length - 1]!
      const active = document.activeElement

      if (event.shiftKey) {
        if (active === first || !event.currentTarget.contains(active)) {
          event.preventDefault()
          last.focus()
        }
        return
      }

      if (active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [cancelPendingAction, pendingAction?.status],
  )

  const runRequest = useCallback(
    async (request: ViewRpcRequest): Promise<ViewRpcResponse> => {
      try {
        const requestId = request.id
        switch (request.op) {
          case 'dohc.sources.list':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.listSources, {
                packageRoot,
                ...request.args,
                ...workspaceArgs,
              }),
            )
          case 'dohc.atom.get':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.getAtom, {
                packageRoot,
                ...request.args,
                ...workspaceArgs,
              }),
            )
          case 'dohc.fields.query':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.queryFields, {
                packageRoot,
                ...request.args,
                ...workspaceArgs,
              }),
            )
          case 'dohc.imports.list':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.listImports, {
                packageRoot,
                ...workspaceArgs,
              }),
            )
          case 'dohc.exports.list':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.listExports, {
                packageRoot,
                ...workspaceArgs,
              }),
            )
          case 'dohc.source.open': {
            const result = await convex.query(api.viewData.getAtom, {
              packageRoot,
              path: request.args.path,
              ...workspaceArgs,
            })
            if (result.ok) onOpenSource(result.atom.path)
            return makeViewRpcSuccess(request.id, result)
          }
          case 'dohc.agent.run':
            recordAction(request.op, request.args.sources?.[0])
            onRunAgent?.(request.args.prompt)
            return makeViewRpcSuccess(request.id, { ok: true })
          case 'dohc.actions.run':
            return await requestActionConfirmation(request)
          case 'dohc.patch.propose': {
            if (!canWriteRequestedPath(scopePath, writeScopes, request.args.path)) {
              return makeViewRpcError(
                request.id,
                'write-not-granted',
                'This view is not allowed to propose changes to that source.',
              )
            }
            recordAction(request.op, request.args.path)
            const prompt = [
              `Review this proposed change from the view at ${packageRoot}.`,
              `Target: ${request.args.path}`,
              `Summary: ${request.args.summary}`,
              '',
              'Proposed patch:',
              JSON.stringify(request.args.patch, null, 2),
            ].join('\n')
            onRunAgent?.(prompt)
            return makeViewRpcSuccess(request.id, { ok: true })
          }
          default:
            return makeViewRpcError(
              requestId,
              'unsupported-operation',
              'This view operation is not supported.',
            )
        }
      } catch {
        return makeViewRpcError(
          request.id,
          'internal-error',
          'The view request could not be completed.',
        )
      }
    },
    [
      convex,
      onOpenSource,
      onRunAgent,
      packageRoot,
      recordAction,
      requestActionConfirmation,
      scopePath,
      workspaceArgs,
      writeScopes,
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
      const request = parseViewRpcRequest(event.data)
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
        title={`${title} view`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="absolute inset-0 size-full border-0 bg-surface"
      />
      {timedOut && (
        <div className="absolute inset-x-4 top-4 rounded-lg border border-rule bg-surface px-3 py-2 text-[12px] text-ink-dim shadow-sm">
          <p className="font-medium text-ink-strong">This view did not start.</p>
          <p className="mt-0.5">
            Open source or ask dohc to repair it.
          </p>
        </div>
      )}
      {pendingAction && (
        <div
          ref={actionDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={actionDialogTitleId}
          aria-describedby={actionDialogDescriptionId}
          onKeyDown={onPendingActionKeyDown}
          className="absolute inset-x-4 top-4 rounded-lg border border-rule bg-surface px-3 py-3 text-[12px] text-ink-dim shadow-sm"
        >
          <p id={actionDialogTitleId} className="font-medium text-ink-strong">
            Run view action?
          </p>
          <p id={actionDialogDescriptionId} className="mt-1">
            {title} wants to run <span className="font-medium text-ink-strong">{pendingAction.name}</span>.
          </p>
          <p
            tabIndex={0}
            className="mt-1 max-h-20 overflow-auto rounded border border-rule bg-paper px-2 py-1 font-mono text-[11px]"
          >
            {pendingAction.inputSummary}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={cancelPendingAction}
              disabled={pendingAction.status === 'running'}
              className="rounded border border-rule px-2 py-1 text-ink-strong disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              ref={confirmActionButtonRef}
              type="button"
              onClick={() => {
                void confirmPendingAction()
              }}
              disabled={pendingAction.status === 'running'}
              className="rounded bg-ink-strong px-2 py-1 text-paper disabled:opacity-50"
            >
              {pendingAction.status === 'running' ? 'Running...' : 'Confirm'}
            </button>
          </div>
        </div>
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
  return writeScopes.some((scope) => resolved === scope || resolved.startsWith(`${scope}/`))
}
