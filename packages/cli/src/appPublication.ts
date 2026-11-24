import { z } from "zod";
import { parseAppCollectionCapability } from "@dohc/security-contract/app-publication";
import {
  APP_DATASET_MAX_BINDINGS,
  parseAppDatasetCapability,
} from "@dohc/security-contract/dataset";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PublicationAgent = z
  .object({
    kind: z.literal("agent"),
    label: z.string().min(1).max(160).nullable(),
    labelSource: z.literal("agent-declared"),
  })
  .strict();
const selector = z
  .object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(100), versionId: z.null() })
  .strict();
const access = z.enum(["view", "comment", "edit"]);
const linkFacts = {
  shareId: id,
  grantId: id,
  selector,
  access,
  bearerWarning: z.string().min(1).max(512),
};
const OwnerAppCollectionCapability = z.unknown().transform((value, context) => {
  try {
    return parseAppCollectionCapability(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid collection capability." });
    return z.NEVER;
  }
});
const OwnerAppCapability = z.unknown().transform((value, context) => {
  try {
    if (value && typeof value === "object" && "kind" in value && value.kind === "dataset")
      return parseAppDatasetCapability(value);
    return parseAppCollectionCapability(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid app capability." });
    return z.NEVER;
  }
});
const OwnerAppDatasetCapability = z.unknown().transform((value, context) => {
  try {
    return parseAppDatasetCapability(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid dataset capability." });
    return z.NEVER;
  }
});
// approved: this device's authority still names the app. active: it can run now. pendingCreates: responses not yet confirmed saved or refused.
// A row with neither capability is an app that reaches no workspace data.
const localPublication = {
  publicationId: hash,
  authorityRevision: z.number().int().positive(),
  appRoot: z.string().min(1).max(1024),
  sourceRevision: hash,
  approved: z.boolean(),
  active: z.boolean(),
};
const LocalPublication = z.union([
  z.object({ ...localPublication, datasetCapability: OwnerAppDatasetCapability }).strict(),
  z
    .object({
      ...localPublication,
      datasetCapabilities: z.array(OwnerAppDatasetCapability).min(2).max(APP_DATASET_MAX_BINDINGS),
    })
    .strict(),
  z
    .object({
      ...localPublication,
      collectionCapability: OwnerAppCollectionCapability,
      pendingCreates: z.number().int().nonnegative().max(1000),
    })
    .strict(),
  z.object(localPublication).strict(),
]);
const publication = {
  operatorTakedown: z
    .object({
      actor: z.literal("operator"),
      disabledAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      reason: z.string().min(1).max(1024),
    })
    .strict()
    .optional(),
  approvalProvenance: z
    .object({
      agent: PublicationAgent.nullable(),
      selector: z.unknown(),
      access,
      committedCandidateDigest: hash,
      sourceRevision: hash,
      capabilities: z.array(OwnerAppCapability).max(1),
    })
    .strict()
    .optional(),
  publicationId: hash,
  authorityRevision: z.number().int().positive(),
  shareId: id,
  grantId: id,
  active: z.boolean(),
  linkCurrent: z.boolean(),
  collectionCapability: z
    .union([OwnerAppCollectionCapability, z.literal("unavailable")])
    .nullable(),
  datasetCapability: z.union([OwnerAppDatasetCapability, z.literal("unavailable")]).nullable(),
};
const OwnerAppPublicationListRow = z.discriminatedUnion("manifestUnavailable", [
  z
    .object({
      ...publication,
      manifestUnavailable: z.literal(false),
      appRoot: z.string().min(1).max(1024),
      sourceRevision: hash,
    })
    .strict(),
  z.object({ ...publication, manifestUnavailable: z.literal(true) }).strict(),
]);
const StagedAppCollectionSummary = z
  .object({
    alias: z.string().min(1).max(64).optional(),
    datasetId: z.string().uuid(),
    name: z.string().min(1).max(256),
    datasetPath: z.string().min(1).max(1024),
    action: z.enum(["create", "migrate", "unchanged"]),
    previousRevision: z.number().int().positive().optional(),
    targetRevision: z.number().int().positive(),
    targetRevisionSha256: hash,
    migrationPath: z.string().min(1).max(1024).nullable().optional(),
    applied: z.boolean(),
    tables: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256),
            fields: z.array(z.string().min(1).max(256)).max(256),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    changes: z
      .array(
        z
          .object({
            kind: z.string().min(1).max(64),
            summary: z.string().min(1).max(512),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict();
export type StagedAppCollectionSummary = z.infer<typeof StagedAppCollectionSummary>;
export const StagedAppSummary = z
  .object({
    stageId: z.string().uuid(),
    appRoot: z.string().min(1).max(1024),
    reviewDigest: hash,
    createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceRevision: hash,
    sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(512),
    collections: z.array(StagedAppCollectionSummary).max(APP_DATASET_MAX_BINDINGS),
    capabilities: z.array(OwnerAppCapability).max(APP_DATASET_MAX_BINDINGS),
    externalNetwork: z.literal(true),
  })
  .strict();
export type StagedAppSummary = z.infer<typeof StagedAppSummary>;
function appPublicationAction<Shape extends z.ZodRawShape>(shape: Shape) {
  const names = Object.keys(shape);
  const action = (shape.action as { value?: string } | undefined)?.value ?? "";
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return undefined;
      const unknown = issue.keys.map((key) => JSON.stringify(key)).join(", ");
      return `Unrecognized key${issue.keys.length === 1 ? "" : "s"} ${unknown} for app action "${action}". Allowed fields: ${names.join(", ")}.`;
    },
  });
}

const APP_VERIFY_BROKER_OP = z.enum([
  "backend.invoke",
  "backend.attempt",
  "backend.upload",
  "backend.file",
  "collection.list",
  "collection.create",
  "unknown",
]);
const APP_VERIFY_OPERATION_NAME = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
const APP_VERIFY_REFUSAL_CODE = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const AppFrontendBackendExpectation = z
  .object({
    op: APP_VERIFY_BROKER_OP.optional(),
    operation: APP_VERIFY_OPERATION_NAME.optional(),
    status: z.number().int().min(100).max(599).optional(),
    refusalCode: APP_VERIFY_REFUSAL_CODE.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.op !== undefined ||
      value.operation !== undefined ||
      value.status !== undefined ||
      value.refusalCode !== undefined,
    "Specify at least one of op, operation, status, or refusalCode.",
  );
const AppFrontendStep = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("waitFor"),
      selector: z.string().min(1).max(256),
      textIncludes: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fill"),
      selector: z.string().min(1).max(256),
      value: z.string().max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("click"),
      selector: z.string().min(1).max(256),
      expectBackend: AppFrontendBackendExpectation.optional(),
    })
    .strict(),
]);
export const AppFrontendBrokerCall = z
  .object({
    op: APP_VERIFY_BROKER_OP,
    operation: APP_VERIFY_OPERATION_NAME.optional(),
    status: z.number().int().min(100).max(599).nullable(),
    ok: z.boolean(),
    rejectedBy: z.enum(["broker", "backend"]).optional(),
    reasonCode: z
      .enum([
        "invalid_id",
        "duplicate_id",
        "unserializable",
        "payload_too_large",
        "invalid_keys",
        "rate_limited",
        "operation_not_approved",
        "unconnected",
        "unsupported_in_dry_run",
        "refused",
        "runtime_error",
      ])
      .optional(),
    refusalCode: APP_VERIFY_REFUSAL_CODE.optional(),
  })
  .strict();
export const AppFrontendDiagnostic = z
  .object({
    code: z.enum([
      "manifest_error",
      "missing_input",
      "input_outside_app_root",
      "compile_error",
      "dataset_binding_error",
      "collection_schema_error",
      "csp_violation",
      "page_exception",
      "unhandled_rejection",
      "console_error",
      "handshake_not_delivered",
      "broker_invalid_id",
      "broker_duplicate_id",
      "broker_unserializable",
      "broker_payload_too_large",
      "broker_invalid_keys",
      "broker_rate_limited",
      "broker_operation_not_approved",
      "broker_unconnected",
      "broker_unsupported_in_dry_run",
      "broker_runtime_error",
      "expected_backend_missing",
      "step_selector_not_found",
      "step_not_fillable",
      "step_not_clickable",
      "step_text_mismatch",
      "external_network_blocked",
      "verification_timeout",
    ]),
    severity: z.enum(["error", "warning"]),
    detail: z.string().min(1).max(240).optional(),
    path: z.string().min(1).max(1024).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    directive: z.string().min(1).max(64).optional(),
    errorName: z.string().min(1).max(64).optional(),
    op: APP_VERIFY_BROKER_OP.optional(),
    operation: APP_VERIFY_OPERATION_NAME.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
    remedy: z.string().min(1).max(320),
  })
  .strict();
export const AppFrontendStepResult = z
  .object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["waitFor", "fill", "click"]),
    ok: z.boolean(),
    code: AppFrontendDiagnostic.shape.code.optional(),
    remedy: z.string().min(1).max(320).optional(),
  })
  .strict();
export type AppFrontendBackendExpectation = z.infer<typeof AppFrontendBackendExpectation>;
export type AppFrontendStep = z.infer<typeof AppFrontendStep>;
export type AppFrontendBrokerCall = z.infer<typeof AppFrontendBrokerCall>;
export type AppFrontendDiagnostic = z.infer<typeof AppFrontendDiagnostic>;
export type AppFrontendStepResult = z.infer<typeof AppFrontendStepResult>;

const APP_PUBLICATION_REQUEST_OPTIONS = [
  appPublicationAction({
    action: z.literal("verifyFrontend"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024).optional(),
    publicationId: hash.optional(),
    expectStartupBackend: z.array(AppFrontendBackendExpectation).max(8).optional(),
    steps: z.array(AppFrontendStep).max(20).optional(),
    timeoutMs: z.number().int().min(1000).max(30_000).optional(),
  }).refine(
    (value) => (value.appRoot !== undefined) !== (value.publicationId !== undefined),
    'Specify exactly one of "appRoot" or "publicationId" for verifyFrontend.',
  ),
  appPublicationAction({
    action: z.literal("createLink"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024),
    paths: selector.shape.paths.optional(),
    access: access.default("view"),
    operationId: z.string().uuid(),
    agentLabel: z.string().min(1).max(160).optional(),
  }),
  appPublicationAction({
    action: z.literal("listLocal"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024),
  }),
  appPublicationAction({
    action: z.literal("checkLocal"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024),
  }),
  appPublicationAction({
    action: z.literal("prepareLocal"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024),
  }),
  appPublicationAction({
    action: z.literal("stage"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024),
    migrations: z
      .record(z.string().min(1).max(1024), z.string().min(1).max(1024))
      .refine((value) => Object.keys(value).length <= APP_DATASET_MAX_BINDINGS, {
        message: `At most ${APP_DATASET_MAX_BINDINGS} migration paths may be supplied.`,
      })
      .optional(),
    agentLabel: z.string().min(1).max(160).optional(),
  }),
  appPublicationAction({
    action: z.literal("listStaged"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024).optional(),
  }),
  appPublicationAction({
    action: z.literal("approveStaged"),
    workspaceId: id,
    stageId: z.string().uuid(),
    reviewDigest: hash,
    agentLabel: z.string().min(1).max(160).optional(),
  }),
  appPublicationAction({
    action: z.literal("discardStaged"),
    workspaceId: id,
    stageId: z.string().uuid(),
  }),
  appPublicationAction({
    action: z.literal("launchLocal"),
    workspaceId: id,
    publicationId: hash,
  }),
  appPublicationAction({
    action: z.literal("list"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024),
    cursor: hash.optional(),
  }),
  appPublicationAction({
    action: z.literal("prepare"),
    workspaceId: id,
    appRoot: z.string().min(1).max(1024),
    shareId: id,
    grantId: id,
  }),
  appPublicationAction({
    action: z.literal("approve"),
    workspaceId: id,
    approvalId: z.string().uuid(),
    candidateDigest: hash,
    agentLabel: z.string().min(1).max(160).optional(),
    linkReads: z
      .array(
        z
          .object({
            operationId: z.string().uuid(),
            fieldIds: z.array(z.string().uuid()).max(128),
          })
          .strict(),
      )
      .max(128)
      .optional(),
  }),
  appPublicationAction({
    action: z.literal("cancel"),
    workspaceId: id,
    approvalId: z.string().uuid(),
  }),
  appPublicationAction({
    action: z.literal("withdraw"),
    workspaceId: id,
    publicationId: hash,
    expectedAuthorityRevision: z.number().int().positive(),
  }),
  appPublicationAction({
    action: z.literal("revokeCollection"),
    workspaceId: id,
    publicationId: hash,
    expectedAuthorityRevision: z.number().int().positive(),
  }),
  appPublicationAction({
    action: z.literal("reviewReactivation"),
    workspaceId: id,
    publicationId: hash,
  }),
] as const;

const APP_PUBLICATION_ACTIONS = APP_PUBLICATION_REQUEST_OPTIONS.map(
  (option) => option.shape.action.value,
);

export const OwnerAppPublicationRequest = z.discriminatedUnion(
  "action",
  APP_PUBLICATION_REQUEST_OPTIONS,
  {
    error: (issue) =>
      issue.code === "invalid_union"
        ? `Unsupported app publication action. Valid actions: ${APP_PUBLICATION_ACTIONS.join(", ")}.`
        : undefined,
  },
);
export type OwnerAppPublicationRequest = z.infer<typeof OwnerAppPublicationRequest>;
export const OwnerAppPublicationResult = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("frontendVerified"),
      ok: z.boolean(),
      stage: z.enum(["compile", "runtime", "steps", "complete"]),
      target: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("candidate"),
            appRoot: z.string().min(1).max(1024),
            sourceRevision: hash.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("publication"),
            publicationId: hash,
            appRoot: z.string().min(1).max(1024),
            authorityRevision: z.number().int().positive(),
          })
          .strict(),
      ]),
      startupOk: z.boolean(),
      stepsOk: z.boolean(),
      handshake: z
        .object({
          delivered: z.boolean(),
          messageCount: z.number().int().nonnegative(),
        })
        .strict(),
      brokerCalls: z.array(AppFrontendBrokerCall).max(64),
      steps: z.array(AppFrontendStepResult).max(20),
      diagnostics: z.array(AppFrontendDiagnostic).max(64),
      externalRequestsBlocked: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ kind: z.literal("linkCreated"), ...linkFacts, url: z.string().url().max(4096) })
    .strict(),
  z.object({ kind: z.literal("urlUnavailable"), ...linkFacts }).strict(),
  z
    .object({
      kind: z.literal("localLaunched"),
      publicationId: hash,
      url: z.string().url().max(4096),
    })
    .strict(),
  z
    .object({ kind: z.literal("localListed"), publications: z.array(LocalPublication).max(64) })
    .strict(),
  // The source revision prepareLocal would capture now. It differs from an approval's sourceRevision once the app's source changed.
  z
    .object({
      kind: z.literal("localChecked"),
      appRoot: z.string().min(1).max(1024),
      sourceRevision: hash,
      sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal("listed"),
      publications: z.array(OwnerAppPublicationListRow).max(25),
      nextCursor: hash.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("listUnavailable") }).strict(),
  z
    .object({
      kind: z.literal("prepared"),
      approvalId: z.string().uuid(),
      candidateDigest: hash,
      appRoot: z.string().min(1).max(1024),
      versionId: id,
      sourceRevision: hash,
      audience: z
        .object({
          shareId: id,
          grantId: id,
          selector: z.object({ paths: z.array(z.string()), versionId: id.nullable() }).strict(),
          access,
        })
        .strict()
        .optional(),
      sourcePaths: z.array(z.string().min(1).max(1024)).min(1).max(512),
      capabilities: z.array(OwnerAppCapability).max(APP_DATASET_MAX_BINDINGS),
      externalNetwork: z.literal(true),
      local: z.literal(true).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z
    .object({
      kind: z.literal("published"),
      publicationId: z.string().regex(/^[a-f0-9]{64}$/),
      authorityRevision: z.number().int().positive(),
      local: z.literal(true).optional(),
      appQuery: z.string().max(256).optional(),
      access: access.optional(),
      bearerWarning: z.string().max(512).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("withdrawn"),
      publicationId: hash,
      authorityRevision: z.number().int().positive(),
    })
    .strict(),
  // Authority ended, but responses admitted earlier may still be saved. Withdraw again at this revision to confirm.
  z
    .object({
      kind: z.literal("withdrawalUnconfirmed"),
      publicationId: hash,
      authorityRevision: z.number().int().positive(),
      unresolvedCreates: z.number().int().positive().max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collectionRevoked"),
      publicationId: hash,
      authorityRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("staged"), stage: StagedAppSummary }).strict(),
  z.object({ kind: z.literal("stagedListed"), stages: z.array(StagedAppSummary).max(16) }).strict(),
  z
    .object({
      kind: z.literal("stagedApproved"),
      stageId: z.string().uuid(),
      publicationId: hash,
      authorityRevision: z.number().int().positive(),
      collectionsApplied: z
        .array(
          z
            .object({
              datasetId: z.string().uuid(),
              action: z.enum(["create", "migrate"]),
              revision: z.number().int().positive(),
              revisionSha256: hash,
            })
            .strict(),
        )
        .max(APP_DATASET_MAX_BINDINGS),
    })
    .strict(),
  z.object({ kind: z.literal("stagedDiscarded"), stageId: z.string().uuid() }).strict(),
]);
export type OwnerAppPublicationResult = z.infer<typeof OwnerAppPublicationResult>;
