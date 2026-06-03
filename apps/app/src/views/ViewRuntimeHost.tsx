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
const VIEW_ACTION_DIALOG_FOCUS_SELECTOR = [
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

export function nextViewActionDialogFocusIndex({
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
    container.querySelectorAll<HTMLElement>(VIEW_ACTION_DIALOG_FOCUS_SELECTOR),
  ).filter((element) => !element.hasAttribute('disabled'))
}

export function ViewActionConfirmationDialog({
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
  pendingAction: PendingViewActionState
  titleId: string
  descriptionId: string
  confirmButtonRef?: Ref<HTMLButtonElement>
  onCancel: () => void
  onConfirm: () => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      data-view-action-scrim="true"
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
          Run view action?
        </p>
        <p id={descriptionId} className="mt-1">
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
      const active = document.activeElement
      const activeIndex = active instanceof HTMLElement ? elements.indexOf(active) : -1
      const targetIndex = nextViewActionDialogFocusIndex({
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
        <ViewActionConfirmationDialog
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
