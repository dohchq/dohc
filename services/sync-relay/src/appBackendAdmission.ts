import { TokenBucketLimiter } from "@dohc/service-http";
import { relayError } from "./errors";

export interface AppBackendAdmissionScope {
  dataset: string;
  participant: string;
  link?: string;
  organizer: boolean;
}
type Rate = { capacity: number; refillPerSecond: number };
export interface AppBackendAdmissionLimits {
  participant: Rate;
  link: Rate;
  dataset: Rate;
  global: Rate;
  organizer: Rate;
  organizerGlobal: Rate;
  maxKeys: number;
  maxPending: number;
  maxOrganizerPending: number;
  maxParticipantPending: number;
  maxUploads: number;
  maxRecovery: number;
}
export const DEFAULT_APP_BACKEND_ADMISSION_LIMITS: AppBackendAdmissionLimits = {
  participant: {capacity: 30, refillPerSecond: 0.5},
  link: {capacity: 600, refillPerSecond: 10},
  dataset: {capacity: 1200, refillPerSecond: 20},
  global: {capacity: 2400, refillPerSecond: 40},
  organizer: {capacity: 120, refillPerSecond: 4},
  organizerGlobal: {capacity: 240, refillPerSecond: 8},
  maxKeys: 2048, maxPending: 64, maxOrganizerPending: 8,
  maxParticipantPending: 4, maxUploads: 4, maxRecovery: 1,
};

export function createAppBackendAdmission(overrides: Partial<AppBackendAdmissionLimits> = {}) {
  const limits = {...DEFAULT_APP_BACKEND_ADMISSION_LIMITS, ...overrides};
  for (const value of Object.values(limits)) {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid app admission limit.");
    } else if (!value || !Number.isSafeInteger(value.capacity) || value.capacity < 1 ||
      !Number.isFinite(value.refillPerSecond) || value.refillPerSecond <= 0) throw new TypeError("Invalid app admission rate.");
  }
  const bucket = (rate: Rate, keys = limits.maxKeys) => new TokenBucketLimiter(rate.capacity, rate.refillPerSecond, keys);
  const participant = bucket(limits.participant), link = bucket(limits.link), dataset = bucket(limits.dataset);
  const global = bucket(limits.global, 1), organizer = bucket(limits.organizer), organizerGlobal = bucket(limits.organizerGlobal, 1);
  // Only admitted requests occupy this map; entries disappear when their last request completes.
  const participants = new Map<string, number>();
  let pending = 0, organizerPending = 0, uploads = 0, recovery = 0;
  return (scope: AppBackendAdmissionScope, action: string, nowMs: number): (() => void) => {
    const participantKey = JSON.stringify([scope.dataset, scope.participant]);
    const count = participants.get(participantKey) ?? 0;
    const recovering = action === "restore" || action === "export";
    const uploading = action === "upload";
    const refuse = () => { throw relayError("link_read_rate_limited"); };
    if (count >= limits.maxParticipantPending ||
        (scope.organizer ? organizerPending >= limits.maxOrganizerPending : pending >= limits.maxPending) ||
        (uploading && uploads >= limits.maxUploads) || (recovering && recovery >= limits.maxRecovery)) refuse();
    if (scope.organizer) {
      if (!organizer.allow(participantKey, nowMs) || !organizerGlobal.allow("global", nowMs)) refuse();
    } else if (!participant.allow(participantKey, nowMs) ||
        (scope.link !== undefined && !link.allow(scope.link, nowMs)) ||
        !dataset.allow(scope.dataset, nowMs) || !global.allow("global", nowMs)) refuse();
    participants.set(participantKey, count + 1);
    if (scope.organizer) organizerPending++; else pending++;
    if (uploading) uploads++;
    if (recovering) recovery++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = participants.get(participantKey)! - 1;
      if (remaining) participants.set(participantKey, remaining); else participants.delete(participantKey);
      if (scope.organizer) organizerPending--; else pending--;
      if (uploading) uploads--;
      if (recovering) recovery--;
    };
  };
}
