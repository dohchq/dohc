# Lightbox

Lightbox is a photo proofing studio. A photographer uploads a shoot, rates and labels the frames, and publishes the ones the client should see.
The client opens a gallery with a code, hearts their favorites up to a limit, and pins notes on the exact spot in a photo they want changed.
It is an ordinary workspace app. Every rule lives in the files in this folder, and you can change any of them.

## Try it

Copy this folder into a workspace as `lightbox`.
Publish `lightbox` locally to open the studio from [app.publish.json](app.publish.json). Approve the Lightbox proofing Collection when dohc asks.
Publish `lightbox/portal` to open the client gallery from [portal/app.publish.json](portal/app.publish.json), then share ONLY the `lightbox/portal` folder with a link.
Every frontend file the client portal needs lives inside `lightbox/portal`, keeping `lightbox/proofing` (including `schema.sql`'s seeded rates, codes, and drafts) and `lightbox/studio.tsx` outside the shared link.

The sample shoot "Golden hour in Positano" opens with code `GOLD-HOUR-2026`.
Its photos are drawn in the browser from short recipes, so the example ships no image files.
**Add sample photo** renders a 2400 × 1600 JPEG and uploads it like a real photo.

Keys in the studio grid: arrows move, Enter opens, 1–5 rate, 0 clears the rating, Space publishes or hides, 6–9 set a red, yellow, green, or blue label.
In the client gallery, Space hearts a photo.
In the viewer, arrows move, C compares two photos side by side, N pins a note in the center, and Esc closes.

## Who can do what

[proofing/dataset.json](proofing/dataset.json) declares one Collection with four tables: `shoots`, `assets`, `selections`, and `annotations`.
[proofing/schema.sql](proofing/schema.sql) seeds the sample shoot.
[proofing/operations.js](proofing/operations.js) holds every rule. Collections have no SQL views, so gallery and shoot totals are computed in read operations.

Link callers can use five operations, and each one requires the gallery code:

- `listPublishedAssets` lists published photos, with the caller's own picks.
- `assetFileAccess` grants one published photo's file.
- `listAnnotations` lists a published photo's notes.
- `toggleClientPick` picks or unpicks a photo.
- `addPinnedAnnotation` pins a note. Its position must be between 0 and 100 percent, and the note can be at most 1,000 characters.

A gallery is visible only while the shoot is in proofing or delivered. Picks and notes are accepted only during proofing.
Link operations never select a shoot's rate, its code, owner ratings, color labels, or draft photos.
Every other operation is owner only, both in the Collection declaration and inside the operation.

`toggleClientPick` checks the selection limit and writes the pick in one SQL statement, so two picks sent at once cannot pass the limit together.
Each link principal picks separately. The studio shows how many people picked each photo.

`uploadAsset` attaches a file that was uploaded first. It accepts JPEG, PNG, and WebP files up to 5 MiB, and a refused file is not kept.
New photos start as drafts. `publishAsset` shows or hides up to 100 photos at once.

## Larger photos

Today an app sends each upload as base64 in one request, which caps a photo at 5 MiB.
`checkPhoto`, `uploadPhoto`, and `photoFileUrl` in [portal/api.ts](portal/api.ts) are the only code that knows how a file travels.
`UPLOAD_LIMIT_BYTES` and `UPLOAD_BYTES` in the operations are the only limits.
When dohc gains a streaming transport, change those helpers and limits. The rest of the app stays the same.

## Tests

`packages/app-backend-runtime/src/lightbox-example.test.ts` runs the operations against a real database.
It checks that link callers never see drafts or private fields, that the pick limit holds under concurrent picks, that pin positions and notes are checked, that link callers cannot run owner operations, and that photo files are granted only while published.
`apps/desktop/src/workspaces/lightboxExample.test.ts` stages and approves both apps the way the desktop app does, uploads a photo, and reads it through each app.
