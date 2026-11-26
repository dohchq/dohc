import {
  HTTP_HEADER_NAME_PATTERN,
  HTTP_HEADER_VALUE_PATTERN,
  isForbiddenHttpHeader,
} from "@dohc/workspace-contracts/http-headers";
import {
  normalizeSecretAllowedHost,
  WORKSPACE_SECRET_NAME_PATTERN,
} from "@dohc/workspace-contracts/workspace-secrets";

export const APP_EXTERNAL_MAX_OPERATIONS = 32;
export const APP_EXTERNAL_MAX_PARAMS = 16;
export const APP_EXTERNAL_MAX_QUERY = 16;
export const APP_EXTERNAL_MAX_HEADERS = 8;
export const APP_EXTERNAL_MAX_PATH_BYTES = 1024;
export const APP_EXTERNAL_MAX_BODY_TEMPLATE_BYTES = 16 * 1024;
export const APP_EXTERNAL_MAX_INPUT_BYTES = 16 * 1024;
export const APP_EXTERNAL_MIN_RESPONSE_BYTES = 1024;
export const APP_EXTERNAL_DEFAULT_RESPONSE_BYTES = 256 * 1024;
export const APP_EXTERNAL_MAX_RESPONSE_BYTES = 512 * 1024;
export const APP_EXTERNAL_TIMEOUT_MS = 10_000;

export type AppExternalParam =
  | { type: "integer"; min: number; max: number }
  | { type: "enum"; values: string[] }
  | { type: "boolean" }
  | { type: "string"; maxLength: number };

export type AppExternalJson =
  | string
  | number
  | boolean
  | null
  | AppExternalJson[]
  | { [key: string]: AppExternalJson };

/** One request an app may ask its host to send. Only `params` vary, and only in `{{slot}}` places. */
export interface AppExternalOperation {
  name: string;
  method: "GET" | "POST";
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: AppExternalJson | null;
  params: Record<string, AppExternalParam>;
  secret: { name: string; header: string; prefix: string };
  response: { maxBytes: number };
  access: "owner" | "viewers";
}

export interface AppExternalRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

const NAME = /^[a-z][A-Za-z0-9_-]{0,63}$/u;
const PARAM = /^[a-z][A-Za-z0-9_]{0,31}$/u;
const SLOT = /^\{\{([a-z][A-Za-z0-9_]{0,31})\}\}$/u;
const QUERY_KEY = /^[A-Za-z0-9._~[\]-]{1,64}$/u;
const PATH_LITERAL = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})*$/u;
const PATH_VALUE = /^[A-Za-z0-9_.~-]+$/u;
const CONTROL = /[\x00-\x1f\x7f]/u;
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;

const fail = (message: string): never => {
  throw new Error(message);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function keys(value: unknown, required: string[], optional: string[], what: string) {
  if (!isRecord(value)) return fail(`${what} must be an object.`);
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      fail(`${what} has an unknown field "${key}".`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${what} needs "${key}".`);
  return value;
}
function text(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || !value || CONTROL.test(value) || bytes(value) > max)
    return fail(`${what} must be text of at most ${max} bytes.`);
  return value;
}
const sorted = <T>(entries: [string, T][]) =>
  Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function parseParam(name: string, value: unknown): AppExternalParam {
  if (!PARAM.test(name) || RESERVED.has(name)) fail(`input name "${name}" is not allowed.`);
  const what = `Input "${name}"`;
  const type = isRecord(value) ? value.type : undefined;
  if (type === "boolean") {
    keys(value, ["type"], [], what);
    return { type };
  }
  if (type === "integer") {
    const row = keys(value, ["type", "min", "max"], [], what);
    if (
      !Number.isSafeInteger(row.min) ||
      !Number.isSafeInteger(row.max) ||
      (row.min as number) > (row.max as number)
    )
      fail(`${what} needs whole-number min and max, with min at most max.`);
    return { type, min: row.min as number, max: row.max as number };
  }
  if (type === "enum") {
    const row = keys(value, ["type", "values"], [], what);
    if (!Array.isArray(row.values) || row.values.length < 1 || row.values.length > 64)
      fail(`${what} needs 1 to 64 values.`);
    const values = (row.values as unknown[]).map((v) => text(v, 128, `${what} value`));
    if (new Set(values).size !== values.length) fail(`${what} repeats a value.`);
    return { type, values };
  }
  if (type === "string") {
    const row = keys(value, ["type", "maxLength"], [], what);
    if (
      !Number.isSafeInteger(row.maxLength) ||
      (row.maxLength as number) < 1 ||
      (row.maxLength as number) > 1024
    )
      fail(`${what} needs a maxLength from 1 to 1024.`);
    return { type, maxLength: row.maxLength as number };
  }
  return fail(`${what} must have type integer, enum, boolean, or string.`);
}

function slotOf(value: string): string | null {
  return SLOT.exec(value)?.[1] ?? null;
}

function parseBody(value: unknown, used: Set<string>, depth = 0): AppExternalJson {
  if (depth > 16) return fail("the body is nested too deeply.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("the body has a number JSON can't hold.");
    return value;
  }
  if (typeof value === "string") {
    const slot = slotOf(value);
    if (slot) used.add(slot);
    else if (value.includes("{{") || value.includes("}}"))
      fail('a body text holds "{{" or "}}" but is not exactly one {{input}}.');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => parseBody(item, used, depth + 1));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (RESERVED.has(key)) fail(`the body uses the reserved key "${key}".`);
        return [key, parseBody(item, used, depth + 1)];
      }),
    );
  return fail("the body must be JSON.");
}

function parseHeaderName(value: unknown, what: string): string {
  if (
    typeof value !== "string" ||
    !HTTP_HEADER_NAME_PATTERN.test(value) ||
    isForbiddenHttpHeader(value)
  )
    return fail(`${what} "${String(value)}" can't be set.`);
  return value;
}

/** An operation as the app's author writes it in `app.publish.json`, keyed by its name. */
export function parseAppExternalDeclaration(value: unknown): AppExternalOperation[] {
  if (!isRecord(value)) return fail('"external" must map operation names to operations.');
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > APP_EXTERNAL_MAX_OPERATIONS)
    fail(`an app declares 1 to ${APP_EXTERNAL_MAX_OPERATIONS} operations.`);
  return entries.map(([name, raw]) => {
    const row = keys(
      raw,
      ["method", "url", "secret"],
      ["query", "headers", "body", "params", "maxResponseBytes", "access"],
      `Operation "${name}"`,
    );
    const url = text(row.url, 2048, `Operation "${name}" url`);
    const match = /^https:\/\/([^/?#]+)(\/[^?#]*)$/u.exec(url);
    if (!match)
      fail(`operation "${name}" url must be https://host/path with no query or fragment.`);
    const secret = keys(row.secret, ["name", "header"], ["prefix"], `Operation "${name}" secret`);
    return parseAppExternalOperation({
      name,
      method: row.method,
      host: match![1],
      path: match![2],
      query: row.query ?? {},
      headers: row.headers ?? {},
      body: row.body ?? null,
      params: row.params ?? {},
      secret: { name: secret.name, header: secret.header, prefix: secret.prefix ?? "" },
      response: { maxBytes: row.maxResponseBytes ?? APP_EXTERNAL_DEFAULT_RESPONSE_BYTES },
      access: row.access ?? "owner",
    });
  });
}

/** The stored, normalized form an approval binds. */
export function parseAppExternalOperation(value: unknown): AppExternalOperation {
  const row = keys(
    value,
    [
      "name",
      "method",
      "host",
      "path",
      "query",
      "headers",
      "body",
      "params",
      "secret",
      "response",
      "access",
    ],
    [],
    "Operation",
  );
  const name = row.name;
  if (typeof name !== "string" || !NAME.test(name) || RESERVED.has(name))
    return fail(`the name "${String(name)}" is not allowed.`);
  const what = `Operation "${name}"`;
  if (row.method !== "GET" && row.method !== "POST") fail(`${what} method must be GET or POST.`);
  const method = row.method as "GET" | "POST";
  const host = typeof row.host === "string" ? normalizeSecretAllowedHost(row.host) : null;
  if (!host || host !== row.host) fail(`${what} host must be a lowercase public hostname.`);

  if (!isRecord(row.params) || Object.keys(row.params).length > APP_EXTERNAL_MAX_PARAMS)
    fail(`${what} declares at most ${APP_EXTERNAL_MAX_PARAMS} inputs.`);
  const params = sorted(
    Object.entries(row.params as Record<string, unknown>).map(([key, param]) => [
      key,
      parseParam(key, param),
    ]),
  );
  const used = new Set<string>();

  const path = row.path;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    bytes(path) > APP_EXTERNAL_MAX_PATH_BYTES
  )
    fail(`${what} path must start with "/" and stay under ${APP_EXTERNAL_MAX_PATH_BYTES} bytes.`);
  const segments = (path as string).slice(1).split("/");
  segments.forEach((segment, index) => {
    const slot = slotOf(segment);
    if (slot) {
      used.add(slot);
      const param = params[slot];
      if (
        param?.type === "enum" &&
        param.values.some((v) => !PATH_VALUE.test(v) || v === "." || v === "..")
      )
        fail(`${what} input "${slot}" has a value that can't go in the address.`);
      return;
    }
    if (
      (!segment && index !== segments.length - 1 && segments.length > 1) ||
      segment === "." ||
      segment === ".." ||
      !PATH_LITERAL.test(segment) ||
      /%2e|%2f|%5c/iu.test(segment)
    )
      fail(`${what} path segment "${segment}" is not allowed.`);
  });

  if (!isRecord(row.query) || Object.keys(row.query).length > APP_EXTERNAL_MAX_QUERY)
    fail(`${what} has at most ${APP_EXTERNAL_MAX_QUERY} query fields.`);
  const query = sorted(
    Object.entries(row.query as Record<string, unknown>).map(([key, raw]) => {
      if (!QUERY_KEY.test(key)) fail(`${what} query field "${key}" is not allowed.`);
      const value = text(raw, 512, `${what} query field "${key}"`);
      const slot = slotOf(value);
      if (slot) used.add(slot);
      else if (value.includes("{{")) fail(`${what} query field "${key}" mixes text and an input.`);
      return [key, value];
    }),
  );

  if (!isRecord(row.headers) || Object.keys(row.headers).length > APP_EXTERNAL_MAX_HEADERS)
    fail(`${what} sets at most ${APP_EXTERNAL_MAX_HEADERS} headers.`);
  const seen = new Set<string>();
  const headers = sorted(
    Object.entries(row.headers as Record<string, unknown>).map(([key, raw]) => {
      const header = parseHeaderName(key, `${what} header`);
      const lower = header.toLowerCase();
      if (
        ["authorization", "content-type", "proxy-authorization"].includes(lower) ||
        seen.has(lower)
      )
        fail(`${what} header "${header}" can't be set here.`);
      seen.add(lower);
      const value = text(raw, 512, `${what} header "${header}"`);
      if (!HTTP_HEADER_VALUE_PATTERN.test(value) || value.includes("{{"))
        fail(`${what} header "${header}" must be fixed printable text.`);
      return [header, value];
    }),
  );

  const secretRow = keys(row.secret, ["name", "header", "prefix"], [], `${what} secret`);
  if (typeof secretRow.name !== "string" || !WORKSPACE_SECRET_NAME_PATTERN.test(secretRow.name))
    fail(`${what} secret name must look like POSTHOG_KEY.`);
  const secretHeader = parseHeaderName(secretRow.header, `${what} secret header`);
  if (seen.has(secretHeader.toLowerCase()) || secretHeader.toLowerCase() === "content-type")
    fail(`${what} secret header "${secretHeader}" clashes with another header.`);
  if (
    typeof secretRow.prefix !== "string" ||
    secretRow.prefix.length > 64 ||
    !HTTP_HEADER_VALUE_PATTERN.test(secretRow.prefix)
  )
    fail(`${what} secret prefix must be printable text of at most 64 characters.`);

  if (method === "GET" && row.body !== null)
    fail(`${what} sends a body, so its method must be POST.`);
  const body = row.body === null ? null : parseBody(row.body, used);
  if (body !== null && bytes(JSON.stringify(body)) > APP_EXTERNAL_MAX_BODY_TEMPLATE_BYTES)
    fail(`${what} body is over ${APP_EXTERNAL_MAX_BODY_TEMPLATE_BYTES} bytes.`);

  for (const slot of used)
    if (!params[slot]) fail(`${what} uses {{${slot}}} but doesn't declare it.`);
  for (const param of Object.keys(params))
    if (!used.has(param)) fail(`${what} declares input "${param}" but never uses it.`);

  const response = keys(row.response, ["maxBytes"], [], `${what} response`);
  if (
    !Number.isSafeInteger(response.maxBytes) ||
    (response.maxBytes as number) < APP_EXTERNAL_MIN_RESPONSE_BYTES ||
    (response.maxBytes as number) > APP_EXTERNAL_MAX_RESPONSE_BYTES
  )
    fail(
      `${what} response limit must be from ${APP_EXTERNAL_MIN_RESPONSE_BYTES} to ${APP_EXTERNAL_MAX_RESPONSE_BYTES} bytes.`,
    );
  if (row.access !== "owner" && row.access !== "viewers")
    fail(`${what} access must be "owner" or "viewers".`);

  return {
    name,
    method,
    host: host!,
    path: path as string,
    query,
    headers,
    body,
    params,
    secret: {
      name: secretRow.name as string,
      header: secretHeader,
      prefix: secretRow.prefix as string,
    },
    response: { maxBytes: response.maxBytes as number },
    access: row.access as "owner" | "viewers",
  };
}

/** A list of operations as a candidate stores it: unique names, sorted. */
export function parseAppExternalOperations(value: unknown): AppExternalOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > APP_EXTERNAL_MAX_OPERATIONS)
    return fail(`an app declares 1 to ${APP_EXTERNAL_MAX_OPERATIONS} operations.`);
  const operations = value.map(parseAppExternalOperation);
  for (let i = 1; i < operations.length; i++)
    if (operations[i - 1]!.name >= operations[i]!.name)
      fail("operations must be sorted by name, with no name twice.");
  return operations;
}

export const sortAppExternalOperations = (operations: AppExternalOperation[]) =>
  [...operations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Refusals of an app's input. The message names the input, never a secret. */
export class AppExternalInputError extends Error {
  override readonly name = "AppExternalInputError";
}

function inputValue(
  op: AppExternalOperation,
  name: string,
  value: unknown,
): string | number | boolean {
  const param = op.params[name]!;
  const bad = (why: string): never => {
    throw new AppExternalInputError(`Input "${name}" ${why}`);
  };
  switch (param.type) {
    case "integer":
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < param.min ||
        (value as number) > param.max
      )
        bad(`must be a whole number from ${param.min} to ${param.max}.`);
      return value as number;
    case "enum":
      if (typeof value !== "string" || !param.values.includes(value))
        bad(`must be one of: ${param.values.join(", ")}.`);
      return value as string;
    case "boolean":
      if (typeof value !== "boolean") bad("must be true or false.");
      return value as boolean;
    case "string":
      if (
        typeof value !== "string" ||
        !value ||
        value.length > param.maxLength ||
        CONTROL.test(value)
      )
        bad(`must be text of 1 to ${param.maxLength} characters.`);
      return value as string;
  }
}

/** Builds the one request an operation allows from the app's input. The host and secret never come from input. */
export function renderAppExternalRequest(
  op: AppExternalOperation,
  input: unknown,
): AppExternalRequest {
  if (!isRecord(input)) throw new AppExternalInputError("The input must be an object.");
  if (bytes(JSON.stringify(input)) > APP_EXTERNAL_MAX_INPUT_BYTES)
    throw new AppExternalInputError(`The input is over ${APP_EXTERNAL_MAX_INPUT_BYTES} bytes.`);
  for (const key of Object.keys(input))
    if (!Object.hasOwn(op.params, key))
      throw new AppExternalInputError(`Operation "${op.name}" has no input "${key}".`);
  const values = new Map<string, string | number | boolean>();
  for (const name of Object.keys(op.params)) {
    if (!Object.hasOwn(input, name)) throw new AppExternalInputError(`Input "${name}" is missing.`);
    values.set(name, inputValue(op, name, input[name]));
  }
  const path = op.path
    .split("/")
    .map((segment) => {
      const slot = slotOf(segment);
      if (!slot) return segment;
      const value = String(values.get(slot));
      if (!PATH_VALUE.test(value) || value === "." || value === "..")
        throw new AppExternalInputError(`Input "${slot}" can't go in the address.`);
      return encodeURIComponent(value);
    })
    .join("/");
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(op.query)) {
    const slot = slotOf(raw);
    search.append(key, slot ? String(values.get(slot)) : raw);
  }
  const fill = (value: AppExternalJson): AppExternalJson => {
    if (typeof value === "string") {
      const slot = slotOf(value);
      return slot ? values.get(slot)! : value;
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
    return value;
  };
  const query = search.toString();
  return {
    method: op.method,
    url: `https://${op.host}${path}${query ? `?${query}` : ""}`,
    headers: { ...op.headers, ...(op.body !== null ? { "Content-Type": "application/json" } : {}) },
    body: op.body === null ? null : JSON.stringify(fill(op.body)),
  };
}
