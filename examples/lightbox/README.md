# Lightbox

Lightbox is a photo proofing studio. A photographer uploads a shoot, rates and labels the frames, and publishes the ones the client should see.
The client opens a gallery with a code, hearts their favorites up to a limit, and pins notes on the exact spot in a photo they want changed.
It is an ordinary workspace app. Every rule lives in the files in this folder, and you can change any of them.

## Try it

Copy this folder into a workspace as `lightbox`.
Publish `lightbox` locally to open the studio from [app.publish.json](app.publish.json). Approve the Lightbox proofing Collection when dohc asks.
Publish `lightbox/portal` to open the client gallery from [portal/app.publish.json](portal/app.publish.json), then share ONLY the `lightbox/portal` folder with a link.
Every frontend file the client portal needs lives inside `lightbox/portal`. The studio files and `lightbox/proofing`, including `schema.sql`'s seeded rates, codes, and drafts, stay outside the shared link.

The sample shoot "Golden hour in Positano" opens with code `GOLD-HOUR-2026`.
Its photos are drawn in the browser from short recipes, so the example ships no image files.
The image button next to **Upload** renders a 2400 × 1600 JPEG and uploads it like a real photo. You can also drop photos anywhere on the studio.

## The studio

The studio works like a darkroom library. The left rail holds the navigator, shoots, library filters, and the client gallery settings. The right rail holds the histogram, the photo's rating, label, and publish switch, and the client's pinned notes.

- **Grid (G)** shows every frame with its rating, label, client picks, and open notes. The slider at the bottom sets the thumbnail size.
- **Loupe (E)** shows one photo with a filmstrip. Click to zoom to that spot, drag to pan, and press Z or Space to go back to fit.
- **Compare (C)** puts the select next to a candidate. X swaps them, and ↑ makes the candidate the select.

Keys anywhere in the studio: arrows move, Home and End jump, 1 to 5 rate, 0 clears the rating, 6 to 9 set a red, yellow, green, or blue label, P publishes or hides, N pins a note, and ? lists every shortcut.
**Final picks** lists the favorites each client sent as file names for Lightroom or Capture One, and downloads them as CSV. Hearts a client has not sent yet show under **Client picks** but stay out of this list.

## The client gallery

The gallery opens on a cover photo, then shows every published photo on a justified wall. The tabs show all photos, favorites, or annotated photos, and Compare lets the client choose two photos to see side by side.
In the gallery, Space or H hearts a photo. In the viewer, arrows move, click pins a note on that spot, N pins one in the center, C compares, I shows or hides notes, D downloads the photo once the gallery is delivered, and Esc closes.

## Who can do what

[proofing/dataset.json](proofing/dataset.json) declares one Collection with six tables: `shoots`, `assets`, `selections`, `submissions`, `annotations`, and `deleted_annotations`, which keeps each link's 20 most recently deleted notes so they can be restored.
[proofing/schema.sql](proofing/schema.sql) seeds the sample shoot.
[proofing/operations.js](proofing/operations.js) holds every rule. Collections have no SQL views, so gallery and shoot totals are computed in read operations.

Link callers can use nine operations, and each one requires the gallery code:

- `listPublishedAssets` lists published photos, with the caller's own picks.
- `assetFileAccess` grants one published photo's file. Once the shoot is delivered, the viewer offers it as a download.
- `listAnnotations` lists a published photo's notes.
- `toggleClientPick` picks or unpicks a photo.
- `submitSelection` sends the caller's favorites to the photographer. The studio counts the reviewers who sent theirs, and a later pick marks the sent favorites as changed.
- `addPinnedAnnotation` pins a note. Its position must be between 0 and 100 percent, and the note can be at most 1,000 characters.
- `updateOwnNote` edits a note the same link pinned.
- `deleteOwnNote` deletes a note the same link pinned.
- `restoreOwnNote` brings back one of that link's 20 most recently deleted notes.

A gallery is visible only while the shoot is in proofing or delivered. Picks and notes are accepted only during proofing.
Link operations never select a shoot's rate, its code, owner ratings, color labels, or draft photos.
Every other operation is owner only, both in the Collection declaration and inside the operation.

`toggleClientPick` checks the selection limit and writes the pick in one SQL statement, so two picks sent at once cannot pass the limit together.
Each link principal picks separately. The studio shows how many people picked each photo.

`uploadAsset` attaches a file that was uploaded first. It accepts JPEG, PNG, and WebP files up to 20 MiB, and a refused file is not kept.
It also needs a JPEG preview of at most 1 MiB, uploaded as its own file. The studio draws it at 2048 px or smaller, which also drops the original's metadata.
Clients see only previews until the shoot is delivered. `assetFileAccess` refuses the original with `not_delivered` before then.
The studio reads the camera, lens, ISO, aperture, shutter speed, and focal length from a JPEG's EXIF data in [camera.ts](camera.ts) and sends them as `capture`. The inspector shows them under the file facts.
New photos start as drafts. `publishAsset` shows or hides up to 100 photos at once.

## Larger photos

An app sends each upload and download as one binary buffer, which caps a photo at 20 MiB.
`checkPhoto`, `uploadPhoto`, and `photoFileUrl` in [portal/api.ts](portal/api.ts) are the only code that knows how a file travels.
`UPLOAD_LIMIT_BYTES` and `UPLOAD_BYTES` in the operations are the only limits.
When dohc gains a streaming transport, change those helpers and limits. The rest of the app stays the same.

## Tests

`packages/app-backend-runtime/src/lightbox-example.test.ts` runs the operations against a real database.
It checks that link callers never see drafts or private fields, that the pick limit holds under concurrent picks, that pin positions and notes are checked, that link callers cannot run owner operations, and that photo files are granted only while published.
`apps/desktop/src/workspaces/lightboxExample.test.ts` stages and approves both apps the way the desktop app does, uploads a photo, and reads it through each app.
