// Words for a workspace's transactional Collections on the phone: Home's Collections, a Collection's records and one
// record. The desktop's where it has them (file named beside each); the rest are the phone's.
// Strings with names or counts are functions, so no app builds a sentence from pieces.

export const collectionWords = {
  collections: "Collections",
  collectionsFailed: (workspace: string) => `dohc could not read the Collections in ${workspace}.`,

  // CollectionPage.tsx
  collectionFailed: "dohc could not load this collection.",
  // TransactionalCollectionPage.tsx
  recordsFailed: (table: string) => `dohc could not load ${table}.`,
  noRecords: "No records yet.",
  // CollectionResourceInputs.tsx, for a file whose name the server doesn't have.
  attachedFile: "Attached file",

  // The phone's.
  /** A table whose Collection has no operation that reads it. */
  noRead: (table: string) => `Nothing in this Collection reads ${table}'s records.`,
  recordMissing: "dohc could not find this record. Go back and open it again.",
  checked: "Checked",
  notChecked: "Not checked",
} as const;
