import { runWorkspaceBackendConformance } from "@dohc/workspace-contracts";
import { postgresTestAdapter } from "./testAdapter";

runWorkspaceBackendConformance(postgresTestAdapter);
