// Frontend copies of the operation types in ./types.ts. The backend owns the originals.
export type SessionId = "s1" | "s2";
export type RegistrationStatus = "pending_verification" | "verified" | "rejected" | "pay_at_venue";
export type PaymentMethod = "gcash" | "bdo" | "unionbank" | "bpi" | "cash";
export type OnlinePaymentMethod = Exclude<PaymentMethod, "cash">;
export type Role = "player" | "spectator";
export type Source = "website" | "reclub" | "manual";

export interface RosterInput { sessionId: SessionId; players: string[]; spectators: string[] }
export interface RegisterInput {
  submissionId: string; retrySecret: string; receiptSha256: string;
  fullName: string; mobile: string; sessions: RosterInput[];
  paymentMethod: OnlinePaymentMethod; receiptFileId: string;
}
export interface ManualEntryInput {
  fullName: string; mobile?: string; session: SessionId | "both"; role: Role;
  source: "reclub" | "manual"; status: Exclude<RegistrationStatus, "rejected">; paymentMethod: PaymentMethod;
}
export interface PublicSession {
  id: SessionId; name: string; startsAt: string; capacity: number; reserved: number; available: number;
  playerPrice: number; spectatorPrice: number;
}
export interface Attendee { id: string; sessionId: SessionId; role: Role; name: string }
export interface RegistrationSummary {
  id: string; status: RegistrationStatus; total: number; version: number; createdAtMs: number;
  sessions: Array<{ sessionId: SessionId; players: number; spectators: number }>;
}
export interface RegistrationRow extends RegistrationSummary {
  fullName: string; mobile: string; source: Source;
  paymentMethod: PaymentMethod; hasReceipt: boolean; updatedAtMs: number;
}
export interface RegisterResult extends RegistrationSummary { statusToken: string }
export interface StatusResult extends RegistrationSummary { attendees: Attendee[] }
export interface RegistrationPage { records: RegistrationRow[]; nextOffset: number | null }
export interface ListRegistrationsInput { status?: RegistrationStatus | "all"; search?: string; offset?: number; limit?: number }
export interface SetStatusInput { id: string; status: RegistrationStatus; expectedVersion: number; paymentMethod?: PaymentMethod }
export interface PaymentTotal {
  paymentMethod: PaymentMethod; verified: number; pending: number; rejected: number; dueAtVenue: number; total: number;
}
export interface AttendeeRow extends Attendee { registrationId: string; contactName: string; mobile: string; status: RegistrationStatus }
export interface AttendeePage { records: AttendeeRow[]; nextOffset: number | null }
export interface AttendeesInput { sessionId?: SessionId; status?: RegistrationStatus; offset?: number; limit?: number }

// Broker envelopes. The host adds identity and authority; the app never sends them.
export interface BackendFile { fileId: string; name: string; contentType: string; byteLength: number; sha256: string }
export interface InvokeReply<T> { result: T; revision: number; replayed: boolean }
export interface UploadReply { file: BackendFile; replayed: boolean }
export interface FileReply { file: BackendFile; bytesBase64: string }
