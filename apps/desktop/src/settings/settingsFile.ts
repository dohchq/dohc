import { z } from "zod";

// The rule for every settings file a person can edit (contracts-06): a key
// dohc does not know, or a key whose value dohc cannot use, turns off only
// itself. That key takes its default, the rest of the file applies, and dohc
// names the key. A save changes only the keys it changed, so dohc never
// rewrites a person's file to drop what it does not understand.

const MAX_IGNORED_SETTINGS = 50;
const MAX_IGNORED_KEY_CHARS = 200;

export const IgnoredSetting = z.object({
  key: z.string().max(MAX_IGNORED_KEY_CHARS),
  reason: z.enum(["unknown", "invalid"]),
}).strict();
export type IgnoredSetting = z.infer<typeof IgnoredSetting>;

export const IgnoredSettings = z.array(IgnoredSetting).min(1).max(MAX_IGNORED_SETTINGS);

type SettingsPath = readonly string[];

// "group" is read key by key, "leaf" is used or ignored whole, and null is a
// key dohc does not know.
type SettingKind = "group" | "leaf" | null;

export function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(value: unknown, path: SettingsPath): unknown {
  let current = value;
  for (const key of path) {
    if (!isSettingsObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

// A copy of `target` with `value` at `path`; undefined removes the key.
function withValue(target: unknown, path: SettingsPath, value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  const copy = isSettingsObject(target) ? { ...target } : {};
  const child = withValue(copy[key], rest, value);
  if (child === undefined) delete copy[key];
  else copy[key] = child;
  return copy;
}

function unwrapped(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodDefault || current instanceof z.ZodOptional) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

// The schema of one key inside an object or a record, or undefined for a key
// the object does not have. Every key of a record is known: whether it is
// valid is the record's to say.
function childSchema(schema: z.ZodType, key: string): z.ZodType | undefined {
  const inner = unwrapped(schema);
  if (inner instanceof z.ZodObject) {
    return Object.hasOwn(inner.shape, key) ? inner.shape[key] as z.ZodType : undefined;
  }
  if (inner instanceof z.ZodRecord) return inner.valueType as z.ZodType;
  return undefined;
}

/**
 * Which keys a settings schema knows. A group is an object or a record with
 * defaults, so each of its keys can fall back alone; an object without
 * defaults, such as an optional launch profile, is one leaf.
 */
export function settingKinds(
  schema: z.ZodType,
  defaults: unknown,
): (path: SettingsPath) => SettingKind {
  return (path) => {
    let current: z.ZodType | undefined = schema;
    for (const key of path) {
      current = childSchema(current, key);
      if (!current) return null;
    }
    const inner = unwrapped(current);
    return (inner instanceof z.ZodObject || inner instanceof z.ZodRecord) &&
      isSettingsObject(valueAt(defaults, path))
      ? "group"
      : "leaf";
  };
}

function ignoredKey(path: SettingsPath): string {
  const key = path.join(".");
  return key.length > MAX_IGNORED_KEY_CHARS
    ? `${key.slice(0, MAX_IGNORED_KEY_CHARS - 1)}…`
    : key;
}

/**
 * Reads a settings object key by key. Each key the file sets is tried on top
 * of the defaults and kept when the whole still parses. Keys that depend on
 * each other (dispatch needs a command) are retried until nothing more fits,
 * so their order in the file does not matter.
 */
export function readSettingsLeniently<T>(input: {
  raw: Record<string, unknown>;
  defaults: T;
  kind: (path: SettingsPath) => SettingKind;
  parse: (candidate: unknown) => T | null;
}): { settings: T; ignored: IgnoredSetting[] } {
  const whole = input.parse(input.raw);
  if (whole !== null) return { settings: whole, ignored: [] };

  const leaves: Array<{ path: SettingsPath; known: boolean }> = [];
  const collect = (object: Record<string, unknown>, parent: SettingsPath) => {
    for (const [key, value] of Object.entries(object)) {
      const path = [...parent, key];
      const kind = input.kind(path);
      if (kind === "group" && isSettingsObject(value)) collect(value, path);
      else leaves.push({ path, known: kind !== null });
    }
  };
  collect(input.raw, []);

  let candidate: unknown = input.defaults;
  let settings = input.defaults;
  let pending = leaves.filter((leaf) => leaf.known);
  for (let progressed = true; progressed && pending.length > 0;) {
    progressed = false;
    pending = pending.filter(({ path }) => {
      const trial = withValue(candidate, path, valueAt(input.raw, path));
      const parsed = input.parse(trial);
      if (parsed === null) return true;
      candidate = trial;
      settings = parsed;
      progressed = true;
      return false;
    });
  }
  const invalid = new Set(pending);
  const ignored = leaves
    .filter((leaf) => !leaf.known || invalid.has(leaf))
    .slice(0, MAX_IGNORED_SETTINGS)
    .map((leaf): IgnoredSetting => ({
      key: ignoredKey(leaf.path),
      reason: leaf.known ? "invalid" : "unknown",
    }));
  return { settings, ignored };
}

/**
 * The file after a save: `raw` as the person left it, with only the settings
 * that differ between `current` (what the file means now) and `next`.
 * Unknown keys, and values dohc could not use and did not change, stay.
 */
export function overlaySettings(
  raw: Record<string, unknown>,
  current: unknown,
  next: unknown,
): Record<string, unknown> {
  let content: unknown = raw;
  const visit = (before: unknown, after: unknown, path: SettingsPath) => {
    if (isSettingsObject(before) && isSettingsObject(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        visit(before[key], after[key], [...path, key]);
      }
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      content = withValue(content, path, after);
    }
  };
  visit(current, next, []);
  return content as Record<string, unknown>;
}
