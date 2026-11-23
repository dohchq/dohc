const CATEGORIES = new Set(["Food", "Transport", "Housing", "Health", "Gear", "Other"]);

globalThis.operations = {
  listExpenses(ctx) {
    return ctx.db.query(
      "SELECT id, spent_on AS date, merchant, category, amount, note FROM expenses ORDER BY spent_on DESC, id DESC LIMIT 200",
    );
  },
  addExpense(ctx, input) {
    const date = typeof input?.date === "string" ? input.date.trim() : "";
    const merchant = typeof input?.merchant === "string" ? input.merchant.trim() : "";
    const category = typeof input?.category === "string" ? input.category.trim() : "";
    const amount = Number(input?.amount);
    const note = typeof input?.note === "string" ? input.note.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      ctx.refuse("invalid_date", "Enter a date as YYYY-MM-DD.");
    if (!merchant || merchant.length > 120)
      ctx.refuse("invalid_merchant", "Enter a merchant name.");
    if (!CATEGORIES.has(category)) ctx.refuse("invalid_category", "Choose a valid category.");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)
      ctx.refuse("invalid_amount", "Enter a positive amount.");
    const id = `exp_${ctx.requestId}`;
    ctx.db.execute(
      "INSERT INTO expenses (id, spent_on, merchant, category, amount, note) VALUES (?, ?, ?, ?, ?, ?)",
      [id, date, merchant, category, Math.round(amount * 100) / 100, note || null],
    );
    return {
      id,
      date,
      merchant,
      category,
      amount: Math.round(amount * 100) / 100,
      note: note || null,
    };
  },
  deleteExpense(ctx, input) {
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    if (!id) ctx.refuse("invalid_id", "Choose an expense to delete.");
    ctx.db.execute("DELETE FROM expenses WHERE id = ?", [id]);
    return { deleted: true, id };
  },
};
