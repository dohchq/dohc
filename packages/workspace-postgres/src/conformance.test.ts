import { runWorkspaceBackendConformance } from "@dohc/workspace-contracts/conformance";
import { postgresTestAdapter } from "./testAdapter";

runWorkspaceBackendConformance(postgresTestAdapter);
