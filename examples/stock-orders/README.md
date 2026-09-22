# Stock order backend

This example is for an app author checking that dohc's operation host supports a different set of business rules.
It has no frontend. It uses the same isolated runtime and database APIs as the fundraiser.
No runtime code recognizes shirts, stock, or order statuses.

`listItems` returns public stock and prices in cents. `placeOrder` accepts a customer name and up to 20 distinct items.
The backend calculates prices and reserves all requested stock in one transaction.
If one item lacks stock, the entire order refuses.

Organizers call `listOrders`, `listOrderItems`, and `setStatus`.
Cancelling an order returns its stock. Restoring it requires enough stock for every item.
`editOrderStatus` exposes the same status action for Collection editing and returns an undo receipt.
Both paths require the expected row version.

[schema.sql](schema.sql) defines `items`, `orders`, and `order_items`, each with an explicit primary key named `id`.
[dataset.json](dataset.json) declares the dataset's fields, relations, and approved operations.
Copy this folder into a workspace as `stock-orders`. Approve its descriptor and captured schema and operations first.
[app.binding.json](app.binding.json) is the pinned reference to place under `dataset` in your app's `app.publish.json`.
Declare only your frontend inputs there. Changing the dataset sources requires a new approval and an updated binding hash.
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
