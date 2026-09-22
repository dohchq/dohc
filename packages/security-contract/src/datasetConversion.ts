/** A decimal identity without allocating exponent-sized strings. */
function decimal(value: string): string | null {
  if (value.length > 64 * 1024) return null;
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  let digits = (match[2]! + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  const trimmed = digits.replace(/0+$/, "");
  const exponent = Number(match[4] ?? 0) - fraction.length + digits.length - trimmed.length;
  digits = trimmed;
  return `${match[1]}${digits}e${exponent}`;
}

/** Null means the text would be invalid, rounded, overflowed, or lost to underflow. */
export function losslessDatasetNumber(value: string): number | null {
  const identity = decimal(value);
  if (identity === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || decimal(String(parsed)) !== identity) return null;
  return parsed;
}

/** JavaScript's shortest decimal form round-trips the stored finite double. */
export function datasetNumberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error("This value is not a finite number.");
  return String(value);
}
