# Collection automations (`automations.yaml`)

Place `automations.yaml` inside a Collection folder (beside `collection.yaml` or `dataset.json`). After writing it, verify with `dohc_list_automations` (`{ collectionPath }`) that `file.status` is `"read"` and every entry has `status: "valid"`.

## File structure

```yaml
version: 1
automations:
  - id: flag-large-expense
    name: Flag expenses over 500
    when:
      field-changed: Amount
    do:
      - if: record.Amount > 500
        do:
          - set:
              Status: Needs Review
              Flagged On: '=today()'
          - post: 'Expense needs review: {record.Amount}'
            group: Finance
```

- `id`: lowercase slug (`[a-z0-9-]`, up to 64 characters), unique in the file.
- `name`: display label (up to 120 characters).
- Optional `enabled: true | false` (defaults to `true`).
- Optional top-level `if:` condition on the automation (same bare expression rule as an `if` step).

## Triggers (`when:`)

A trigger is a mapping with exactly one kind key (or a bare string for argument-free triggers like `when: record-added`). Add `table: TableName` when targeting a multi-table dataset.

| Kind key | Value | Optional keys |
| --- | --- | --- |
| `record-added` | empty (or bare `when: record-added`) | `table` |
| `record-changed` | empty or list of field names | `table` |
| `record-removed` | empty (or bare `when: record-removed`) | `table` |
| `field-changed` | field name (string) | `to` (literal or `'=formula'`), `table` |
| `starts-matching` | bare JS condition expression | `table` |
| `button` | button field name | `table` |
| `group-message` | Group name | `starts-with` |
| `schedule` | mapping `{ every: hour\|day\|weekday\|week\|month, timezone: "Asia/Singapore", at?: "09:00", days?: [...] }` | none |

## Steps (`do:`)

Each step in `do:` is a mapping with exactly one kind key:

| Kind key | Value | Optional keys |
| --- | --- | --- |
| `set` | mapping `{ FieldName: value }` | `records` (from `as`), `operation` (required on datasets) |
| `add-record` | mapping `{ FieldName: value }` | `collection`, `as`, `operation` (required on datasets) |
| `find` | bare JS condition expression | `collection`, `as` (required), `operation` (required on datasets) |
| `invoke` | dataset operation name | `collection`, `input: { key: value }` |
| `if` | bare JS condition expression | `do` (required list of steps), `otherwise` (optional list of steps) |
| `post` | message template string | `group` (required Group name) |
| `notify` | message template string | `to` (list of person IDs or formulas) |
| `direct-message` | message template string | `to` (list of person IDs or formulas) |
| `run` | JS function body reading `ctx` | `as` |
| `run-file` | relative script path inside the Collection folder | `as` |

## Formulas, conditions, and message templates

The syntax differs by position:

1. **Values (`set`, `add-record`, `to`, `input`)**: Start formulas with one `=` and quote them in YAML (`Flagged On: '=today()'`). Plain text without `=` is a literal string. Start literal text that begins with `=` using `==`.
2. **Conditions (`if`, `find`, `starts-matching`)**: Write a bare JavaScript expression with **no leading `=`** (`if: record.Amount > 500`). Putting `=` in an `if` condition fails validation.
3. **Message templates (`post`, `notify`, `direct-message`)**: Interpolate expressions with **single braces** `{expr}` (`'Expense needs review: {record.Amount}'`). Double braces `{{` and `}}` render literal `{` and `}` characters.

Available names in formulas and conditions: `record`, `previous`, `trigger`, `person`, `message`, plus helpers `today()`, `now()`, `dateAdd`, `dateBetween`, `formatDate`, `lower`, `upper`, `trim`, `contains`, `join`, `length`, `sum`, `min`, `max`, `round`.
