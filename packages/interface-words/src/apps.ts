// Words for a workspace's published apps on the phone: Home's Apps, an app's review and its runner. The phone's, except
// where a desktop file is named. Strings with names or counts are functions, so no app builds a sentence from pieces.

export const appWords = {
  apps: "Apps",
  noApps: "No published apps yet.",
  appsFailed: (workspace: string) => `dohc could not read the apps in ${workspace}.`,
  approved: "Approved",
  /** A version, by its source revision's first characters. */
  version: (version: string) => `Version ${version}`,
  published: (version: string, when: string) => `Version ${version}, published ${when}`,

  review: "Review app",
  reviewFailed: "dohc could not read this app.",
  // OwnerAppPublication.tsx says "Approved on this device"; a phone's approval holds on every phone of the account.
  approvedOnPhones: "Approved on your phones",
  approveToOpen: "Approve it to open this version on your phones.",
  notApproved: "Not approved",
  cantOpenHere: "This app can't be opened on this phone yet.",
  approve: "Approve",
  open: "Open",
  revoke: "Revoke",
  revokeTitle: (app: string) => `Revoke ${app}?`,
  revokeBody: "It closes on every phone, and needs approval again to open.",
  publishedBy: (agent: string) => `Published by ${agent}`,
  publishedByAgent: "Published by an agent",

  // A Member app: one a workspace member shared. Its review uses share-web's words (NamedApp.tsx).
  sharedBy: (person: string) => `Made by ${person}`,
  sharedByMember: "Made by a workspace member",
  /** A Member app that now reaches more than the person allowed. */
  updated: "Updated, review changes",
  toReview: "Review",
  memberNote:
    "A workspace member made this app. It can only do what both of you can do, and only in these Collections.",
  reviewToOpen: "Review what it can do before you open it.",
  changedToOpen: "This app changed. Review it again before you open it.",
  allowedEverywhere: "Allowed for your account",
  allowAndOpen: "Allow and open",
  allowFailed: "dohc could not allow this app.",
  /** A Collection's level for this app, from sharingWords.level. */
  access: (level: string) => `${level} access`,
  // Revoking a Member app also withdraws the person's allowing, which holds on every device.
  memberRevokeBody:
    "It closes on your phones, computers and in the browser, and needs your review again to open.",

  reach: "What it can reach",
  /** An app that requests nothing in the workspace. It may still reach other websites. */
  reachesNothing: "Nothing in this workspace.",
  readsRecords: "Reads records",
  changesRecords: "Can change records",
  fields: (names: string) => `Fields: ${names}`,
  sendsElsewhere: "An app can send what it reads, and what you enter in it, to other websites.",

  source: "Source",
  sourceNote: "The source this version was published from. It doesn't prove what runs.",
  sourceUnavailable: "This version's source isn't available.",
  sourceFailed: "dohc could not read this file.",

  changed: "This app changed. Review it again.",
  approveFailed: "dohc could not approve this app.",
  revokeFailed: "dohc could not revoke this app.",
  openFailed: "dohc could not open this app.",
  // Its web process died, from a crash or the phone running short of memory.
  stopped: "This app stopped.",

  // A link the person tapped in an app, before it leaves dohc. The message is the link's host.
  // Android may hand the link to an installed app that owns the site, as Chrome does.
  openOutside: { ios: "Open in Safari?", android: "Open link?" },
} as const;
