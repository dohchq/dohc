export interface LiveSettlementConfig { readonly maxApplicationsPerSettlement: number }

/** An absent operator field leaves native settlement disabled. */
export function parseLiveSettlementConfig(value: unknown): LiveSettlementConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "maxApplicationsPerSettlement") throw new TypeError("Invalid native settlement configuration.");
  const max = (value as Record<string, unknown>).maxApplicationsPerSettlement;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) throw new TypeError("Invalid native settlement limit.");
  return Object.freeze({ maxApplicationsPerSettlement: max });
}
