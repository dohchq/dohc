# Stock order backend

This example is for an app author checking that dohc's operation host supports a different set of business rules.
It has no frontend. It uses the same isolated runtime and database APIs as the fundraiser.
No runtime code recognizes shirts, stock, or order statuses.

`listItems` returns public stock and prices in cents. `placeOrder` accepts a customer name and up to 20 distinct items.
The backend calculates prices and reserves all requested stock in one transaction.
If one item lacks stock, the entire order refuses.

Organizers call `listOrders`, `listOrderItems`, and `setStatus`.
Cancelling an order returns its stock. Restoring it requires enough stock for every item.
`updateOrder` exposes the same status action for owner table editing.
Both paths require the expected row version.

[schema.sql](schema.sql) defines `items`, `orders`, and `order_items`, each with an explicit primary key named `id`.
[backend.publish.json](backend.publish.json) is the backend declaration to place under `backend` in an app's `app.publish.json`.
It uses workspace-relative paths under `stock-orders`. Add the backend, schema, and your own frontend to that app's declared inputs.
`listItems` and `placeOrder` allow link callers; management operations require helper access.
Only `placeOrder`, `setStatus`, and `updateOrder` write data.

Owner tables use `tableItems`, `tableOrders`, and `tableOrderItems`.
They accept `offset`, `limit` (1–100), and `search`, and return `{ rows, total }` with a filtered total.
Search matches literal substrings in IDs and text fields, ignoring ASCII case; `%` and `_` are ordinary characters.
Pagination runs in SQL. Existing public and organizer list operations retain their original result shapes.

The shared runtime test proves atomic reservation, cancellation, restoration, stale update rejection, and private order lists:

```sh
pnpm --filter @dohc/app-backend-runtime test src/examples.test.ts
```
