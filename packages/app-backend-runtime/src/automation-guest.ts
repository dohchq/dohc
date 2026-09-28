type GuestValue = null | boolean | number | string | GuestValue[] | { [key: string]: GuestValue };
type GuestObject = { [key: string]: GuestValue };
type GuestScope = {
  record?: GuestObject;
  previous?: GuestObject;
  trigger: GuestObject;
  person: GuestValue;
  message?: GuestObject;
  bindings?: GuestObject;
  now: string;
  recordKeys?: string[];
};
type GuestTextPart = { kind: "text"; text: string } | { kind: "expression"; expression: string };

export type GuestKind = "expression" | "text" | "code";

export type GuestEvaluate = (source: string, resultChars: number) => string;

/**
 * Prepares one formula or code step's scope inside a fresh QuickJS context, before authored code runs.
 * It returns a function that evaluates the source and returns the outcome as JSON, or that outcome
 * already when the scope cannot be read. For `text`, the source is the parts as JSON.
 * A reply longer than `resultChars` reports `too_large`.
 * The worker sends this function's source text to the guest, so it must not use anything declared outside it.
 * The client validates `scope.now` and the worker refuses bindings named after globals before the call.
 */
export function automationGuest(scopeJson: string, kind: GuestKind): GuestEvaluate | string {
  const freeze = Object.freeze, isArray = Array.isArray, stringify = JSON.stringify;
  const subject = kind === "code" ? "The code" : "The formula";
  const fail = (code: string, message: string) => stringify({ ok: false, error: { code, message } });
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
      freeze(value);
    }
    return value;
  };
  let scope: GuestScope;
  try {
    scope = deepFreeze(JSON.parse(scopeJson) as GuestScope);
  } catch {
    return fail("too_large", "The record and step results are too large or too deeply nested to read.");
  }

  // Dates are ISO strings. A calendar date (2026-09-24) has no offset. A date with a time
  // keeps its own offset; one written without an offset uses the offset of `now`.
  type Moment = { wall: number; offset: number | null };
  const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const utc = (year: number, month: number, day: number) => {
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    return date.getTime();
  };
  const pattern = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;
  const parse = (value: unknown, helper: string, runOffset: number | null): Moment => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (!match) throw new TypeError(`${helper} needs a date such as 2026-09-24 or 2026-09-24T09:30:00Z.`);
    const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(part => part === undefined ? undefined : Number(part));
    const millisecond = match[7] ? Math.floor(Number(`0.${match[7]}`) * 1000) : 0;
    const date = new Date(utc(year!, month! - 1, day!) + hour * HOUR + minute * MINUTE + second * 1000 + millisecond);
    const zone = match[8];
    const offset = match[4] === undefined ? null : zone === undefined ? runOffset : zone === "Z" ? 0
      : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
    if (date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 ||
      (offset !== null && (Math.abs(offset) > 14 * 60 || Number(zone?.slice(4, 6) ?? 0) > 59))) {
      throw new RangeError(`${helper} needs a real date. ${String(value)} is not one.`);
    }
    return { wall: date.getTime(), offset };
  };
  const clock = parse(scope.now, "now", null);
  const runOffset = clock.offset!;
  const moment = (value: unknown, helper: string) => parse(value, helper, runOffset);
  const format = ({ wall, offset }: Moment, helper: string) => {
    const date = new Date(wall);
    const year = date.getUTCFullYear();
    if (!(year >= 0 && year <= 9999)) throw new RangeError(`${helper} went outside the years 0000 to 9999.`);
    const day = `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    if (offset === null) return day;
    const zone = offset === 0 ? "Z" : `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return `${day}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}${zone}`;
  };
  const withTime = (value: Moment): Moment => value.offset === null ? { wall: value.wall, offset: runOffset } : value;
  const addMonths = (wall: number, count: number) => {
    const time = ((wall % DAY) + DAY) % DAY, date = new Date(wall - time);
    const first = new Date(utc(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
    const last = new Date(utc(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return utc(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date.getUTCDate(), last)) + time;
  };
  const monthsBetween = (later: number, earlier: number): number => {
    if (later < earlier) return -monthsBetween(earlier, later);
    const a = new Date(later), b = new Date(earlier);
    const count = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + a.getUTCMonth() - b.getUTCMonth();
    return addMonths(earlier, count) > later ? count - 1 : count;
  };
  const unit = (value: unknown, helper: string) => {
    const name = typeof value === "string" ? value.toLowerCase().replace(/s$/, "") : "";
    if (!["year", "quarter", "month", "week", "day", "hour", "minute"].includes(name)) {
      throw new TypeError(`${helper} needs a unit: years, quarters, months, weeks, days, hours, or minutes.`);
    }
    return name;
  };

  const text = (value: unknown, helper: string): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    throw new TypeError(`${helper} needs text.`);
  };
  const numbers = (values: unknown[], helper: string): number[] => {
    const list: number[] = [];
    for (const value of values.flat()) {
      if (value === null || value === undefined || value === "") continue;
      if (typeof value !== "number") throw new TypeError(`${helper} needs numbers.`);
      list.push(value);
    }
    return list;
  };
  const shift = (value: number, places: number) => {
    const [digits, exponent = "0"] = String(value).split("e");
    return Number(`${digits}e${Number(exponent) + places}`);
  };

  const helpers = freeze({
    now: () => format(clock, "now"),
    today: () => format({ wall: clock.wall, offset: null }, "today"),
    dateAdd(date: unknown, amount: unknown, units: unknown) {
      const start = moment(date, "dateAdd"), name = unit(units, "dateAdd");
      if (!Number.isInteger(amount)) throw new TypeError("dateAdd needs a whole number to add, such as 3.");
      const count = amount as number;
      if (name === "hour" || name === "minute") {
        const timed = withTime(start);
        return format({ wall: timed.wall + count * (name === "hour" ? HOUR : MINUTE), offset: timed.offset }, "dateAdd");
      }
      const wall = name === "day" || name === "week" ? start.wall + count * (name === "week" ? 7 : 1) * DAY
        : addMonths(start.wall, count * (name === "year" ? 12 : name === "quarter" ? 3 : 1));
      return format({ wall, offset: start.offset }, "dateAdd");
    },
    dateBetween(first: unknown, second: unknown, units: unknown) {
      const a = moment(first, "dateBetween"), b = moment(second, "dateBetween"), name = unit(units, "dateBetween");
      // Both dates are read on the clock of `now`. A calendar date starts at its midnight.
      const local = (value: Moment) => value.offset === null ? value.wall : value.wall + (runOffset - value.offset) * MINUTE;
      const later = local(a), earlier = local(b), difference = later - earlier;
      const result = name === "minute" ? difference / MINUTE : name === "hour" ? difference / HOUR : name === "day" ? difference / DAY
        : name === "week" ? difference / (7 * DAY) : monthsBetween(later, earlier) / (name === "year" ? 12 : name === "quarter" ? 3 : 1);
      return Math.trunc(result) || 0;
    },
    formatDate(date: unknown, pattern: unknown = "MMMM D, YYYY") {
      const value = new Date(moment(date, "formatDate").wall);
      if (typeof pattern !== "string") throw new TypeError('formatDate needs a format such as "MMMM D, YYYY".');
      const hours = value.getUTCHours();
      const tokens: Record<string, string> = {
        YYYY: pad(value.getUTCFullYear(), 4), YY: pad(value.getUTCFullYear() % 100),
        MMMM: months[value.getUTCMonth()]!, MMM: months[value.getUTCMonth()]!.slice(0, 3),
        MM: pad(value.getUTCMonth() + 1), M: String(value.getUTCMonth() + 1), DD: pad(value.getUTCDate()), D: String(value.getUTCDate()),
        dddd: weekdays[value.getUTCDay()]!, ddd: weekdays[value.getUTCDay()]!.slice(0, 3),
        HH: pad(hours), H: String(hours), hh: pad(hours % 12 || 12), h: String(hours % 12 || 12),
        mm: pad(value.getUTCMinutes()), ss: pad(value.getUTCSeconds()), A: hours < 12 ? "AM" : "PM",
      };
      return pattern.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A/g,
        (token, literal: string | undefined) => literal ?? tokens[token]!);
    },
    lower: (value: unknown) => text(value, "lower").toLowerCase(),
    upper: (value: unknown) => text(value, "upper").toUpperCase(),
    trim: (value: unknown) => text(value, "trim").trim(),
    contains(value: unknown, search: unknown) {
      if (isArray(value)) return value.includes(search);
      return text(value, "contains").includes(text(search, "contains"));
    },
    join(list: unknown, separator: unknown = ", ") {
      if (list === null || list === undefined) return "";
      if (!isArray(list)) throw new TypeError("join needs a list.");
      return list.filter(item => item !== null && item !== undefined && item !== "").map(item => text(item, "join")).join(text(separator, "join"));
    },
    length(value: unknown) {
      if (value === null || value === undefined) return 0;
      if (typeof value === "string") return Array.from(value).length;
      if (isArray(value)) return value.length;
      throw new TypeError("length needs text or a list.");
    },
    sum: (...values: unknown[]) => numbers(values, "sum").reduce((total, value) => total + value, 0),
    min: (...values: unknown[]) => numbers(values, "min").reduce<number | null>((low, value) => low === null || value < low ? value : low, null),
    max: (...values: unknown[]) => numbers(values, "max").reduce<number | null>((high, value) => high === null || value > high ? value : high, null),
    round(value: unknown, places: unknown = 0) {
      if (value === null || value === undefined) return null;
      if (typeof value !== "number") throw new TypeError("round needs a number.");
      if (!Number.isInteger(places) || Math.abs(places as number) > 15) throw new RangeError("round needs a whole number of places from -15 to 15.");
      const shifted = shift(value, places as number);
      // A number too large to shift has no digits at that place, so it stays as it is.
      return Number.isFinite(shifted) ? shift(Math.round(shifted), -(places as number)) : value;
    },
  });
  // A record whose other keys formulas may not read: reading one throws, so a
  // formula never takes a field it cannot see for an empty one. What every
  // object has, such as toString, still works.
  const allowed = scope.recordKeys;
  // Asking whether it has a key, or for the key's descriptor, is a read too.
  const check = (key: string | symbol) => {
    if (allowed !== undefined && typeof key === "string" && !allowed.includes(key) && !(key in Object.prototype)) {
      throw new TypeError(`${subject} can read only this record's ${allowed.join(", ")}, not ${key}.`);
    }
  };
  const sealed = (record: GuestObject | undefined): GuestObject | null => record === undefined ? null : allowed === undefined ? record
    : new Proxy(record, {
      get(target, key, receiver) { check(key); return Reflect.get(target, key, receiver); },
      has(target, key) { check(key); return Reflect.has(target, key); },
      getOwnPropertyDescriptor(target, key) { check(key); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
  const record = sealed(scope.record);
  const trigger = allowed !== undefined && scope.trigger.record && typeof scope.trigger.record === "object" && !isArray(scope.trigger.record)
    ? freeze({ ...scope.trigger, record: sealed(scope.trigger.record as GuestObject) })
    : scope.trigger;
  const names = {
    record, previous: scope.previous ?? {}, trigger, person: scope.person,
    message: scope.message ?? null, ...scope.bindings, ...helpers,
  };
  try {
    // SharedArrayBuffer's grow returns heap memory without clearing it, so authored code never gets it.
    if (!Reflect.deleteProperty(globalThis, "SharedArrayBuffer")) throw new TypeError("SharedArrayBuffer stayed.");
    // Frozen built-ins keep authored code from changing what the evaluator uses after that code runs.
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      const value: unknown = (globalThis as Record<string, unknown>)[name];
      if (value === globalThis) continue;
      if (typeof value === "function") freeze(value.prototype);
      if (value !== null && (typeof value === "object" || typeof value === "function")) freeze(value);
    }
    // A formula reads the scope and helpers as globals; a code step reads them from `ctx`. Both are frozen already.
    if (kind !== "code") {
      for (const [name, value] of Object.entries(names)) {
        Object.defineProperty(globalThis, name, { value, writable: false, enumerable: false, configurable: false });
      }
    }
    freeze(globalThis);
  } catch {
    return fail("too_large", "The record and step results are too large to read.");
  }

  const describe = (error: unknown) => {
    try {
      if (typeof error === "string") return error.slice(0, 1024);
      if (error instanceof Error) return `${String(error.name)}: ${String(error.message)}`.slice(0, 1024);
    } catch { /* A thrown value's own getters can fail. */ }
    return `${subject} threw a value that is not an error.`;
  };
  // QuickJS reports both limits as a catchable InternalError.
  const failure = (error: unknown, code: string, prefix = "") => {
    try {
      if (error instanceof Error && error.name === "InternalError") {
        if (error.message === "out of memory") return fail("memory", `${subject} used more memory than it is allowed, so it stopped.`);
        if (error.message === "stack overflow") return fail("memory", `${subject} nested its calls too deeply, so it stopped.`);
      }
    } catch { /* A thrown value's own getters can fail. */ }
    return fail(code, prefix + describe(error));
  };
  const compile = (expression: string) => new Function(`"use strict"; return (${expression}\n);`) as () => unknown;
  // Message text inserts each expression's value: a list as its items, an object as JSON, nothing for an empty value.
  const messageText = (json: string) => {
    const parts = (JSON.parse(json) as GuestTextPart[]).map(part => part.kind === "text" ? part.text : compile(part.expression));
    return () => parts.map(part => {
      if (typeof part === "string") return part;
      const value = part();
      if (isArray(value)) return helpers.join(value);
      if (value === null || value === undefined) return "";
      return typeof value === "object" ? stringify(value) : String(value);
    }).join("");
  };

  return (source, resultChars) => {
    let run: () => unknown;
    try {
      if (kind === "code") {
        const body = new Function("ctx", `"use strict";\n${source}\n`) as (ctx: unknown) => unknown;
        const ctx = freeze(names);
        run = () => body(ctx);
      } else {
        run = kind === "expression" ? compile(source) : messageText(source);
      }
    } catch (error) {
      return failure(error, "syntax");
    }

    let value: unknown;
    try {
      value = run();
      if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
        return fail("invalid_result", `${subject} must finish without waiting. Remove async and await.`);
      }
    } catch (error) {
      return failure(error, "runtime");
    }
    // A code step that returns nothing asks for nothing. A formula without a value is empty.
    if (kind === "code") value ??= {};
    else if (value === undefined) value = null;
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      return fail("invalid_result", `${subject} must produce text, a number, true or false, a list, or an object.`);
    }
    let json: string;
    try {
      json = `{"ok":true,"value":${stringify(value)}}`;
    } catch (error) {
      return failure(error, "invalid_result", `${subject} produced a value that cannot be saved. `);
    }
    return json.length > resultChars ? fail("too_large", `${subject} produced more than ${resultChars / 1024} KiB.`) : json;
  };
}
