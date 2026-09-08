# Marketing site

Use this guidance when changing the marketing site or its product demos.
The [root product commitments](../../AGENTS.md#product-commitments) also apply.

## Explain the product through the work

- Show how people and their agents use the same files, documents, data, chat, and apps.
- Explain what sync, sharing, permissions, and history add to that work. Verify relationships shown in diagrams against concrete user actions.
- Check availability claims against the implementation. Distinguish demonstrations and planned capabilities from available product behavior.
- Use the offering names in [CONTEXT.md](../../CONTEXT.md). Verify availability and pricing before publishing either.
- Use actual product components for interactive product behavior where practical. Keep illustrative scenes distinguishable from the working demo.

## Compose each section for its content

- Choose each section's composition from what the reader needs to understand.
- Give comparisons and device arrangements enough room. Maintain a consistent rhythm without repeating one layout throughout the page.
- Check section spacing, text wrapping, visual proportions, and alignment at desktop and phone widths.
- Preserve the established content and approved behavior unless the task changes them.
- For a broad visual direction, develop one representative section before extending the treatment across the page.
- Preserve a recoverable comparison so the user can assess the direction without losing the approved version.

## Express precision through craft

Use consistent materials, proportions, alignment, lighting, and responsive motion.
Use metallic depth selectively where it supports the content or interaction.
The engine and machined switch establish the site's material treatment; product demos should remain recognizable as dohc.

- Reuse the font, color, material, and motion tokens in [styles.css](styles.css).
- Preserve the material identity in light and dark themes.
- Make controls respond immediately to input. Match animated movement to the object's form and intended interaction.
- Keep decoration subordinate to legibility and usable controls.
- Keep this marketing treatment scoped to the site. Follow the desktop's interface guidance for desktop components.

## Verify the complete experience

- Inspect affected sections in the browser, including desktop, narrow desktop, and phone layouts.
- Check both themes, keyboard access, reduced motion, and the changed interactions.
- For async visuals, inspect first load, loading-to-live transitions, and failure fallback.
- Keep preview and live views consistent in pose, framing, perspective, and lighting.
- Preserve useful content while optional visuals load or fail. Pause animation when it is offscreen or the document is hidden.
- Measure startup and interaction when changing rendering or loading. Inspect the experience alongside any automated performance score.
- Run the site's focused tests, typecheck, and production build when the changed code affects them.

Use the root [verification policy](../../AGENTS.md#verification) for PR gates.
Focused site checks do not replace a selected full gate.
