const EFFORTS = new Set(["Easy", "Moderate", "Hard"]);

globalThis.operations = {
  listWorkouts(ctx) {
    return ctx.db.query(
      "SELECT id, done_on AS date, activity, minutes, effort, notes FROM workouts ORDER BY done_on DESC, id DESC LIMIT 200",
    );
  },
  logWorkout(ctx, input) {
    const date = typeof input?.date === "string" ? input.date.trim() : "";
    const activity = typeof input?.activity === "string" ? input.activity.trim() : "";
    const minutes = Math.round(Number(input?.minutes));
    const effort = typeof input?.effort === "string" ? input.effort.trim() : "";
    const notes = typeof input?.notes === "string" ? input.notes.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      ctx.refuse("invalid_date", "Enter a date as YYYY-MM-DD.");
    if (!activity || activity.length > 120)
      ctx.refuse("invalid_activity", "Enter an activity name.");
    if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 1440)
      ctx.refuse("invalid_minutes", "Enter minutes between 1 and 1440.");
    if (!EFFORTS.has(effort)) ctx.refuse("invalid_effort", "Choose Easy, Moderate, or Hard.");
    const id = `wrk_${ctx.requestId}`;
    ctx.db.execute(
      "INSERT INTO workouts (id, done_on, activity, minutes, effort, notes) VALUES (?, ?, ?, ?, ?, ?)",
      [id, date, activity, minutes, effort, notes || null],
    );
    return { id, date, activity, minutes, effort, notes: notes || null };
  },
  deleteWorkout(ctx, input) {
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    if (!id) ctx.refuse("invalid_id", "Choose a workout to delete.");
    ctx.db.execute("DELETE FROM workouts WHERE id = ?", [id]);
    return { deleted: true, id };
  },
};
