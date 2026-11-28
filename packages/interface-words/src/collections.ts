// Words for a workspace's transactional Collections on the phone: Home's Collections, a Collection's records and one
// record. The desktop's where it has them (file named beside each); the rest are the phone's.
// Strings with names or counts are functions, so no app builds a sentence from pieces.

export const collectionWords = {
  collections: "Collections",
  collectionsFailed: (workspace: string) => `dohc could not read the Collections in ${workspace}.`,

  // CollectionPage.tsx
  collectionFailed: "dohc could not load this Collection.",
  // TransactionalCollectionPage.tsx
  recordsFailed: (table: string) => `dohc could not load ${table}.`,
  noRecords: "No records yet.",
  // A record with no name. RecordPanel.tsx and BoardView.tsx.
  untitledRecord: "Untitled",
  // CollectionResourceInputs.tsx, for a file whose name the server doesn't have.
  attachedFile: "Attached file",

  // A change to a record's field. transactionalWriteQueue.ts and TransactionalCollectionPage.tsx.
  notConfirmed: "dohc could not confirm this change.",
  refused: (reason: string) => `The Collection refused this change. ${reason}`,
  rulesChanged:
    "The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.",
  undoLastEdit: "Undo last edit",
  // TransactionalCollectionPage.tsx
  clearValue: "Clear value",
  newRecord: "New record",
  // DeleteCollectionRecordDialog.tsx's button; its title and body are the phone's.
  deleteRecord: "Delete record",
  deleteRecordTitle: "Delete this record?",
  deleteRecordBody: "This can't be undone.",

  // The phone's.
  /** A table whose Collection has no operation that reads it. */
  noRead: (table: string) => `Nothing in this Collection reads ${table}'s records.`,
  recordMissing: "dohc could not find this record. Go back and open it again.",
  checked: "Checked",
  notChecked: "Not checked",
  /** A record whose version the server answered as newer than the one the phone read. */
  recordChanged: "This record changed since this phone read it.",
  reload: "Reload",
  save: "Save",
  saving: "Saving",
  create: "Create",
  done: "Done",
  clear: "Clear",
  remove: "Remove",
  searchRecords: "Search",
  searchField: (name: string) => `Search ${name}`,
  clearSearch: "Clear search",
  noMatches: "No records match your search.",
  queryUnsupported: "This Collection does not support search or sort.",
  searchUnsupported: "This Collection does not support search.",
  sort: "Sort",
  sortBy: "Sort by",
  defaultOrder: "Default order",
  reverseOrder: "Reverse order",
  sortedBy: (field: string, ascending: boolean) =>
    `Sorted by ${field}, ${ascending ? "ascending" : "descending"}`,
  chooseRecord: "Choose record",
  chooseRecords: "Choose records",
  chooseDate: "Choose date",
  findFailed: (name: string) => `dohc could not find records for ${name}.`,
  enterField: (name: string) => `Enter ${name}.`,
  chooseField: (name: string) => `Choose ${name}.`,
  enterNumber: "Enter a number.",
  enterUrl: "Enter a web address.",
  tooManyRelations: "Choose up to 100 related records.",
  required: "Required",
  newCollection: "New Collection",
  collectionNamePlaceholder: "Collection name",
  collectionNameRequired: "Enter a Collection name.",
  invalidCollectionName: "That Collection name cannot be used here.",
  folderOccupied: "A folder or file with that name already exists.",
  recordExists: "A record with that name already exists.",
  couldntCreateCollection: "dohc could not create this Collection.",
  couldntCreateRecord: "dohc could not create this record.",
  recordName: "Title",
  recordNamePlaceholder: "Record name",
  recordNameRequired: "Enter a record name.",
  invalidRecordName: "That record name cannot be used here.",
  emptyProperty: "Empty",
  editPropertyFailed: "dohc could not update this property.",
  propertyRefused: "This property cannot be edited here.",
  boundedResults: (limit: number) => `Showing results from the first ${limit} records.`,
  creating: "Creating…",
  actionsFor: (name: string) => `Actions for ${name}`,
  title: "Title",
} as const;
