import { CORE_SCHEMA, load, realMapTag } from "js-yaml";
import {
  RECORD_ID_FRONTMATTER_KEY,
  type CollectionFieldType,
  type CollectionSchema,
  type CollectionSchemaParseResult,
  type CollectionSchemaReason,
  type FieldDefinition,
  type FieldValueReasonCode,
  type FieldValueValidation,
  type ViewDefinition,
  type ViewKind,
  type ViewSort,
} from "./collection";

const RECORD_ID_PATTERN = /^rec_[a-z2-7]{26}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;
const MAX_COLLECTION_FIELD_VALUE_DEPTH = 24;
const MAX_SCHEMA_COLLECTION_ITEMS = 16_384;
const COLLECTION_SCHEMA = CORE_SCHEMA.withTags(realMapTag);

const FIELD_TYPES = new Set<CollectionFieldType>([
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi-select",
  "person",
  "relation",
  "url",
]);
const VIEW_KINDS = new Set<ViewKind>(["table", "board", "calendar"]);

function emptyCollectionSchema(): CollectionSchema {
  return {
    name: null,
    description: null,
    fields: [],
    views: [],
  };
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function propertyPath(parent: string, property: string): string {
  return `${parent}/${pointerSegment(property)}`;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlKeyText(value: unknown): string | null {
  if (
    typeof value === "string" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return value === null ? "null" : null;
}

function yamlToPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of value) {
      const text = yamlKeyText(key);
      if (text !== null) result[text] = yamlToPlain(entry);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map(yamlToPlain);
  return value;
}

function reason(
  reasons: CollectionSchemaReason[],
  code: CollectionSchemaReason["code"],
  path: string,
): void {
  reasons.push({ code, path });
}

function flag(code: FieldValueReasonCode, path = ""): FieldValueValidation {
  return { status: "flagged", reason: { code, path } };
}

function reportUnknownProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  reasons: CollectionSchemaReason[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      reason(reasons, "unknown-property", propertyPath(path, key));
    }
  }
}

function readOptionalText(
  value: Record<string, unknown>,
  key: string,
  path: string,
  reasons: CollectionSchemaReason[],
): string | null {
  if (!(key in value)) return null;
  const candidate = value[key];
  if (typeof candidate !== "string") {
    reason(reasons, "expected-text", propertyPath(path, key));
    return null;
  }
  return candidate;
}

function readRequiredText(
  value: Record<string, unknown>,
  key: string,
  path: string,
  reasons: CollectionSchemaReason[],
): string | null {
  const keyPath = propertyPath(path, key);
  if (!(key in value)) {
    reason(reasons, "missing-property", keyPath);
    return null;
  }
  const candidate = value[key];
  if (typeof candidate !== "string") {
    reason(reasons, "expected-text", keyPath);
    return null;
  }
  if (candidate.length === 0) {
    reason(reasons, "empty-value", keyPath);
    return null;
  }
  return candidate;
}

function isCollectionFieldType(value: string): value is CollectionFieldType {
  return FIELD_TYPES.has(value as CollectionFieldType);
}

function isViewKind(value: string): value is ViewKind {
  return VIEW_KINDS.has(value as ViewKind);
}

function isWorkspaceRelativeCollectionPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function parseOptions(
  raw: unknown,
  path: string,
  reasons: CollectionSchemaReason[],
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    reason(reasons, "expected-sequence", path);
    return [];
  }
  const options: string[] = [];
  const seen = new Set<string>();
  raw.forEach((option, index) => {
    const optionPath = `${path}/${index}`;
    if (typeof option !== "string") {
      reason(reasons, "expected-text", optionPath);
    } else if (option.length === 0) {
      reason(reasons, "empty-value", optionPath);
    } else if (seen.has(option)) {
      reason(reasons, "duplicate-value", optionPath);
    } else {
      seen.add(option);
      options.push(option);
    }
  });
  return options;
}

function parseFields(
  raw: unknown,
  reasons: CollectionSchemaReason[],
  preservedEntries?: readonly (readonly [unknown, unknown])[],
): FieldDefinition[] {
  if (raw === undefined) return [];
  if (!isMapping(raw)) {
    reason(reasons, "expected-mapping", "/fields");
    return [];
  }

  const entries = preservedEntries ?? Object.entries(raw);
  const nameCounts = new Map<string, number>();
  for (const [rawName] of entries) {
    const name = yamlKeyText(rawName);
    if (name !== null) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const fields: FieldDefinition[] = [];
  for (const [rawName, rawField] of entries) {
    const name = yamlKeyText(rawName);
    if (name === null) {
      reason(reasons, "expected-text", "/fields/<non-text-key>");
      continue;
    }
    const field = yamlToPlain(rawField);
    const path = propertyPath("/fields", name);
    if ((nameCounts.get(name) ?? 0) > 1) {
      reason(reasons, "field-name-collision", path);
    }
    if (name.length === 0) {
      reason(reasons, "empty-value", path);
      continue;
    }
    if (name === RECORD_ID_FRONTMATTER_KEY) {
      reason(reasons, "reserved-field-name", path);
      continue;
    }
    if (!isMapping(field)) {
      reason(reasons, "expected-mapping", path);
      continue;
    }

    const rawType = field.type;
    if (!("type" in field)) {
      reason(reasons, "missing-property", `${path}/type`);
      continue;
    }
    if (typeof rawType !== "string") {
      reason(reasons, "expected-text", `${path}/type`);
      continue;
    }
    if (!isCollectionFieldType(rawType)) {
      reason(reasons, "unknown-field-type", `${path}/type`);
      continue;
    }

    if (rawType === "select" || rawType === "multi-select") {
      reportUnknownProperties(field, new Set(["type", "options"]), path, reasons);
      fields.push({
        name,
        type: rawType,
        options: parseOptions(field.options, `${path}/options`, reasons),
      });
      continue;
    }

    if (rawType === "relation") {
      reportUnknownProperties(
        field,
        new Set(["type", "collection", "many"]),
        path,
        reasons,
      );
      const collection = readRequiredText(field, "collection", path, reasons);
      let many: boolean | null = null;
      if (!("many" in field)) {
        reason(reasons, "missing-property", `${path}/many`);
      } else if (typeof field.many !== "boolean") {
        reason(reasons, "expected-boolean", `${path}/many`);
      } else {
        many = field.many;
      }
      if (collection !== null && !isWorkspaceRelativeCollectionPath(collection)) {
        reason(reasons, "invalid-relation-target", `${path}/collection`);
      } else if (collection !== null && many !== null) {
        fields.push({ name, type: "relation", collection, many });
      }
      continue;
    }

    reportUnknownProperties(field, new Set(["type"]), path, reasons);
    fields.push({ name, type: rawType });
  }
  return fields;
}

function parseFieldReference(
  raw: unknown,
  path: string,
  fieldNames: ReadonlySet<string>,
  reasons: CollectionSchemaReason[],
): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    reason(reasons, "expected-text", path);
    return null;
  }
  if (raw.length === 0) {
    reason(reasons, "empty-value", path);
    return null;
  }
  if (!fieldNames.has(raw)) {
    reason(reasons, "unknown-field-reference", path);
    return null;
  }
  return raw;
}

function parseSort(
  raw: unknown,
  path: string,
  fieldNames: ReadonlySet<string>,
  reasons: CollectionSchemaReason[],
): ViewSort[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    reason(reasons, "expected-sequence", path);
    return [];
  }
  const sort: ViewSort[] = [];
  raw.forEach((entry, index) => {
    const entryPath = `${path}/${index}`;
    if (!isMapping(entry)) {
      reason(reasons, "expected-mapping", entryPath);
      return;
    }
    reportUnknownProperties(entry, new Set(["field", "direction"]), entryPath, reasons);
    const field = readRequiredText(entry, "field", entryPath, reasons);
    let direction: "asc" | "desc" | null = null;
    if (!("direction" in entry)) {
      reason(reasons, "missing-property", `${entryPath}/direction`);
    } else if (entry.direction !== "asc" && entry.direction !== "desc") {
      reason(reasons, "invalid-sort-direction", `${entryPath}/direction`);
    } else {
      direction = entry.direction;
    }
    if (field !== null && !fieldNames.has(field)) {
      reason(reasons, "unknown-field-reference", `${entryPath}/field`);
    } else if (field !== null && direction !== null) {
      sort.push({ field, direction });
    }
  });
  return sort;
}

function parseVisibleFields(
  raw: unknown,
  path: string,
  fieldNames: ReadonlySet<string>,
  reasons: CollectionSchemaReason[],
): string[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    reason(reasons, "expected-sequence", path);
    return null;
  }
  const fields: string[] = [];
  const seen = new Set<string>();
  raw.forEach((field, index) => {
    const fieldPath = `${path}/${index}`;
    if (typeof field !== "string") {
      reason(reasons, "expected-text", fieldPath);
    } else if (!fieldNames.has(field)) {
      reason(reasons, "unknown-field-reference", fieldPath);
    } else if (seen.has(field)) {
      reason(reasons, "duplicate-value", fieldPath);
    } else {
      seen.add(field);
      fields.push(field);
    }
  });
  return fields;
}

function parseViews(
  raw: unknown,
  fields: readonly FieldDefinition[],
  reasons: CollectionSchemaReason[],
): ViewDefinition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    reason(reasons, "expected-sequence", "/views");
    return [];
  }
  const fieldNames = new Set(fields.map((field) => field.name));
  const viewNames = new Set<string>();
  const views: ViewDefinition[] = [];
  raw.forEach((view, index) => {
    const path = `/views/${index}`;
    if (!isMapping(view)) {
      reason(reasons, "expected-mapping", path);
      return;
    }
    reportUnknownProperties(
      view,
      new Set(["name", "kind", "groupBy", "sort", "visibleFields", "dateField"]),
      path,
      reasons,
    );
    const name = readRequiredText(view, "name", path, reasons);
    const rawKind = readRequiredText(view, "kind", path, reasons);
    let kind: ViewKind | null = null;
    if (rawKind !== null) {
      if (isViewKind(rawKind)) {
        kind = rawKind;
      } else {
        reason(reasons, "unknown-view-kind", `${path}/kind`);
      }
    }
    if (name !== null && viewNames.has(name)) {
      reason(reasons, "duplicate-value", `${path}/name`);
      return;
    }
    if (name === null || kind === null) return;
    viewNames.add(name);
    views.push({
      name,
      kind,
      groupBy: parseFieldReference(view.groupBy, `${path}/groupBy`, fieldNames, reasons),
      sort: parseSort(view.sort, `${path}/sort`, fieldNames, reasons),
      visibleFields: parseVisibleFields(
        view.visibleFields,
        `${path}/visibleFields`,
        fieldNames,
        reasons,
      ),
      dateField: parseFieldReference(
        view.dateField,
        `${path}/dateField`,
        fieldNames,
        reasons,
      ),
    });
  });
  return views;
}

export function parseCollectionSchema(yamlText: string): CollectionSchemaParseResult {
  if (yamlText.trim().length === 0) {
    return { status: "valid", schema: emptyCollectionSchema(), reasons: [] };
  }

  let raw: unknown;
  let preservedFieldEntries: readonly (readonly [unknown, unknown])[] | undefined;
  try {
    const loaded = load(yamlText, {
      schema: COLLECTION_SCHEMA,
      json: true,
      maxAliases: 100,
      maxDepth: 100,
    });
    const fields = loaded instanceof Map ? loaded.get("fields") : undefined;
    preservedFieldEntries = fields instanceof Map ? [...fields.entries()] : undefined;
    raw = yamlToPlain(loaded);
  } catch {
    return {
      status: "degraded",
      schema: emptyCollectionSchema(),
      reasons: [{ code: "invalid-yaml", path: "" }],
    };
  }
  if (!isMapping(raw)) {
    return {
      status: "degraded",
      schema: emptyCollectionSchema(),
      reasons: [{ code: "root-not-mapping", path: "" }],
    };
  }

  const reasons: CollectionSchemaReason[] = [];
  reportUnknownProperties(
    raw,
    new Set(["name", "description", "fields", "views"]),
    "",
    reasons,
  );
  const fields = parseFields(raw.fields, reasons, preservedFieldEntries);
  const name = readOptionalText(raw, "name", "", reasons);
  const description = readOptionalText(raw, "description", "", reasons);
  const views = parseViews(raw.views, fields, reasons);
  if (fields.length > MAX_SCHEMA_COLLECTION_ITEMS) {
    fields.length = MAX_SCHEMA_COLLECTION_ITEMS;
    reasons.push({ code: "schema-collection-limit-exceeded", path: "/fields" });
  }
  if (views.length > MAX_SCHEMA_COLLECTION_ITEMS) {
    views.length = MAX_SCHEMA_COLLECTION_ITEMS;
    reasons.push({ code: "schema-collection-limit-exceeded", path: "/views" });
  }
  const schema: CollectionSchema = {
    name,
    description,
    fields,
    views,
  };
  return {
    status: reasons.length === 0 ? "valid" : "degraded",
    schema,
    reasons,
  };
}

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function validateMany(
  value: unknown,
  validateEntry: (entry: unknown, path: string) => FieldValueValidation,
): FieldValueValidation {
  if (!Array.isArray(value)) return flag("expected-sequence");
  const seen = new Set<unknown>();
  for (const [index, entry] of value.entries()) {
    const path = `/${index}`;
    const verdict = validateEntry(entry, path);
    if (verdict.status === "flagged") return verdict;
    if (seen.has(entry)) return flag("duplicate-value", path);
    seen.add(entry);
  }
  return { status: "valid" };
}

function valueExceedsDepth(value: unknown, maximum: number): boolean {
  const pending: Array<readonly [unknown, number]> = [[value, 1]];
  while (pending.length > 0) {
    const [candidate, depth] = pending.pop()!;
    if (depth > maximum) return true;
    if (Array.isArray(candidate)) {
      pending.push(...candidate.map((entry) => [entry, depth + 1] as const));
    } else if (isMapping(candidate)) {
      pending.push(...Object.values(candidate).map((entry) => [entry, depth + 1] as const));
    }
  }
  return false;
}

export function validateFieldValue(
  field: FieldDefinition,
  value: unknown,
): FieldValueValidation {
  if (valueExceedsDepth(value, MAX_COLLECTION_FIELD_VALUE_DEPTH)) {
    return flag("value-depth-exceeded");
  }
  if (value === null || value === undefined) return { status: "valid" };

  switch (field.type) {
    case "text":
      return typeof value === "string" ? { status: "valid" } : flag("expected-text");
    case "number":
      if (typeof value === "bigint") return { status: "valid" };
      if (typeof value !== "number") return flag("expected-number");
      return Number.isFinite(value) ? { status: "valid" } : flag("number-not-finite");
    case "checkbox":
      return typeof value === "boolean" ? { status: "valid" } : flag("expected-boolean");
    case "date":
      if (typeof value !== "string") return flag("expected-text");
      return isCalendarDate(value) ? { status: "valid" } : flag("invalid-date");
    case "select":
      if (typeof value !== "string") return flag("expected-text");
      return field.options.includes(value) ? { status: "valid" } : flag("unknown-option");
    case "multi-select":
      return validateMany(value, (entry, path) => {
        if (typeof entry !== "string") return flag("expected-text", path);
        return field.options.includes(entry)
          ? { status: "valid" }
          : flag("unknown-option", path);
      });
    case "person":
      if (typeof value !== "string") return flag("expected-text");
      return value.trim().length > 0 ? { status: "valid" } : flag("empty-person-id");
    case "relation": {
      const validateRecordId = (entry: unknown, path: string): FieldValueValidation => {
        if (typeof entry !== "string") return flag("expected-text", path);
        return isRecordId(entry) ? { status: "valid" } : flag("invalid-record-id", path);
      };
      return field.many ? validateMany(value, validateRecordId) : validateRecordId(value, "");
    }
    case "url":
      if (typeof value !== "string") return flag("expected-text");
      return URL_PATTERN.test(value) ? { status: "valid" } : flag("invalid-url");
  }
}

export function isRecordId(value: string): boolean {
  return RECORD_ID_PATTERN.test(value);
}
