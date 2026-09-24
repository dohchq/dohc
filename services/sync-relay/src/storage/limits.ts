import {
  SHARE_DISCUSSION_BODY_CODE_POINT_LIMIT,
  SHARE_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
  SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT,
  SHARE_DISCUSSION_NAME_BYTE_LIMIT,
} from "@dohc/security-contract/share-discussion";

export const SHARED_BLOB_CANDIDATE_LIMIT = 64;

export const LINK_INVENTORY_PAGE_SIZE = 1_000;
export const LINK_INVENTORY_INDEPENDENT_GRANT_LIMIT = 1_000;

export const SYNC_RELAY_BUSY_TIMEOUT_MS = 5_000;
export const DEFAULT_WORKSPACE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const LINK_DISCUSSION_BODY_CODE_POINT_LIMIT =
  SHARE_DISCUSSION_BODY_CODE_POINT_LIMIT;
export const LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT =
  SHARE_DISCUSSION_BODY_INPUT_BYTE_LIMIT;
export const LINK_DISCUSSION_NAME_CODE_POINT_LIMIT =
  SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT;
export const LINK_DISCUSSION_NAME_BYTE_LIMIT = SHARE_DISCUSSION_NAME_BYTE_LIMIT;
export const LINK_DISCUSSION_IDEMPOTENCY_KEY_LIMIT = 64;
export const LINK_DISCUSSION_PRINCIPAL_LIMIT = 100;
export const DISCUSSION_MESSAGE_RATE_LIMIT = 10;
export const DISCUSSION_MESSAGE_RATE_WINDOW_MS = 60_000;
export const DISCUSSION_LIFETIME_MESSAGE_LIMIT = 500;
export const DISCUSSION_NON_OWNER_SHARE_ROW_LIMIT = 5_000;
export const LINK_DISCUSSION_PAGE_LIMIT = 100;
// Share creation accepts account ids up to 256 characters. Reserve the
// four-byte UTF-8 worst case so a later owner tombstone never grows quota.
export const LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT = 1_024;
const LINK_DISCUSSION_SQLITE_INTEGER_BYTES = 8;
export const LINK_DISCUSSION_MESSAGE_FIXED_STORAGE_BYTES =
  LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT +
  4 * LINK_DISCUSSION_SQLITE_INTEGER_BYTES;
export const LINK_DISCUSSION_PRINCIPAL_FIXED_STORAGE_BYTES =
  LINK_DISCUSSION_NAME_BYTE_LIMIT + 5 * LINK_DISCUSSION_SQLITE_INTEGER_BYTES;
export const MAX_DISCUSSION_REVISION = Number.MAX_SAFE_INTEGER;
// Retention grace for freshly-uploaded blobs (0P sync-hardening item 4). Blob
// upload is two-phase (PUT /blobs/:sha, then POST /log referencing it); GC that
// runs between the two must not reclaim the blob just because no log row
// references it yet. Any blob younger than this window is untouchable. Ten
// minutes comfortably covers a slow/retried push.
export const DEFAULT_BLOB_GRACE_MS = 10 * 60 * 1000;
export const RETIRED_LINK_CREDENTIAL_HISTORY_LIMIT = 10;
export const ACTIVE_LINK_DEPENDENT_GRANT_LIMIT = 1_000;

// A person's notice list keeps at most this many rows. A new notice past it
// removes read and dismissed rows first, oldest first, then the oldest unread.
export const NOTICE_LIST_ROW_LIMIT = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// How long a row stays after it arrives unread, after it is read, and after
// it is dismissed. A dismissed row stays as a tombstone so a computer that
// was away still learns of the dismissal.
export const NOTICE_UNREAD_RETENTION_MS = 180 * DAY_MS;
export const NOTICE_READ_RETENTION_MS = 90 * DAY_MS;
export const NOTICE_DISMISSED_RETENTION_MS = 30 * DAY_MS;
// Expired rows each post removes from every list, oldest first.
export const NOTICE_SWEEP_BATCH = 100;
