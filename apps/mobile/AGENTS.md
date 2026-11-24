# dohc phone app

Read this before changing anything a person sees in the phone app.

## Platform differences

The phone uses the desktop's words and behaviour, which the dohc-interface skill gives (`.agents/skills/dohc-interface/SKILL.md`).
Take shared words from `@dohc/interface-words`. Never copy them.
The phone differs from the desktop on purpose in these ways:

- Touch targets are at least 44 pt on iOS and 48 dp on Android (`src/touch.ts`), and Android controls ripple when pressed.
- Use the system's tab bar, navigation, large titles, sheets, and haptics on iOS, and Material's on Android.
- Body text is 17 pt, with Dynamic Type, in the system font.
- Use SF Symbols only where iOS draws the control. Use lucide for dohc's own content.
- A confirmation is an action sheet or a system alert, with the desktop's words. Delete, Forget, Leave, and Remove use the destructive style.
- Every swipe and long-press has a visible control that does the same thing.
- Toasts sit at the bottom, above the tab bar or the composer, with a visible ×.
- The composer docks to the keyboard.
- There are no tooltips.

If a phone word or behaviour differs from the desktop in another way, say why in the PR.
If a difference changes what another surface shows, get Ice's decision first.

## Screenshot comparisons

A page's last pixel row at the screen's bottom edge, under the home indicator, can differ by a third of a point from the approved frames.
Accept that difference. Look again only if it shows on another page or grows.

## Android

On Android a tab's stack draws dohc's own header above the screen (`src/AndroidHeader.tsx`): the system header lays a
nested stack's screen out under itself. `Stack.Toolbar` is iOS only, since Android's needs `@expo/ui` and shows no text
buttons; give Android the same actions as `headerRight` `HeaderButton`s. SF Symbols draw only on iOS, so a `SymbolView`
passes `symbolFallback` (`src/symbolFallback.tsx`), which maps the names in use to lucide icons. Android's web view may
inject `__dohcPage` after the editor's script runs; the editor starts when it arrives (`editor/page.ts`). On Android,
`choose` (`src/confirm.ts`) shows a menu of two or more choices in a Material bottom sheet (`src/ChoiceSheet.tsx`), and a
one-action confirmation in an `Alert`. Back closes what is open on a screen, such as the reaction picker or New post,
before it leaves the screen (`src/backCloses.ts`). `plugins/androidLaunchTheme.js` gives the splash, the window and
system dialogs dohc's colours.

On iOS the sync band on the sample's Notices and Sharing sits in a small native host (`modules/bar-band`), through
`src/notices/useSyncBandHost.tsx`. It tells iOS the band's strip is covered, keeps the band on the list's top edge but
never above the folded bar, has VoiceOver read the band before the list, and reports the space between the bar and the
tab bar. The band is at most half that space, and scrolls inside itself when its text is taller. Android doesn't have
the host. There the screen draws the band at the bar's reported height, the list keeps an empty first row of the
band's height, and the band has no height cap. The reading order and a focused row's place aren't handled, and the
band hasn't run on Android.

## Controls that act

The app shows its sample data only in a sample build: a development build, or one made with `EXPO_PUBLIC_DOHC_SAMPLE=1`, as the simulator tests are (`src/sampleBuild.ts`).
Any other build signs in to a server first (`src/account/Connect.tsx`), then reads the open workspace from it: Home, Chats, a chat and a page (`src/server/workspaceData.ts`). It reads and marks the account's Notices.
The tab bar has no Search tab until search is built.

Phone writes are off by default, so a signed-in build stays read-only (`src/server/phoneWrites.ts`). Off, the outbox sends nothing, not even records an earlier build kept.
Keep every write control behind `phoneWrites`: the composer, New post, Reply, reactions, a question's or poll's answers, Send and Discard on outbox messages and reactions, an app's Approve and Open, editing a page, a Collection record's field editors and Undo (`collectionEdit`, `src/collections/FieldEditor.tsx`), and a Collection's New record and Delete (`collectionCreate`, `collectionDelete`).
An app's Revoke is the one exception: an approval holds on every phone of the account, so every phone shows its way back (`src/apps/AppReview.tsx`).
An app runs in react-native-webview on iOS and in `modules/app-web-view` on Android, where react-native-webview lets a load through when JS answers late and saves downloads. The Android view decides in Kotlin and refuses by default; keep its rules in step with `src/apps/appNavigation.ts` and `src/apps/AppRunner.tsx`.
A build made with `EXPO_PUBLIC_DOHC_PHONE_WRITES=1` turns writes on.
Then a chat's stream and a thread have the composer, messages have Reply and reactions, questions and polls take answers, and Settings links to Messages on this phone (`src/conversation/OutboxRecovery.tsx`).
An answer is a reply with `resolves`, placed as the desktop's chat places it (`src/conversation/decisionAnswers.ts`). Any other reply never carries `resolves`.
A sample build always shows the composer, over an outbox in memory that reaches no server.
Controls never call `sendWrite`. They enqueue through the outbox, through `src/conversation/conversationWrites.ts`.

- An installable build never presents sample data as someone's work, and its bundle holds none. Import a sample module (`sample.ts`, or a screen in `Sample*.tsx`) elsewhere only as a type, or require it behind the exact test `src/sampleBuild.ts` gives.
- A sample build may keep a control the server will drive later.
- A link can open any route. Export build-specific screens through `sampleOnly` or `signedInOnly` (`src/sampleOnly.tsx`). `src/routes.test.ts` checks this and rejects other sample-module imports.
- `src/notices/rowAccessibility.test.ts` holds that each action a Notices row offers has a handler.

## Server reads

The server client is in `src/server`. Its files hold how each part works.

- Check `SignIn.isCurrent()` before applying anything a request answered. A sign-in's generation changes at sign-out, at a 401 and when another sign-in starts, and the change aborts that sign-in's requests (`src/server/account.ts`).
- Use `requestGenerations()` for results that replace each other (`src/server/client.ts`).
- A page edited live opens with `openPage`, then its owner socket, which only the server client opens, so the token stays there. The page's one-use ticket goes only into the socket's protocols. The web view runs the provider and sees neither (`src/pages/pageLive.ts`, `src/pages/liveBridge.ts`).
- A Collection record's field changes live in memory in its Collections store, one per record, sent while the app runs and never through the outbox. Try again sends a change with its own key and stamp (`src/collections/collectionStore.ts`).
- The open workspace's reads live in one store per sign-in and workspace. The store stops when either changes, so a late answer can't reach another workspace's screen (`src/server/workspaceData.ts`).
- The phone opens only workspaces the list marks `canOpen`. A 404 for the open workspace clears and stops its store, and the phone reads its workspace list again (`src/server/openWorkspace.ts`).
- The read cache keeps a copy in cache.db, in Caches, so a relaunch opens the last workspace before the server answers. `src/server/cacheRows.ts` and the `ReadCache` in `src/server/workspaceData.ts` hold when it writes and deletes its rows. Every change of sign-in deletes cache.db. Its writes have their own connection and queue, so a cache save never delays a Send.
- Raise `CACHE_FORMAT` when a cache table or a view's value changes shape: cache.db of another format, or a damaged one, is deleted and starts empty.
- The account's Notices live in one store per sign-in, beside the workspace list, not in the open workspace's (`src/server/noticeStore.ts`). It reads the whole list again at each start, return from the background, refresh, and change to which workspaces show on the phone. Its list and waiting marks are kept.db rows. A mark shows and sends only once its row commits, and a mark the server took leaves kept.db in the same commit as the list it changed. Marks wait through a 401 for their own account; every change of sign-in deletes the list.
- Sign out waits for the server. Its session ends there, with its alerts, before its token leaves the keychain. Its pending mark commits in the account's `push_registrations` row before anything else, or, for a damaged kept.db the person agreed to delete, just after the delete: the token stays, no sign-in starts, and a relaunch tries again. A launch that can't read the row doesn't sign in, and offers that delete when kept.db is damaged. A token dropped without Sign out, as a superseded sign-in's, is deleted first, then its session revoked (`src/server/account.ts`).
- Alerts are iOS only, through expo-notifications with the APNs device token, never Expo's push service. The person turns them on in Settings, which asks the system then. A tap reads the workspace list from the server first, gives it to the workspace list store, and opens its message only when its binding generation matches the sign-in's row and the workspace shows on the phone; otherwise Home. Offline, it waits with Try again (`src/push/AlertTaps.tsx`).
- Work the phone must not lose lives in kept.db, one SQLite file per install, never per sign-in, with each row's server and account (`src/server/keptStore.ts`). Run every statement through its one connection and queue, and write only through `transaction`, never expo-sqlite's transaction helpers: the exclusive one opens a connection without the durability settings. The `durable-file` module only prepares its folder: excluded from backup, and on iOS closed until the first unlock. Never replace a damaged kept.db; only the person deletes it, after a warning. Tests run real SQL on Node's `node:sqlite` (`src/server/testKeptDisk.ts`).
- The outbox keeps the phone's chat writes in kept.db until the server saves them and a read shows them. Only the composer, reactions and answers add to it, while phone writes are on. A record is inserted withheld, and becomes sendable only through a second commit made after the insert's commit returned; enqueue says it kept the message only once that second commit returns. If that commit fails, the record stays withheld this run, with Send and Discard, but the failed commit may still stand, so a relaunch may send it; its row says so (`maySendOnReopen`). It sends a record only with a sign-in for the record's own server and account, one at a time per thread or stream, in order, and repeats the same operation ID until the write is saved or refused. A 401 keeps every record (`src/server/outbox.ts`).
- `discard` deletes one record the person chooses. It withholds a record that may still send before deleting it, and refuses one a waiting reply needs (`src/server/outbox.ts`).
- Only Sign out deletes an account's outbox rows and Notice marks, through `onSignOut`: sending stops, the rows of the account last signed in go in one commit (`deleteAccountRows`), nothing else writes to kept.db until it ends (`holding`), a TRUNCATE checkpoint empties the WAL of their text, then the account ends the sign-in and deletes its token. If the commit fails, Sign out fails and a phone still signed in stays signed in with its token. Until a Sign out finishes, the outbox holds in memory: nothing sends and nothing is added, and Connect shows a failure that a 401 left behind, with Try again, which signs out again and deletes the rows of every account whose Sign out failed, whoever signed in since. A relaunch loses that hold (`src/server/outbox.ts`, `src/server/account.ts`).

## Copy

`src/copy.ts` uses React Native's core `Clipboard`, which React Native marks deprecated.
Before an upgrade removes it, switch `src/copy.ts` to expo-clipboard.
