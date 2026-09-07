export function encodeFixtureBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { $dohcInt64: value.toString() };
  }
  if (Array.isArray(value)) return value.map(encodeFixtureBigInts);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        encodeFixtureBigInts(child),
      ]),
    );
  }
  return value;
}
