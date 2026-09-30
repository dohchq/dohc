import { compileDatasetOperations } from "@dohc/app-backend-runtime/dataset-compiler";

// Share only successful compiled bytes; each fixture keeps its own host and approval.
export function createDatasetFixtureCompiler() {
  const compiledSources = new Map<string, string>();
  return async (source: string, path: string, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    const key = JSON.stringify([path, source]);
    const existing = compiledSources.get(key);
    if (existing !== undefined) return existing;
    const compiled = await compileDatasetOperations(source, path, { signal });
    signal.throwIfAborted();
    compiledSources.set(key, compiled);
    return compiled;
  };
}
