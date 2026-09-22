# Stock orders

This example is for an app author checking that dohc's operation host supports a different set of business rules.
The order form and stock board use the same isolated runtime and database APIs as the fundraiser.
No runtime code recognizes shirts, stock, or order statuses.

`listItems` returns public stock and prices in cents. `placeOrder` accepts a customer name and up to 20 distinct items.
The backend calculates prices and reserves all requested stock in one transaction.
If one item lacks stock, the entire order refuses.
Orders can attach an optional receipt. The uploaded file becomes private order data in the same transaction.
The form saves its exact request through dohc before placing the order. Reopening offers that request for retry.
Keep the page open while uploading; an unfinished upload has not saved the draft yet.
The example keeps one saved order per browser and app. It has no checkout or payment processing.

Organizers call `listOrders`, `listOrderItems`, `receiptAccess`, and `setStatus`.
Cancelling an order returns its stock. Restoring it requires enough stock for every item.
`editOrderStatus` exposes the same status action for Collection editing and returns an undo receipt.
Both paths require the expected row version.

[schema.sql](schema.sql) defines `items`, `orders`, and `order_items`, each with an explicit primary key named `id`.
[dataset.json](dataset.json) declares the dataset's fields, relations, and approved operations.
Copy this folder into a workspace as `stock-orders`. Approve its descriptor and captured schema and operations first.
[app.binding.json](app.binding.json) is the pinned reference to place under `dataset` in your app's `app.publish.json`.
Declare only your frontend inputs there. Changing the dataset sources requires a new approval and an updated binding hash.
Publish `stock-orders` to open the order form from [app.publish.json](app.publish.json).
Publish `stock-orders/board` to open a separate read-only app from [board/app.publish.json](board/app.publish.json).
The board uses the same inventory. Its cards are ordinary app source, and its grant cannot place orders or upload files.
Both declarations capture frontend files from `stock-orders`; a shared link must include that folder.
`listItems` and `placeOrder` allow link callers; management operations require helper access.
Only `placeOrder`, `setStatus`, `updateOrder`, and `editOrderStatus` write data.

Owner tables use `tableItems`, `tableOrders`, and `tableOrderItems`.
They accept `after`, `limit` (1–100), `search`, `sort`, and `filters`.
They return `{ rows: [{ id, version, values }], nextCursor }`, with values keyed by stable field ID.
Search matches literal substrings in IDs and text fields, ignoring ASCII case; `%` and `_` are ordinary characters.
Pagination runs in SQL. Existing public and organizer list operations retain their original result shapes.

The runtime and dataset-host tests prove atomic reservation, cancellation, restoration, stale edits, and app/Collection access to the same records:

```sh
pnpm --filter @dohc/app-backend-runtime test src/examples.test.ts src/dataset-examples.test.ts
```

The browser proof compiles both real apps and runs them through the local launch broker and SQLite host.
It submits two related order lines with a receipt, checks the stock board, and reads the same records through Collection and MCP interfaces.
It also checks that a stock shortage rolls back every line and inventory change.

```sh
pnpm --filter @dohc/app-backend-runtime build
pnpm --filter @dohc/share-web exec playwright test e2e/stock-orders.spec.ts --config playwright.config.ts
```
