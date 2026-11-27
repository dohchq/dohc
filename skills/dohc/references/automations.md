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
| `schedule` | frequency scalar (`hour`, `day`, `weekday`, `week`, or `month`) | `timezone` (required IANA timezone, e.g. `Asia/Singapore`), `at` (`"HH:MM"`, or `":MM"` for `hour`), `days` (for `week`: `mon..sun`; for `month`: `1..31`) |

Example scheduled trigger (note `timezone` and `at` are sibling keys under `when:`, not nested under `schedule:`):

```yaml
version: 1
automations:
  - id: daily-digest
    name: Daily morning digest
    when:
      schedule: day
      timezone: Asia/Singapore
      at: '09:00'
    do:
      - post: 'Daily check-in reminder'
        group: General
```

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
| `notify` | message template string | `to` (required list of person IDs or formulas) |
| `direct-message` | message template string | `to` (required list of person IDs or formulas) |
| `wake-agent` | message template string | `person` (required person ID, plain text only, not a formula) |
| `http` | public HTTPS URL on port 443 or `{ secret: SECRET_NAME }` | `method` (`POST` default, or `GET`), `headers` (`{ Name: scalar or '=formula' }`), `secret-headers` (`{ Name: { secret, prefix? } }`), `body` (`POST` only: non-empty JSON mapping or text template), `as` |
| `run` | JS function body reading `ctx` | `as` |
| `run-file` | relative script path inside the Collection folder | `as` |

## Formulas, conditions, and message templates

The syntax differs by position:

1. **Values (`set`, `add-record`, `to`, `input`, `http` `headers`, and `http` JSON `body`)**: Start formulas with one `=` and quote them in YAML (`Flagged On: '=today()'`). Plain text without `=` is a literal string. Start literal text that begins with `=` using `==`. `http` `headers` accept scalar values or formulas, not lists or `null`. An `http` JSON `body` must be a non-empty mapping whose values are scalars, lists of literal scalars, or formulas (a formula can return nested JSON).
2. **Conditions (`if`, `find`, `starts-matching`)**: Write a bare JavaScript expression with **no leading `=`** (`if: record.Amount > 500`). Putting `=` in an `if` condition fails validation.
3. **Message templates (`post`, `notify`, `direct-message`, `wake-agent`, and `http` text `body`)**: Interpolate expressions with **single braces** `{expr}` (`'Expense needs review: {record.Amount}'`). Double braces `{{` and `}}` render literal `{` and `}` characters.

Available names in formulas and conditions: `record`, `previous`, `trigger`, `person`, `message`, plus helpers `today()`, `now()`, `dateAdd`, `dateBetween`, `formatDate`, `lower`, `upper`, `trim`, `contains`, `join`, `length`, `sum`, `min`, `max`, `round`.

## Personal steps (`wake-agent` and `http`)

A Personal step uses one person's own reach. `wake-agent` and `http` are Personal steps, so they run only on a Collection that nobody but the workspace owner can edit, including its `automations.yaml` and any code file the automation runs. Granting Edit access to another person, including an Edit share link or a pending Edit invite that covers those paths, stops them. View and Comment access do not stop them. After an editor is removed, a current editor must confirm previously stopped steps before they run again.

- `wake-agent`: sends the rendered message template to wake the named person's automation agent, configured in desktop Settings › Agents. `person` must be a plain-text verified user ID, or the local person ID in a solo local-only workspace, for the Collection's sole editor.
- `http`: sends `POST` (default) or `GET` to a static public HTTPS URL on port 443 or to an `http-url` workspace secret (`{ secret: SECRET_NAME }`). Attach `http-header` workspace secrets with `secret-headers` and an optional `prefix` such as `'Bearer '`. Secret names start with `A-Z` and use `A-Z`, `0-9`, and `_`, up to 64 characters. An `http-header` secret attaches only when its allowed hosts include the destination's exact canonical hostname.
  - The workspace owner must allow each `http` step in the dohc desktop app before it runs. Changing `when`, `if`, `do`, or a code file the automation runs, replacing an `http-url` secret, or changing an `http-header` secret's allowed hosts holds the step until the owner allows it again.
  - Create and manage `http-url` and `http-header` secrets in desktop Settings. CLI and MCP tools cannot create or change workspace secrets.
  - Without `as`, `http` reads only the HTTP status, capped at 64 KiB. With `as: name`, it parses an uncompressed 2xx JSON response (`application/json` or `application/*+json`, charset absent or `utf-8`, up to 192 KiB and 64 levels deep), scrubs attached secrets, and binds the value for later formulas and code steps.
  - Limits: up to 3 `http` steps per automation, 16 headers total across `headers` and `secret-headers` (case-insensitively unique names; printable ASCII values; up to 2,048 bytes per `headers` value, 4,096 bytes per saved `http-header` secret plus a `prefix` up to 64 characters, and 8,192 bytes total across header names and rendered values), 32 keys in a JSON `body`, and 64 KiB per `POST` body. Reserved headers such as `Host`, `Cookie`, `User-Agent`, `Proxy-*`, and `X-Dohc-*` are refused. `GET` cannot include `body`. Destinations must be public HTTPS hosts on port 443, with no IP literals, local hosts, or redirects. `POST` runs at most once per claim; an interrupted `GET` can fetch again on resume.

Example using both Personal steps (with `STATS_KEY` configured in desktop Settings to allow `api.example.com`):

```yaml
version: 1
automations:
  - id: enrich-and-triage
    name: Enrich new record and wake agent
    when: record-added
    do:
      - http: https://api.example.com/stats
        method: GET
        secret-headers:
          Authorization:
            secret: STATS_KEY
            prefix: 'Bearer '
        as: stats
      - set:
          Score: '=stats.score'
      - wake-agent: 'Review {record.Name}: score {stats.score}'
        person: user_ana
```

## Incoming webhooks

An incoming webhook is a secret address that adds a record to a private Collection for each delivery, so a website form or another service can feed a Collection, and its `automations.yaml` runs on the new records. Only the owner's own agents set them up, and only in a synced workspace.

1. Read the host with `dohc_read_automation_host` (`dohc automation host`). Webhooks need the dohc server to run the workspace's automations.
2. If a computer runs them, pass the `generation` you read to `dohc_use_server_for_automations` (`dohc automation use-server --generation <n>`). `handover-pending` means the named computer must hand over first; if it stays offline, the owner uses Take over in Settings › Advanced.
3. Create the webhook with `dohc_create_incoming_webhook` (`dohc webhook create <name> --collection <path>`). The path is the Collection's folder, relative to the workspace root.

The result shows the address once, as `endpointUrl`. Anyone who has it can add records, so give it only to the person you work for or the site that posts to it. If you don't know whether a create worked, list with `dohc_list_incoming_webhooks` (`dohc webhook list`) before you try again; the list never shows addresses. The owner renames, pauses, rotates, and deletes webhooks in Settings › Secrets › Incoming webhooks.
