import { useEffect, useMemo, useState } from 'react'
import { Bot, FilePenLine, TriangleAlert } from 'lucide-react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import { bundleViewServer } from '../views/buildViewBundle.server'
import { ViewRuntimeHost } from '../views/ViewRuntimeHost'
import { buildViewShell } from '../views/viewShell'
import { ViewFrameSkeleton } from './Skeleton'

type BuildState =
  | { status: 'idle'; key: null }
  | { status: 'building'; key: string; previousCode: string | null }
  | { status: 'ready'; key: string; code: string }
  | { status: 'error'; key: string; diagnostics: Array<{ code: string; message: string }> }

const BUILD_DEBOUNCE_MS = 150

export function ViewFrame({
  packageRoot,
  onOpenSource,
  onRunAgent,
}: {
  packageRoot: string | null
  onOpenSource: (path: string) => void
  onRunAgent?: (prompt: string) => void
}) {
  const activeWorkspaceId = useActiveWorkspaceId()
  const view = useQuery(
    api.views.get,
    packageRoot ? { packageRoot, activeWorkspaceId } : 'skip',
  )
  const sourceFiles = useQuery(
    api.views.getSourceFiles,
    packageRoot ? { packageRoot, activeWorkspaceId } : 'skip',
  )
  const [buildState, setBuildState] = useState<BuildState>({
    status: 'idle',
    key: null,
  })

  const sourceKey = useMemo(() => {
    if (!sourceFiles || !sourceFiles.ok) return null
    return JSON.stringify({
      entry: sourceFiles.entry,
      files: sourceFiles.files.map((file) => [
        file.relativePath,
        file.body.length,
        file.body,
      ]),
    })
  }, [sourceFiles])

  useEffect(() => {
    if (!sourceFiles || !sourceFiles.ok || !sourceKey) {
      setBuildState({ status: 'idle', key: null })
      return
    }
    let cancelled = false
    setBuildState((current) => {
      if (current.status === 'ready' && current.key === sourceKey) return current
      const previousCode =
        current.status === 'ready'
          ? current.code
          : current.status === 'building' && 'previousCode' in current
            ? current.previousCode
            : null
      return { status: 'building', key: sourceKey, previousCode }
    })
    const debounce = window.setTimeout(() => {
      void bundleViewServer({
        data: { entry: sourceFiles.entry, files: sourceFiles.files },
      })
        .then((result) => {
          if (cancelled) return
          if (result.ok) {
            setBuildState({ status: 'ready', key: sourceKey, code: result.code })
          } else {
            setBuildState({
              status: 'error',
              key: sourceKey,
              diagnostics: result.diagnostics,
            })
          }
        })
        .catch(() => {
          if (cancelled) return
          setBuildState({
            status: 'error',
            key: sourceKey,
            diagnostics: [
              {
                code: 'build-failed',
                message: 'This view could not be bundled safely.',
              },
            ],
          })
        })
    }, BUILD_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(debounce)
    }
  }, [sourceFiles, sourceKey])

  if (!packageRoot) {
    return (
      <main className="grid min-w-0 place-items-center bg-page text-[13px] text-ink-faint">
        Select a view.
      </main>
    )
  }

  if (view === undefined) {
    return <ViewFrameSkeleton withHeader />
  }

  if (view === null) {
    return (
      <main className="grid min-w-0 place-items-center bg-page text-[13px] text-ink-faint">
        View not found.
      </main>
    )
  }

  if (!view.entryExists) {
    return (
      <ViewDiagnostic
        title={view.title}
        packageRoot={view.packageRoot}
        entryPath={view.entryPath}
        message="The view entry file is missing."
        onOpenSource={onOpenSource}
        onRunAgent={onRunAgent}
      />
    )
  }

  if (sourceFiles && !sourceFiles.ok) {
    return (
      <ViewDiagnostic
        title={view.title}
        packageRoot={view.packageRoot}
        entryPath={view.entryPath}
        message={sourceFiles.message}
        code={sourceFiles.code}
        onOpenSource={onOpenSource}
        onRunAgent={onRunAgent}
      />
    )
  }

  if (buildState.status === 'error') {
    return (
      <ViewDiagnostic
        title={view.title}
        packageRoot={view.packageRoot}
        entryPath={view.entryPath}
        message={buildState.diagnostics[0]?.message ?? 'This view could not render.'}
        code={buildState.diagnostics[0]?.code}
        onOpenSource={onOpenSource}
        onRunAgent={onRunAgent}
      />
    )
  }

  const viewLoadingScript = `
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const bg = dark ? '#100f0e' : '#f7f6f1';
    const surface = dark ? '#191c1a' : '#fffefa';
    const rule = dark ? 'rgba(244,241,234,.14)' : 'rgba(21,21,21,.12)';
    const base = dark ? '#30332f' : '#ece9e1';
    const sheen = dark ? '#3c403a' : '#ded9ce';
    document.body.style.margin = '0';
    document.body.style.background = bg;
    document.getElementById('root').innerHTML =
      '<main style="min-height:100vh;display:grid;place-items:center;background:' + bg + ';padding:24px;box-sizing:border-box">' +
        '<style>@keyframes s{0%{background-position:180% 0}100%{background-position:-80% 0}}.sk{display:block;border-radius:8px;background-color:' + base + ';background-image:linear-gradient(100deg,transparent 0%,transparent 34%,' + sheen + ' 48%,transparent 62%,transparent 100%);background-size:220% 100%;animation:s 1.55s ease-in-out infinite}@media (prefers-reduced-motion:reduce){.sk{animation:none;background-image:none}}</style>' +
        '<section style="width:min(760px,100%);border:1px solid ' + rule + ';border-radius:10px;background:' + surface + ';padding:22px;box-sizing:border-box">' +
          '<span class="sk" style="height:20px;width:42%;margin-bottom:22px"></span>' +
          '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:24px"><span class="sk" style="height:96px"></span><span class="sk" style="height:96px"></span><span class="sk" style="height:96px"></span></div>' +
          '<span class="sk" style="height:10px;width:92%;margin-bottom:10px"></span><span class="sk" style="height:10px;width:82%;margin-bottom:10px"></span><span class="sk" style="height:10px;width:64%"></span>' +
        '</section>' +
      '</main>';
  `
  const runtimeCode =
    buildState.status === 'ready'
      ? buildState.code
      : buildState.status === 'building' &&
          'previousCode' in buildState &&
          buildState.previousCode
        ? buildState.previousCode
        : viewLoadingScript

  const srcDoc = buildViewShell({
    title: view.title,
    script: runtimeCode,
  })

  return (
    <main className="flex min-w-0 flex-col bg-page">
      <header className="flex h-12 items-center justify-between border-b border-rule bg-surface px-4">
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold text-ink-strong">
            {view.title}
          </h1>
          <div className="truncate font-mono text-[10.5px] text-ink-faint">
            {view.scopePath || 'Workspace'} · {view.packageRoot}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpenSource(view.entryPath)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule bg-panel px-2.5 text-[12px] font-medium text-ink-dim hover:border-rule-strong hover:bg-hover hover:text-ink"
        >
          <FilePenLine className="size-3.5" strokeWidth={2} />
          Open source
        </button>
      </header>
      <ViewRuntimeHost
        packageRoot={view.packageRoot}
        scopePath={view.scopePath}
        writeScopes={view.write}
        title={view.title}
        srcDoc={srcDoc}
        onOpenSource={onOpenSource}
        onRunAgent={onRunAgent}
      />
    </main>
  )
}

function ViewDiagnostic({
  title,
  packageRoot,
  entryPath,
  message,
  code,
  onOpenSource,
  onRunAgent,
}: {
  title: string
  packageRoot: string
  entryPath: string
  message: string
  code?: string
  onOpenSource: (path: string) => void
  onRunAgent?: (prompt: string) => void
}) {
  return (
    <main className="flex min-w-0 flex-col bg-page">
      <header className="flex h-12 items-center justify-between border-b border-rule bg-surface px-4">
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold text-ink-strong">
            {title}
          </h1>
          <div className="truncate font-mono text-[10.5px] text-ink-faint">
            {packageRoot}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpenSource(entryPath)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule bg-panel px-2.5 text-[12px] font-medium text-ink-dim hover:border-rule-strong hover:bg-hover hover:text-ink"
        >
          <FilePenLine className="size-3.5" strokeWidth={2} />
          Open source
        </button>
      </header>
      <section className="grid min-h-0 flex-1 place-items-center px-6">
        <div className="max-w-md rounded-lg border border-rule bg-surface px-4 py-4">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={2} />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-ink-strong">
                This view needs attention.
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">
                {message}
              </p>
              {code && (
                <p className="mt-2 font-mono text-[10.5px] text-ink-faint">
                  {entryPath} · {code}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onOpenSource(entryPath)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rule bg-panel px-2.5 text-[12px] font-medium text-ink-dim hover:border-rule-strong hover:bg-hover hover:text-ink"
                >
                  <FilePenLine className="size-3.5" strokeWidth={2} />
                  Open source
                </button>
                {onRunAgent && (
                  <button
                    type="button"
                    onClick={() =>
                      onRunAgent(
                        `Fix the dohc view at ${packageRoot}. The entry is ${entryPath}. Error: ${message}`,
                      )
                    }
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rule bg-ink-strong px-2.5 text-[12px] font-medium text-surface hover:bg-ink"
                  >
                    <Bot className="size-3.5" strokeWidth={2} />
                    Ask dohc to fix
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
