import { bridge } from "../bridge";
export function useWorkspaceListing() { return bridge().listWorkspaceFiles({}); }
