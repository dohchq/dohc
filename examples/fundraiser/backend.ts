// This source runs in dohc's isolated operation host. Every write is one transaction.
(function () {
  const PLAYER_PRICE = 1000;
  const SPECTATOR_PRICE = 150;
  const SESSION_IDS = ["s1", "s2"];
  const STATUSES = ["pending_verification", "verified", "rejected", "pay_at_venue"];
  const PAYMENT_METHODS = ["gcash", "bdo", "unionbank", "bpi", "cash"];

  function invalid(ctx, message) { return ctx.refuse("invalid_input", message); }
  function organizer(ctx) {
    if (ctx.caller.kind !== "owner" && !(ctx.caller.kind === "named" && ctx.caller.helper && ctx.caller.access === "edit")) {
      ctx.refuse("forbidden", "Organizer access is required.");
    }
  }
  function object(ctx, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid(ctx, "Enter the registration details.");
    return input;
  }
  function name(ctx, input) {
    if (typeof input !== "string" || input.length > 150 || /[\r\n]/.test(input)) invalid(ctx, "Enter a first and last name, up to 150 characters.");
    const value = input.trim().replace(/\s+/g, " ");
    const words = value.split(" ");
    if (words.length < 2 || words.some(word => !/\p{L}/u.test(word))) invalid(ctx, "Enter a first and last name.");
    return value;
  }
  function nameKey(value) { return value.normalize("NFKC").toLowerCase(); }
  function mobile(ctx, input, optional) {
    if (optional && (input === undefined || input === "")) return "";
    if (typeof input !== "string" || input.length > 24 || !/^[\d+()\s-]+$/.test(input)) invalid(ctx, "Enter a Philippine mobile number.");
    let digits = input.replace(/[()\s-]/g, "");
    if (digits.startsWith("00")) digits = "+" + digits.slice(2);
    if (/^0(?:9\d{9}|817\d{7})$/.test(digits)) digits = "+63" + digits.slice(1);
    if (/^63(?:9\d{9}|817\d{7})$/.test(digits)) digits = "+" + digits;
    if (/^(?:9\d{9}|817\d{7})$/.test(digits)) digits = "+63" + digits;
    if (!/^\+63(?:817|90[5-9]|9[1-9]\d)\d{7}$/.test(digits)) invalid(ctx, "Enter a Philippine mobile number, such as 0917 123 4567.");
    return digits;
  }
  function payment(ctx, input, allowCash) {
    if (!PAYMENT_METHODS.includes(input) || (!allowCash && input === "cash")) invalid(ctx, "Choose a payment method.");
    return input;
  }
  function status(ctx, input) {
    if (!STATUSES.includes(input)) invalid(ctx, "Choose a registration status.");
    return input;
  }
  function session(ctx, input) {
    if (!SESSION_IDS.includes(input)) invalid(ctx, "Choose a session.");
    return input;
  }
  function pageInput(ctx, input, max) {
    const limit = input.limit === undefined ? 50 : input.limit;
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid(ctx, "The page is invalid.");
    return {limit, offset};
  }
  function roster(ctx, input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 2) invalid(ctx, "Choose one or both sessions.");
    const seen = new Set();
    return input.map(raw => {
      object(ctx, raw);
      const sessionId = session(ctx, raw.sessionId);
      if (seen.has(sessionId)) invalid(ctx, "A session was repeated.");
      seen.add(sessionId);
      if (!Array.isArray(raw.players) || !Array.isArray(raw.spectators) || raw.players.length > 36 || raw.spectators.length > 100) invalid(ctx, "Each session allows up to 36 players and 100 spectators per registration.");
      const players = raw.players.map(value => name(ctx, value));
      const spectators = raw.spectators.map(value => name(ctx, value));
      const names = players.concat(spectators).map(nameKey);
      if (!names.length) invalid(ctx, "Add an attendee to each selected session.");
      if (new Set(names).size !== names.length) ctx.refuse("duplicate_attendee", "A person cannot appear twice in one session.");
      return {sessionId, players, spectators};
    }).sort((a, b) => a.sessionId < b.sessionId ? -1 : 1);
  }
  function summary(ctx, row) {
    return {
      id: row.id, status: row.status, total: row.total_php, version: row.version, createdAtMs: row.created_at_ms,
      sessions: ctx.db.query("SELECT session_id,player_count,spectator_count FROM registration_sessions WHERE registration_id=? ORDER BY session_id", [row.id])
        .map(item => ({sessionId: item.session_id, players: item.player_count, spectators: item.spectator_count})),
    };
  }
  function registration(ctx, id) {
    if (typeof id !== "string" || id.length > 128) invalid(ctx, "The registration reference is invalid.");
    const row = ctx.db.query("SELECT * FROM registrations WHERE id=?", [id])[0];
    if (!row) ctx.refuse("not_found", "Registration not found.");
    return row;
  }
  function changeCapacity(ctx, rows, direction) {
    for (const row of rows) {
      const count = row.player_count;
      const changed = direction === 1
        ? ctx.db.execute("UPDATE sessions SET reserved_players=reserved_players+? WHERE id=? AND reserved_players+?<=player_capacity", [count, row.session_id, count]).changes
        : ctx.db.execute("UPDATE sessions SET reserved_players=reserved_players-? WHERE id=? AND reserved_players>=?", [count, row.session_id, count]).changes;
      if (changed !== 1) ctx.refuse("capacity_unavailable", "A session no longer has enough player slots.");
    }
  }
  function insert(ctx, input, source, nextStatus, rows, receiptFileId) {
    const id = ctx.requestId;
    const total = rows.reduce((sum, row) => sum + row.players.length * PLAYER_PRICE + row.spectators.length * SPECTATOR_PRICE, 0);
    changeCapacity(ctx, rows.map(row => ({session_id: row.sessionId, player_count: row.players.length})), 1);
    ctx.db.execute("INSERT INTO registrations(id,status_token,full_name,mobile,source,status,payment_method,total_php,receipt_file_id,version,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)",
      [id, ctx.secret, input.fullName, input.mobile, source, nextStatus, input.paymentMethod, total, receiptFileId, ctx.nowMs, ctx.nowMs]);
    for (const row of rows) {
      ctx.db.execute("INSERT INTO registration_sessions(id,registration_id,session_id,player_count,spectator_count) VALUES(?,?,?,?,?)",
        [id + "_" + row.sessionId, id, row.sessionId, row.players.length, row.spectators.length]);
      const people = row.players.map(value => ({role: "player", name: value})).concat(row.spectators.map(value => ({role: "spectator", name: value})));
      for (let start = 0; start < people.length; start += 20) {
        const group = people.slice(start, start + 20), values = [];
        group.forEach((person, index) => values.push(id + "_" + row.sessionId + "_" + (start + index), id, row.sessionId, person.role, person.name, nameKey(person.name)));
        ctx.db.execute("INSERT INTO attendees(id,registration_id,session_id,role,name,name_key) VALUES " + group.map(() => "(?,?,?,?,?,?)").join(","), values);
      }
    }
    return summary(ctx, {id, status: nextStatus, total_php: total, version: 1, created_at_ms: ctx.nowMs});
  }

  function listPublicSessions(ctx) {
    return ctx.db.query("SELECT id,name,starts_at,player_capacity,reserved_players FROM sessions ORDER BY id").map(row => ({
      id: row.id, name: row.name, startsAt: row.starts_at, capacity: row.player_capacity,
      reserved: row.reserved_players, available: row.player_capacity - row.reserved_players,
      playerPrice: PLAYER_PRICE, spectatorPrice: SPECTATOR_PRICE,
    }));
  }
  function register(ctx, input) {
    object(ctx, input);
    const contact = {fullName: name(ctx, input.fullName), mobile: mobile(ctx, input.mobile, false), paymentMethod: payment(ctx, input.paymentMethod, false)};
    const rows = roster(ctx, input.sessions);
    if (typeof input.receiptFileId !== "string" || !input.receiptFileId) ctx.refuse("receipt_required", "Upload your payment receipt.");
    const file = ctx.files.attach(input.receiptFileId);
    if (!["image/jpeg", "image/png", "application/pdf"].includes(file.contentType) || file.byteLength < 1 || file.byteLength > 5 * 1024 * 1024) ctx.refuse("invalid_receipt", "Upload a JPG, PNG, or PDF receipt, up to 5 MB.");
    return Object.assign(insert(ctx, contact, "website", "pending_verification", rows, file.fileId), {statusToken: ctx.secret});
  }
  function lookupStatus(ctx, input) {
    object(ctx, input);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) ctx.refuse("not_found", "This status link is invalid.");
    const row = ctx.db.query("SELECT * FROM registrations WHERE status_token=?", [input.token])[0];
    if (!row) ctx.refuse("not_found", "This status link is invalid.");
    const people = ctx.db.query("SELECT id,session_id,role,name FROM attendees WHERE registration_id=? ORDER BY session_id,role,name,id", [row.id]);
    return Object.assign(summary(ctx, row), {attendees: people.map(person => ({id: person.id, sessionId: person.session_id, role: person.role, name: person.name}))});
  }
  function listRegistrations(ctx, input) {
    organizer(ctx); object(ctx, input);
    const {limit, offset} = pageInput(ctx, input, 100);
    const filter = input.status === undefined || input.status === "all" ? "" : status(ctx, input.status);
    const search = input.search === undefined ? "" : input.search;
    if (typeof search !== "string" || search.length > 150) invalid(ctx, "Keep the search under 150 characters.");
    const rows = ctx.db.query("SELECT id,status,full_name,mobile,source,payment_method,receipt_file_id,total_php,version,created_at_ms,updated_at_ms FROM registrations WHERE (?='' OR status=?) AND (?='' OR instr(lower(full_name),lower(?))>0 OR instr(mobile,?)>0) ORDER BY created_at_ms DESC,id DESC LIMIT ? OFFSET ?",
      [filter, filter, search, search, search, limit + 1, offset]);
    return {
      records: rows.slice(0, limit).map(row => Object.assign(summary(ctx, row), {
        fullName: row.full_name, mobile: row.mobile, source: row.source, paymentMethod: row.payment_method,
        hasReceipt: row.receipt_file_id !== null, updatedAtMs: row.updated_at_ms,
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  function setStatus(ctx, input) {
    organizer(ctx); object(ctx, input);
    const nextStatus = status(ctx, input.status);
    const row = registration(ctx, input.id);
    if (!Number.isSafeInteger(input.expectedVersion) || row.version !== input.expectedVersion) ctx.refuse("conflict", "This registration changed. Reload it before updating.");
    const method = input.paymentMethod === undefined ? row.payment_method : payment(ctx, input.paymentMethod, true);
    if (nextStatus === "pay_at_venue" && method !== "cash") invalid(ctx, "Use cash for a pay-at-venue reservation.");
    if (row.status === "pay_at_venue" && nextStatus === "verified" && input.paymentMethod === undefined) invalid(ctx, "Choose the payment method used.");
    if ((row.status === "rejected") !== (nextStatus === "rejected")) {
      const rows = ctx.db.query("SELECT session_id,player_count FROM registration_sessions WHERE registration_id=? ORDER BY session_id", [row.id]);
      changeCapacity(ctx, rows, nextStatus === "rejected" ? -1 : 1);
    }
    ctx.db.execute("UPDATE registrations SET status=?,payment_method=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?", [nextStatus, method, ctx.nowMs, row.id, row.version]);
    return summary(ctx, Object.assign({}, row, {status: nextStatus, version: row.version + 1}));
  }
  function updateRegistration(ctx, input) {
    organizer(ctx); object(ctx, input);
    if (input.field !== "status") invalid(ctx, "Use the status action to update this registration.");
    return setStatus(ctx, {id: input.rowId, status: input.value, expectedVersion: input.expectedVersion});
  }
  function manualEntry(ctx, input) {
    organizer(ctx); object(ctx, input);
    const fullName = name(ctx, input.fullName);
    const contact = {fullName, mobile: mobile(ctx, input.mobile, true), paymentMethod: payment(ctx, input.paymentMethod, true)};
    if (!["manual", "reclub"].includes(input.source)) invalid(ctx, "Choose manual entry or ReClub.");
    const nextStatus = status(ctx, input.status);
    if (nextStatus === "rejected") invalid(ctx, "Choose pay at venue, pending verification, or verified.");
    if (nextStatus === "pay_at_venue" && contact.paymentMethod !== "cash") invalid(ctx, "Use cash for a pay-at-venue reservation.");
    if (!["player", "spectator"].includes(input.role)) invalid(ctx, "Choose player or spectator.");
    const selected = input.session === "both" ? SESSION_IDS : [session(ctx, input.session)];
    const rows = selected.map(sessionId => ({sessionId, players: input.role === "player" ? [fullName] : [], spectators: input.role === "spectator" ? [fullName] : []}));
    return insert(ctx, contact, input.source, nextStatus, rows, null);
  }
  function attendees(ctx, input) {
    organizer(ctx); object(ctx, input);
    const {limit, offset} = pageInput(ctx, input, 200);
    const selected = input.sessionId === undefined ? "" : session(ctx, input.sessionId);
    const filter = input.status === undefined ? "" : status(ctx, input.status);
    const rows = ctx.db.query("SELECT a.id,a.registration_id,a.session_id,a.role,a.name,r.full_name,r.mobile,r.status FROM attendees a JOIN registrations r ON r.id=a.registration_id WHERE (?='' OR a.session_id=?) AND (?='' OR r.status=?) AND r.status<>'rejected' ORDER BY a.session_id,a.role,a.name,a.id LIMIT ? OFFSET ?",
      [selected, selected, filter, filter, limit + 1, offset]);
    return {records: rows.slice(0, limit).map(row => ({
      id: row.id, registrationId: row.registration_id, sessionId: row.session_id, role: row.role,
      name: row.name, contactName: row.full_name, mobile: row.mobile, status: row.status,
    })), nextOffset: rows.length > limit ? offset + limit : null};
  }
  function totals(ctx) {
    organizer(ctx);
    return ctx.db.query("SELECT payment_method AS paymentMethod,SUM(CASE WHEN status='verified' THEN total_php ELSE 0 END) AS verified,SUM(CASE WHEN status='pending_verification' THEN total_php ELSE 0 END) AS pending,SUM(CASE WHEN status='rejected' THEN total_php ELSE 0 END) AS rejected,SUM(CASE WHEN status='pay_at_venue' THEN total_php ELSE 0 END) AS dueAtVenue,SUM(total_php) AS total FROM registrations GROUP BY payment_method ORDER BY payment_method");
  }
  function receiptAccess(ctx, input) {
    organizer(ctx); object(ctx, input);
    const row = registration(ctx, input.id);
    if (!row.receipt_file_id) ctx.refuse("not_found", "This registration has no receipt.");
    return {fileId: row.receipt_file_id};
  }
  function listRegistrationSessions(ctx, input) {
    organizer(ctx); object(ctx, input);
    const {limit, offset} = pageInput(ctx, input, 100);
    const records = ctx.db.query("SELECT id,registration_id AS registrationId,session_id AS sessionId,player_count AS players,spectator_count AS spectators FROM registration_sessions ORDER BY id LIMIT ? OFFSET ?", [limit + 1, offset]);
    return {records: records.slice(0, limit), nextOffset: records.length > limit ? offset + limit : null};
  }
  globalThis.operations = {listPublicSessions, register, lookupStatus, listRegistrations, attendees, totals, setStatus, updateRegistration, manualEntry, receiptAccess, listRegistrationSessions};
}());
