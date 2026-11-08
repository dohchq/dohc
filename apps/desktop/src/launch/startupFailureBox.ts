import {
  REGISTRY_READ_FAILURE_TITLE,
  RegistryReadError,
  registryReadFailureNext,
} from "../workspaces/registryReadFailure";

// The native box main shows when startup fails before any window opens.
export function startupFailureBox(error: unknown): { title: string; content: string } {
  if (error instanceof RegistryReadError) {
    return {
      title: REGISTRY_READ_FAILURE_TITLE,
      content: `${registryReadFailureNext(error.code)}\n\nTechnical details\nFile: ${error.registryFile}\nDetail: ${error.message}`,
    };
  }
  const message = error instanceof Error ? error.message : "Unknown desktop startup error.";
  return {
    title: "dohc failed to start",
    content: `${message}\n\nRestart dohc. If it fails again, review the desktop logs.`,
  };
}
