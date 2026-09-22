export const FORM_CSS = `
:root { color-scheme: light dark; --bg: #faf9f5; --panel: #f3f1ea; --ink: #1c1b18; --muted: #55524a; --line: #e4e1d8; --accent: #2d342e; --danger: #a6402c; }
@media (prefers-color-scheme: dark) { :root { --bg: #131211; --panel: #1b1d1a; --ink: #f6f4ee; --muted: #a9a599; --line: #2a2925; --accent: #d7d0c0; --danger: #e08065; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
main { width: min(100%, 580px); margin: 0 auto; padding: 48px 24px; }
h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; letter-spacing: -.025em; overflow-wrap: anywhere; }
.intro { color: var(--muted); margin: 0 0 32px; font-size: 14px; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.field { margin: 0 0 24px; }
label { display: block; margin-bottom: 8px; font-weight: 500; overflow-wrap: anywhere; }
input, select { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); font: inherit; }
input::placeholder { color: var(--muted); }
.check-field { display: grid; grid-template-columns: 24px 1fr; column-gap: 12px; align-items: start; }
.check-field input { width: 20px; min-height: 20px; height: 20px; margin: 2px 0 0; accent-color: var(--accent); }
.check-field label { margin: 0; }
.check-field .field-error { grid-column: 2; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
:disabled { opacity: .65; cursor: not-allowed; }
button { min-height: 44px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: var(--bg); padding: 10px 20px; font: inherit; font-weight: 500; cursor: pointer; }
button:hover:not(:disabled) { opacity: .9; }
button:active:not(:disabled) { opacity: .8; }
.status { color: var(--muted); margin: 20px 0; overflow-wrap: anywhere; }
.status:empty { margin: 0; }
.field-error { color: var(--danger); font-size: 14px; margin: 8px 0 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 400px) { main { padding: 32px 20px; } button { width: 100%; } }
`;
