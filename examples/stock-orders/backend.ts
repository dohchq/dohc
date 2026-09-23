// Stock-limited orders use the same database and operation APIs as the fundraiser.
(function () {
  function invalid(ctx, message) { ctx.refuse("invalid_input", message); }
  function organizer(ctx) {
    if (ctx.caller.kind !== "owner" && !(ctx.caller.kind === "named" && ctx.caller.helper)) ctx.refuse("forbidden", "Organizer access is required.");
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
  function search(ctx, input) {
    const value = input.search === undefined ? "" : input.search;
    if (typeof value !== "string" || value.length > 100) invalid(ctx, "The search is invalid.");
    return value;
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
    const receipt = input.receiptFileId === undefined ? null : ctx.files.attach(input.receiptFileId);
    ctx.db.execute("INSERT INTO orders(id,customer_name,status,total_cents,receipt_file_id,version,created_at_ms) VALUES(?,?,'pending',?,?,1,?)", [ctx.requestId, input.customerName.trim(), totalCents, receipt ? receipt.fileId : null, ctx.nowMs]);
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
  function receiptAccess(ctx, input) {
    organizer(ctx); object(ctx, input);
    if (typeof input.id !== "string") invalid(ctx, "Choose an order.");
    const order = ctx.db.query("SELECT receipt_file_id FROM orders WHERE id=?", [input.id])[0];
    if (!order || !order.receipt_file_id) ctx.refuse("not_found", "This order has no receipt.");
    return {fileId: order.receipt_file_id};
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
  const collectionTables = {"tableItems":{"sqlName":"items","version":false,"fields":[{"fieldId":"f0020000-0000-4000-8000-000000000003","sqlColumn":"id","type":"text"},{"fieldId":"f0020000-0000-4000-8000-000000000004","sqlColumn":"name","type":"text"},{"fieldId":"f0020000-0000-4000-8000-000000000005","sqlColumn":"price_cents","type":"number"},{"fieldId":"f0020000-0000-4000-8000-000000000006","sqlColumn":"remaining","type":"number"}]},"tableOrders":{"sqlName":"orders","version":true,"fields":[{"fieldId":"f0020000-0000-4000-8000-000000000008","sqlColumn":"id","type":"text"},{"fieldId":"f0020000-0000-4000-8000-000000000009","sqlColumn":"customer_name","type":"text"},{"fieldId":"f0020000-0000-4000-8000-000000000010","sqlColumn":"status","type":"select"},{"fieldId":"f0020000-0000-4000-8000-000000000011","sqlColumn":"total_cents","type":"number"},{"fieldId":"f0020000-0000-4000-8000-000000000012","sqlColumn":"version","type":"number"},{"fieldId":"f0020000-0000-4000-8000-000000000013","sqlColumn":"created_at_ms","type":"number"}]},"tableOrderItems":{"sqlName":"order_items","version":false,"fields":[{"fieldId":"f0020000-0000-4000-8000-000000000015","sqlColumn":"id","type":"text"},{"fieldId":"f0020000-0000-4000-8000-000000000016","sqlColumn":"order_id","type":"relation"},{"fieldId":"f0020000-0000-4000-8000-000000000017","sqlColumn":"item_id","type":"relation"},{"fieldId":"f0020000-0000-4000-8000-000000000018","sqlColumn":"quantity","type":"number"},{"fieldId":"f0020000-0000-4000-8000-000000000019","sqlColumn":"unit_price_cents","type":"number"}]}};

  // Collection reads project stable field IDs; edits below call the same domain rules as the app.
  function collectionRead(ctx, input, table) {
    organizer(ctx); object(ctx, input);
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid(ctx, "Choose a page size from 1 to 100.");
    const fields = table.fields;
    let sort = fields[0], direction = "asc";
    if (input.sort !== undefined) {
      sort = fields.find(field => field.fieldId === input.sort.fieldId);
      direction = input.sort.direction;
      if (!sort || sort.type === "attachment" || !["asc", "desc"].includes(direction)) invalid(ctx, "Choose a sortable field.");
    }
    const encode = value => typeof value === "boolean" ? Number(value) : value;
    const decode = (field, value) => value === null ? null : field.type === "checkbox" ? value === 1 : value;
    const q = value => '"' + value + '"';
    const terms = [], params = [];
    if (input.search !== undefined && input.search !== "") {
      if (typeof input.search !== "string" || input.search.length > 200) invalid(ctx, "Keep the search under 200 characters.");
      const searchable = fields.filter(field => ["text", "select"].includes(field.type));
      terms.push("(" + searchable.map(field => "instr(lower(" + q(field.sqlColumn) + "),lower(?))>0").join(" OR ") + ")");
      params.push(...searchable.map(() => input.search));
    }
    if (input.filters !== undefined) {
      if (!Array.isArray(input.filters) || input.filters.length > 20) invalid(ctx, "Choose up to 20 filters.");
      for (const filter of input.filters) {
        const field = fields.find(field => field.fieldId === filter.fieldId);
        if (!field || (filter.value !== null && !["string", "number", "boolean"].includes(typeof filter.value))) invalid(ctx, "Choose a valid filter.");
        terms.push(q(field.sqlColumn) + " IS ?"); params.push(encode(filter.value));
      }
    }
    if (input.group !== undefined) {
      object(ctx, input.group);
      const field = fields.find(field => field.fieldId === input.group.fieldId), value = input.group.value;
      if (!field || (value !== null && !["string", "number", "boolean"].includes(typeof value))) invalid(ctx, "Choose a valid group.");
      terms.push(q(field.sqlColumn) + " IS ?"); params.push(encode(value));
    }
    if (input.range !== undefined) {
      object(ctx, input.range);
      const range = input.range, field = fields.find(field => field.fieldId === range.fieldId);
      const day = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
      if (!field || field.type !== "date" || !day(range.start) || !day(range.end) || range.start >= range.end) invalid(ctx, "Choose a valid date range.");
      terms.push(q(field.sqlColumn) + " >= ? AND " + q(field.sqlColumn) + " < ?"); params.push(range.start,range.end);
    }
    if (input.groupBy !== undefined) {
      const field = fields.find(field => field.fieldId === input.groupBy);
      if (!field || field.type === "attachment" || limit > 8 || input.after !== undefined || input.sort !== undefined) invalid(ctx, "Choose a valid group field.");
      const group = q(field.sqlColumn);
      if (input.groupAfter !== undefined) {
        object(ctx,input.groupAfter);
        const value = input.groupAfter.value;
        if (value !== null && !["string","number","boolean"].includes(typeof value)) invalid(ctx,"Choose a valid group page.");
        if (value === null) terms.push(group + " IS NOT NULL");
        else { terms.push(group + " > ?"); params.push(encode(value)); }
      }
      const rows = ctx.db.query("SELECT DISTINCT " + group + " AS value FROM " + q(table.sqlName) + (terms.length ? " WHERE " + terms.join(" AND ") : "") + " ORDER BY " + group + " ASC NULLS FIRST LIMIT ?",[...params,limit+1]);
      const more = rows.length > limit; if(more)rows.pop();
      return {groupBy:field.fieldId,groups:rows.map(row=>decode(field,row.value)),nextGroupCursor:more?{value:decode(field,rows[rows.length-1].value)}:null};
    }
    if (input.after !== undefined && input.after !== null) {
      const after = input.after;
      if (typeof after.id !== "string" || !["string", "number", "boolean"].includes(typeof after.value)) invalid(ctx, "The page reference is invalid.");
      const compare = direction === "asc" ? ">" : "<";
      terms.push("(" + q(sort.sqlColumn) + compare + "? OR (" + q(sort.sqlColumn) + "=? AND id" + compare + "?))");
      params.push(encode(after.value), encode(after.value), after.id);
    }
    const columns = fields.map(field => q(field.sqlColumn));
    if (table.version && !columns.includes(q("version"))) columns.push(q("version"));
    const rows = ctx.db.query("SELECT " + columns.join(",") + " FROM " + q(table.sqlName) + (terms.length ? " WHERE " + terms.join(" AND ") : "") +
      " ORDER BY " + q(sort.sqlColumn) + " " + direction + ",id " + direction + " LIMIT ?", [...params, limit + 1]);
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows[rows.length - 1];
    return {rows: rows.map(row => ({id: row.id, version: table.version ? row.version : 1,
      values: Object.fromEntries(fields.map(field => [field.fieldId, decode(field, row[field.sqlColumn])]))})),
      nextCursor: more ? {id: last.id, value: decode(sort, last[sort.sqlColumn])} : null, ...(input.range ? {range:input.range} : {}), ...(input.group ? {group:input.group} : {})};
  }
  function tableItems(ctx, input) { return collectionRead(ctx, input, collectionTables.tableItems); }
  function tableOrders(ctx, input) { return collectionRead(ctx, input, collectionTables.tableOrders); }
  function tableOrderItems(ctx, input) { return collectionRead(ctx, input, collectionTables.tableOrderItems); }
  function editOrderStatus(ctx, input) {
    organizer(ctx); object(ctx, input);
    const fieldId = "f0020000-0000-4000-8000-000000000010";
    if (!input.values || Object.keys(input.values).length !== 1 || !Object.hasOwn(input.values, fieldId)) invalid(ctx, "Use the status field to update this record.");
    const before = ctx.db.query("SELECT status FROM orders WHERE id=?", [input.id])[0];
    const changed = setStatus(ctx, {id: input.id, expectedVersion: input.expectedVersion, status: input.values[fieldId]});
    return {id: changed.id, version: changed.version, priorValues: {[fieldId]: before.status}};
  }
  collectionTables.tableOrders.fields.push({fieldId: "f0020000-0000-4000-8000-000000000030", sqlColumn: "receipt_file_id", type: "attachment"});
  globalThis.operations = {receiptAccess, editOrderStatus, listItems, placeOrder, listOrders, listOrderItems, setStatus, updateOrder, tableItems, tableOrders, tableOrderItems};
}());
