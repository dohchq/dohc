import { parsePublicEditRelease } from "@dohc/security-contract";
import type { AccountFileWriteLiveHost } from "./accountFileWrites";
import {
  accountDisplayName,
  backfillUnnamedAccounts,
  type LookupUserDisplayNames,
} from "./accountDisplayName";
import {
  APP_PUBLICATION_MAX_FILES,
  APP_PUBLICATION_MAX_METADATA_BYTES,
  APP_PUBLICATION_MAX_BUNDLE_BYTES,
} from "@dohc/security-contract/app-publication";
import {
  createAccountSessionResolver,
  createPhoneCapableAccountSessionResolver,
  createPostgresAccountSessions,
  createSessionActorResolver,
  UnauthorizedError,
  type AccountSessions,
  type ResolveAccountSession,
  type ResolveActor,
} from "@dohc/workspace-auth/session";
import {
  createPostgresCredentialFence,
  type CredentialFence,
} from "@dohc/workspace-auth/credentialFence";
import { readApnsConfig, readPushConfig } from "./pushConfig";
import { createPushSender } from "./pushSender";
import { createApnsClient } from "./apnsClient";
import { SIGN_UP_INVITE_PATH, signUpInviteKey } from "@dohc/workspace-auth/signUp";
import { createSmtpSender, smtpSettingsFromEnv } from "@dohc/workspace-auth/smtp";
import { SHARE_INVITATION_EMAIL_TIMEOUT_MS } from "./shareInvitationEmail";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fatal,
  installShutdown,
  jsonResponse,
  parseGracePeriodMs,
  serveFetchHandler,
  waitsOnQuery,
} from "@dohc/service-http";
import {
  AnalyticsConfigError,
  createServiceAnalyticsClient,
  readAnalyticsEnvConfig,
  type ServiceAnalyticsConfig,
} from "@dohc/service-http/telemetry";
import { Pool, type QueryConfig } from "pg";
import { compileDatasetOperations } from "./datasetCompiler";
import { createVerifiedEmailLookups } from "./verifiedEmailLookups";
import {
  ACCOUNT_DELETION_PATH,
  ACCOUNT_DELETION_KEY_HEADER,
  accountDeletionKey,
  accountDeletionFenceKey,
} from "@dohc/workspace-auth/accountDeletion";
import {
  APP_LAUNCH_PURGE_BATCH,
  APP_LAUNCH_PURGE_KEY_HEADER,
  APP_LAUNCH_PURGE_PATH,
  appLaunchPurgeKey,
} from "@dohc/security-contract/account-deletion";
import { createAccountDeletionRoute, fencePendingAccountDeletions } from "./accountDeletionRoute";
import type { StorageContext } from "./storage/context";
import { startLiveJournalCheck } from "./storage/liveJournalCheck";
import { createSignUpInviteRoute } from "./signUpInviteRoute";
import { errorBody, errorResponse, notFound, relayError } from "./errors";
import { appBackendLimit } from "@dohc/security-contract/app-backend";
import {
  ENGINE_API_MIN_SETTING,
  RELAY_API_VERSIONS,
  engineApiMinimum,
  relayApiVersionRefusal,
  relayApiVersionsFor,
} from "./apiVersion";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import { PresenceHub } from "./presence";
import {
  createSyncRelayHandler,
  maxRequestBodyBytes,
  requestBodyCaller,
  streamsRequestBody,
} from "./server";
import { DiscussionActivityHub } from "./discussionActivity";
import type { HeldDocumentHost } from "./heldDocumentRoutes";
import { automationHostMaxBodyBytes } from "./automationHostRoutes";
import { AUTOMATION_SERVER_MAX_BODY_BYTES, isAutomationServerPath } from "./automationServerRoutes";
import { ACCOUNT_WORKSPACE_MAX_BODY_BYTES, isAccountWorkspacePath } from "./accountWorkspaceRoutes";
import { isAutomationPressPath, pruneAutomationPresses } from "./automationPressRoutes";
import { AUTOMATION_PRESS_MAX_BODY_BYTES } from "@dohc/workspace-contracts/relay";
import {
  parseNamedLiveBrowserHttpLimits,
  type NamedLiveBrowserHttpLimits,
} from "./namedLiveBrowserHttp";
import { DEFAULT_WORKSPACE_QUOTA_BYTES, openSyncRelayStorage } from "./storage";
import type { SyncRelayOpenPart } from "./storage/types";
import { createDeviceControl } from "./deviceControl";
import { readOwnerAdmissionConfig, startOwnerAdmission } from "./ownerAdmissionConfig";
import { liveValidation } from "./liveValidation.js";
import { startRelayMainThreadTiming } from "./relayMainThreadTiming.js";
import { readRelayDeviceDeliveryConfig } from "./deviceLiveHostConfig";
import { parseDeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { startPublicationOperator } from "./appPublicationOperator";
import { operatorSecretPath, operatorSocketPath } from "./appPublicationOperatorProtocol";
import { openRelayDeployment } from "./relayDeployment";
import { guardRelayResponses } from "./relayResponseStanding";
import { checkReaderConfig } from "./readerConfig";
import { admitBodySequenceNotes } from "@dohc/ydoc-projection/live-journal-validation";
import { BODY_SEQUENCE_SETTING, bodySequenceNotesAdmitted } from "./bodySequenceSetting";
import { startServiceLiveHost, deleteConfiguredServiceWorkspaceRoots } from "./serviceLiveHost";
import { startEngineProjection } from "./engineProjection";
import { parseNamedLiveConfig } from "./namedLiveConfig";
import {
  readAppBackendParticipantLimit,
  readAppCollectionPolicy,
  readAppPublicationConfig,
} from "./appPublicationConfig";
import { createNamedFrameChanges } from "./liveHostChanges";
import {
  createOwnerLiveRoutes,
  createNamedLiveRoutes,
  createPersonalLiveRoutes,
} from "./namedLiveRoutes";
import { createLiveTickets } from "./liveTickets";
import {
  createPhoneMemberLiveSessions,
  createPhonePages,
  type PhoneMemberLiveSessions,
  type PhonePages,
} from "./phonePages";
import { createLiveHostReports } from "./namedLiveHostReports";
import { createLinkLiveResolver } from "./linkLiveBrowserAuth";
import { liveNoteStanding, normalizeLinkRefusal, opaqueLinkRefusal } from "./linkRefusal";
import { isLinkEndpointPath, isLinkLivePath } from "./linkEndpointPath";
import { relayEntryPattern, SYNC_RELAY_REQUEST_LOG } from "./requestLog";
import { createLinkLiveHttp } from "./linkLiveHttp";
import { createLiveMembershipRegistry } from "./liveMembership";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { createNamedDesktopLive } from "./namedDesktopLive";
import { parseNamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-transport";
import { captureOwnerLiveFrameHost, type NamedFrameNativeHost } from "./namedLiveFrameHost";
import { createLiveRooms, LiveRoomBindingEndedError, type LiveRooms } from "./liveRoom";
import { liveRoomPaused } from "./storage/liveRoomPauses";
import { workspaceOwner } from "./storage/workspaces";
import { createAutomationRecordHost } from "./automationRecordHost";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import {
  startSelfHostedLiveHost,
  deleteSelfHostedWorkspaceRoots,
  selfHostedLiveHostId,
} from "./selfHostedLiveHost";
import {
  createServiceHostEnrollmentRoutes,
  isServiceHostEnrollmentPath,
  serviceHostReadiness,
} from "./serviceHostEnrollmentRoutes";
import {
  createPersonalLiveDocumentRoute,
  PERSONAL_LIVE_DOCUMENT_MAX_BODY_BYTES,
  PERSONAL_LIVE_DOCUMENT_PATH,
} from "./personalLiveDocumentRoutes";
import { createServiceHostReplication } from "./serviceHostReplication";
import { authorizeServiceHostReplication } from "./serviceHostCredential";
import { loopbackDeclaredHttpsTransport, TokenBucketLimiter } from "@dohc/service-http";
import {
  NOTICE_POST_BUCKET_CAPACITY,
  NOTICE_POST_MAX_SENDERS,
  NOTICE_POST_REFILL_PER_SECOND,
} from "./noticeRoutes";
import { automationServerLabel, startAutomationServer } from "./automationServer";
import { isPublicHttpsOrigin, removeAutomationReplicas } from "./automationReplicas";
import { tombstoneSettledOperations } from "./operationPublication";
import { sweepChatWakesInBatches } from "./chatWakes";
import { startServerCopies, type ServerCopies } from "./serverCopies";
import { untilRelayAnswers } from "./relayAnswers";
import {
  AUTOMATION_REPLICA_BEARER_PREFIX,
  authorizeAutomationReplication,
  carriesAutomationReplicaBearer,
} from "./automationReplicaCredential";
import { serverLogLine } from "./serverLogWords";
import { createStartTimeline } from "./startTimeline";
import { resealWorkspaceSecrets, workspaceSecretKeyring } from "./workspaceSecretCrypto";

// Node starting, and every module above loading.
const startTimeline = createStartTimeline();
startTimeline.done("code");

const RELAY_ANSWER_WAIT_MS = 120_000;
const SHUTDOWN_GRACE_PERIOD_MS = parseGracePeriodMs(
  process.env.NODE_ENV === "test"
    ? process.env.SYNC_RELAY_TEST_SHUTDOWN_GRACE_PERIOD_MS
    : undefined,
  10_000,
);
const requestedPort =
  process.env.SYNC_RELAY_PORT === undefined ? 1788 : Number(process.env.SYNC_RELAY_PORT);
const workspaceQuotaBytes =
  process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES === undefined
    ? DEFAULT_WORKSPACE_QUOTA_BYTES
    : Number(process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES);
const defaultPostgresUrl = "postgres://dohc:dohc@localhost:54329/dohc";
const secret = process.env.BETTER_AUTH_SECRET ?? "";
const nodeEnv = process.env.NODE_ENV;
const isDevOrTest = nodeEnv === "development" || nodeEnv === "test";
const testAuthSeam = process.env.SYNC_RELAY_TEST_AUTH === "1" && isDevOrTest;
const linkKey = process.env.DOHC_RELAY_LINK_KEY;
// A workspace invite link lets a new person create an account to join that
// workspace. DOHC_INVITE_LINK_SIGN_UP=off keeps sign-up to listed and invited
// addresses only; the links still let existing accounts join.
if (
  process.env.DOHC_INVITE_LINK_SIGN_UP !== undefined &&
  !["on", "off"].includes(process.env.DOHC_INVITE_LINK_SIGN_UP)
)
  fatal("FATAL: DOHC_INVITE_LINK_SIGN_UP must be on or off.");
const inviteLinkSignUp = process.env.DOHC_INVITE_LINK_SIGN_UP !== "off";
const relayExchangeKey = process.env.DOHC_RELAY_EXCHANGE_KEY;
const relayExchangeKeyHash =
  relayExchangeKey === undefined ? undefined : hashRelayExchangeKey(relayExchangeKey);
const selfHostedLive = process.env.DOHC_SELF_HOST_LIVE === "1";
let analyticsConfig: ServiceAnalyticsConfig | null;
try {
  analyticsConfig = readAnalyticsEnvConfig(process.env);
} catch (error) {
  fatal(
    `FATAL: ${error instanceof AnalyticsConfigError ? error.message : "invalid analytics configuration"}`,
  );
}
const analytics = analyticsConfig
  ? createServiceAnalyticsClient({ service: "sync-relay", config: analyticsConfig })
  : null;
if (
  process.env.DOHC_SELF_HOST_LIVE !== undefined &&
  !["0", "1"].includes(process.env.DOHC_SELF_HOST_LIVE)
)
  fatal("FATAL: DOHC_SELF_HOST_LIVE must be 0 or 1.");
const liveProfile = selfHostedLive ? selfHostLiveProfile() : undefined;
// This server runs its owners' automations: on by default under the supported
// self-host profile, off for development relays and tests unless they ask.
const automationsSetting = process.env.DOHC_RELAY_AUTOMATIONS;
if (automationsSetting !== undefined && !["0", "1"].includes(automationsSetting))
  fatal("FATAL: DOHC_RELAY_AUTOMATIONS must be 0 or 1.");
const automationsOn =
  automationsSetting === undefined ? selfHostedLive : automationsSetting === "1";
try {
  admitBodySequenceNotes(bodySequenceNotesAdmitted());
} catch {
  fatal(`FATAL: ${BODY_SEQUENCE_SETTING} must be 0 or 1.`);
}
const engineApiMin =
  engineApiMinimum() ??
  fatal(
    `FATAL: ${ENGINE_API_MIN_SETTING} must be a whole number from 1 to ${RELAY_API_VERSIONS.max}.`,
  );
// This server keeps copies of workspaces to run their automations and to answer their owners' phones.
// A self-hosted server always keeps them; a development relay only while it runs automations.
const copiesOn = automationsOn || selfHostedLive;
if (
  selfHostedLive &&
  (process.env.DOHC_RELAY_SERVICE_HOST_CONFIG ||
    process.env.DOHC_RELAY_DEVICE_DELIVERY_CONFIG ||
    process.env.DOHC_DEVICE_CONTROL_LIMITS)
) {
  fatal(
    "FATAL: The self-host live service cannot replace a manually configured service or device host.",
  );
}
// A live host without the Markdown reader starts, but its Edit shares never go live.
if (selfHostedLive || process.env.DOHC_RELAY_SERVICE_HOST_CONFIG) {
  const reader = checkReaderConfig(process.env.DOHC_ENGINE_READER_CONFIG);
  if ("problem" in reader)
    fatal(
      `FATAL: Edit shares need the Markdown reader, but ${reader.problem}. DOHC_ENGINE_READER_CONFIG holds the startup.json that stage-engine-reader.mjs --self-host writes. The self-host image reads /opt/dohc-reader/engine-reader/startup.json, which is missing if the image was built without the reader.`,
    );
  // The engines this relay starts get the value checked here.
  process.env.DOHC_ENGINE_READER_CONFIG = reader.config;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname === "[::1]"
  );
}

function validateShareWebOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    if (!isDevOrTest) {
      fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be set outside development/test.");
    }
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an absolute HTTP(S) origin.");
  }
  if (
    value.trim() !== value ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    value.includes("@") ||
    parsed.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    fatal(
      "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an origin without credentials, a path, a query, or a fragment.",
    );
  }
  if (!isDevOrTest && parsed.protocol !== "https:") {
    fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must use HTTPS outside development/test.");
  }
  if (isDevOrTest && parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    fatal(
      "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must use HTTPS unless its HTTP hostname is loopback in development/test.",
    );
  }
  return parsed.origin;
}

const shareWebOrigin = validateShareWebOrigin(process.env.DOHC_RELAY_SHARE_WEB_ORIGIN);
if (shareWebOrigin && !process.env.DOHC_RELAY_SHARE_WEB_URL)
  fatal("DOHC_RELAY_SHARE_WEB_ORIGIN requires DOHC_RELAY_SHARE_WEB_URL for account deletion.");

// Reject an unparseable SYNC_RELAY_PORT up front: Number("abc") is NaN and
// server.listen(NaN) fails with an obscure downstream error. Port 0 is
// allowed (bind an ephemeral port, used by the integration harness).
if (
  process.env.SYNC_RELAY_PORT !== undefined &&
  (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)
) {
  fatal(
    `FATAL: SYNC_RELAY_PORT must be an integer in 0-65535, got "${process.env.SYNC_RELAY_PORT}".`,
  );
}

if (
  process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES !== undefined &&
  (!Number.isInteger(workspaceQuotaBytes) || workspaceQuotaBytes <= 0)
) {
  fatal(
    `FATAL: SYNC_RELAY_WORKSPACE_QUOTA_BYTES must be a positive integer, got "${process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES}".`,
  );
}

// In production the relay reuses workspace-api's Postgres for session and
// share-account lookups. Falling back to a localhost default there would
// silently point auth at the wrong database; fail fast instead. The default
// stays available for dev/test convenience only.
if (!isDevOrTest && !testAuthSeam && process.env.POSTGRES_URL === undefined) {
  fatal(
    "FATAL: POSTGRES_URL must be set outside development/test (it must match workspace-api's database).",
  );
}

if (!isDevOrTest && !linkKey) {
  fatal("FATAL: DOHC_RELAY_LINK_KEY must be set outside development/test.");
}

const secretKeys = process.env.DOHC_RELAY_SECRET_KEYS;
const secretKeyring = (() => {
  try {
    return workspaceSecretKeyring({ linkKey, secretKeys });
  } catch (error) {
    return fatal(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
  }
})();

if (!isDevOrTest && !relayExchangeKey) {
  fatal("FATAL: DOHC_RELAY_EXCHANGE_KEY must be set outside development/test.");
}

if (relayExchangeKey !== undefined && relayExchangeKey.length < 32) {
  fatal("FATAL: DOHC_RELAY_EXCHANGE_KEY must be at least 32 characters.");
}

if (process.env.SYNC_RELAY_TEST_AUTH === "1" && !isDevOrTest) {
  fatal(
    `FATAL: SYNC_RELAY_TEST_AUTH=1 requires NODE_ENV=development or test, got NODE_ENV=${nodeEnv ?? "(unset)"}. ` +
      "This fake bearer seam is test-only — refusing to start.",
  );
}

if (!testAuthSeam && secret.length < 32) {
  fatal("BETTER_AUTH_SECRET must be set (>=32 chars) and must match workspace-api's secret.");
}

const publicEditRelease = parsePublicEditRelease(
  process.env.DOHC_PUBLIC_EDIT_RELEASE === undefined
    ? selfHostedLive
      ? { version: 1 }
      : undefined
    : JSON.parse(process.env.DOHC_PUBLIC_EDIT_RELEASE),
);
const appPublicationLimits = (() => {
  try {
    return readAppPublicationConfig(process.env.DOHC_RELAY_APP_PUBLICATIONS);
  } catch {
    fatal("FATAL: DOHC_RELAY_APP_PUBLICATIONS must be 0 or 1.");
  }
})();
const appBackendMaxParticipantsPerGrant = (() => {
  try {
    return readAppBackendParticipantLimit(
      process.env.DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT,
    );
  } catch (error) {
    fatal(
      `FATAL: ${error instanceof Error ? error.message : "invalid app backend participant limit"}`,
    );
  }
})();
const appCollectionPolicy = (() => {
  try {
    return readAppCollectionPolicy(process.env.DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT);
  } catch (error) {
    fatal(`FATAL: ${error instanceof Error ? error.message : "invalid app collection policy"}`);
  }
})();
if (appCollectionPolicy && !appPublicationLimits) {
  fatal("FATAL: App collections require DOHC_RELAY_APP_PUBLICATIONS=1.");
}
const namedBrowserSessionLimits = loadNamedBrowserSessionLimits();
const namedLiveConfig = (() => {
  const value =
    process.env.DOHC_RELAY_NAMED_LIVE_CONFIG ??
    (liveProfile && JSON.stringify(liveProfile.namedLive));
  if (value === undefined) return undefined;
  if (
    !namedBrowserSessionLimits ||
    !shareWebOrigin ||
    !relayExchangeKey ||
    !linkKey ||
    !process.env.DOHC_RELAY_NAMED_LIVE_HOSTS
  ) {
    fatal(
      "FATAL: Named live routes require browser sessions, viewer origin, relay exchange and link keys, and explicit relay Host values.",
    );
  }
  try {
    return parseNamedLiveConfig(
      JSON.parse(value),
      process.env.DOHC_RELAY_NAMED_EDITOR_LIMITS !== undefined || liveProfile
        ? {
            maxPendingAdmissionRequests: namedBrowserSessionLimits.maxPendingRequests,
            maxPendingReadinessRequests: selfHostLiveProfile().desktopReadiness.maxPendingRequests,
          }
        : undefined,
    );
  } catch {
    fatal(
      "FATAL: DOHC_RELAY_NAMED_LIVE_CONFIG must provide every named live budget and validation policy.",
    );
  }
})();
const frameChanges = namedLiveConfig
  ? createNamedFrameChanges(namedLiveConfig.maxListeners)
  : undefined;
const linkLiveEnabled =
  process.env.DOHC_RELAY_LINK_LIVE === "1" ||
  (selfHostedLive && process.env.DOHC_RELAY_LINK_LIVE === undefined);
if (
  process.env.DOHC_RELAY_LINK_LIVE !== undefined &&
  !["0", "1"].includes(process.env.DOHC_RELAY_LINK_LIVE)
)
  fatal("FATAL: DOHC_RELAY_LINK_LIVE must be 0 or 1.");
if (linkLiveEnabled && !namedLiveConfig)
  fatal("FATAL: Link live routes require configured live admission limits.");
const desktopEditorLimits = (() => {
  const value =
    process.env.DOHC_RELAY_NAMED_EDITOR_LIMITS ??
    (liveProfile && JSON.stringify(liveProfile.editor));
  if (value === undefined) return undefined;
  if (!namedLiveConfig || !namedBrowserSessionLimits)
    fatal("FATAL: Desktop live editing requires configured named live routes.");
  try {
    const limits = parseNamedLiveBrowserLimits(JSON.parse(value));
    if (limits.provider.frames.receive.maxFrameBytes > namedLiveConfig.frames.receive.maxFrameBytes)
      throw Error();
    return limits;
  } catch {
    fatal(
      "FATAL: DOHC_RELAY_NAMED_EDITOR_LIMITS must provide bounded editor limits within relay frame capacity.",
    );
  }
})();
const dbPath = process.env.SYNC_RELAY_DB_PATH ?? join(tmpdir(), "dohc-sync-relay.sqlite");
const deploymentConfig = process.env.DOHC_RELAY_DEPLOYMENT_CONFIG;
if (!isDevOrTest && !deploymentConfig)
  fatal(
    "FATAL: DOHC_RELAY_DEPLOYMENT_CONFIG must name an initialized deployment outside development/test.",
  );
if (deploymentConfig && process.env.SYNC_RELAY_DB_PATH !== undefined)
  fatal("FATAL: The deployment config owns the relay database path. Remove SYNC_RELAY_DB_PATH.");
const projectionExecutable = process.env.DOHC_RELAY_ENGINE_EXECUTABLE;
const projectionOptIn = process.env.DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION;
if (projectionOptIn !== undefined && !["0", "1"].includes(projectionOptIn))
  fatal("FATAL: DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION must be 0 or 1.");
if (projectionOptIn !== undefined && !isDevOrTest)
  fatal("FATAL: DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION is allowed only in development/test.");
if (projectionOptIn === "1")
  console.warn(
    "WARNING: DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION=1 permits document projection without OS memory isolation on non-Linux platforms.",
  );
if (!isDevOrTest && !projectionExecutable)
  fatal("FATAL: Document sharing requires DOHC_RELAY_ENGINE_EXECUTABLE outside development/test.");

// Production auth intentionally reuses workspace-api's Better Auth database
// and BETTER_AUTH_SECRET. A bearer token minted by workspace-api's desktop
// device flow is valid here only when POSTGRES_URL and BETTER_AUTH_SECRET
// match that service exactly; the relay has no separate login system.
let pool: Pool | undefined;
// Share-grant account lookups: production resolves against Better
// Auth's user table on the same Postgres the session check uses; the test
// seam maps "<userId>@dohc.test" <-> "<userId>" so share E2E can address
// recipients by email without a user database.
const TEST_EMAIL_SUFFIX = "@dohc.test";
let resolveUserIdByEmail: (email: string) => Promise<string | null> | string | null;
let lookupUserEmail: (userId: string) => Promise<string | null> | string | null;
let lookupVerifiedUserEmail: (userId: string) => Promise<string | null> | string | null;
let lookupUserDisplayName: (userId: string) => Promise<string | null> | string | null;
let lookupUserDisplayNames: LookupUserDisplayNames;
// The test seam has no browser sign-ins, so it serves no push subscriptions
// and no personal agent sign-in. Its Bearer identities are desktop sign-ins.
const accountResolvers: {
  actor: ResolveActor;
  session?: ResolveAccountSession;
  phoneCapableSession?: ResolveAccountSession;
  sessions?: AccountSessions;
  credentialFence?: CredentialFence;
} = testAuthSeam
  ? { actor: createTestActorResolver(), phoneCapableSession: createTestAccountSessionResolver() }
  : await (async () => {
      const { createWorkspaceAuth } = await import("@dohc/workspace-auth/betterAuth");
      pool = new Pool({
        connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
        // A request waiting for a connection Postgres can't give fails instead of hanging.
        connectionTimeoutMillis: 5_000,
      });
      // pg pools emit 'error' for idle-client failures (Postgres restart,
      // network partition). Without a listener that is an uncaught 'error'
      // event and takes the whole relay process down; with one, only the
      // in-flight requests fail (as a 5xx via the handler's error path).
      pool.on("error", (error) => {
        console.error("[sync-relay] postgres pool error", serverLogLine(error));
      });
      const auth = createWorkspaceAuth({
        pool,
        baseURL:
          process.env.SYNC_RELAY_AUTH_BASE_URL ?? `http://localhost:${requestedPort || 1788}`,
        secret,
      });
      const credentialFence = createPostgresCredentialFence(pool);
      return {
        actor: createSessionActorResolver(auth),
        session: createAccountSessionResolver(auth),
        phoneCapableSession: createPhoneCapableAccountSessionResolver(auth),
        sessions: createPostgresAccountSessions(pool),
        credentialFence,
      };
    })();
startTimeline.done("accounts");
const resolveAccountActor = accountResolvers.actor;
const resolveAccountSession = accountResolvers.session;
const resolvePhoneCapableAccountSession = accountResolvers.phoneCapableSession;
const credentialFence = accountResolvers.credentialFence;
const pushConfig = (() => {
  try {
    return readPushConfig(process.env);
  } catch (error) {
    fatal(
      `FATAL: ${error instanceof Error ? error.message : "Invalid push sender configuration."}`,
    );
  }
})();
const pushVapidPublicKey = pushConfig?.publicKey;
const apnsConfig = (() => {
  try {
    return readApnsConfig(process.env);
  } catch (error) {
    fatal(`FATAL: ${error instanceof Error ? error.message : "Invalid APNs configuration."}`);
  }
})();
const smtpSettings = (() => {
  try {
    return smtpSettingsFromEnv(process.env);
  } catch (error) {
    fatal(`FATAL: ${error instanceof Error ? error.message : "Invalid SMTP configuration."}`);
  }
})();

const documentProjection = projectionExecutable
  ? await startEngineProjection({
      engineExecutable: projectionExecutable,
      allowUnisolatedProjection: projectionOptIn === "1",
    }).catch((error: unknown) =>
      fatal(`FATAL: Document projection could not start: ${serverLogLine(error)}`),
    )
  : undefined;
startTimeline.done("engine check");
const storageOptions = {
  workspaceQuotaBytes,
  pushConfigured: Boolean(pool && pushConfig),
  apnsConfigured: Boolean(pool && apnsConfig),
  ...(namedLiveConfig ? { liveTickets: { ...namedLiveConfig.tickets, now: Date.now } } : {}),
  opened: (part: SyncRelayOpenPart) => startTimeline.done(`database ${part}`),
};
const deployment = deploymentConfig
  ? openRelayDeployment(deploymentConfig, storageOptions)
  : undefined;
const storage = deployment?.storage ?? openSyncRelayStorage(dbPath, storageOptions);
if (secretKeyring && secretKeys?.trim()) {
  const counts = resealWorkspaceSecrets(storage, secretKeyring);
  console.log(
    `[sync-relay] workspace secrets on key ${secretKeyring.activeId}: ${counts.resealed} resealed, ${counts.current} already current, ${counts.unreadable} unreadable, ${counts.changed} changed while resealing`,
  );
}
// Worker files are disposable materializations. The relay database retains authority and recovery history.
const datasetDirectory =
  deployment?.datasetDirectory ?? (await mkdtemp(join(tmpdir(), "dohc-relay-datasets-")));
const datasetHost = await storage.createDatasetHost({
  directory: datasetDirectory,
  limits: appPublicationLimits ?? {
    maxFiles: APP_PUBLICATION_MAX_FILES,
    maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES,
    maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES,
  },
  publicEditRelease,
  maxParticipantsPerGrant: appBackendMaxParticipantsPerGrant,
  compileOperations: compileDatasetOperations,
  startupExclusive: Boolean(deployment),
  onShutdownError(error) {
    console.error("[sync-relay] dataset shutdown failed", serverLogLine(error));
  },
});

const resolveActor = resolveAccountActor;
if (
  copiesOn &&
  (!deployment ||
    !linkKey ||
    !process.env.DOHC_RELAY_SERVICE_HOST_ROOT ||
    !process.env.DOHC_RELAY_ENGINE_EXECUTABLE ||
    !process.env.DOHC_RELAY_PUBLIC_ORIGIN)
) {
  fatal(
    "FATAL: Copies of workspaces on this server require a deployment, the link key, a persistent host root, the native engine executable, and the public HTTPS relay origin.",
  );
}
// The copies sync with this origin, and it issues the actor key of each phone write.
if (copiesOn && !isPublicHttpsOrigin(process.env.DOHC_RELAY_PUBLIC_ORIGIN!)) {
  fatal(
    "FATAL: DOHC_RELAY_PUBLIC_ORIGIN must be exactly an HTTPS origin, such as https://relay.example.com, with no path or trailing slash.",
  );
}
const automationServer = automationsOn
  ? { label: automationServerLabel(process.env.DOHC_SERVER_NAME) }
  : undefined;
const automationReplicaKey = copiesOn
  ? { key: Buffer.from(linkKey!), namespace: deployment!.history.namespace }
  : undefined;
// One wait hub for every route that writes the log, so a write any of them takes wakes every wait on it.
const discussionActivity = new DiscussionActivityHub();
const automationReplication = automationReplicaKey
  ? createServiceHostReplication({
      storage,
      prefix: AUTOMATION_REPLICA_BEARER_PREFIX,
      activity: discussionActivity,
      authorize: (input) =>
        authorizeAutomationReplication(storage, { ...automationReplicaKey, ...input }),
      lookupUserDisplayName: (userId) => lookupUserDisplayName(userId),
      lookupUserDisplayNames: (userIds) => lookupUserDisplayNames(userIds),
    })
  : undefined;
// One limit per person for notices to others, shared by the route and this server's automations.
const noticePostRateLimiter = new TokenBucketLimiter(
  NOTICE_POST_BUCKET_CAPACITY,
  NOTICE_POST_REFILL_PER_SECOND,
  NOTICE_POST_MAX_SENDERS,
);
let automations: Awaited<ReturnType<typeof startAutomationServer>> | undefined;
let copies: ServerCopies | undefined;
const serviceReplication =
  selfHostedLive && deployment && linkKey
    ? (() => {
        const credential = { key: Buffer.from(linkKey), namespace: deployment.history.namespace };
        return createServiceHostReplication({
          storage,
          prefix: "dohc-service-v1.",
          hostedFeed: true,
          activity: discussionActivity,
          authorize: (input) =>
            authorizeServiceHostReplication(storage, { ...credential, ...input }),
          lookupUserDisplayName: (userId) => lookupUserDisplayName(userId),
          lookupUserDisplayNames: (userIds) => lookupUserDisplayNames(userIds),
        });
      })()
    : undefined;

function createTestActorResolver(): ResolveActor {
  return (request, workspaceId) => {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer test:([A-Za-z0-9_.:-]+)$/u.exec(authorization);
    if (!match) throw new UnauthorizedError();
    return { userId: match[1]!, workspaceId };
  };
}

function createTestAccountSessionResolver(): ResolveAccountSession {
  const resolveActor = createTestActorResolver();
  return async (request) => {
    const { userId } = await resolveActor(request, "");
    return {
      userId,
      sessionId: `test:${userId}`,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      clientKind: "desktop",
    };
  };
}

if (testAuthSeam) {
  resolveUserIdByEmail = (email) =>
    email.endsWith(TEST_EMAIL_SUFFIX) && email.length > TEST_EMAIL_SUFFIX.length
      ? email.slice(0, -TEST_EMAIL_SUFFIX.length)
      : null;
  lookupUserEmail = (userId) => `${userId}${TEST_EMAIL_SUFFIX}`;
  lookupVerifiedUserEmail = lookupUserEmail;
  lookupUserDisplayName = (userId) => userId;
  lookupUserDisplayNames = (userIds) => new Map(userIds.map((id) => [id, id]));
} else {
  // Better Auth's canonical table/column names on the shared Postgres.
  ({ resolveUserIdByEmail, lookupVerifiedUserEmail } = createVerifiedEmailLookups(pool!));
  lookupUserEmail = async (userId) => {
    const result = await pool!.query<{ email: string }>(
      'SELECT email FROM "user" WHERE id = $1 LIMIT 1',
      [userId],
    );
    return result.rows[0]?.email ?? null;
  };
  lookupUserDisplayName = async (userId) => {
    const result = await pool!.query<{ name: string | null }>(
      'SELECT name FROM "user" WHERE id = $1 LIMIT 1',
      [userId],
    );
    return result.rows[0]?.name ?? null;
  };
  lookupUserDisplayNames = async (userIds) => {
    if (userIds.length === 0) return new Map();
    const result = await pool!.query<{ id: string; name: string | null }>({
      text: 'SELECT id, name FROM "user" WHERE id = ANY($1::text[])',
      values: [userIds],
      query_timeout: 5_000,
    } as QueryConfig & { query_timeout: number });
    return new Map(result.rows.map((row) => [row.id, row.name]));
  };
}

// One in-memory presence hub for the whole process: the ephemeral awareness
// transport is never persisted, so it lives only here and is lost on restart
// (by design — presence is not durable).
const presence = new PresenceHub();

let liveRooms: LiveRooms | undefined;
let phonePages: PhonePages | undefined;
let heldDocumentHost: (() => HeldDocumentHost | undefined) | undefined;
let liveHost: AccountFileWriteLiveHost | undefined;
const relayApplication = createSyncRelayHandler({
  discussionActivity,
  ...(analytics ? { onWorkspaceCreated: () => analytics.track("sync_workspace_activated") } : {}),
  liveRooms: () => liveRooms,
  heldDocumentHost: () => heldDocumentHost?.(),
  storage,
  resolveActor,
  ...(resolveAccountSession ? { resolveAccountSession } : {}),
  ...(resolvePhoneCapableAccountSession ? { resolvePhoneCapableAccountSession } : {}),
  ...(accountResolvers.sessions ? { accountSessions: accountResolvers.sessions } : {}),
  ownerLiveSockets: () =>
    ownerLive || desktopLive || phoneLive || phoneMemberSessions
      ? {
          stopSession: (userId, sessionId) => {
            ownerLive?.stopSession(userId, sessionId);
            desktopLive?.stopSession(userId, sessionId);
            phoneLive?.stopSession(userId, sessionId);
            phoneMemberSessions?.stopSession(userId, sessionId);
          },
          stopPhoneWorkspace: (userId, workspaceId) => {
            ownerLive?.stopPhoneWorkspace(userId, workspaceId);
            phoneLive?.stopPhoneWorkspace(userId, workspaceId);
            phoneMemberSessions?.stopPhoneWorkspace(userId, workspaceId);
          },
        }
      : undefined,
  ...(credentialFence ? { credentialFence } : {}),
  ...(pushVapidPublicKey ? { pushVapidPublicKey } : {}),
  ...(pushConfig ? { pushHosts: pushConfig.hosts } : {}),
  ...(apnsConfig ? { apnsConfig } : {}),
  resolveUserIdByEmail: (email) => resolveUserIdByEmail(email),
  lookupUserEmail: (userId) => lookupUserEmail(userId),
  lookupUserEmails: async (userIds) => {
    if (userIds.length === 0) return new Map();
    if (testAuthSeam) return new Map(userIds.map((id) => [id, `${id}${TEST_EMAIL_SUFFIX}`]));
    const result = await pool!.query<{ id: string; email: string }>(
      'SELECT id, email FROM "user" WHERE id = ANY($1::text[])',
      [userIds],
    );
    return new Map(result.rows.map((row) => [row.id, row.email]));
  },
  lookupVerifiedUserEmail: (userId) => lookupVerifiedUserEmail(userId),
  ...(smtpSettings
    ? {
        sendShareInvitationEmail: createSmtpSender(smtpSettings, {
          timeoutMs: SHARE_INVITATION_EMAIL_TIMEOUT_MS,
        }),
      }
    : {}),
  lookupUserDisplayName: (userId) => lookupUserDisplayName(userId),
  lookupUserDisplayNames: (userIds) => lookupUserDisplayNames(userIds),
  presence,
  linkKey,
  secretKeyring,
  ...(nodeEnv === "test" && process.env.DOHC_TEST_APP_EXTERNAL_ORIGIN
    ? {
        appExternalTransport: loopbackDeclaredHttpsTransport(
          process.env.DOHC_TEST_APP_EXTERNAL_ORIGIN,
        ),
      }
    : {}),
  shareWebOrigin,
  relayExchangeKey,
  // The relay has already ended these launches, so every later call share-web makes for them is refused.
  // This ends share-web's own state without waiting for that call.
  // Share-web ends only these launches, so a purge that arrives late can't end a newer one.
  endShareWebAppLaunches: (launchHashes) => {
    const origin = process.env.DOHC_RELAY_SHARE_WEB_URL;
    if (!shareWebOrigin || !origin || !relayExchangeKey) return;
    for (let start = 0; start < launchHashes.length; start += APP_LAUNCH_PURGE_BATCH)
      fetch(new URL(APP_LAUNCH_PURGE_PATH, origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json",
          [APP_LAUNCH_PURGE_KEY_HEADER]: appLaunchPurgeKey(relayExchangeKey),
        },
        body: JSON.stringify({
          launchHashes: launchHashes.slice(start, start + APP_LAUNCH_PURGE_BATCH),
        }),
      })
        .then(async (response) => {
          await response.body?.cancel();
          if (!response.ok)
            console.error(`Share-web refused the end of phone app sessions: ${response.status}.`);
        })
        .catch(() => console.error("Share-web did not confirm the end of phone app sessions."));
  },
  namedBrowserSessionLimits,
  publicEditRelease,
  appPublicationLimits,
  datasetHost,
  pressDataset: (auth, input, signal) => {
    if (!automations) throw notFound();
    return automations.pressDataset(auth, input, signal);
  },
  serverRuns: () => automations?.runs,
  workspaceSecretsChanged: (workspaceId) => automations?.secretsChanged(workspaceId),
  appCollectionPolicy,
  noticePostRateLimiter,
  serverCopies: () => copies,
  phonePages: () => phonePages,
  liveHost: () => liveHost,
  relayPublicOrigin: process.env.DOHC_RELAY_PUBLIC_ORIGIN,
  ...(automationServer ? { automationServer } : {}),
});
let ownerLive: ReturnType<typeof createOwnerLiveRoutes> | undefined;
let namedLive: ReturnType<typeof createNamedLiveRoutes> | undefined;
let linkLive: ReturnType<typeof createNamedLiveRoutes> | undefined;
let linkLiveHttp: ReturnType<typeof createLinkLiveHttp> | undefined;
let desktopLive: ReturnType<typeof createNamedLiveRoutes> | undefined;
let phoneLive: ReturnType<typeof createNamedLiveRoutes> | undefined;
let phoneMemberSessions: PhoneMemberLiveSessions | undefined;
let desktopAdmission: ReturnType<typeof createNamedDesktopLive> | undefined;
let memberAdmission: ReturnType<typeof createNamedDesktopLive> | undefined;
let serviceEnrollment: ReturnType<typeof createServiceHostEnrollmentRoutes> | undefined;
let personalLiveDocument: ReturnType<typeof createPersonalLiveDocumentRoute> | undefined;
let personalLive: ReturnType<typeof createPersonalLiveRoutes> | undefined;
const relayHandler = guardRelayResponses(storage, (request) => {
  const path = new URL(request.url).pathname;
  if (request.headers.get("authorization")?.startsWith("Bearer dohc-service-v1."))
    return (
      serviceReplication?.(request) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  if (carriesAutomationReplicaBearer(request.headers))
    return (
      automationReplication?.(request) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  if (isServiceHostEnrollmentPath(path))
    return (
      serviceEnrollment?.(request) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  if (path === PERSONAL_LIVE_DOCUMENT_PATH)
    return (
      personalLiveDocument?.(request) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  if (path === "/sync/live/personal-tickets")
    return (
      personalLive?.handle(request) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  if (path === "/sync/live/named-tickets")
    return (
      namedLive?.handle(request) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  if (path === "/sync/live/desktop-open" || path === "/sync/live/desktop-ready")
    return (
      desktopAdmission?.handle(request) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  if (path === "/sync/live/member-open" || path === "/sync/live/member-ready")
    return (
      memberAdmission?.handle(request) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  if (isLinkLivePath(path))
    return (
      (path === "/sync/live/link-tickets" ? linkLive?.handle(request) : linkLiveHttp?.(request)) ??
      Promise.resolve(Response.json({ ok: false, error: "not found" }, { status: 404 }))
    );
  return relayApplication(request);
});
const deletions = createAccountDeletionRoute({
  storage: storage as StorageContext,
  key: accountDeletionKey(secret),
  fenceKey: accountDeletionFenceKey(secret),
  invalidate(userId, manifest) {
    const ids = manifest.workspaces.map((row) => row.workspaceId);
    relayApplication.deleteAccount(userId, ids, manifest.shareIds);
    namedLive?.deleteAccount(userId, ids);
    linkLive?.deleteAccount(userId, ids);
    personalLive?.deleteAccount(userId, ids);
    desktopLive?.deleteAccount(userId, ids);
    phoneLive?.deleteAccount(userId, ids);
    phoneMemberSessions?.deleteAccount(userId, ids);
    ownerLive?.deleteAccount(userId, ids);
    automations?.deleteAccount(userId);
  },
  async deleteRuntime(userId, manifest) {
    const ids = manifest.workspaces.map((row) => row.workspaceId);
    if (shareWebOrigin) {
      const origin = process.env.DOHC_RELAY_SHARE_WEB_URL;
      if (!origin || !relayExchangeKey) throw new Error("Share-web deletion is unavailable.");
      const batches = Math.max(
        1,
        Math.ceil(
          Math.max(ids.length, manifest.grantIds.length, manifest.publicationIds.length) / 8,
        ),
      );
      for (let i = 0; i < batches; i++) {
        const response = await fetch(new URL(ACCOUNT_DELETION_PATH, origin), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "content-type": "application/json",
            [ACCOUNT_DELETION_KEY_HEADER]: accountDeletionKey(relayExchangeKey),
          },
          body: JSON.stringify({
            userId,
            workspaceIds: ids.slice(i * 8, i * 8 + 8),
            grantIds: manifest.grantIds.slice(i * 8, i * 8 + 8),
            publicationIds: manifest.publicationIds.slice(i * 8, i * 8 + 8),
          }),
        });
        const result: unknown = await response.json();
        if (
          !response.ok ||
          !result ||
          typeof result !== "object" ||
          !("finished" in result) ||
          result.finished !== true
        )
          throw new Error("Share-web deletion is unfinished.");
      }
    }
    await (automations ?? copies)?.deleteWorkspaces(ids);
    if (selfHost) await selfHost.deleteWorkspaces(manifest.workspaces);
    else if (deployment && process.env.DOHC_RELAY_SERVICE_HOST_ROOT)
      await deleteSelfHostedWorkspaceRoots(
        process.env.DOHC_RELAY_SERVICE_HOST_ROOT,
        deployment.history.namespace,
        manifest.workspaces,
      );
    await configuredServiceHost?.deleteWorkspaces(ids);
    if (serviceHostConfig) await deleteConfiguredServiceWorkspaceRoots(serviceHostConfig, ids);
    await datasetHost.deleteWorkspaces(manifest.datasets);
  },
});
startTimeline.done("collections");
const pendingDeletions = pool ? await fencePendingAccountDeletions(pool, deletions) : [];
startTimeline.done("account deletions");
const signUpInvites =
  secret.length >= 32
    ? createSignUpInviteRoute({
        storage,
        key: signUpInviteKey(secret),
        inviteLinkKey: inviteLinkSignUp ? (linkKey ?? null) : null,
      })
    : undefined;
const fetchHandler = async (request: Request): Promise<Response> => {
  const entry = relayEntryPattern(
    request.headers.get("authorization"),
    new URL(request.url).pathname,
  );
  if (entry) SYNC_RELAY_REQUEST_LOG.mark(request, entry);
  // These four answer before relayHandler, whatever the bearer, so each marks its own route.
  if (secret.length >= 32 && new URL(request.url).pathname === ACCOUNT_DELETION_PATH) {
    SYNC_RELAY_REQUEST_LOG.mark(request, "/internal/account-deletion");
    return deletions.handle(request);
  }
  if (signUpInvites && new URL(request.url).pathname === SIGN_UP_INVITE_PATH) {
    SYNC_RELAY_REQUEST_LOG.mark(request, "/internal/sign-up-invite");
    return signUpInvites(request);
  }
  if (new URL(request.url).pathname === "/ready") {
    SYNC_RELAY_REQUEST_LOG.mark(request, "/ready");
    const ready =
      !storage.unavailable.aborted && (!selfHostedLive || (!!selfHost && !selfHost.unavailable));
    return Response.json(
      {
        ok: ready,
        service: "sync-relay",
        selfHostedLive: selfHostedLive && ready,
        apiVersions: RELAY_API_VERSIONS,
        engineApiMin,
        automations: !automationsOn
          ? "off"
          : automations && !automations.unavailable
            ? "on"
            : "unavailable",
      },
      { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  }
  if (new URL(request.url).pathname === "/health") {
    SYNC_RELAY_REQUEST_LOG.mark(request, "/health");
    // The presence hub footprint is exposed only under the dev/test seam so
    // integration tests can assert parked waiters are released on disconnect;
    // production health stays a bare liveness probe.
    return Response.json(
      {
        ok: !storage.unavailable.aborted,
        service: "sync-relay",
        ...(testAuthSeam ? { presence: presence.stats() } : {}),
      },
      { status: storage.unavailable.aborted ? 503 : 200 },
    );
  }
  const refusal = relayApiVersionRefusal(
    request.headers,
    relayApiVersionsFor(request, engineApiMin),
  );
  const result = refusal ? errorResponse(refusal) : await relayHandler(request);
  const path = new URL(request.url).pathname;
  return normalizeLinkRefusal(result, path, isLinkLivePath(path));
};

const MAX_LINK_EXCHANGE_BODY_BYTES = 4096;
// Bodies that handlers have read and not yet answered. Handlers read only
// after checking the caller's credential; past either limit the caller gets
// server_busy and retries. One credential's share covers the uploads and log
// push a desktop sends at once.
const BODIES_IN_FLIGHT = {
  maxBytes: 256 * 1024 * 1024,
  maxBytesPerCaller: 128 * 1024 * 1024,
  caller: requestBodyCaller,
};

function loadNamedBrowserSessionLimits(): NamedLiveBrowserHttpLimits | undefined {
  const value =
    process.env.DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS ??
    (liveProfile && JSON.stringify(liveProfile.browserSessions));
  if (value === undefined) return undefined;
  if (!shareWebOrigin || !shareWebOrigin.startsWith("https://")) {
    fatal(
      "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an HTTPS origin when named browser sessions are enabled.",
    );
  }
  if (!relayExchangeKey) {
    fatal("FATAL: DOHC_RELAY_EXCHANGE_KEY must be set when named browser sessions are enabled.");
  }
  try {
    return parseNamedLiveBrowserHttpLimits(JSON.parse(value));
  } catch {
    fatal(
      "FATAL: DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS must be valid JSON with all required positive limits within their supported bounds, a safe expiry timestamp, and capacity for the named session envelopes.",
    );
  }
}

function isLiveAdmissionPath(pathname: string): boolean {
  return (
    pathname === "/sync/live/desktop-open" ||
    pathname === "/sync/live/desktop-ready" ||
    pathname === "/sync/live/member-open" ||
    pathname === "/sync/live/member-ready"
  );
}

function isNamedBrowserSessionPath(pathname: string): boolean {
  return (
    pathname === "/sync/live/named-sessions" || pathname === "/sync/live/named-sessions/resolve"
  );
}

function isLinkExchangePath(pathname: string): boolean {
  try {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return parts.length === 2 && parts[0] === "sync" && parts[1] === "link-exchange";
  } catch {
    return false;
  }
}

function isLinkRefreshPath(pathname: string): boolean {
  try {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return parts.length === 2 && parts[0] === "sync" && parts[1] === "link-refresh";
  } catch {
    return false;
  }
}

function presentsValidRelayExchangeKey(headers: Headers): boolean {
  const presented = headers.get("x-dohc-relay-exchange-key");
  return (
    relayExchangeKeyHash !== undefined && verifyRelayExchangeKey(presented, relayExchangeKeyHash)
  );
}

// Presses from shared views go when their retention ends, whether or not
// more arrive or any host lists them. Settled phone writes become tombstones,
// chat wakes end and go, and expired phone sign-ins' alerts end, on the same schedule.
const AUTOMATION_PRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
startRelayMainThreadTiming();
setInterval(() => {
  try {
    storage.purgeExpiredShareRemovals(Date.now());
  } catch (error) {
    console.error("[sync-relay] share removal prune failed:", serverLogLine(error));
  }
  try {
    storage.sweepExpiredPushDevices(Date.now());
  } catch (error) {
    console.error("[sync-relay] phone alert sweep failed:", serverLogLine(error));
  }
  try {
    storage.pruneExpiredIncomingWebhookDeliveries(Date.now());
  } catch (error) {
    console.error("[sync-relay] incoming webhook delivery prune failed:", serverLogLine(error));
  }
  pruneAutomationPresses(storage, Date.now()).catch((error: unknown) => {
    console.error("[sync-relay] automation press prune failed:", serverLogLine(error));
  });
  tombstoneSettledOperations(storage, Date.now()).catch((error: unknown) => {
    console.error("[sync-relay] account operation tombstones failed:", serverLogLine(error));
  });
  sweepChatWakesInBatches(storage, Date.now()).catch((error: unknown) => {
    console.error("[sync-relay] chat wake sweep failed:", serverLogLine(error));
  });
}, AUTOMATION_PRESS_PRUNE_INTERVAL_MS).unref();

const server = serveFetchHandler({
  handler: fetchHandler,
  streamBody: streamsRequestBody,
  // Reads kept open to hear of a change. `hold`: a page's log, chat and comment activity, sent on by the share
  // service, presence, and a session's operation changes. `wait`: a computer's chat wakes and a session's notices.
  // `waitMs`: a computer's button presses.
  waits: waitsOnQuery("hold", "wait", "waitMs"),
  requestLog: SYNC_RELAY_REQUEST_LOG,
  bodiesInFlight: BODIES_IN_FLIGHT,
  busy: () => errorBody("server_busy"),
  maxBodyBytes: (url) =>
    automationHostMaxBodyBytes(url.pathname) ??
    (isServiceHostEnrollmentPath(url.pathname)
      ? 16 * 1024
      : url.pathname === PERSONAL_LIVE_DOCUMENT_PATH
        ? PERSONAL_LIVE_DOCUMENT_MAX_BODY_BYTES
        : isAutomationPressPath(url.pathname)
          ? AUTOMATION_PRESS_MAX_BODY_BYTES
          : isAutomationServerPath(url.pathname)
            ? AUTOMATION_SERVER_MAX_BODY_BYTES
            : isAccountWorkspacePath(url.pathname)
              ? ACCOUNT_WORKSPACE_MAX_BODY_BYTES
              : isLiveAdmissionPath(url.pathname) && namedBrowserSessionLimits
                ? namedBrowserSessionLimits.maxRequestBytes
                : (url.pathname === "/sync/live/named-tickets" ||
                      url.pathname === "/sync/live/personal-tickets" ||
                      isLinkLivePath(url.pathname)) &&
                    namedLiveConfig
                  ? namedLiveConfig.transport.maxRequestBytes
                  : (isNamedBrowserSessionPath(url.pathname) ||
                        url.pathname === "/sync/named-chat/messages") &&
                      namedBrowserSessionLimits
                    ? namedBrowserSessionLimits.maxRequestBytes
                    : isLinkExchangePath(url.pathname) || isLinkRefreshPath(url.pathname)
                      ? MAX_LINK_EXCHANGE_BODY_BYTES
                      : maxRequestBodyBytes(url)),
  oversized: (url, { limit, bytes, declared }) =>
    isLinkEndpointPath(url.pathname)
      ? opaqueLinkRefusal()
      : isLiveAdmissionPath(url.pathname) ||
          url.pathname === "/sync/live/named-tickets" ||
          url.pathname === "/sync/live/personal-tickets" ||
          isLinkLivePath(url.pathname) ||
          isNamedBrowserSessionPath(url.pathname) ||
          isLinkExchangePath(url.pathname) ||
          isLinkRefreshPath(url.pathname)
        ? errorBody("not_found")
        : errorResponse(
            relayError(
              "payload_too_large",
              declared
                ? `Request body declared ${bytes} bytes. The limit is ${limit} bytes.`
                : appBackendLimit("Request body", limit, bytes, "bytes", true),
            ),
          ),
  // Never echo internal error details (or anything derived from the request)
  // back to the caller.
  failure: () => jsonResponse({ ok: false, error: "internal error" }, 500),
  prepareHeaders: (headers, incoming, url) => {
    // Only the keyed share-web exchange hop can select a forwarded bucket.
    if (
      !isLinkExchangePath(url.pathname) ||
      headers.get("x-dohc-relay-client-ip") === null ||
      !presentsValidRelayExchangeKey(headers)
    ) {
      headers.set("x-dohc-relay-client-ip", incoming.socket.remoteAddress ?? "unknown");
    }
  },
});

const host = testAuthSeam ? "127.0.0.1" : (process.env.SYNC_RELAY_BIND ?? "0.0.0.0");
let deviceControl: ReturnType<typeof createDeviceControl> | undefined;
const deviceDeliveryConfig = process.env.DOHC_RELAY_DEVICE_DELIVERY_CONFIG;
const trustedOwnerAccount = async (accountId: string) => ({
  accountId,
  name: (await accountDisplayName(lookupUserDisplayName, accountId)) ?? "Unnamed",
});
const ownerAdmissionPath = process.env.DOHC_RELAY_OWNER_ADMISSION_CONFIG;
if (ownerAdmissionPath && !deviceDeliveryConfig)
  fatal("FATAL: Private owner admission requires configured device delivery.");
let ownerAdmission: ReturnType<typeof readOwnerAdmissionConfig> | undefined;
if (deviceDeliveryConfig && (!deployment || process.env.DOHC_DEVICE_CONTROL_LIMITS === undefined))
  fatal("FATAL: Device delivery requires an initialized deployment and device control limits.");
if (process.env.DOHC_DEVICE_CONTROL_LIMITS !== undefined) {
  try {
    const limits = parseDeviceControlLimits(JSON.parse(process.env.DOHC_DEVICE_CONTROL_LIMITS));
    const delivery = deviceDeliveryConfig
      ? readRelayDeviceDeliveryConfig(deviceDeliveryConfig, limits)
      : undefined;
    if (ownerAdmissionPath && delivery) {
      ownerAdmission = readOwnerAdmissionConfig(
        ownerAdmissionPath,
        delivery.workspaceIds,
        trustedOwnerAccount,
      );
    }
    deviceControl = createDeviceControl({
      storage,
      relayExchangeKey: relayExchangeKey ?? "",
      hosts: new Set((process.env.DOHC_RELAY_DEVICE_CONTROL_HOSTS ?? "").split(",")),
      limits,
      ...(delivery && deployment
        ? {
            delivery: {
              config: delivery,
              history: deployment.history,
              ownerAdmission: ownerAdmission?.admission,
              frameChanges,
            },
          }
        : {}),
    });
  } catch (error) {
    // A configuration file that cannot be read is named by its path.
    fatal(`FATAL: Invalid device control configuration. ${serverLogLine(error)}`);
  }
}
if (deviceControl) {
  server.on("upgrade", (request, socket, head) => {
    if (
      namedLiveConfig &&
      (request.url?.startsWith("/sync/live/named?") ||
        request.url?.startsWith("/sync/live/link?") ||
        request.url?.startsWith("/sync/live/personal?") ||
        request.url?.startsWith("/sync/live/desktop?") ||
        /^\/sync\/workspaces\/[^/]+\/live\/owner(?:\?|$)/.test(request.url ?? ""))
    )
      return;
    deviceControl!.handleUpgrade(request, socket, head);
  });
  process.once("SIGINT", deviceControl.close);
  process.once("SIGTERM", deviceControl.close);
  server.once("close", deviceControl.close);
}
const ownerAdmissionRun =
  ownerAdmission && deviceControl && deployment
    ? startOwnerAdmission({
        config: ownerAdmission,
        storage,
        history: deployment.history,
        control: deviceControl,
        onError: (error) =>
          console.error("[sync-relay] private owner delivery:", serverLogLine(error)),
      })
    : undefined;
const stopOwnerAdmission = () => {
  void ownerAdmissionRun
    ?.close()
    .catch((error) =>
      console.error("[sync-relay] private owner delivery shutdown:", serverLogLine(error)),
    );
};
server.once("close", stopOwnerAdmission);
server.once("close", () => void relayApplication.dispose());
process.once("SIGINT", stopOwnerAdmission);
process.once("SIGTERM", stopOwnerAdmission);
const serviceHostConfig = process.env.DOHC_RELAY_SERVICE_HOST_CONFIG;
if (serviceHostConfig && !deployment)
  fatal("FATAL: A service host requires an initialized relay deployment.");
const configuredServiceHost =
  serviceHostConfig && deployment
    ? await startServiceLiveHost({
        trustedAccount: trustedOwnerAccount,
        configPath: serviceHostConfig,
        storage,
        history: deployment.history,
        frameChanges,
      })
    : undefined;
if (
  selfHostedLive &&
  (!deployment ||
    !frameChanges ||
    !linkKey ||
    !process.env.DOHC_RELAY_SERVICE_HOST_ROOT ||
    !process.env.DOHC_RELAY_ENGINE_EXECUTABLE ||
    !process.env.DOHC_RELAY_PUBLIC_ORIGIN)
) {
  fatal(
    "FATAL: Self-host live editing requires a deployment, a persistent host root, the native engine executable, and the public HTTPS relay origin.",
  );
}
const selfHost = selfHostedLive
  ? await startSelfHostedLiveHost({
      trustedAccount: trustedOwnerAccount,
      storage,
      history: deployment!.history,
      frameChanges: frameChanges!,
      root: process.env.DOHC_RELAY_SERVICE_HOST_ROOT!,
      engineExecutable: process.env.DOHC_RELAY_ENGINE_EXECUTABLE!,
      relayOrigin: process.env.DOHC_RELAY_PUBLIC_ORIGIN!,
      key: Buffer.from(linkKey!),
      onError: (error) =>
        console.error("[sync-relay] self-host live service:", serverLogLine(error)),
    })
  : undefined;
liveHost = selfHost;
const serviceHost = () => selfHost?.current() ?? configuredServiceHost;
// Browsers are told why live editing stopped while the self-hosted session host cannot continue the document.
const sessionHostBlocked = selfHost
  ? (document: { workspaceId: string; objectId: string }) =>
      storage.getLiveHostControl()?.configuredMode === "service"
        ? selfHost.sessionBlock(document)
        : undefined
  : undefined;
const readiness =
  selfHost &&
  serviceHostReadiness({
    storage,
    history: deployment!.history,
    host: selfHost,
    activation: storage.createServiceActivationStore(deployment!.history),
  });
const liveNote = readiness
  ? (document: { workspaceId: string; objectId: string }) => {
      if (storage.getLiveHostControl()?.configuredMode !== "service") return undefined;
      const row = storage.readServiceHostEnrollmentByObjectId(
        document.workspaceId,
        document.objectId,
      );
      return row ? liveNoteStanding(row.note.state, () => readiness.state(row)) : undefined;
    }
  : undefined;
if (selfHost && deployment)
  serviceEnrollment = createServiceHostEnrollmentRoutes({
    storage,
    history: deployment.history,
    host: selfHost,
    resolveActor: resolveAccountActor,
    rooms: () => liveRooms,
  });
// Every relay answers a personal open. Only one running the self-hosted live host hosts it.
personalLiveDocument = createPersonalLiveDocumentRoute({
  storage,
  linkAuthority: relayApplication.linkAuthority,
  personalAgents: relayApplication.personalAgents,
  limiter: relayApplication.personalLimiter,
  nowMs: () => Date.now(),
  ...(selfHost && deployment
    ? {
        live: {
          host: selfHost,
          history: deployment.history,
          hostId: selfHostedLiveHostId(deployment.history.namespace),
        },
      }
    : {}),
});
// Only a session service keeps hosted replicas, so only it holds documents for released retained work.
heldDocumentHost = () =>
  storage.getLiveHostControl()?.configuredMode === "service" ? serviceHost() : undefined;
if (publicEditRelease) {
  const mode = storage.getLiveHostControl()?.configuredMode;
  if (
    !linkLiveEnabled ||
    !namedLiveConfig ||
    (mode === "service"
      ? !configuredServiceHost && !selfHost
      : mode === "device"
        ? !deviceControl || !deviceDeliveryConfig || !ownerAdmission
        : true)
  ) {
    fatal(
      "FATAL: Public Edit release requires link live routes and the configured service host or device delivery with owner admission.",
    );
  }
}
if (namedLiveConfig) {
  if (!configuredServiceHost && !selfHost && !deviceControl)
    fatal("FATAL: Named live routes require an authenticated service or device host.");
  const captureNative = async (
    binding: LiveObjectBinding,
    signal: AbortSignal,
  ): Promise<NamedFrameNativeHost> => {
    const mode = storage.getLiveHostControl()?.configuredMode;
    const host = mode === "service" ? serviceHost() : mode === "device" ? deviceControl : undefined;
    if (!host) throw new Error("Named live host is unavailable.");
    return host.captureNative(binding, signal);
  };
  // A link reader's early state, from the configured host only, which answers only for a note it holds awake.
  // The engine is not told the client's output bound, and an answer past it fails the whole engine connection, so
  // this reads under the bound a socket's opening sync uses, never a smaller one.
  const readAwakeState = async (binding: LiveObjectBinding, signal: AbortSignal) => {
    const mode = storage.getLiveHostControl()?.configuredMode;
    const host = mode === "service" ? serviceHost() : mode === "device" ? deviceControl : undefined;
    return host?.readAwakeState(binding, namedLiveConfig.host.maxSyncOutputBytes, signal);
  };
  const hostReports = createLiveHostReports({ storage, captureNative });
  const tickets = createLiveTickets({
    storage,
    audience: shareWebOrigin!,
    key: linkKey!,
    hostReports,
  });
  const admission = createLiveConnectionAdmission();
  const membership = createLiveMembershipRegistry(
    {
      maxSessions: namedLiveConfig.transport.maxConnections,
      maxMembers: namedLiveConfig.transport.maxConnections,
      maxSnapshotBytes: namedLiveConfig.frames.receive.maxFrameBytes,
    },
    storage.readLiveAuthority.bind(storage),
  );
  const bounds = namedLiveConfig.host;
  const everyRoom = createLiveRooms({
    storage,
    maxUpdateBytes: Math.min(bounds.maxSubmissionBytes, bounds.maxAppliedUpdateBytes),
    maxNoteBytes: bounds.maxAdmissionBytes,
    maxAppliedBytes: Math.min(bounds.maxSubmissionBytes, bounds.maxAppliedUpdateBytes),
    // A room saves as the workspace's owner, whoever is connected.
    async openSaver(document, signal) {
      const ownerUserId = workspaceOwner(storage as StorageContext, document.workspaceId);
      if (!ownerUserId) throw new Error("The workspace has no owner.");
      const current = storage.resolveCurrentLiveDocumentBinding({
        document,
        actor: { kind: "owner", userId: ownerUserId },
      });
      // A moved, deleted or replaced file, or an ended lineage, doesn't come back by itself.
      if (current.kind !== "current")
        throw current.reason === "stale-document"
          ? new LiveRoomBindingEndedError()
          : new Error("The owner's binding is not current.");
      return captureOwnerLiveFrameHost({
        authenticatedUserId: ownerUserId,
        storage,
        native: await captureNative(current.binding, signal),
        bounds,
        validate: namedLiveConfig.validate,
      });
    },
  });
  // A desktop that hosts its own notes takes each edit itself, so only a session service's notes edit in a room.
  const rooms: LiveRooms = {
    ...everyRoom,
    join: (host, options) =>
      storage.getLiveHostControl()?.configuredMode === "service"
        ? everyRoom.join(host, options)
        : host,
  };
  liveRooms = rooms;
  // A paused note is refused to editors as a held one is: only its owner can start it again.
  const editorsBlocked = (document: { workspaceId: string; objectId: string }) =>
    liveRoomPaused(storage as StorageContext, document) ? "held" : sessionHostBlocked?.(document);
  const liveHosts = new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(","));
  const sharedNamedLive = {
    rooms,
    kind: "named" as const,
    storage,
    lookupUserDisplayName,
    hosts: liveHosts,
    publicOrigin: shareWebOrigin!,
    exchangeKey: relayExchangeKey!,
    limits: namedLiveConfig.transport,
    frames: namedLiveConfig.frames,
    bounds: namedLiveConfig.host,
    validate: namedLiveConfig.validate,
    captureNative,
    membership,
    admission,
  };
  namedLive = createNamedLiveRoutes({
    ...sharedNamedLive,
    sessions: { resolve: relayApplication.resolveNamedBrowserSession },
    tickets,
    sessionHostBlocked: editorsBlocked,
    liveNote,
  });
  if (linkLiveEnabled && publicEditRelease) {
    const hosts = new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(","));
    linkLive = createNamedLiveRoutes({
      kind: "link",
      storage,
      hosts,
      publicOrigin: shareWebOrigin!,
      exchangeKey: relayExchangeKey!,
      limits: namedLiveConfig.transport,
      frames: namedLiveConfig.frames,
      bounds: namedLiveConfig.host,
      validate: namedLiveConfig.validate,
      sessions: createLinkLiveResolver({
        storage,
        linkKey: linkKey!,
        publicEditRelease,
        linkAuthority: relayApplication.linkAuthority,
      }),
      tickets,
      captureNative,
      membership,
      rooms,
      admission,
      sessionHostBlocked: editorsBlocked,
      liveNote,
    });
    linkLiveHttp = createLinkLiveHttp({
      storage,
      hosts,
      publicOrigin: shareWebOrigin!,
      exchangeKey: relayExchangeKey!,
      limits: namedLiveConfig.transport,
      linkKey: linkKey!,
      publicEditRelease,
      sessionHostBlocked: editorsBlocked,
      liveNote,
      linkAuthority: relayApplication.linkAuthority,
      readAwakeState,
      frames: namedLiveConfig.frames.receive,
    });
    server.once("close", linkLive.close);
    process.once("SIGINT", linkLive.close);
    process.once("SIGTERM", linkLive.close);
  }
  // A personal agent edits only through the self-hosted live host, and only while it is the configured host.
  if (selfHost && deployment) {
    const hostId = selfHostedLiveHostId(deployment.history.namespace);
    personalLive = createPersonalLiveRoutes({
      storage,
      hosts: new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(",")),
      publicOrigin: shareWebOrigin!,
      exchangeKey: relayExchangeKey!,
      limits: namedLiveConfig.transport,
      frames: namedLiveConfig.frames,
      bounds: namedLiveConfig.host,
      validate: namedLiveConfig.validate,
      tickets,
      captureNative,
      admission,
      sessionHostBlocked: editorsBlocked,
      linkAuthority: relayApplication.linkAuthority,
      personalAgents: relayApplication.personalAgents,
      limiter: relayApplication.personalLimiter,
      supported: () => {
        const control = storage.getLiveHostControl();
        return control?.configuredMode === "service" && control.configuredHostId === hostId;
      },
    });
    server.once("close", personalLive.close);
    process.once("SIGINT", personalLive.close);
    process.once("SIGTERM", personalLive.close);
  }
  if (desktopEditorLimits) {
    const hosts = new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(","));
    const openOptions = {
      storage,
      resolveActor,
      publicOrigin: shareWebOrigin!,
      hosts,
      limits: namedBrowserSessionLimits!,
      editorLimits: desktopEditorLimits,
      tickets,
      changes: frameChanges!,
      readinessLimits: selfHostLiveProfile().desktopReadiness,
      // As for an agent's open: only a relay running the self-hosted live host hosts a member's.
      hostsMemberDocuments: () => {
        const control = storage.getLiveHostControl();
        return (
          !!selfHost &&
          !!deployment &&
          control?.configuredMode === "service" &&
          control.configuredHostId === selfHostedLiveHostId(deployment.history.namespace)
        );
      },
      hostBlocked: (document: { workspaceId: string; objectId: string }) =>
        storage.getLiveHostControl()?.configuredMode === "service"
          ? selfHost?.blocked(document)
          : undefined,
      blocked: editorsBlocked,
    };
    desktopAdmission = createNamedDesktopLive(openOptions);
    // A member's browser, through share-web, into the sessions its live socket resolves.
    const browserSessions = relayApplication.namedBrowserSessions;
    if (browserSessions)
      memberAdmission = createNamedDesktopLive({
        ...openOptions,
        browser: { exchangeKey: relayExchangeKey!, sessions: browserSessions },
      });
    desktopLive = createNamedLiveRoutes({
      rooms,
      kind: "named",
      desktopBearer: true,
      ...(resolveAccountSession && accountResolvers.sessions
        ? { resolveAccountSession, accountSessions: accountResolvers.sessions }
        : {}),
      storage,
      lookupUserDisplayName,
      hosts,
      publicOrigin: shareWebOrigin!,
      exchangeKey: relayExchangeKey!,
      limits: namedLiveConfig.transport,
      frames: namedLiveConfig.frames,
      bounds: namedLiveConfig.host,
      validate: namedLiveConfig.validate,
      sessions: desktopAdmission,
      tickets,
      captureNative,
      membership,
      admission,
    });
    server.once("close", desktopLive.close);
    process.once("SIGINT", desktopLive.close);
    process.once("SIGTERM", desktopLive.close);
  }
  ownerLive = createOwnerLiveRoutes({
    rooms,
    storage,
    // The Bearer sign-in, a phone's included. A phone also needs a ticket, which only an uncached sign-in read admits.
    resolveAccountSession: resolvePhoneCapableAccountSession!,
    ...(accountResolvers.sessions ? { accountSessions: accountResolvers.sessions, tickets } : {}),
    lookupUserDisplayName,
    hosts: new Set(process.env.DOHC_RELAY_NAMED_LIVE_HOSTS!.split(",")),
    publicOrigin: shareWebOrigin!,
    exchangeKey: relayExchangeKey!,
    limits: namedLiveConfig.transport,
    frames: namedLiveConfig.frames,
    bounds: namedLiveConfig.host,
    validate: namedLiveConfig.validate,
    captureNative,
    admission,
  });
  server.once("close", ownerLive.close);
  process.once("SIGINT", ownerLive.close);
  process.once("SIGTERM", ownerLive.close);
  // A phone opens its pages only through the self-hosted live host, with a ticket only its sign-in redeems, and edits
  // within the editor limits the desktop's admission sends.
  if (selfHost && deployment && accountResolvers.sessions && desktopEditorLimits) {
    const hostId = selfHostedLiveHostId(deployment.history.namespace);
    let phoneNamedTickets: ReturnType<typeof createLiveTickets> | undefined;
    if (resolvePhoneCapableAccountSession) {
      phoneNamedTickets = createLiveTickets({
        storage,
        audience: shareWebOrigin!,
        key: createHmac("sha256", linkKey!).update("dohc-phone-named-live-ticket").digest(),
        hostReports,
      });
      phoneMemberSessions = createPhoneMemberLiveSessions({
        storage,
        maxSessions:
          namedBrowserSessionLimits?.maxSessions ?? namedLiveConfig.transport.maxConnections,
      });
      phoneLive = createNamedLiveRoutes({
        ...sharedNamedLive,
        phoneBearer: true,
        resolveAccountSession: resolvePhoneCapableAccountSession,
        accountSessions: accountResolvers.sessions,
        phoneSessions: phoneMemberSessions,
        tickets: phoneNamedTickets,
      });
      server.once("close", phoneLive.close);
      process.once("SIGINT", phoneLive.close);
      process.once("SIGTERM", phoneLive.close);
    }
    phonePages = createPhonePages({
      storage,
      history: deployment.history,
      host: selfHost,
      supported: () => {
        const control = storage.getLiveHostControl();
        return control?.configuredMode === "service" && control.configuredHostId === hostId;
      },
      tickets,
      ...(phoneNamedTickets && phoneMemberSessions
        ? { phoneNamedTickets, phoneMemberSessions }
        : {}),
      sessions: accountResolvers.sessions,
      nowMs: () => Date.now(),
      editorLimits: desktopEditorLimits,
    });
  }
  server.on("upgrade", (request, socket, head) => {
    if (/^\/sync\/workspaces\/[^/]+\/live\/owner(?:\?|$)/.test(request.url ?? ""))
      void ownerLive!.handleUpgrade(request, socket, head).catch(() => socket.destroy());
    else if (request.url?.startsWith("/sync/live/named?"))
      void namedLive!.handleUpgrade(request, socket, head).catch(() => socket.destroy());
    else if (request.url?.startsWith("/sync/live/link?")) {
      if (linkLive)
        void linkLive!.handleUpgrade(request, socket, head).catch(() => socket.destroy());
      else socket.destroy();
    } else if (request.url?.startsWith("/sync/live/personal?")) {
      if (personalLive)
        void personalLive.handleUpgrade(request, socket, head).catch(() => socket.destroy());
      else socket.destroy();
    } else if (request.url?.startsWith("/sync/live/desktop?")) {
      if (desktopLive)
        void desktopLive!.handleUpgrade(request, socket, head).catch(() => socket.destroy());
      else socket.destroy();
    } else if (request.url?.startsWith("/sync/live/phone?")) {
      if (phoneLive)
        void phoneLive.handleUpgrade(request, socket, head).catch(() => socket.destroy());
      else socket.destroy();
    } else if (!deviceControl) socket.destroy();
  });
  server.once("close", namedLive.close);
  process.once("SIGINT", namedLive.close);
  process.once("SIGTERM", namedLive.close);
}
startTimeline.done("live host");
const publicationOperator = await startPublicationOperator(
  storage,
  operatorSocketPath(),
  operatorSecretPath(),
  ({ ownerUserId, workspaceId, publicationId }) =>
    relayApplication.endPhoneAppLaunches({ userId: ownerUserId, workspaceId, publicationId }),
);

// A server that keeps no copies removes them at start. One that runs no automations ends that reason for every copy.
const automationRoot = process.env.DOHC_RELAY_SERVICE_HOST_ROOT
  ? join(process.env.DOHC_RELAY_SERVICE_HOST_ROOT, "automations")
  : undefined;
// Their phone writes settle first, in an engine started for that alone when the server has one.
if (!copiesOn && automationRoot) {
  await removeAutomationReplicas(
    storage,
    automationRoot,
    deployment && process.env.DOHC_RELAY_ENGINE_EXECUTABLE
      ? {
          namespace: deployment.history.namespace,
          engineExecutable: process.env.DOHC_RELAY_ENGINE_EXECUTABLE,
        }
      : undefined,
  );
}
if (!automationsOn && copiesOn) storage.endCopyReasonEverywhere("automation");
// No phone read is open at start, but one a crash cut short can leave the reason a pass gave back after "Show on phone" went off.
if (copiesOn) storage.endAccountReasonsOfHiddenOrDisownedCopies();
const relayAnswered = Promise.withResolvers<void>();
const relayProbe = new AbortController();
const copyReplicas =
  automationReplicaKey && automationRoot
    ? {
        root: automationRoot,
        engineExecutable: process.env.DOHC_RELAY_ENGINE_EXECUTABLE!,
        relayOrigin: process.env.DOHC_RELAY_PUBLIC_ORIGIN!,
        relayAnswers: relayAnswered.promise,
        ...automationReplicaKey,
      }
    : undefined;
automations =
  automationServer && copyReplicas
    ? await startAutomationServer({
        storage,
        server: automationServer,
        datasetHost,
        replicas: copyReplicas,
        readOwnerShares: relayApplication.readOwnerShares,
        executeOutboundWebhook: relayApplication.executeOutboundWebhook,
        lookupUserDisplayName: (userId) => lookupUserDisplayName(userId),
        noticeLimiter: noticePostRateLimiter,
        ...(deployment && namedLiveConfig
          ? {
              recordDelivery: createAutomationRecordHost({
                storage,
                namespace: deployment.history.namespace,
                serviceHost,
                ...(deviceControl ? { deviceHost: deviceControl } : {}),
                lookupUserDisplayName,
                bounds: namedLiveConfig.host,
                validate: namedLiveConfig.validate,
              }),
            }
          : {}),
        ...(selfHost
          ? {
              live: {
                ledger: (workspaceId: string) => selfHost.automationLedger(workspaceId),
                workspaces: () => selfHost.automationWorkspaces(),
                onEvent: selfHost.onAutomationEvent,
              },
            }
          : {}),
        onError: (context, error) =>
          console.error(`[sync-relay] automations: ${context}:`, serverLogLine(error)),
        ...(analytics
          ? { onRunCompleted: (outcome) => analytics.track("server_automation_ran", { outcome }) }
          : {}),
      })
    : undefined;
copies =
  automations?.copies ??
  (copyReplicas
    ? await startServerCopies({
        ...copyReplicas,
        storage,
        onError: (error, workspaceId) =>
          console.error(
            workspaceId === undefined
              ? "[sync-relay] copies of workspaces:"
              : `[sync-relay] copy of workspace "${workspaceId}":`,
            serverLogLine(error),
          ),
      })
    : undefined);

startTimeline.done("apps and automations");
let journalCheck: ReturnType<typeof startLiveJournalCheck> | undefined;
// pg reads query_timeout from each query's config, but its QueryConfig type doesn't declare it.
const pushQuery = (text: string, values: unknown[]): QueryConfig & { query_timeout: number } => ({
  text,
  values,
  query_timeout: 5000,
});
const pushSender = createPushSender({
  storage: storage as StorageContext,
  config: pool ? pushConfig : undefined,
  apns: pool && apnsConfig ? createApnsClient(apnsConfig) : undefined,
  async lookupAccountName(userId, signal) {
    signal.throwIfAborted();
    const result = await pool!.query<{ name: string | null }>(
      pushQuery('SELECT name FROM "user" WHERE id = $1 LIMIT 1', [userId]),
    );
    signal.throwIfAborted();
    return result.rows[0]?.name ?? null;
  },
  async sessionIsValid(session, signal) {
    signal.throwIfAborted();
    const result = await pool!.query(
      pushQuery(
        `SELECT 1 FROM "session" s JOIN "user" u ON u.id = s."userId"
      WHERE s.id = $1 AND s."userId" = $2 AND s."expiresAt" > now()`,
        [session.sessionId, session.userId],
      ),
    );
    signal.throwIfAborted();
    return result.rowCount === 1;
  },
  onError: () => console.error("[sync-relay] Push delivery could not finish."),
  onApnsRefused: () =>
    console.error(
      "[sync-relay] Apple refused the APNs key, team, or topic. Phone alerts wait 20 minutes.",
    ),
});
const stopPushSender = () => {
  void pushSender.close().catch(() => console.error("[sync-relay] Push sender could not close."));
};
process.once("SIGINT", stopPushSender);
process.once("SIGTERM", stopPushSender);
server.once("close", stopPushSender);
const stopJournalCheck = () => journalCheck?.close();
process.once("SIGINT", stopJournalCheck);
process.once("SIGTERM", stopJournalCheck);
server.once("close", stopJournalCheck);
const accountNameBackfillAbort = new AbortController();
let accountNameBackfill: Promise<unknown> | undefined;
server.listen(requestedPort, host, () => {
  // First, so the work this callback starts is not counted as binding the port.
  startTimeline.done("listening");
  journalCheck = startLiveJournalCheck((storage as StorageContext).db);
  pushSender.start();
  accountNameBackfill = backfillUnnamedAccounts({
    storage,
    lookupUserDisplayNames,
    signal: accountNameBackfillAbort.signal,
    onError: (error) =>
      console.error("[sync-relay] account name backfill failed:", serverLogLine(error)),
  });
  void (async () => {
    for (const job of pendingDeletions.splice(0))
      await deletions
        .purge(job.user_id, job.email)
        .catch(() => console.error("[sync-relay] Account deletion remains pending."));
  })();
  if (copyReplicas)
    void untilRelayAnswers(copyReplicas.relayOrigin, {
      withinMs: RELAY_ANSWER_WAIT_MS,
      retryMs: 500,
      signal: relayProbe.signal,
    }).then(() => {
      if (!relayProbe.signal.aborted) relayAnswered.resolve();
    });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`[sync-relay] listening on ${host}:${actualPort}`);
  console.log(`[sync-relay] ${startTimeline.line()}`);
  console.log(`SYNC_RELAY_LISTENING host=${host} port=${actualPort}`);
  if (testAuthSeam) console.log("[sync-relay] SYNC_RELAY_TEST_AUTH seam ENABLED (dev/test only)");
});

installShutdown(server, {
  gracePeriodMs: SHUTDOWN_GRACE_PERIOD_MS,
  onClosed: async () => {
    relayProbe.abort();
    // The rooms save through the hosts closed below, so they save what they hold first.
    await liveRooms?.close();
    stopJournalCheck();
    await pushSender.close();
    await publicationOperator.close();
    await documentProjection?.close();
    await ownerAdmissionRun?.close();
    await (automations ?? copies)?.close();
    await selfHost?.close();
    await configuredServiceHost?.close();
    await liveValidation.close();
    await datasetHost?.close();
    if (!deployment)
      await rm(datasetDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    // The fence listener holds a pool client, so it closes before the pool ends.
    accountNameBackfillAbort.abort();
    await accountNameBackfill;
    await relayApplication.dispose();
    storage.close();
    try {
      await Promise.allSettled([analytics?.flush(), pool?.end()]);
    } finally {
      process.exit(0);
    }
  },
});
