import { DatabaseTableGrid, type DatabaseTableView } from './DatabaseTableGrid'

type DatabaseOpView = {
  operationId: string
  op: string
  table: string
  rowId?: string
  actorUserId: string
  version: number
}

export function DatabaseStudio({
  database,
}: {
  database: {
    path: string
    version: number
    tables: DatabaseTableView[]
    ops?: DatabaseOpView[]
  }
}) {
  const active = database.tables[0] ?? null
  return (
    <section className="flex h-full min-h-0 flex-col bg-paper text-ink-strong">
      <header className="border-b border-rule px-4 py-3">
        <h1 className="text-sm font-semibold">{database.path}</h1>
        <p className="text-xs text-ink-dim">version {database.version}</p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr]">
        <aside className="border-r border-rule p-3 text-xs">
          {database.tables.map((table) => (
            <div key={table.name} className="py-1 font-medium">{table.name}</div>
          ))}
        </aside>
        <main className="min-w-0 p-3">
          {active ? (
            <>
              <div className="mb-3 flex flex-wrap gap-2 text-xs text-ink-dim">
                {active.columns.map((column) => (
                  <span key={column.name} className="border border-rule px-2 py-1">
                    {column.name} {column.type}
                  </span>
                ))}
              </div>
              <DatabaseTableGrid table={active} />
            </>
          ) : (
            <p className="text-xs text-ink-dim">No tables</p>
          )}
          {database.ops && database.ops.length > 0 && (
            <section className="mt-4 text-xs">
              <h2 className="mb-2 font-medium">Operation history</h2>
              {database.ops.map((op) => (
                <div key={op.operationId} className="border-t border-rule py-1">
                  {op.operationId} {op.op} {op.table} {op.rowId ?? ''} version {op.version}
                </div>
              ))}
            </section>
          )}
        </main>
      </div>
    </section>
  )
}
