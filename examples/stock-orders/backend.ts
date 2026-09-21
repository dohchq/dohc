// Stock-limited orders use the same database and operation APIs as the fundraiser.
(function () {
  function invalid(ctx, message) { ctx.refuse("invalid_input", message); }
  function organizer(ctx) {
    if (ctx.caller.kind !== "owner" && !(ctx.caller.kind === "named" && ctx.caller.helper && ctx.caller.access === "edit")) ctx.refuse("forbidden", "Organizer access is required.");
  }
  function object(ctx, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid(ctx, "Enter the order details.");
  }
  function page(ctx, input) {
    const limit = input.limit === undefined ? 50 : input.limit;
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid(ctx, "The page is invalid.");
    return {limit, offset};
  }
  function listItems(ctx) {
    return ctx.db.query("SELECT id,name,price_cents AS priceCents,remaining FROM items ORDER BY id LIMIT 100");
  }
  function placeOrder(ctx, input) {
    object(ctx, input);
    if (typeof input.customerName !== "string" || !input.customerName.trim() || input.customerName.length > 150) invalid(ctx, "Enter a name, up to 150 characters.");
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) invalid(ctx, "Choose between one and 20 items.");
    const seen = new Set();
    const lines = input.items.map(line => {
      object(ctx, line);
      if (typeof line.itemId !== "string" || seen.has(line.itemId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 1000) invalid(ctx, "Enter each item once with a quantity from one to 1,000.");
      seen.add(line.itemId);
      const item = ctx.db.query("SELECT id,price_cents,remaining FROM items WHERE id=?", [line.itemId])[0];
      if (!item) invalid(ctx, "An item is unavailable.");
      return {itemId: item.id, quantity: line.quantity, unitPriceCents: item.price_cents};
    }).sort((a, b) => a.itemId < b.itemId ? -1 : 1);
    let totalCents = 0;
    for (const line of lines) {
      if (ctx.db.execute("UPDATE items SET remaining=remaining-? WHERE id=? AND remaining>=?", [line.quantity, line.itemId, line.quantity]).changes !== 1) ctx.refuse("stock_unavailable", "An item no longer has enough stock.");
      totalCents += line.quantity * line.unitPriceCents;
    }
    if (!Number.isSafeInteger(totalCents)) invalid(ctx, "The order total is too large.");
    ctx.db.execute("INSERT INTO orders(id,customer_name,status,total_cents,version,created_at_ms) VALUES(?,?,'pending',?,1,?)", [ctx.requestId, input.customerName.trim(), totalCents, ctx.nowMs]);
    for (const line of lines) ctx.db.execute("INSERT INTO order_items(id,order_id,item_id,quantity,unit_price_cents) VALUES(?,?,?,?,?)", [ctx.requestId + "_" + line.itemId, ctx.requestId, line.itemId, line.quantity, line.unitPriceCents]);
    return {id: ctx.requestId, status: "pending", totalCents, version: 1};
  }
  function listOrders(ctx, input) {
    organizer(ctx); object(ctx, input);
    const {limit, offset} = page(ctx, input);
    const rows = ctx.db.query("SELECT id,customer_name AS customerName,status,total_cents AS totalCents,version,created_at_ms AS createdAtMs FROM orders ORDER BY created_at_ms DESC,id DESC LIMIT ? OFFSET ?", [limit + 1, offset]);
    return {records: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null};
  }
  function listOrderItems(ctx, input) {
    organizer(ctx); object(ctx, input);
    const {limit, offset} = page(ctx, input);
    const rows = ctx.db.query("SELECT id,order_id AS orderId,item_id AS itemId,quantity,unit_price_cents AS unitPriceCents FROM order_items ORDER BY id LIMIT ? OFFSET ?", [limit + 1, offset]);
    return {records: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null};
  }
  function setStatus(ctx, input) {
    organizer(ctx); object(ctx, input);
    const nextStatus = input.status;
    if (!["pending", "confirmed", "cancelled"].includes(nextStatus) || typeof input.id !== "string") invalid(ctx, "Choose an order and status.");
    const order = ctx.db.query("SELECT id,status,version,total_cents FROM orders WHERE id=?", [input.id])[0];
    if (!order) ctx.refuse("not_found", "Order not found.");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== order.version) ctx.refuse("conflict", "This order changed. Reload it before updating.");
    if ((order.status === "cancelled") !== (nextStatus === "cancelled")) {
      const lines = ctx.db.query("SELECT item_id,quantity FROM order_items WHERE order_id=? ORDER BY item_id", [order.id]);
      for (const line of lines) {
        const changed = nextStatus === "cancelled"
          ? ctx.db.execute("UPDATE items SET remaining=remaining+? WHERE id=?", [line.quantity, line.item_id]).changes
          : ctx.db.execute("UPDATE items SET remaining=remaining-? WHERE id=? AND remaining>=?", [line.quantity, line.item_id, line.quantity]).changes;
        if (changed !== 1) ctx.refuse("stock_unavailable", "An item no longer has enough stock.");
      }
    }
    ctx.db.execute("UPDATE orders SET status=?,version=version+1 WHERE id=? AND version=?", [nextStatus, order.id, order.version]);
    return {id: order.id, status: nextStatus, totalCents: order.total_cents, version: order.version + 1};
  }
  function updateOrder(ctx, input) {
    organizer(ctx); object(ctx, input);
    if (input.field !== "status") invalid(ctx, "Use the status action to update an order.");
    return setStatus(ctx, {id: input.rowId, status: input.value, expectedVersion: input.expectedVersion});
  }
  globalThis.operations = {listItems, placeOrder, listOrders, listOrderItems, setStatus, updateOrder};
}());
