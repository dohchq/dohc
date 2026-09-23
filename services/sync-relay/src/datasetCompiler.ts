import { compileDatasetOperations as compile, DatasetCompilerError } from "@dohc/app-backend-runtime/dataset-compiler";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-host";

export async function compileDatasetOperations(source: string, path: string): Promise<string> {
  try { return await compile(source, path); }
  catch (error) {
    if (error instanceof DatasetCompilerError) throw new DatasetHostError(error.code, error.message);
    throw error;
  }
}
