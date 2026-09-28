import { posix } from "node:path";
import type { DatasetRevision } from "@dohc/security-contract/dataset";
import { isSharedWithMePath } from "@dohc/workspace-core";
import type { ReachCollection, ReachDatasetGrants } from "./automationReach";

export type AutomationTarget =
  | { kind: "document"; collection: ReachCollection; fields: ReadonlySet<string> | null }
  | { kind: "dataset"; collection: ReachCollection; approved: DatasetRevision; generated: boolean; grants: ReachDatasetGrants };

export type TargetProblem = "denied" | "missing" | "invalid-schema" | "invalid-descriptor" | "descriptor-mismatch" | "host-unavailable";
export type TargetResolution = AutomationTarget | { kind: "problem"; code: TargetProblem; problem: string };

export interface AutomationTargetHost {
  revision(datasetId: string): DatasetRevision;
  generated(datasetId: string): boolean;
  dataGrants(datasetId: string): ReachDatasetGrants;
}

export interface AutomationTargetDependencies {
  /** Changes whenever watched Collection metadata or approved rules change. */
  revisionOf?(): number;
  readText(path: string): Promise<{ text: string; truncated: boolean } | null>;
  /** A document Collection's fields, why its schema cannot be read, or null when it has none. */
  readSchemaFields(path: string): Promise<ReadonlySet<string> | string | null>;
  isCollection(path: string): boolean;
  withHost<T>(work: (host: AutomationTargetHost) => T | Promise<T>): Promise<T | null>;
}

const problem = (code: TargetProblem, message: string): TargetResolution => ({ kind: "problem", code, problem: message });

/** Resolves metadata, never permission. Callers check source-editor reach before record access. */
export function createAutomationTargets(dependencies: AutomationTargetDependencies): AutomationTargets {
  const checkedAt = new WeakMap<AutomationTarget, number>();
  async function resolve(path: string, documentFields?: ReadonlySet<string> | null): Promise<TargetResolution> {
    if (isSharedWithMePath(path)) return problem("denied", "Automations cannot use a Collection received through a share. Choose a Collection you own.");
    const collection = { path, name: path.split("/").at(-1) ?? path };
    const descriptor = await dependencies.readText(`${path}/dataset.json`);
    if (descriptor !== null) {
      let value: unknown;
      try { value = descriptor.truncated ? null : JSON.parse(descriptor.text); } catch { value = null; }
      if (typeof value !== "object" || value === null || !("datasetId" in value) || typeof value.datasetId !== "string" || value.datasetId.length === 0) {
        return problem("invalid-descriptor", `dohc cannot read ${path}/dataset.json. Fix that file, then try again.`);
      }
      const datasetId = value.datasetId;
      const resolved = await dependencies.withHost((host): TargetResolution => {
        const approved = host.revision(datasetId);
        if (approved.datasetId !== datasetId || approved.definition.datasetId !== datasetId || posix.dirname(approved.definition.schemaPath) !== path) {
          return problem("descriptor-mismatch", `${path}/dataset.json does not match its approved rules. Restore the matching file, then try again.`);
        }
        return { kind: "dataset", collection, approved, generated: host.generated(datasetId), grants: host.dataGrants(datasetId) };
      });
      return resolved ?? problem("host-unavailable", `The dataset host for ${path} is unavailable.`);
    }
    if (!dependencies.isCollection(path)) return problem("missing", `dohc cannot find the Collection ${path}.`);
    const fields = documentFields !== undefined ? documentFields : await dependencies.readSchemaFields(path);
    if (typeof fields === "string") return problem("invalid-schema", fields);
    return { kind: "document", collection, fields };
    }
  return {
    async resolve(path) {
      const revision = dependencies.revisionOf?.();
      const target = await resolve(path);
      if (target.kind !== "problem" && revision !== undefined) checkedAt.set(target, revision);
      return target;
    },
    async validate(target) {
      const revision = dependencies.revisionOf?.();
      if (revision !== undefined && checkedAt.get(target) === revision) return target;
      const fresh = await resolve(target.collection.path, target.kind === "document" ? target.fields : undefined);
      if (fresh.kind !== "problem" && revision !== undefined) checkedAt.set(target, revision);
      return fresh;
    },
  };
}

export interface AutomationTargets {
  resolve(path: string): Promise<TargetResolution>;
  /** Rechecks the descriptor and authority while retaining this attempt's document schema. */
  validate?(target: AutomationTarget): Promise<TargetResolution>;
}
