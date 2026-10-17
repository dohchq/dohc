// An object's own property descriptors, saved once and put back later. The
// shared test projects use it to give each file the globals and DOM
// prototypes its worker started with.

interface Saved {
  descriptor: PropertyDescriptor;
  value: unknown;
}

export interface OwnProperties {
  keys: (target: object) => PropertyKey[];
  saved: Map<PropertyKey, Saved>;
  compareValues: boolean;
}

function read(target: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return undefined;
  }
}

function same(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return Object.is(a.value, b.value) && a.get === b.get && a.set === b.set
    && a.writable === b.writable && a.enumerable === b.enumerable && a.configurable === b.configurable;
}

/**
 * Saves the descriptors of the keys `keys` lists. With `compareValues`, it also
 * reads each accessor that has a setter: vitest exposes jsdom's window through
 * such accessors, and an assignment changes what they return, not the
 * descriptor.
 */
export function saveOwnProperties(
  target: object,
  keys: (target: object) => PropertyKey[],
  compareValues = false,
): OwnProperties {
  const saved = new Map<PropertyKey, Saved>();
  for (const key of keys(target)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (descriptor) saved.set(key, { descriptor, value: compareValues && descriptor.set ? read(target, key) : undefined });
  }
  return { keys, saved, compareValues };
}

/** Deletes added properties and puts back changed or deleted ones. A property that cannot be configured stays. */
export function restoreOwnProperties(target: object, { keys, saved, compareValues }: OwnProperties): void {
  for (const key of keys(target)) {
    const now = Reflect.getOwnPropertyDescriptor(target, key);
    if (!now?.configurable) continue;
    const before = saved.get(key);
    if (!before) Reflect.deleteProperty(target, key);
    else if (!same(before.descriptor, now)) Reflect.defineProperty(target, key, before.descriptor);
    else if (compareValues && now.set && !Object.is(read(target, key), before.value)) Reflect.set(target, key, before.value);
  }
  for (const [key, { descriptor }] of saved) {
    if (!Reflect.getOwnPropertyDescriptor(target, key)) Reflect.defineProperty(target, key, descriptor);
  }
}
