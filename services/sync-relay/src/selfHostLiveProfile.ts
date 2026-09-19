/** Shared bounds for the supported small-server live-edit deployment. */
export function selfHostLiveProfile() {
  const MiB = 1024 * 1024;
  const frames = {
    receive: {maxFrameBytes: 64 * 1024, maxStateVectorBytes: 128 * 1024, maxUpdateBytes: 2 * MiB, maxSyncBytes: 4 * MiB},
    maxQueuedBytes: 4 * MiB, maxQueuedFrames: 128, maxControlBytes: 128 * 1024, maxControlFrames: 16, maxAssemblyBytes: 4 * MiB,
  };
  const validation = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
    maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
  const requests = {maxPendingRequests: 32, maxRequestBytes: 16 * 1024, maxResponseBytes: 64 * 1024, timeoutMs: 30_000};
  const connections = {maxConnections: 32, maxConnectionsPerSession: 4, maxConnectionsPerPrincipal: 8, maxConnectionsPerGrant: 16,
    maxPendingBytes: 4 * MiB, maxFragments: 16, maxBufferedChunks: 128, upgradeTimeoutMs: 30_000, idleTimeoutMs: 60_000, drainTimeoutMs: 1_000};
  const nativeIngress = {ingress: {aggregateBytes: 512 * MiB, applicationWorkingReserveBytes: 8 * MiB, maxUploads: 4, uploadDeadlineMs: 30_000},
    maxRegistrations: 64, maxAdoptionBytes: 4 * MiB, maxAdoptionEvents: 128, maxApplicationsPerSettlement: 128,
    ownerOutbox: {maxPendingBytes: 64 * MiB, maxPendingAgeMs: 7 * 24 * 60 * 60 * 1000},
    sync: {policy: {maxClientVectorBytes: 128 * 1024, maxHostVectorBytes: 128 * 1024, maxOutputBytes: 4 * MiB, maxReadBytes: 16 * MiB}, workingReserveBytes: 8 * MiB}};
  const nativeClient = {aggregateBytes: 256 * MiB, maxUploads: 4};
  const editor = {provider: {frames, maxPendingUpdateBytes: 4 * MiB, maxPendingUpdates: 128, maxDeliveryAttempts: 8},
    maxHttpResponseBytes: 64 * 1024, maxSocketBufferedBytes: 4 * MiB, connectTimeoutMs: 30_000, sendTimeoutMs: 30_000, drainPollMs: 10};
  const gateway = {...connections, maxFrameBytes: frames.receive.maxFrameBytes, maxPendingFrames: 128};
  return {
    frames, nativeIngress, nativeClient, editor, gateway, requests, validation,
    owner: {frames, nativeIngress, nativeClient, attemptTimeoutMs: 30_000, retryDelayMs: 2_000},
    browserSessions: {...requests, maxSessions: 256, retentionMs: 12 * 60 * 60 * 1000},
    namedLive: {version: 1, tickets: {retainedTicketsPerPrincipalGrant: 8, expiredTicketCleanupBatchSize: 64},
      transport: {...connections, maxPendingRequests: requests.maxPendingRequests, maxRequestBytes: requests.maxRequestBytes, maxResponseBytes: requests.maxResponseBytes},
      frames, host: {maxClientVectorBytes: 128 * 1024, maxSyncOutputBytes: 4 * MiB, maxAppliedUpdateBytes: 2 * MiB,
        maxSubmissionBytes: 4 * MiB, maxAdmissionBytes: 16 * MiB}, validation, maxListeners: 128},
    service: {ingress: nativeIngress.ingress, client: {...nativeClient, connectTimeoutMs: 30_000, requestDeadlineMs: 30_000},
      settlement: {maxApplicationsPerSettlement: nativeIngress.maxApplicationsPerSettlement},
      adoption: {maxBytes: nativeIngress.maxAdoptionBytes, maxEvents: nativeIngress.maxAdoptionEvents, ownerOutbox: nativeIngress.ownerOutbox},
      sync: nativeIngress.sync,
      activation: {validation, maxCaptureBytes: 4 * MiB, maxEntriesPerDrain: 128, maxBytesPerDrain: 4 * MiB,
        maxDocumentsPerPass: 8, pollIntervalMs: 250, passDeadlineMs: 30_000}},
  };
}

export const selfHostedLiveProfile = selfHostLiveProfile().owner;
