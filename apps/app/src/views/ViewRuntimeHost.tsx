import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvex } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { resolveScopeRelativePath } from '../lib/viewPaths'
import {
  makeViewRpcError,
  makeViewRpcSuccess,
  parseViewRpcRequest,
  type ViewRpcRequest,
  type ViewRpcResponse,
} from './sdkProtocol'

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
  const activeWorkspaceId = useActiveWorkspaceId()
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    startedRef.current = false
    setTimedOut(false)
    const timeout = window.setTimeout(() => {
      if (!startedRef.current) setTimedOut(true)
    }, 2500)
    return () => window.clearTimeout(timeout)
  }, [srcDoc])

  const recordAction = useCallback(
    (operation: string, target?: string) => {
      window.dispatchEvent(
        new CustomEvent('dohc:view-action', {
          detail: {
            packageRoot,
            operation,
            target: target ?? null,
            timestamp: Date.now(),
          },
        }),
      )
    },
    [packageRoot],
  )

  const runRequest = useCallback(
    async (request: ViewRpcRequest): Promise<ViewRpcResponse> => {
      try {
        switch (request.op) {
          case 'dohc.sources.list':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.listSources, {
                packageRoot,
                activeWorkspaceId,
                ...request.args,
              }),
            )
          case 'dohc.atom.get':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.getAtom, {
                packageRoot,
                activeWorkspaceId,
                ...request.args,
              }),
            )
          case 'dohc.fields.query':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.queryFields, {
                packageRoot,
                activeWorkspaceId,
                ...request.args,
              }),
            )
          case 'dohc.imports.list':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.listImports, {
                packageRoot,
                activeWorkspaceId,
              }),
            )
          case 'dohc.exports.list':
            return makeViewRpcSuccess(
              request.id,
              await convex.query(api.viewData.listExports, {
                packageRoot,
                activeWorkspaceId,
              }),
            )
          case 'dohc.source.open': {
            const result = await convex.query(api.viewData.getAtom, {
              packageRoot,
              activeWorkspaceId,
              path: request.args.path,
            })
            if (result.ok) onOpenSource(result.atom.path)
            return makeViewRpcSuccess(request.id, result)
          }
          case 'dohc.agent.run':
            recordAction(request.op, request.args.sources?.[0])
            onRunAgent?.(request.args.prompt)
            return makeViewRpcSuccess(request.id, { ok: true })
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
      activeWorkspaceId,
      convex,
      onOpenSource,
      onRunAgent,
      packageRoot,
      recordAction,
      scopePath,
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
    </div>
  )
}

function canWriteRequestedPath(
  scopePath: string,
  writeScopes: string[],
  requestedPath: string,
): boolean {
  if (writeScopes.length === 0) return false
  const resolved = resolveScopeRelativePath(scopePath, requestedPath)
  if (resolved === null) return false
  return writeScopes.some((scope) => resolved === scope || resolved.startsWith(`${scope}/`))
}
