import { requireNativeModule } from "expo";

/** The native module as JavaScript sees it. Use it through `createDurableFiles` (`src/server/durableFiles.ts`), which
 * checks names and sizes first and turns native errors into `DurableFileError`. */
export interface NativeDurableFile {
  write(name: string, text: string): Promise<void>;
  read(name: string): Promise<string | null>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
  recover(): Promise<{ leftovers: string[]; unreadable: string[] }>;
  removeLeftover(fileName: string): Promise<void>;
}

/** Loads the native module on first use, so importing this file does nothing on its own. */
export const nativeDurableFile = (): NativeDurableFile =>
  requireNativeModule<NativeDurableFile>("DurableFile");
