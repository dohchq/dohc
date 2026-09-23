export type SessionId = "s1" | "s2";
export type RegistrationStatus = "pending_verification" | "verified" | "rejected" | "pay_at_venue";
export type PaymentMethod = "gcash" | "bdo" | "unionbank" | "bpi" | "cash";
export interface RosterInput { sessionId: SessionId; players: string[]; spectators: string[] }
export interface RegisterInput {
  fullName: string; mobile: string; sessions: RosterInput[];
  paymentMethod: Exclude<PaymentMethod, "cash">; receiptFileId: string;
  submissionId: string; retrySecret: string; receiptSha256: string;
}
export interface ManualEntryInput {
  fullName: string; mobile?: string; session: SessionId | "both"; role: "player" | "spectator";
  source: "reclub" | "manual"; status: Exclude<RegistrationStatus, "rejected">; paymentMethod: PaymentMethod;
}
export interface PublicSession {
  id: SessionId; name: string; startsAt: string; capacity: number; reserved: number; available: number;
  playerPrice: number; spectatorPrice: number;
}
export interface Attendee { id: string; sessionId: SessionId; role: "player" | "spectator"; name: string }
export interface RegistrationSummary {
  id: string; status: RegistrationStatus; total: number; version: number; createdAtMs: number;
  sessions: Array<{sessionId: SessionId; players: number; spectators: number}>;
}
export interface RegistrationRow extends RegistrationSummary {
  fullName: string; mobile: string; source: "website" | "reclub" | "manual";
  paymentMethod: PaymentMethod; hasReceipt: boolean; updatedAtMs: number;
}
export interface RegisterResult extends RegistrationSummary { statusToken: string }
export interface StatusResult extends RegistrationSummary { attendees: Attendee[] }
export interface RegistrationPage { records: RegistrationRow[]; nextOffset: number | null }
export interface SetStatusInput {
  id: string; status: RegistrationStatus; expectedVersion: number; paymentMethod?: PaymentMethod;
}
export interface TableStatusInput { rowId: string; field: "status"; value: RegistrationStatus; expectedVersion: number }
export interface PaymentTotal {
  paymentMethod: PaymentMethod; verified: number; pending: number; rejected: number; dueAtVenue: number; total: number;
}
export interface AttendeeRow extends Attendee {
  registrationId: string; contactName: string; mobile: string; status: RegistrationStatus; reclubSynced: boolean;
}
export interface SetPlayerReclubInput { attendeeId: string; synced: boolean }
export interface AttendeePage { records: AttendeeRow[]; nextOffset: number | null }

// Context is supplied by the isolated operation host, never by request input.
export interface OperationContext {
  caller: {kind: "owner"; userId: string} |
    {kind: "named"; userId: string; grantId: string; access: "view" | "comment" | "edit"; helper: boolean} |
    {kind: "link"; principalId: string; grantId: string};
  db: {
    query(sql: string, parameters?: Array<string | number | null>): Array<Record<string, string | number | null>>;
    execute(sql: string, parameters?: Array<string | number | null>): {changes: number};
  };
  nowMs: number; requestId: string; secret: string;
  files: { attach(fileId: string): {fileId: string; name: string; contentType: string; byteLength: number; sha256: string} };
  refuse(code: string, message: string): never;
}
