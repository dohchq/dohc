// Compatibility re-export. The canonical cross-process implementation lives
// in @dohc/security-contract so relay code no longer imports engine internals.
export {
  classifyEngineFilePath,
  classifyEngineFilePathForRead,
} from "@dohc/security-contract/engine-path-floor";
