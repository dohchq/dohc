---
name: dohc-interface
description: >-
  Use when writing or changing anything a person sees in the dohc desktop app or phone app: a label, button, menu item, error, empty state, toast, dialog, or panel. Also use when choosing a token, class recipe, or control in the renderer.
---

# dohc's interface

Write in plain and simple language.
A person reads these words in the middle of a task, sometimes worried, and cannot ask what they mean.

Read the code for values and this skill for meaning.

## Read the part your task needs

This file holds the rules for every surface. The parts sit beside it.
Before you start, read each part whose row matches your task.

| Before you | Read |
| --- | --- |
| Write or change any label, button text, menu item, error, empty state, agent status, explanation, or the words of a delete | [`words.md`](words.md) |
| Build or change a dialog, its title, body or buttons, a form, a field, or a message box from main | [`dialogs.md`](dialogs.md) |
| Add or change a toast, a Notices row, **Details**, a copy control, or the line a failed list shows | [`messages.md`](messages.md) |
| Choose a control, token, type size, radius, spacing, class recipe, focus mark, avatar, or motion | [`controls.md`](controls.md) |
| Change anything a person sees in the phone app (`apps/mobile`) | [`phone.md`](phone.md), and each part above that matches the change |

## Show first

Before reading a word, a person should see what a surface is, its state, and what to do next.
Use words only for the person's own content and for facts a picture cannot show, such as an error's cause.

To test a surface, hide every word that is not the person's own content.
If the purpose, state, or next click disappears, show it with an icon, position, shape, or color.
Who can reach the work is a fact a picture can't show. A share row says it in words: `sam@ridge.co can edit`, `1 person can edit, 2 can view`, `Anyone with the link can view`.

| Instead of | Show |
| --- | --- |
| A type label (`DOCUMENT`) | The file's icon |
| A panel title that repeats the active rail icon | The rail's active mark |
| The same status twice (`Local · saved`, then `Saved`) | One mark in one place |
| A helper sentence under a control | A live preview of its effect, or a tooltip |
| A scope tag on every row | One group heading per scope |
| Prose about what changed | A number, a bar, or the changed words highlighted |
| A label saying who is an agent | The agent's square avatar |

Some meaning still needs words or its own mark:

- Every icon-only control keeps an accessible name and a tooltip.
- Distinct states keep distinct marks. Saved on this machine, accepted by the host, and waiting to share are three states.
- An error keeps its sentence. The icon marks it, and the words explain it.
- Color always comes with a shape, an icon, or a position, so the meaning survives grayscale and color blindness.
- Use the lucide icon people already know for the action.

## Words

Use as few words as possible in anything a person sees without a hover or a click.
Put further detail behind a tooltip, a **Details** disclosure, or a **Learn more** link.
Link **Learn more** only to a page that exists.
Keep an error and its next step in view.

Say what is true, what changed, and what to do next, in that order.

- Call a thing what the surrounding UI calls it, every time. Never show an internal name. Check both the code and the shipping UI, because they often differ.
- Keep the words literal. Leave out metaphors, jokes, irony, exclamation marks, and emoji.
- Use sentence case: `New folder`.
- Leave the period off labels, buttons, and fragments. Full sentences keep theirs.

## Where messages go

| Situation | Where it goes |
| --- | --- |
| The whole workspace is unusable | A full-height state over the workbench, which goes inert |
| One thing failed, and the workspace still works | A toast at the bottom right, then a row in Notices until it is retried or dismissed |
| An update is available or downloaded | The Update button at the top right of the title bar. No toast and no row |
| Something finished out of sight, such as a background job | A toast at the bottom right that fades, and a row in Notices |
| An action whose result the person can see | No toast and no row |
| A control's own input is wrong | Inline, beside the control |

Use these places. Do not add a new one for a new message.

## Hard rules

- End-to-end tests pin every `data-testid`, `aria-*`, `role`, and accessible name. Rewording and restyling keep them. A surface can become something else, such as the right panel changing from Chats to About. Then change them in the same PR as the tests that read them.
- Surface work adds no dependencies, no `any`, and no `styles.css` edits. Propose a new shared pattern instead of inlining it.
- Use lucide-react icons only, at 12 to 18px, with `strokeWidth={1.9}` at rail size.
- Keep the global halo and `dohc-focus-row`, and draw no focus ring of your own. Add `outline-none` only where the part shows focus another way, and name that way in a comment. The command palette's frame shows it with `focus-within:border-ink`, and a menu row with its fill, plus its line beside a current row. A dialog's panel never wears the halo: it holds focus only until Tab reaches its controls, which show their own.
- Keep body text at 4.5:1 or more and decorative text at 3:1 or more against its surface. Keep every focus mark at 3:1 or more against the surface under it.

## Before you finish

1. Is the surface's one job obvious, and does it carry the most visual weight?
2. Does every border earn its place? Prefer space and background steps to boxes inside boxes.
3. Are hover, active, focus-visible, disabled, empty, loading, and error states all there?
   Loading: the header shows at once. The skeleton under it stays blank for its first 150 ms, so a fast read never flashes, then stays until the answer comes, with no deadline. Only an error answer shows Try again.
4. Is every visible string as short as it can be, with further detail behind a hover or a click?
5. Does each string do one job, does every error give a Next, and does every empty state give one when the person can act there?
6. Does every noun match the surrounding UI?
7. Read each string as someone whose sync just failed. Does it help them?
8. Would Notion or Linear ship it? If not, it is not done.
