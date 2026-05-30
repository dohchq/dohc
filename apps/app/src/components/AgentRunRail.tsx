import {
  Check,
  Circle,
  FileText,
  GitBranch,
  PanelsTopLeft,
  Share2,
} from 'lucide-react'

type FileRow = {
  path: string
  type?: 'html' | 'skill' | 'command' | null
}

function isRunPath(path: string): boolean {
  return /^\.?runs\//i.test(path)
}

function isSourcePath(file: FileRow): boolean {
  return (
    file.type !== 'html' &&
    !file.path.startsWith('.context/') &&
    !file.path.startsWith('.skills/') &&
    !file.path.startsWith('.commands/') &&
    !isRunPath(file.path)
  )
}

function isCockpitPath(file: FileRow): boolean {
  return file.type === 'html' && /(^|\/)(home|dashboard|cockpit)\.html$/i.test(file.path)
}

function first<T>(items: T[], n: number): T[] {
  return items.slice(0, n)
}

export function AgentRunRail({
  files,
  chatDockOpen,
}: {
  files: FileRow[]
  chatDockOpen: boolean
}) {
  const sourceFiles = files.filter(isSourcePath)
  const cockpit = files.find(isCockpitPath)
  const setupRun = files.find((f) => /^\.?runs\/setup\.md$/i.test(f.path))
  const reviewSignals = files.filter((f) =>
    /(^|\/)(review|reviews|inbox|pending)\b/i.test(f.path),
  )

  const progress = [
    {
      label: 'Sources',
      done: sourceFiles.length > 0,
      detail:
        sourceFiles.length > 0
          ? `${sourceFiles.length} source${sourceFiles.length === 1 ? '' : 's'}`
          : 'waiting',
    },
    {
      label: 'Cockpit',
      done: !!cockpit,
      detail: cockpit?.path ?? 'home.html',
    },
    {
      label: 'Run',
      done: !!setupRun,
      detail: setupRun?.path ?? '.runs/setup.md',
    },
  ]

  return (
    <aside className="flex h-screen w-[340px] shrink-0 flex-col border-l border-rule bg-panel">
      <div className="border-b border-rule px-4 py-3.5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Run
        </p>
        <h2 className="mt-1 text-[14px] font-semibold tracking-tight text-ink-strong">
          Current workspace
        </h2>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <RailSection title="Progress" Icon={GitBranch}>
          <div className="flex flex-col gap-2.5">
            {progress.map((item) => (
              <div key={item.label} className="flex items-start gap-2.5">
                <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
                  {item.done ? (
                    <Check className="size-3.5 text-success" strokeWidth={2.6} />
                  ) : (
                    <Circle className="size-3.5 text-ink-ghost" strokeWidth={2} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-ink-strong">
                    {item.label}
                  </p>
                  <p className="truncate font-mono text-[10.5px] text-ink-faint">
                    {item.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </RailSection>

        <RailSection title="Sources" Icon={FileText}>
          {sourceFiles.length > 0 ? (
            <PathList paths={first(sourceFiles.map((f) => f.path), 6)} />
          ) : (
            <EmptyLine label="No sources yet" />
          )}
        </RailSection>

        <RailSection title="Review" Icon={PanelsTopLeft}>
          {reviewSignals.length > 0 ? (
            <PathList paths={first(reviewSignals.map((f) => f.path), 4)} />
          ) : (
            <EmptyLine label="No review items" />
          )}
        </RailSection>

        <RailSection title="Collaboration" Icon={Share2}>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-surface px-3 py-2">
            <span className="text-[12px] text-ink-dim">Side chat</span>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">
              {chatDockOpen ? 'docked' : 'files mode'}
            </span>
          </div>
        </RailSection>
      </div>
    </aside>
  )
}

function RailSection({
  title,
  Icon,
  children,
}: {
  title: string
  Icon: typeof FileText
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-ink-faint">
        <Icon className="size-3.5" strokeWidth={2} />
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em]">
          {title}
        </p>
      </div>
      {children}
    </section>
  )
}

function PathList({ paths }: { paths: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {paths.map((path) => (
        <div
          key={path}
          className="truncate rounded-md border border-rule bg-surface px-2.5 py-1.5 font-mono text-[10.5px] text-ink-dim"
        >
          {path}
        </div>
      ))}
    </div>
  )
}

function EmptyLine({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-rule px-2.5 py-2 text-[11.5px] text-ink-faint">
      {label}
    </div>
  )
}
