const cache: Record<string, unknown> = {};
export async function readCached(desktop: any, input: { key: string }) { cache[input.key] = await desktop.read(input); return cache[input.key]; }
