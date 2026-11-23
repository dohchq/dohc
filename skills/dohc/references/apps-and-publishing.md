# Apps and publishing

An app is a folder of web files in the workspace. When it needs structured data, it binds to approved operations on a transactional Collection through `app.publish.json` and calls them over the `dohc-app-channel` `MessagePort`.

## `app.publish.json` format

Place `app.publish.json` inside the app folder:

```json
{
  "version": 1,
  "entryPath": "index.html",
  "inputs": ["index.html", "app.js", "styles.css"],
  "packageMap": {},
  "dataset": {
    "kind": "dataset",
    "datasetPath": "tracker/dataset.json",
    "revision": 1,
    "revisionSha256": "<64-char hex from describe or approve>",
    "operationIds": ["<approved operation UUID>"]
  }
}
```

Rules:

- Always include `"version": 1`.
- `entryPath`, every entry in `inputs`, and every `packageMap` target are relative to the app folder with no leading `/`. `inputs` must include `entryPath`.
- `dataset.datasetPath` is relative to the workspace root and ends in `dataset.json`.
- Only one of `dataset` or `collection` may appear.
- For public share-link apps, list only `access: "link"` operations in `operationIds`. Never include owner-only reads in a public app manifest.

## Calling Collection operations from app code (`dohc-app-channel`)

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

// Example call (use a fresh idempotencyKey per call; reuse the same key on write retry):
// const { result } = await send({
//   op: "backend.invoke",
//   operation: "listExpenses",
//   input: {},
//   idempotencyKey: crypto.randomUUID(),
// });
```

Other app channel operations: `backend.upload` (`name`, `contentType`, `bytesBase64`, `idempotencyKey`), `backend.file` (`fileId`, `operation`, `input`), `backend.attempt` (`operation`, `request`), and for document-Collection share-link apps: `collection.list` and `collection.create`.

## Verifying an app frontend (`dohc_publish_app` `verifyFrontend`)

Before publishing or handing an app to a user, verify its compiled frontend inside dohc's real sandboxed document, CSP, and `dohc-app-channel` broker with `{ action: "verifyFrontend", workspaceId, appRoot }` (candidate source) or `{ action: "verifyFrontend", workspaceId, publicationId }` (active local publication). Specify exactly one of `appRoot` or `publicationId`.

- Runs completely offline against a fresh, empty ephemeral Collection database (never reads or mutates live Collection rows, uploaded files, or workspace files).
- Catches manifest/input errors, bundle compile errors, CSP violations (inline scripts, native form submission without `event.preventDefault()`), uncaught page/console errors, broken `dohc-app-channel` handshakes, malformed broker messages, and unapproved operations.
- Optional checks:
  - `expectStartupBackend`: array of `{ op?, operation?, status?, refusalCode? }` expected during startup.
  - `steps`: ordered UI checks (`{ kind: "waitFor", selector, textIncludes? }`, `{ kind: "fill", selector, value }`, `{ kind: "click", selector, expectBackend? }`).
  - `timeoutMs`: `1000`–`30000` (default `10000`).
- Use `dohc_test_app` to test a Collection's SQL schema and backend operations in isolation; use `verifyFrontend` to verify the compiled browser frontend end to end against those operations.

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

## Local approval and launch (`dohc_publish_app`)

Pass `{ request: { action, ... } }` to `dohc_publish_app`:

1. **Prepare**: `{ action: "prepareLocal", workspaceId, appRoot }` -> returns `approvalId`, `candidateDigest`.
2. **Approve**: `{ action: "approve", workspaceId, approvalId, candidateDigest }` -> returns `publicationId`.
3. **Launch**: `{ action: "launchLocal", workspaceId, publicationId }` -> returns a local `url` that works while dohc is open.

## Publishing to a share link (`dohc_publish_app`)

1. **Create link**: `{ action: "createLink", workspaceId, appRoot, operationId: "<fresh UUID>" }` -> returns `shareId`, `grantId`, and one-time bearer `url`. Reuse the same `operationId` on retry.
2. **Prepare**: `{ action: "prepare", workspaceId, appRoot, shareId, grantId }` -> returns `approvalId`, `candidateDigest`.
3. **Approve**: `{ action: "approve", workspaceId, approvalId, candidateDigest }` -> returns `publicationId` and `appQuery` (`?app=<publicationId>`).
4. Append `appQuery` before the `#` fragment of the share link URL. Keep the share link secret out of workspace files and dohc requests.
