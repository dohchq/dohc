export type JsonScalar = string | number | boolean | null
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }

export type CollectionQuery = Record<string, JsonValue>
export type CollectionRow = Record<string, JsonValue> & { id?: string }

export type Collection = {
  list(query?: CollectionQuery): Promise<CollectionRow[]>
  get(id: string): Promise<CollectionRow | null>
  insert(record: Record<string, JsonValue>): Promise<{ ok: true; id: string }>
  update(id: string, patch: Record<string, JsonValue>): Promise<{ ok: true }>
  upsert(id: string, record: Record<string, JsonValue>): Promise<{ ok: true; id: string }>
  delete(id: string): Promise<{ ok: true }>
}

export type DohcDoc = {
  get(): Promise<{ path: string; body: string; frontmatter: Record<string, string> }>
  set(key: string, value: JsonScalar): Promise<{ ok: true }>
  append(markdown: string): Promise<{ ok: true }>
  replaceText(args: { find: string; with: string; occurrence?: number }): Promise<{ ok: true }>
  section(heading: string): {
    append(markdown: string): Promise<{ ok: true }>
    replace(markdown: string): Promise<{ ok: true }>
  }
}

export type DatabaseColumn = {
  name: string
  type: string
  nullable?: boolean
}

export type DohcDatabase = {
  tables(): Promise<Array<{ name: string; columns: DatabaseColumn[] }>>
  query<T = Record<string, JsonValue>>(sql: string, params?: JsonValue[]): Promise<T[]>
  table(name: string): Collection
}

export type AppPresenceUser = {
  id: string
  displayName: string
  color?: string
}
