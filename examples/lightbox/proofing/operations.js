const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const COLOR_LABELS = ["none", "red", "yellow", "green", "blue", "purple"];
const STATUSES = ["draft", "proofing", "delivered"];
const UPLOAD_BYTES = 20 * 1024 * 1024;
const PREVIEW_BYTES = 1024 * 1024;
const PAGE_SIZE = 100;
const NOTE_PAGE_SIZE = 40;
const NOTES_PER_PHOTO = 500;
const RESTORABLE_NOTES = 20;
const BATCH = 100;
const EXPORT_PAGE_SIZE = 250;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function invalid(ctx, message) {
  ctx.refuse("invalid_input", message);
}

function shape(ctx, input, required, optional = []) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid(ctx, "Send the request as an object.");
  for (const key of Object.keys(input))
    if (!required.includes(key) && !optional.includes(key)) invalid(ctx, `Unknown field: ${key}.`);
  for (const key of required)
    if (!Object.hasOwn(input, key)) invalid(ctx, `Missing field: ${key}.`);
  return input;
}

function text(ctx, value, label, max) {
  if (typeof value !== "string") invalid(ctx, `${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) invalid(ctx, `${label} must be 1 to ${max} characters.`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(trimmed))
    invalid(ctx, `${label} has characters that can't be saved.`);
  return trimmed;
}

function id(ctx, value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{1,128}$/.test(value))
    invalid(ctx, `Choose a valid ${label}.`);
  return value;
}

function integer(ctx, value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    invalid(ctx, `${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

function measure(ctx, value, label, min, max) {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    invalid(ctx, `${label} must be a number from ${min} to ${max}.`);
  return value;
}

function captureSettings(ctx, value) {
  if (value === undefined)
    return {
      camera: null,
      lens: null,
      iso: null,
      f_number: null,
      exposure_s: null,
      focal_mm: null,
    };
  shape(ctx, value, [], ["camera", "lens", "iso", "fNumber", "exposureS", "focalMm"]);
  return {
    camera: value.camera === undefined ? null : text(ctx, value.camera, "The camera", 80),
    lens: value.lens === undefined ? null : text(ctx, value.lens, "The lens", 80),
    iso: value.iso === undefined ? null : integer(ctx, value.iso, "ISO", 1, 1000000),
    f_number: measure(ctx, value.fNumber, "The aperture", 0.5, 128),
    exposure_s: measure(ctx, value.exposureS, "The shutter speed in seconds", 0.00001, 3600),
    focal_mm: measure(ctx, value.focalMm, "The focal length in millimeters", 1, 5000),
  };
}

function flag(ctx, value, label) {
  if (typeof value !== "boolean") invalid(ctx, `${label} must be true or false.`);
  return value;
}

function day(ctx, value) {
  const parsed = typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : null;
  if (
    !parsed ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    invalid(ctx, "Enter the shoot date as YYYY-MM-DD.");
  return value;
}

function percent(ctx, value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
    invalid(ctx, `${label} must be a number from 0 to 100.`);
  return Math.round(value * 100) / 100;
}

function page(ctx, input, maxLimit = PAGE_SIZE) {
  const limit =
    input.limit === undefined ? maxLimit : integer(ctx, input.limit, "Page size", 1, maxLimit);
  const after = input.after ?? null;
  if (after !== null) {
    shape(ctx, after, ["order", "id"]);
    integer(ctx, after.order, "Page position", -1e15, 1e15);
    id(ctx, after.id, "page position");
  }
  return { limit, after };
}

function notePage(ctx, input) {
  const limit =
    input.limit === undefined
      ? NOTE_PAGE_SIZE
      : integer(ctx, input.limit, "Page size", 1, NOTE_PAGE_SIZE);
  const after = input.after ?? null;
  if (after !== null) {
    shape(ctx, after, ["createdAtMs", "id"]);
    integer(ctx, after.createdAtMs, "Page position", -1e15, 1e15);
    id(ctx, after.id, "page position");
  }
  return { limit, after };
}

function seek(columns, position, after) {
  return after
    ? { sql: `(${columns}) > (?, ?)`, args: [position(after), after.id] }
    : { sql: "1", args: [] };
}

function readNotesPage(ctx, assetId, input) {
  const { limit, after } = notePage(ctx, input);
  const from = seek("created_at_ms, id", (cursor) => cursor.createdAtMs, after);
  const rows = ctx.db.query(
    `SELECT ${NOTE_COLUMNS} FROM annotations
    WHERE asset_id = ? AND ${from.sql}
    ORDER BY created_at_ms, id LIMIT ?`,
    [assetId, ...from.args, limit + 1],
  );
  let cursor = null;
  if (rows.length > limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    cursor = { createdAtMs: last.created_at_ms, id: last.id };
  }
  const viewer = viewerKey(ctx);
  return { annotations: rows.map((row) => note(row, viewer)), nextCursor: cursor };
}

function owner(ctx) {
  if (ctx.caller.kind !== "owner") ctx.refuse("forbidden", "Only the studio owner can do this.");
}

function viewerKey(ctx) {
  const caller = ctx.caller;
  if (caller.kind === "owner") return "owner";
  if (caller.kind === "link") return `link:${caller.principalId}`;
  if (caller.kind === "named") return `named:${caller.userId}`;
  return null;
}

function reviewerKey(ctx) {
  return (
    viewerKey(ctx) ??
    ctx.refuse("forbidden", "Open the gallery from its proofing link to pick photos.")
  );
}

function accessCode(ctx, value) {
  if (typeof value !== "string" || value.length > 64) invalid(ctx, "Enter the gallery code.");
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newAccessCode(ctx) {
  const fair = BASE64URL.length - (BASE64URL.length % CODE_ALPHABET.length);
  return [...ctx.secret]
    .map((char) => BASE64URL.indexOf(char))
    .filter((index) => index >= 0 && index < fair)
    .slice(0, 12)
    .map((index) => CODE_ALPHABET[index % CODE_ALPHABET.length])
    .join("");
}

function openGallery(ctx, input, writing) {
  const code = accessCode(ctx, input.code);
  const shoot = ctx.db.query(
    "SELECT id, title, client_name, shot_on, selection_limit, status FROM shoots WHERE access_code = ? AND status IN ('proofing', 'delivered')",
    [code],
  )[0];
  if (!shoot)
    ctx.refuse(
      "gallery_not_found",
      "No gallery matches that code. Check the code your photographer sent.",
    );
  if (writing && shoot.status !== "proofing")
    ctx.refuse("gallery_closed", "This gallery is closed. Picks and notes can no longer change.");
  return shoot;
}

function publishedAsset(ctx, shoot, assetId) {
  const asset = ctx.db.query(
    "SELECT id, file_id, preview_file_id FROM assets WHERE id = ? AND shoot_id = ? AND is_published = 1",
    [id(ctx, assetId, "photo"), shoot.id],
  )[0];
  if (!asset) ctx.refuse("not_found", "This photo is not in the gallery.");
  return asset;
}

function picksUsed(ctx, shootId, reviewer, column = "selected") {
  return ctx.db.query(
    `SELECT COUNT(*) AS n FROM selections s JOIN assets a ON a.id = s.asset_id WHERE a.shoot_id = ? AND a.is_published = 1 AND s.reviewer_key = ? AND s.${column} = 1`,
    [shootId, reviewer],
  )[0].n;
}

function pickColumn(ctx, shoot, reviewer) {
  if (shoot.status === "proofing") return "selected";
  return ctx.db.query("SELECT 1 AS sent FROM submissions WHERE shoot_id = ? AND reviewer_key = ?", [
    shoot.id,
    reviewer,
  ]).length
    ? "sent"
    : "selected";
}

function sentState(ctx, shootId, reviewer) {
  const row = ctx.db.query(
    "SELECT sent_at_ms, changed, picks FROM submissions WHERE shoot_id = ? AND reviewer_key = ?",
    [shootId, reviewer],
  )[0];
  return {
    sentAtMs: row ? row.sent_at_ms : null,
    sentPicks: row ? row.picks : 0,
    changedSinceSent: row ? row.changed === 1 : false,
  };
}

function gallerySummary(ctx, shoot, reviewer, column = pickColumn(ctx, shoot, reviewer)) {
  return {
    title: shoot.title,
    clientName: shoot.client_name,
    shotOn: shoot.shot_on,
    status: shoot.status,
    selectionLimit: shoot.selection_limit,
    picksUsed: picksUsed(ctx, shoot.id, reviewer, column),
    ...sentState(ctx, shoot.id, reviewer),
  };
}

function nextCursor(rows, limit) {
  if (rows.length <= limit) return null;
  rows.pop();
  const last = rows[rows.length - 1];
  return { order: last.sort_order, id: last.id };
}

function note(row, viewer) {
  return {
    id: row.id,
    assetId: row.asset_id,
    xPct: row.x_pct,
    yPct: row.y_pct,
    authorName: row.author_name,
    mine: viewer !== null && row.author_key === viewer,
    body: row.body,
    resolved: row.resolved === 1,
    createdAtMs: row.created_at_ms,
  };
}

const NOTE_COLUMNS =
  "id, asset_id, x_pct, y_pct, author_name, author_key, body, resolved, created_at_ms";

function listPublishedAssets(ctx, input) {
  shape(ctx, input, ["code"], ["after", "limit"]);
  const shoot = openGallery(ctx, input, false);
  const reviewer = reviewerKey(ctx);
  const column = pickColumn(ctx, shoot, reviewer);
  const { limit, after } = page(ctx, input);
  const from = seek("a.sort_order, a.id", (cursor) => cursor.order, after);
  const rows = ctx.db.query(
    `SELECT a.id, a.title, a.file_id, a.preview_file_id, a.demo_scene, a.mime_type, a.width, a.height, a.sort_order,
      EXISTS (SELECT 1 FROM selections s WHERE s.asset_id = a.id AND s.reviewer_key = ? AND s.${column} = 1) AS picked,
      EXISTS (SELECT 1 FROM selections s WHERE s.asset_id = a.id AND s.reviewer_key = ? AND s.sent = 1) AS sent,
      (SELECT COUNT(*) FROM annotations n WHERE n.asset_id = a.id) AS notes,
      (SELECT COUNT(*) FROM annotations n WHERE n.asset_id = a.id AND n.resolved = 0) AS open_notes
    FROM assets a
    WHERE a.shoot_id = ? AND a.is_published = 1 AND ${from.sql}
    ORDER BY a.sort_order, a.id LIMIT ?`,
    [reviewer, reviewer, shoot.id, ...from.args, limit + 1],
  );
  const cursor = nextCursor(rows, limit);
  return {
    gallery: gallerySummary(ctx, shoot, reviewer, column),
    assets: rows.map((row) => ({
      id: row.id,
      title: row.title,
      fileId: row.file_id,
      previewFileId: row.preview_file_id,
      demoScene: row.demo_scene,
      mimeType: row.mime_type,
      width: row.width,
      height: row.height,
      sortOrder: row.sort_order,
      picked: row.picked === 1,
      sent: row.sent === 1,
      noteCount: row.notes,
      openNoteCount: row.open_notes,
    })),
    nextCursor: cursor,
  };
}

function fileOf(ctx, asset, input, fullSize = true) {
  const preview = input.preview === undefined ? false : flag(ctx, input.preview, "Preview");
  if (!preview && !fullSize)
    ctx.refuse(
      "not_delivered",
      "Full-size photos open once your photographer delivers the gallery.",
    );
  const fileId = preview ? asset.preview_file_id : asset.file_id;
  if (!fileId)
    ctx.refuse(
      "not_found",
      preview ? "This photo has no preview." : "This photo has no uploaded file.",
    );
  return { fileId };
}

function assetFileAccess(ctx, input) {
  shape(ctx, input, ["code", "assetId"], ["preview"]);
  const shoot = openGallery(ctx, input, false);
  return fileOf(
    ctx,
    publishedAsset(ctx, shoot, input.assetId),
    input,
    shoot.status === "delivered",
  );
}

function listAnnotations(ctx, input) {
  shape(ctx, input, ["code", "assetId"], ["after", "limit"]);
  const asset = publishedAsset(ctx, openGallery(ctx, input, false), input.assetId);
  return readNotesPage(ctx, asset.id, input);
}

function toggleClientPick(ctx, input) {
  shape(ctx, input, ["code", "assetId", "selected"]);
  const shoot = openGallery(ctx, input, true);
  const asset = publishedAsset(ctx, shoot, input.assetId);
  const selected = flag(ctx, input.selected, "Selected");
  const reviewer = reviewerKey(ctx);
  if (selected) {
    const changed = ctx.db.execute(
      `INSERT INTO selections (id, asset_id, reviewer_key, selected, updated_at_ms)
      SELECT ?, ?, ?, 1, ?
      WHERE (
        SELECT COUNT(*) FROM selections s JOIN assets a ON a.id = s.asset_id
        WHERE a.shoot_id = ? AND a.is_published = 1 AND s.reviewer_key = ? AND s.selected = 1 AND s.asset_id <> ?
      ) < (SELECT selection_limit FROM shoots WHERE id = ?)
      ON CONFLICT (asset_id, reviewer_key) DO UPDATE SET selected = 1, updated_at_ms = excluded.updated_at_ms`,
      [ctx.requestId, asset.id, reviewer, ctx.nowMs, shoot.id, reviewer, asset.id, shoot.id],
    ).changes;
    if (changed !== 1)
      ctx.refuse(
        "selection_limit_reached",
        `You've picked ${picksUsed(ctx, shoot.id, reviewer)} of ${shoot.selection_limit} photos, the limit for this gallery. Unpick one to choose this photo.`,
      );
  } else {
    ctx.db.execute(
      "UPDATE selections SET selected = 0, updated_at_ms = ? WHERE asset_id = ? AND reviewer_key = ?",
      [ctx.nowMs, asset.id, reviewer],
    );
  }
  ctx.db.execute(
    `UPDATE submissions SET changed = EXISTS (
      SELECT 1 FROM selections s JOIN assets a ON a.id = s.asset_id
      WHERE a.shoot_id = ? AND a.is_published = 1 AND s.reviewer_key = ? AND s.selected <> s.sent
    ) WHERE shoot_id = ? AND reviewer_key = ?`,
    [shoot.id, reviewer, shoot.id, reviewer],
  );
  return {
    assetId: asset.id,
    selected,
    changedSinceSent: sentState(ctx, shoot.id, reviewer).changedSinceSent,
    picksUsed: picksUsed(ctx, shoot.id, reviewer),
    selectionLimit: shoot.selection_limit,
  };
}

function submitSelection(ctx, input) {
  shape(ctx, input, ["code", "assetIds"]);
  const shoot = openGallery(ctx, input, true);
  const reviewer = reviewerKey(ctx);
  if (
    !Array.isArray(input.assetIds) ||
    input.assetIds.length > 1000 ||
    input.assetIds.some((id) => typeof id !== "string")
  )
    invalid(ctx, "List up to 1000 photo IDs, the favorites shown to the client.");
  const stored = ctx.db.query(
    `SELECT s.asset_id FROM selections s JOIN assets a ON a.id = s.asset_id
    WHERE a.shoot_id = ? AND a.is_published = 1 AND s.reviewer_key = ? AND s.selected = 1`,
    [shoot.id, reviewer],
  );
  const shown = new Set(input.assetIds);
  if (shown.size !== stored.length || stored.some((row) => !shown.has(row.asset_id)))
    ctx.refuse(
      "selection_changed",
      "Your saved favorites don't match the ones shown here. Check them, then send again.",
    );
  const picks = stored.length;
  const sentBefore =
    ctx.db.query("SELECT 1 AS sent FROM submissions WHERE shoot_id = ? AND reviewer_key = ?", [
      shoot.id,
      reviewer,
    ]).length > 0;
  if (!picks && !sentBefore)
    ctx.refuse("no_picks", "Choose at least 1 favorite before you send them.");
  ctx.db.execute(
    `UPDATE selections SET sent = CASE WHEN asset_id IN (SELECT id FROM assets WHERE shoot_id = ? AND is_published = 1) THEN selected ELSE 0 END
    WHERE reviewer_key = ? AND asset_id IN (SELECT id FROM assets WHERE shoot_id = ?)`,
    [shoot.id, reviewer, shoot.id],
  );
  ctx.db.execute(
    `INSERT INTO submissions (id, shoot_id, reviewer_key, picks, changed, sent_at_ms) VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT (shoot_id, reviewer_key) DO UPDATE SET picks = excluded.picks, changed = 0, sent_at_ms = excluded.sent_at_ms`,
    [ctx.requestId, shoot.id, reviewer, picks, ctx.nowMs],
  );
  return gallerySummary(ctx, shoot, reviewer);
}

function addPinnedAnnotation(ctx, input) {
  shape(ctx, input, ["code", "assetId", "xPct", "yPct", "authorName", "body"]);
  const shoot = openGallery(ctx, input, true);
  const asset = publishedAsset(ctx, shoot, input.assetId);
  const authorKey = reviewerKey(ctx);
  const xPct = percent(ctx, input.xPct, "The pin's x position");
  const yPct = percent(ctx, input.yPct, "The pin's y position");
  const authorName = text(ctx, input.authorName, "Your name", 80);
  const body = text(ctx, input.body, "The note", 1000);
  const count = ctx.db.query("SELECT COUNT(*) AS n FROM annotations WHERE asset_id = ?", [
    asset.id,
  ])[0].n;
  if (count >= NOTES_PER_PHOTO)
    ctx.refuse(
      "note_limit_reached",
      `This photo already has ${count} notes, and a photo holds at most ${NOTES_PER_PHOTO}.`,
    );
  const row = {
    id: `note_${ctx.requestId}`,
    asset_id: asset.id,
    x_pct: xPct,
    y_pct: yPct,
    author_name: authorName,
    author_key: authorKey,
    body,
    resolved: 0,
    created_at_ms: ctx.nowMs,
  };
  ctx.db.execute(`INSERT INTO annotations (${NOTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`, [
    row.id,
    row.asset_id,
    row.x_pct,
    row.y_pct,
    row.author_name,
    row.author_key,
    row.body,
    row.created_at_ms,
  ]);
  return note(row, authorKey);
}

function studioShoot(ctx, shootId) {
  const shoot = ctx.db.query("SELECT * FROM shoots WHERE id = ?", [id(ctx, shootId, "shoot")])[0];
  if (!shoot) ctx.refuse("not_found", "This shoot no longer exists.");
  return shoot;
}

function studioAsset(ctx, assetId) {
  const asset = ctx.db.query("SELECT * FROM assets WHERE id = ?", [id(ctx, assetId, "photo")])[0];
  if (!asset) ctx.refuse("not_found", "This photo no longer exists.");
  return asset;
}

function shootView(row, cover) {
  return {
    id: row.id,
    title: row.title,
    clientName: row.client_name,
    shotOn: row.shot_on,
    selectionLimit: row.selection_limit,
    status: row.status,
    internalRateCents: row.internal_rate_cents,
    accessCode: row.access_code,
    createdAtMs: row.created_at_ms,
    assetCount: row.asset_count ?? 0,
    publishedCount: row.published_count ?? 0,
    pickedAssetCount: row.picked_asset_count ?? 0,
    reviewerCount: row.reviewer_count ?? 0,
    sentCount: row.sent_count ?? 0,
    noteCount: row.note_count ?? 0,
    openNoteCount: row.open_note_count ?? 0,
    cover: cover ?? null,
  };
}

function listShoots(ctx, input) {
  owner(ctx);
  shape(ctx, input, [], ["after", "limit"]);
  const { limit, after } = page(ctx, input);
  const from = seek("-s.created_at_ms, s.id", (cursor) => cursor.order, after);
  const rows = ctx.db.query(
    `SELECT s.*, -s.created_at_ms AS sort_order,
      (SELECT COUNT(*) FROM assets a WHERE a.shoot_id = s.id) AS asset_count,
      (SELECT COUNT(*) FROM assets a WHERE a.shoot_id = s.id AND a.is_published = 1) AS published_count,
      (SELECT COUNT(DISTINCT p.asset_id) FROM selections p JOIN assets a ON a.id = p.asset_id WHERE a.shoot_id = s.id AND a.is_published = 1 AND p.selected = 1) AS picked_asset_count,
      (SELECT COUNT(DISTINCT p.reviewer_key) FROM selections p JOIN assets a ON a.id = p.asset_id
        WHERE a.shoot_id = s.id AND a.is_published = 1 AND p.selected = 1
        AND NOT EXISTS (SELECT 1 FROM submissions u WHERE u.shoot_id = s.id AND u.reviewer_key = p.reviewer_key))
        + (SELECT COUNT(*) FROM submissions u WHERE u.shoot_id = s.id) AS reviewer_count,
      (SELECT COUNT(*) FROM submissions u WHERE u.shoot_id = s.id) AS sent_count,
      (SELECT COUNT(*) FROM annotations n JOIN assets a ON a.id = n.asset_id WHERE a.shoot_id = s.id) AS note_count,
      (SELECT COUNT(*) FROM annotations n JOIN assets a ON a.id = n.asset_id WHERE a.shoot_id = s.id AND n.resolved = 0) AS open_note_count,
      (SELECT a.id FROM assets a WHERE a.shoot_id = s.id ORDER BY a.is_published DESC, a.owner_rating DESC, a.sort_order, a.id LIMIT 1) AS cover_id
    FROM shoots s
    WHERE ${from.sql}
    ORDER BY -s.created_at_ms, s.id LIMIT ?`,
    [...from.args, limit + 1],
  );
  const cursor = nextCursor(rows, limit);
  const coverIds = rows.map((row) => row.cover_id).filter(Boolean);
  const covers = new Map(
    coverIds.length
      ? ctx.db
          .query(
            `SELECT id, file_id, preview_file_id, demo_scene, width, height FROM assets WHERE id IN (${coverIds.map(() => "?").join(",")})`,
            coverIds,
          )
          .map((row) => [
            row.id,
            {
              assetId: row.id,
              fileId: row.file_id,
              previewFileId: row.preview_file_id,
              demoScene: row.demo_scene,
              width: row.width,
              height: row.height,
            },
          ])
      : [],
  );
  return {
    shoots: rows.map((row) => shootView(row, covers.get(row.cover_id))),
    nextCursor: cursor,
  };
}

function studioAssets(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["shootId"], ["after", "limit"]);
  const shoot = studioShoot(ctx, input.shootId);
  const { limit, after } = page(ctx, input);
  const from = seek("a.sort_order, a.id", (cursor) => cursor.order, after);
  const rows = ctx.db.query(
    `SELECT a.*,
      (SELECT COUNT(*) FROM selections s WHERE s.asset_id = a.id AND s.selected = 1) AS picks,
      (SELECT COUNT(*) FROM annotations n WHERE n.asset_id = a.id) AS notes,
      (SELECT COUNT(*) FROM annotations n WHERE n.asset_id = a.id AND n.resolved = 0) AS open_notes
    FROM assets a
    WHERE a.shoot_id = ? AND ${from.sql}
    ORDER BY a.sort_order, a.id LIMIT ?`,
    [shoot.id, ...from.args, limit + 1],
  );
  const cursor = nextCursor(rows, limit);
  return { assets: rows.map(assetView), nextCursor: cursor };
}

function assetView(row) {
  return {
    id: row.id,
    shootId: row.shoot_id,
    title: row.title,
    fileId: row.file_id,
    previewFileId: row.preview_file_id,
    demoScene: row.demo_scene,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    byteLength: row.byte_length,
    sortOrder: row.sort_order,
    rating: row.owner_rating,
    colorLabel: row.color_label,
    published: row.is_published === 1,
    capture: {
      camera: row.camera ?? null,
      lens: row.lens ?? null,
      iso: row.iso ?? null,
      fNumber: row.f_number ?? null,
      exposureS: row.exposure_s ?? null,
      focalMm: row.focal_mm ?? null,
    },
    pickCount: row.picks ?? 0,
    noteCount: row.notes ?? 0,
    openNoteCount: row.open_notes ?? 0,
  };
}

function studioAnnotations(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["assetId"], ["after", "limit"]);
  const asset = studioAsset(ctx, input.assetId);
  return readNotesPage(ctx, asset.id, input);
}

function studioFileAccess(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["assetId"], ["preview"]);
  return fileOf(ctx, studioAsset(ctx, input.assetId), input);
}

function exportFinalPicksList(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["shootId"], ["after", "limit"]);
  const shoot = studioShoot(ctx, input.shootId);
  const { limit, after } = page(ctx, input, EXPORT_PAGE_SIZE);
  const from = seek("a.sort_order, a.id", (cursor) => cursor.order, after);
  const rows = ctx.db.query(
    `SELECT a.id, a.sort_order, a.title, COUNT(*) AS picks FROM selections s JOIN assets a ON a.id = s.asset_id
    WHERE a.shoot_id = ? AND a.is_published = 1 AND s.sent = 1
      AND ${from.sql}
    GROUP BY a.id ORDER BY a.sort_order, a.id LIMIT ?`,
    [shoot.id, ...from.args, limit + 1],
  );
  const cursor = nextCursor(rows, limit);
  return {
    title: shoot.title,
    clientName: shoot.client_name,
    selectionLimit: shoot.selection_limit,
    reviewerCount: ctx.db.query(
      "SELECT COUNT(DISTINCT s.reviewer_key) AS n FROM selections s JOIN assets a ON a.id = s.asset_id WHERE a.shoot_id = ? AND a.is_published = 1 AND s.sent = 1",
      [shoot.id],
    )[0].n,
    picks: rows.map((row) => [row.title, row.picks]),
    nextCursor: cursor,
  };
}

function createShoot(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["title", "clientName", "shotOn", "selectionLimit"], ["internalRateCents"]);
  const row = {
    id: `shoot_${ctx.requestId}`,
    title: text(ctx, input.title, "The shoot title", 120),
    client_name: text(ctx, input.clientName, "The client name", 120),
    shot_on: day(ctx, input.shotOn),
    selection_limit: integer(ctx, input.selectionLimit, "The selection limit", 1, 500),
    status: "draft",
    internal_rate_cents: integer(ctx, input.internalRateCents ?? 0, "The internal rate", 0, 1e12),
    access_code: newAccessCode(ctx),
    created_at_ms: ctx.nowMs,
  };
  ctx.db.execute(
    "INSERT INTO shoots (id, title, client_name, shot_on, selection_limit, status, internal_rate_cents, access_code, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.title,
      row.client_name,
      row.shot_on,
      row.selection_limit,
      row.status,
      row.internal_rate_cents,
      row.access_code,
      row.created_at_ms,
    ],
  );
  return shootView(row, null);
}

function updateShoot(ctx, input) {
  owner(ctx);
  shape(
    ctx,
    input,
    ["shootId"],
    ["title", "clientName", "shotOn", "selectionLimit", "internalRateCents", "status"],
  );
  const shoot = studioShoot(ctx, input.shootId);
  const next = {
    title: input.title === undefined ? shoot.title : text(ctx, input.title, "The shoot title", 120),
    client_name:
      input.clientName === undefined
        ? shoot.client_name
        : text(ctx, input.clientName, "The client name", 120),
    shot_on: input.shotOn === undefined ? shoot.shot_on : day(ctx, input.shotOn),
    selection_limit:
      input.selectionLimit === undefined
        ? shoot.selection_limit
        : integer(ctx, input.selectionLimit, "The selection limit", 1, 500),
    internal_rate_cents:
      input.internalRateCents === undefined
        ? shoot.internal_rate_cents
        : integer(ctx, input.internalRateCents, "The internal rate", 0, 1e12),
    status: input.status === undefined ? shoot.status : input.status,
  };
  if (!STATUSES.includes(next.status)) invalid(ctx, "Choose draft, proofing, or delivered.");
  if (next.selection_limit < shoot.selection_limit) {
    const over = ctx.db.query(
      `SELECT MAX(SUM(s.selected), SUM(s.sent)) AS n
      FROM selections s JOIN assets a ON a.id = s.asset_id
      WHERE a.shoot_id = ? AND a.is_published = 1
      GROUP BY s.reviewer_key
      HAVING n > ?
      ORDER BY n DESC LIMIT 1`,
      [shoot.id, next.selection_limit],
    )[0];
    if (over)
      ctx.refuse(
        "selection_limit_too_low",
        `A reviewer already has ${over.n} picks. Raise the limit to at least ${over.n}.`,
      );
  }
  ctx.db.execute(
    "UPDATE shoots SET title = ?, client_name = ?, shot_on = ?, selection_limit = ?, internal_rate_cents = ?, status = ? WHERE id = ?",
    [
      next.title,
      next.client_name,
      next.shot_on,
      next.selection_limit,
      next.internal_rate_cents,
      next.status,
      shoot.id,
    ],
  );
  return shootView({ ...shoot, ...next }, null);
}

function uploadAsset(ctx, input) {
  owner(ctx);
  shape(
    ctx,
    input,
    ["shootId", "fileId", "previewFileId", "width", "height"],
    ["title", "capture"],
  );
  const shoot = studioShoot(ctx, input.shootId);
  const capture = captureSettings(ctx, input.capture);
  const width = integer(ctx, input.width, "The width", 1, 30000);
  const height = integer(ctx, input.height, "The height", 1, 30000);
  if (typeof input.fileId !== "string") invalid(ctx, "Upload a photo first.");
  const file = ctx.files.attach(input.fileId);
  if (!IMAGE_TYPES.includes(file.contentType))
    ctx.refuse(
      "unsupported_type",
      `Upload a JPEG, PNG, or WebP image. This file is ${file.contentType}.`,
    );
  if (file.byteLength > UPLOAD_BYTES)
    ctx.refuse(
      "file_too_large",
      `Photos can be at most ${UPLOAD_BYTES} bytes (20 MiB). This one is ${file.byteLength} bytes.`,
    );
  if (typeof input.previewFileId !== "string" || input.previewFileId === input.fileId)
    invalid(ctx, "Upload the preview as its own file.");
  const preview = ctx.files.attach(input.previewFileId);
  if (preview.contentType !== "image/jpeg")
    ctx.refuse("unsupported_type", `A preview must be a JPEG. This one is ${preview.contentType}.`);
  if (preview.byteLength > PREVIEW_BYTES)
    ctx.refuse(
      "file_too_large",
      `A preview can be at most ${PREVIEW_BYTES} bytes (1 MiB). This one is ${preview.byteLength} bytes.`,
    );
  const title =
    input.title === undefined
      ? text(
          ctx,
          file.name.replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 120) || "Untitled",
          "The photo title",
          120,
        )
      : text(ctx, input.title, "The photo title", 120);
  const order = ctx.db.query(
    "SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM assets WHERE shoot_id = ?",
    [shoot.id],
  )[0].n;
  const row = {
    id: `asset_${ctx.requestId}`,
    shoot_id: shoot.id,
    title,
    file_id: file.fileId,
    preview_file_id: preview.fileId,
    demo_scene: null,
    mime_type: file.contentType,
    width,
    height,
    byte_length: file.byteLength,
    sort_order: order,
    owner_rating: 0,
    color_label: "none",
    is_published: 0,
    ...capture,
    created_at_ms: ctx.nowMs,
  };
  ctx.db.execute(
    "INSERT INTO assets (id, shoot_id, title, file_id, preview_file_id, demo_scene, mime_type, width, height, byte_length, sort_order, owner_rating, color_label, is_published, camera, lens, iso, f_number, exposure_s, focal_mm, created_at_ms) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 'none', 0, ?, ?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.shoot_id,
      row.title,
      row.file_id,
      row.preview_file_id,
      row.mime_type,
      row.width,
      row.height,
      row.byte_length,
      row.sort_order,
      capture.camera,
      capture.lens,
      capture.iso,
      capture.f_number,
      capture.exposure_s,
      capture.focal_mm,
      row.created_at_ms,
    ],
  );
  return assetView(row);
}

function assetIdList(ctx, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > BATCH)
    invalid(ctx, `Choose 1 to ${BATCH} photos.`);
  const ids = [...new Set(value.map((item) => id(ctx, item, "photo")))];
  const found = ctx.db.query(
    `SELECT COUNT(*) AS n FROM assets WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  )[0].n;
  if (found !== ids.length)
    ctx.refuse("not_found", "A photo no longer exists. Reload and try again.");
  return ids;
}

function setOwnerRating(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["assetIds", "rating"]);
  const ids = assetIdList(ctx, input.assetIds);
  const rating = integer(ctx, input.rating, "The rating", 0, 5);
  ctx.db.execute(
    `UPDATE assets SET owner_rating = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
    [rating, ...ids],
  );
  return { assetIds: ids, rating };
}

function setColorLabel(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["assetIds", "colorLabel"]);
  const ids = assetIdList(ctx, input.assetIds);
  if (!COLOR_LABELS.includes(input.colorLabel))
    invalid(ctx, `Choose one of: ${COLOR_LABELS.join(", ")}.`);
  ctx.db.execute(
    `UPDATE assets SET color_label = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
    [input.colorLabel, ...ids],
  );
  return { assetIds: ids, colorLabel: input.colorLabel };
}

function publishAsset(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["assetIds", "published"]);
  const published = flag(ctx, input.published, "Published");
  const ids = assetIdList(ctx, input.assetIds);
  if (published) {
    const values = ids.map(() => "(?)").join(",");
    const over = ctx.db.query(
      `WITH targets(id) AS (VALUES ${values}),
        affected(shoot_id) AS (SELECT DISTINCT shoot_id FROM assets WHERE id IN (SELECT id FROM targets))
      SELECT sh.selection_limit AS max_picks, MAX(SUM(s.selected), SUM(s.sent)) AS next_picks
      FROM selections s
      JOIN assets a ON a.id = s.asset_id
      JOIN shoots sh ON sh.id = a.shoot_id
      WHERE a.shoot_id IN (SELECT shoot_id FROM affected)
        AND (a.is_published = 1 OR a.id IN (SELECT id FROM targets))
      GROUP BY a.shoot_id, s.reviewer_key
      HAVING next_picks > sh.selection_limit
      ORDER BY next_picks DESC LIMIT 1`,
      ids,
    )[0];
    if (over)
      ctx.refuse(
        "selection_limit_exceeded",
        `Publishing would give a reviewer ${over.next_picks} picks, above the shoot's limit of ${over.max_picks}. Raise the selection limit first.`,
      );
  }
  const changed = ctx.db.execute(
    `UPDATE assets SET is_published = ? WHERE is_published <> ? AND id IN (${ids.map(() => "?").join(",")})`,
    [published ? 1 : 0, published ? 1 : 0, ...ids],
  ).changes;
  return { assetIds: ids, published, changed };
}

function deleteAssets(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["assetIds"]);
  const ids = assetIdList(ctx, input.assetIds);
  const list = ids.map(() => "?").join(",");
  for (const table of ["selections", "annotations", "deleted_annotations"])
    ctx.db.execute(`DELETE FROM ${table} WHERE asset_id IN (${list})`, ids);
  const deleted = ctx.db.execute(`DELETE FROM assets WHERE id IN (${list})`, ids).changes;
  return { assetIds: ids, deleted };
}

function ownNote(ctx, input) {
  const shoot = openGallery(ctx, input, true);
  const row = ctx.db.query(
    `SELECT ${NOTE_COLUMNS} FROM annotations
    WHERE id = ? AND asset_id IN (SELECT id FROM assets WHERE shoot_id = ? AND is_published = 1)`,
    [id(ctx, input.annotationId, "note"), shoot.id],
  )[0];
  if (!row) ctx.refuse("not_found", "This note no longer exists.");
  if (row.author_key !== reviewerKey(ctx))
    ctx.refuse("forbidden", "You can only change notes you pinned.");
  return row;
}

function updateOwnNote(ctx, input) {
  shape(ctx, input, ["code", "annotationId", "body"]);
  const row = ownNote(ctx, input);
  const body = text(ctx, input.body, "The note", 1000);
  ctx.db.execute("UPDATE annotations SET body = ? WHERE id = ?", [body, row.id]);
  return note({ ...row, body }, row.author_key);
}

function deleteOwnNote(ctx, input) {
  shape(ctx, input, ["code", "annotationId"]);
  const row = ownNote(ctx, input);
  ctx.db.execute(
    `INSERT INTO deleted_annotations (${NOTE_COLUMNS}, deleted_at_ms) SELECT ${NOTE_COLUMNS}, ? FROM annotations WHERE id = ?`,
    [ctx.nowMs, row.id],
  );
  ctx.db.execute(
    `DELETE FROM deleted_annotations WHERE author_key = ? AND id NOT IN
      (SELECT id FROM deleted_annotations WHERE author_key = ? ORDER BY deleted_at_ms DESC, id DESC LIMIT ${RESTORABLE_NOTES})`,
    [row.author_key, row.author_key],
  );
  ctx.db.execute("DELETE FROM annotations WHERE id = ?", [row.id]);
  return { annotationId: row.id, deleted: true };
}

function restoreOwnNote(ctx, input) {
  shape(ctx, input, ["code", "annotationId"]);
  const shoot = openGallery(ctx, input, true);
  const authorKey = reviewerKey(ctx);
  const row = ctx.db.query(
    `SELECT ${NOTE_COLUMNS} FROM deleted_annotations
    WHERE id = ? AND author_key = ? AND asset_id IN (SELECT id FROM assets WHERE shoot_id = ? AND is_published = 1)`,
    [id(ctx, input.annotationId, "note"), authorKey, shoot.id],
  )[0];
  if (!row)
    ctx.refuse(
      "not_found",
      `This note can no longer be restored. Only your last ${RESTORABLE_NOTES} deleted notes can be.`,
    );
  const count = ctx.db.query("SELECT COUNT(*) AS n FROM annotations WHERE asset_id = ?", [
    row.asset_id,
  ])[0].n;
  if (count >= NOTES_PER_PHOTO)
    ctx.refuse(
      "note_limit_reached",
      `This photo already has ${count} notes, and a photo holds at most ${NOTES_PER_PHOTO}.`,
    );
  ctx.db.execute(
    `INSERT INTO annotations (${NOTE_COLUMNS}) SELECT ${NOTE_COLUMNS} FROM deleted_annotations WHERE id = ?`,
    [row.id],
  );
  ctx.db.execute("DELETE FROM deleted_annotations WHERE id = ?", [row.id]);
  return note(row, authorKey);
}

function resolveAnnotation(ctx, input) {
  owner(ctx);
  shape(ctx, input, ["annotationId", "resolved"]);
  const resolved = flag(ctx, input.resolved, "Resolved");
  const changed = ctx.db.execute("UPDATE annotations SET resolved = ? WHERE id = ?", [
    resolved ? 1 : 0,
    id(ctx, input.annotationId, "note"),
  ]).changes;
  if (changed !== 1) ctx.refuse("not_found", "This note no longer exists.");
  return { annotationId: input.annotationId, resolved };
}

globalThis.operations = {
  listPublishedAssets,
  assetFileAccess,
  listAnnotations,
  toggleClientPick,
  submitSelection,
  addPinnedAnnotation,
  updateOwnNote,
  deleteOwnNote,
  restoreOwnNote,
  listShoots,
  studioAssets,
  studioAnnotations,
  studioFileAccess,
  exportFinalPicksList,
  createShoot,
  updateShoot,
  uploadAsset,
  setOwnerRating,
  setColorLabel,
  publishAsset,
  deleteAssets,
  resolveAnnotation,
};
