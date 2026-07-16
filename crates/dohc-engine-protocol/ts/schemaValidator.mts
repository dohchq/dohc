// Minimal JSON Schema (draft 2020-12 subset) validator covering exactly the
// keywords schemars emits for the dohc engine protocol schema: $ref into
// $defs (and "#" root self-reference), oneOf, anyOf, not, type
// (string | string[]), const, enum, properties, required, items, minimum,
// maximum, plus fixed-width integer `format` ranges (uint32 etc., which
// schemars emits without an explicit maximum). Handwritten support code for
// the spike; a production client would use ajv (with equivalent format
// range checks) against the same generated schema.

export type Schema = boolean | SchemaObject;

export interface SchemaObject {
  $defs?: Record<string, Schema>;
  $ref?: string;
  oneOf?: Schema[];
  anyOf?: Schema[];
  not?: Schema;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
  maximum?: number;
  format?: string;
  [other: string]: unknown;
}

// Value ranges implied by schemars' fixed-width integer formats. The wire
// contract additionally caps 64-bit values at Number.MAX_SAFE_INTEGER
// (2^53-1), so a JS peer never loses precision.
const INTEGER_FORMAT_RANGES: Record<string, [number, number]> = {
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  uint64: [0, Number.MAX_SAFE_INTEGER],
  uint: [0, Number.MAX_SAFE_INTEGER],
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
  int64: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const primitive = typeof value;
  if (primitive === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return primitive;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class Validator {
  private readonly root: SchemaObject;

  constructor(root: SchemaObject) {
    this.root = root;
  }

  private resolve(ref: string): Schema {
    if (ref === "#") return this.root;
    const prefix = "#/$defs/";
    if (!ref.startsWith(prefix)) {
      throw new Error(`unsupported $ref: ${ref}`);
    }
    const name = ref.slice(prefix.length);
    const target = this.root.$defs?.[name];
    if (target === undefined) {
      throw new Error(`unresolved $ref: ${ref}`);
    }
    return target;
  }

  /** Returns a list of violations; empty means valid. */
  validate(value: unknown, schema: Schema = this.root, path = "$"): string[] {
    if (schema === true) return [];
    if (schema === false) return [`${path}: schema forbids all values`];
    const errors: string[] = [];

    if (schema.$ref !== undefined) {
      errors.push(...this.validate(value, this.resolve(schema.$ref), path));
    }
    if (schema.type !== undefined) {
      const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!expected.some((entry) => matchesType(value, entry))) {
        errors.push(`${path}: expected ${expected.join("|")}, got ${typeOf(value)}`);
      }
    }
    if (schema.const !== undefined && !deepEqual(value, schema.const)) {
      errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
    }
    if (schema.enum !== undefined && !schema.enum.some((entry) => deepEqual(value, entry))) {
      errors.push(`${path}: value not in enum`);
    }
    if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
    if (schema.format !== undefined && typeof value === "number") {
      const range = INTEGER_FORMAT_RANGES[schema.format];
      if (range !== undefined) {
        if (!Number.isInteger(value)) {
          errors.push(`${path}: ${value} is not an integer (${schema.format})`);
        } else if (value < range[0] || value > range[1]) {
          errors.push(`${path}: ${value} outside ${schema.format} range`);
        }
      }
    }
    if (schema.not !== undefined && this.validate(value, schema.not, path).length === 0) {
      errors.push(`${path}: matches forbidden (not) schema`);
    }
    if (schema.properties !== undefined || schema.required !== undefined) {
      if (typeOf(value) === "object") {
        const record = value as Record<string, unknown>;
        for (const key of schema.required ?? []) {
          if (!(key in record)) errors.push(`${path}: missing required ${key}`);
        }
        for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
          if (key in record) {
            errors.push(...this.validate(record[key], propertySchema, `${path}.${key}`));
          }
        }
      }
    }
    if (schema.items !== undefined && Array.isArray(value)) {
      value.forEach((item, index) => {
        errors.push(...this.validate(item, schema.items as Schema, `${path}[${index}]`));
      });
    }
    if (schema.anyOf !== undefined) {
      const matched = schema.anyOf.some(
        (branch) => this.validate(value, branch, path).length === 0,
      );
      if (!matched) errors.push(`${path}: no anyOf branch matched`);
    }
    if (schema.oneOf !== undefined) {
      const matches = schema.oneOf.filter(
        (branch) => this.validate(value, branch, path).length === 0,
      ).length;
      if (matches !== 1) errors.push(`${path}: ${matches} oneOf branches matched, expected 1`);
    }
    return errors;
  }
}

export interface WireLimitsJson {
  maxFrameBytes: number;
  maxBlobChunkBytes: number;
  maxStringBytes: number;
  maxCollectionLen: number;
  maxBatchLen: number;
  maxJsonDepth: number;
}

/**
 * The TypeScript twin of the Rust `check_json` bounds walker: enforces
 * string bytes, collection length, depth, and safe-integer range using the
 * generated limits. Returns violations; empty means within bounds.
 */
export function checkBounds(
  value: unknown,
  limits: WireLimitsJson,
  maxWireInteger: number,
  path = "$",
  depth = 1,
): string[] {
  const errors: string[] = [];
  if (depth > limits.maxJsonDepth) {
    return [`${path}: depth ${depth} exceeds ${limits.maxJsonDepth}`];
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > limits.maxStringBytes) {
      errors.push(`${path}: string ${bytes} bytes exceeds ${limits.maxStringBytes}`);
    }
  } else if (typeof value === "number") {
    if (Number.isInteger(value) && Math.abs(value) > maxWireInteger) {
      errors.push(`${path}: integer exceeds maxWireInteger`);
    }
  } else if (Array.isArray(value)) {
    if (value.length > limits.maxCollectionLen) {
      errors.push(`${path}: array length ${value.length} exceeds ${limits.maxCollectionLen}`);
    }
    value.forEach((item, index) => {
      errors.push(...checkBounds(item, limits, maxWireInteger, `${path}[${index}]`, depth + 1));
    });
  } else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.maxCollectionLen) {
      errors.push(`${path}: object size ${entries.length} exceeds ${limits.maxCollectionLen}`);
    }
    for (const [key, item] of entries) {
      errors.push(...checkBounds(key, limits, maxWireInteger, `${path}.${key} (key)`, depth));
      errors.push(...checkBounds(item, limits, maxWireInteger, `${path}.${key}`, depth + 1));
    }
  }
  return errors;
}

/** Sorted-key compact JSON — must byte-match Rust's canonical encoding. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
