# Apps and publishing

An app is a folder of web files in the workspace. When it needs structured data, it binds to approved operations on one or more transactional Collections through `app.publish.json` and calls them over the `dohc-app-channel` `MessagePort`.

## `app.publish.json` format

Place `app.publish.json` inside the app folder. Modern manifests omit `inputs`, `packageMap`, `revision`, and `revisionSha256`, and reference operations by name:

```json
{
  "version": 1,
  "entryPath": "src/App.tsx",
  "dataset": {
    "kind": "dataset",
    "datasetPath": "tracker/dataset.json",
    "operations": ["listExpenses", "createExpense"]
  }
}
```

Rules:

- Always include `"version": 1` and `"entryPath"` (relative to the app folder, no leading `/`).
- `inputs` is optional. When omitted, dohc discovers the app folder's source files automatically. When provided, every path is relative to the app folder and must include `entryPath`.
- `packageMap` is optional and defaults to `{}`.
- `dataset.datasetPath` is relative to the workspace root and ends in `dataset.json`.
- Use either `operations: ["opName", ...]` (recommended) or `operationIds: ["<UUID>", ...]`, never both. Omit `revision` and `revisionSha256` so `prepareLocal`, `prepare`, and `stage` pin the latest approved Collection revision automatically.
- An app can bind up to 16 Collections using `datasets` instead of `dataset`: an object map `"datasets": { "<alias>": { "kind": "dataset", "datasetPath": "...", "operations": [...] } }` (call `backend.invoke` with `dataset: "<alias>"`). Apps with more than one Collection get no live updates on a share link.
- Only one of `dataset`, `datasets`, or `collection` may appear.
- For typed rows, run `dohc dataset types '{"workspaceId":"...","datasetPath":"..."}'`. It writes `.dohc/types/<name>-<datasetId>.d.ts` from the approved revision and returns the exact `path`. Import it with `import type { FieldIds, Row, Operations } from "<relative path>/.dohc/types/<name>-<datasetId>"` and run it again after each approved change. Give a custom `action` a `contract` in `dataset.json` to type it with `Input<"name">` and `Output<"name">`. A contract is `{ "input": type, "output": type }`. A type is `"string"`, `"number"`, `"boolean"`, `"unknown"`, `{ "enum": [...] }`, `{ "array": type }`, `{ "nullable": type }`, or `{ "object": { "key": type }, "optional": ["key"] }`. dohc does not check values against it, so the action still checks its input.
- For public share-link apps, list only `access: "link"` operations. Never include owner-only reads in a public app manifest.

## Built-in app kit and TypeScript/JSX

The closed app compiler bundles `.ts`, `.tsx`, `.js`, `.jsx`, and `.css` with extensionless relative imports and ships a built-in kit without needing `node_modules`:

- `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`
- `dohc/app` (backend client and hooks), `dohc/ui` (themed controls and formatters), `dohc/charts` (SVG charts)
- `dohc/icons` (a curated set of Lucide icons, such as `Plus`, `Trash2`, `Receipt`, and `Wallet`; unused icons are left out of the bundle)
- `dohc/money` (`formatCents` and `parseCents` for exact whole-cent amounts) and `dohc/csv` (`parseCsv` and formula-safe `toCsv`)

Other packages, including `lucide-react`, need their files in the app folder and a `packageMap` entry.

## Calling Collection operations (`dohc-app-channel`)

The host delivers one `MessagePort` to the app window on load. Wait for `{ kind: "dohc-app-channel", version: 1 }` and send `backend.invoke` messages on that port:

```js
let channelPort;
const pending = new Map();
const queue = [];

function send(message) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const frame = { id, ...message };
    pending.set(id, { resolve, reject });
    if (channelPort) channelPort.postMessage(frame);
    else queue.push(frame);
  });
}

window.addEventListener("message", (event) => {
  if (
    channelPort ||
    event.source !== window.parent ||
    event.data?.kind !== "dohc-app-channel" ||
    event.data?.version !== 1 ||
    event.ports.length !== 1
  ) {
    return;
  }
  channelPort = event.ports[0];
  channelPort.onmessage = ({ data }) => {
    const req = pending.get(data?.id);
    if (!req) return;
    pending.delete(data.id);
    if (data.ok) req.resolve(data.value);
    else req.reject(new Error(data.error?.message ?? `Request failed (${data.status})`));
  };
  channelPort.start();
  while (queue.length) channelPort.postMessage(queue.shift());
});

// Single-Collection call (add `dataset: "<alias>"` for multi-Collection apps):
// const { result } = await send({
//   op: "backend.invoke",
//   operation: "listExpenses",
//   input: {},
//   idempotencyKey: crypto.randomUUID(),
// });
```

Other channel operations: `backend.upload` (`name`, `contentType`, `bytes` as a transferred `ArrayBuffer` up to 20 MiB, `idempotencyKey`), `backend.file` (`fileId`, `operation`, `input`; replies `{ file, bytes }` with `bytes` as a transferred `ArrayBuffer`), `backend.attempt` (`operation`, `request`), `host.copy` (`text`, up to 65,536 UTF-8 bytes, user-activated), `host.print` (optional `height`, 1 to 50,000 CSS pixels, user-activated), and for document-Collection share-link apps: `collection.list` and `collection.create`.

## Sandbox constraints (`window.origin === "null"`)

Every app runs in a sandboxed `srcdoc` iframe with an opaque origin (`window.origin === "null"`), without `allow-same-origin` or `allow-modals`:

- Do not read or write `sessionStorage`, `localStorage`, `indexedDB`, or `document.cookie`. They throw `SecurityError` in an opaque origin. Keep UI state in memory and persist data in Collections.
- Do not call `navigator.clipboard.writeText(...)` directly inside the app frame. Chromium logs a Permissions Policy `console.error` even inside `try/catch`, which fails `verifyFrontend`. Import `copyText(text)` from `dohc/app` (or send `host.copy` over `dohc-app-channel`) from a click or key handler.
- Do not call `window.print()` directly inside the app frame. Chromium ignores it without `allow-modals`. Import `print()` from `dohc/app` (or send `host.print` over `dohc-app-channel`) from a click or key handler. When the printable area scrolls inside a fixed-height container, expand it in `@media print` (`height: auto; overflow: visible`) and pass `{ height }` with the container's full scroll height so rows below the viewport are not clipped. For standalone offline exports, generate a Blob download via `allow-downloads`.
- Call `requestFullscreen()` only when `document.fullscreenEnabled` is `true`, from a click or key handler. A share link allows full screen; dohc's own tab and `verifyFrontend` don't, and there it rejects and logs a Permissions Policy `console.error` that fails `verifyFrontend`. Fill the frame with CSS (`height: 100vh`).
- Give an `IntersectionObserver` an explicit `root` (`document` or the scrolling element) when it uses `rootMargin`. Without one, the opaque-origin frame ignores `rootMargin`, and content loads only once it is already visible.

## Verifying an app frontend (`dohc_publish_app` `verifyFrontend`)

Before publishing or handing an app to a user, verify its compiled frontend inside dohc's real sandboxed document, CSP, and `dohc-app-channel` broker with `{ action: "verifyFrontend", workspaceId, appRoot }` (candidate source) or `{ action: "verifyFrontend", workspaceId, publicationId }` (active local publication). Specify exactly one of `appRoot` or `publicationId`.

- Runs completely offline against a fresh, empty ephemeral Collection database (never reads or mutates live Collection rows, uploaded files, or workspace files).
- Catches manifest/input errors, bundle compile errors, CSP violations (inline scripts, native form submission without `event.preventDefault()`), uncaught page/console errors, broken `dohc-app-channel` handshakes, malformed broker messages, and unapproved operations.
- Optional checks:
  - `expectStartupBackend`: array of `{ op?, operation?, status?, refusalCode? }` expected during startup.
  - `steps`: ordered UI checks (`{ kind: "waitFor", selector, textIncludes? }`, `{ kind: "fill", selector, value }`, `{ kind: "click", selector, expectBackend? }`).
  - `timeoutMs`: `1000`–`30000` (default `10000`).
- Use `dohc_test_app` for quick folder detection and entry presence checks; use `verifyFrontend` to compile and run the frontend end to end against an empty ephemeral Collection.

```json
{
  "request": {
    "action": "verifyFrontend",
    "workspaceId": "<workspaceId>",
    "appRoot": "apps/booking",
    "steps": [
      { "kind": "fill", "selector": "#name", "value": "Ada" },
      { "kind": "fill", "selector": "#seats", "value": "5" },
      {
        "kind": "click",
        "selector": "#submit",
        "expectBackend": { "op": "backend.invoke", "operation": "createBooking", "status": 200 }
      },
      { "kind": "waitFor", "selector": "#status", "textIncludes": "Booked" }
    ]
  }
}
```

## Local approval, staging, and launch (`dohc_publish_app`)

Pass `{ request: { action, ... } }` to `dohc_publish_app`:

- **App-only local approval**:
  1. `{ action: "prepareLocal", workspaceId, appRoot }` -> returns `approvalId`, `candidateDigest`.
  2. `{ action: "approve", workspaceId, approvalId, candidateDigest }` -> returns `publicationId`.
  3. `{ action: "launchLocal", workspaceId, publicationId }` -> returns a local `url` while dohc is open.
- **Combined app + Collection staging** (creates or migrates bound Collections and approves the local app in one review):
  1. `{ action: "stage", workspaceId, appRoot, migrations?: { "<datasetPath>": "<migration.sql>" } }` -> returns `stage.stageId` and `stage.reviewDigest`. Omit a Collection's entry from `migrations` (or omit `migrations`) for operations-only updates without schema SQL changes.
  2. `{ action: "approveStaged", workspaceId, stageId, reviewDigest }` -> applies Collection changes and activates the local app.

## Publishing to a share link (`dohc_publish_app`)

1. **Create link**: `{ action: "createLink", workspaceId, appRoot, operationId: "<fresh UUID>" }` -> returns `shareId`, `grantId`, and one-time bearer `url`. Reuse the same `operationId` on retry.
2. **Prepare**: `{ action: "prepare", workspaceId, appRoot, shareId, grantId }` -> returns `approvalId`, `candidateDigest`.
3. **Approve**: `{ action: "approve", workspaceId, approvalId, candidateDigest }` -> returns `publicationId` and `appQuery` (`?app=<publicationId>`).
4. Append `appQuery` before the `#` fragment of the share link URL. Keep the share link secret out of workspace files and dohc requests.

## Publishing to workspace members (`dohc_publish_app`)

1. **Prepare**: `{ action: "prepare", workspaceId, appRoot, audience: "workspace" }` -> returns `approvalId`, `candidateDigest`. Omit `shareId` and `grantId`.
2. **Approve**: `{ action: "approve", workspaceId, approvalId, candidateDigest }` -> returns `publicationId`.
3. A member opens the app only while they can see the app folder and every bound Collection. Below Edit, they run only read-only actions. Each member gets the actions their own grant gives, plus the defaults for their level, set with `dohc_dataset` `{ action: "setDefaults", workspaceId, datasetPath, defaults: { view, comment, edit, revision, revisionSha256 } }`. Defaults never include owner-only actions, and `view` and `comment` defaults are read-only.

## Re-approving apps after a standalone Collection migration

1. Inspect `boundApps` returned by `prepareSchemaChange`, `prepareMigration`, `prepareRelationChoices`, `prepareHistoryRestore`, or `dataset permissions`.
2. Each entry reports `scope` (`"local"` or `"link"`), `appRoot`, `shareId`/`grantId` (for share links), `status` (`"compatible"`, `"needs-refresh"`, or `"incompatible"`), and plain-English `reasons` when incompatible. If `boundAppsIncomplete` is `true`, check `dataset permissions` after applying the change.
3. For `"incompatible"` apps, update the app's source or `app.publish.json` to match the changed actions or fields first.
4. For older apps whose `app.publish.json` still pins `revision` and `revisionSha256`, remove those two fields once.
5. Re-approve each affected local app with `prepareLocal` + `approve` (or `stage` + `approveStaged`), and each affected share-link app with `prepare` + `approve` using its `shareId` and `grantId`. Re-publishing a share-link app returns a new `appQuery` (`?app=<newPublicationId>`); withdraw the previous `publicationId` explicitly when ready.
