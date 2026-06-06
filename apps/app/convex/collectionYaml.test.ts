import { describe, expect, it } from 'vitest'
import { listYamlRows } from './collectionYaml'

describe('yaml collection adapter', () => {
  it('parses simple readable YAML list records', () => {
    const result = listYamlRows(
      { key: 'id' },
      {
        path: 'rules.yaml',
        body: [
          '- id: rule_1',
          '  category: Transport',
          '  enabled: true',
          '- id: rule_2',
          '  category: Meals',
          '  limit: 500',
        ].join('\n'),
      },
    )

    expect(result).toMatchObject({
      ok: true,
      rows: [
        expect.objectContaining({ id: 'rule_1', category: 'Transport', enabled: true }),
        expect.objectContaining({ id: 'rule_2', category: 'Meals', limit: 500 }),
      ],
    })
  })
})
