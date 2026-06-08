import type { DatabaseColumn } from '../../convex/databaseSchema'

export type DatabaseTableView = {
  name: string
  columns: DatabaseColumn[]
  rows: Array<Record<string, unknown>>
}

export function DatabaseTableGrid({ table }: { table: DatabaseTableView }) {
  return (
    <div className="overflow-auto border border-rule">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column.name} className="border-b border-rule px-2 py-1 font-medium">
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {table.columns.map((column) => (
                <td key={column.name} className="border-b border-rule px-2 py-1">
                  {String(row[column.name] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
