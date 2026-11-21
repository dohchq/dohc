export const DEMO_WORKSPACE_NAME = "Lisbon trip";

export const APP_ROOT = "trip-planner";
export const APP_ENTRY = `${APP_ROOT}/index.html`;
export const APP_TITLE = "Trip planner";

export type DemoPage = { path: string; markdown: string };

export const DEMO_PAGES: readonly DemoPage[] = [
  {
    path: "Trip plan.md",
    markdown: `---
title: Trip plan
icon: 🧳
---
Five friends, four days in Portugal. The plan, the guest list, a small app, and the chat about them all live in this workspace.

> [!tip] Try it
> - Open **Trip planner** under Apps. It's a web app whose source is in this workspace.
> - Open **Guests** under Collections and give Mei a room.
> - Type **/** on an empty line for commands, or **[[** to link a page.

## Days

Old town on [[Day 1 - Lisbon]], palaces on [[Day 2 - Sintra]], and the river on [[Day 3 - Belém]].

## Still to do

- [x] Book the Alfama flat
- [ ] Book the Sintra cottage for the 15th
- [ ] Ask Mei which day she lands
- [ ] Settle the deposits in [[Budget]]
`,
  },
  {
    path: "Days/Day 1 - Lisbon.md",
    markdown: `---
title: Day 1 - Lisbon
icon: 🚋
---
Everyone who lands on the 14th meets at the Alfama flat.

## Plan

- Tram 28 from Martim Moniz, before the queue builds
- Miradouro de Santa Luzia at sunset
- Dinner at a tasca near the flat. Sam is booking for six.

> [!note] Getting in
> The key box code is in the chat with the host. Ask Sam.
`,
  },
  {
    path: "Days/Day 2 - Sintra.md",
    markdown: `---
title: Day 2 - Sintra
icon: 🏰
---
Train from Rossio, 40 minutes. Priya and Jonas stay over at the cottage.

## Plan

- Pena Palace, timed entry at 10:00
- Lunch in the old town
- Quinta da Regaleira in the afternoon

| Ticket | Price | Booked |
| --- | --- | --- |
| Pena Palace | €20 | Yes |
| Regaleira | €15 | No |
`,
  },
  {
    path: "Days/Day 3 - Belém.md",
    markdown: `---
title: Day 3 - Belém
icon: 🥐
---
A slow day by the river before Mei arrives.

- Pastéis de Belém before 9:00
- Jerónimos Monastery
- MAAT, then the walk back along the water
`,
  },
  {
    path: "Budget.md",
    markdown: `---
title: Budget
icon: 💶
---
Shared costs, split evenly. The [[Trip plan]] has the bookings.

| Item | Cost | Paid by |
| --- | --- | --- |
| Alfama flat, 3 nights | €540 | You |
| Sintra cottage, 1 night | €180 | Priya |
| Pena Palace tickets | €100 | Jonas |

Each person's share is €164.
`,
  },
  {
    path: "Packing list.md",
    markdown: `---
title: Packing list
icon: 🎒
---
- [x] Passport
- [ ] Walking shoes for the hills
- [ ] A light jacket for Sintra
- [ ] Plug adapter
`,
  },
];

export const DEMO_PINNED_PAGES = ["Trip plan.md"];

export const APP_SOURCE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trip planner</title>
<style>
  :root { color-scheme: light; --bg: #faf8f3; --card: #ffffff; --ink: #1f1d1a; --muted: #6f6a60; --line: #e5e0d5; --accent: #c2410c; }
  :root[data-theme="dark"] { color-scheme: dark; --bg: #1c1b19; --card: #252421; --ink: #f1eee8; --muted: #a39d92; --line: #3a3833; --accent: #fb923c; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  main { max-width: 640px; margin: 0 auto; padding: 24px 20px 40px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.lede { margin: 0 0 20px; color: var(--muted); }
  nav { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  nav button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
  nav button[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  ol { list-style: none; padding: 0; margin: 0 0 24px; display: grid; gap: 8px; }
  li { display: flex; gap: 12px; align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  li time { font-variant-numeric: tabular-nums; color: var(--muted); width: 44px; flex: none; }
  li label { flex: 1; display: flex; gap: 10px; align-items: center; cursor: pointer; }
  li input:checked + span { color: var(--muted); text-decoration: line-through; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  .split { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
  .split form { display: flex; gap: 8px; margin-bottom: 10px; }
  .split input { font: inherit; min-width: 0; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; background: var(--bg); color: var(--ink); }
  .split input[name="item"] { flex: 1; }
  .split input[name="cost"] { width: 80px; }
  .split button { font: inherit; border: 0; border-radius: 6px; padding: 4px 12px; background: var(--accent); color: #fff; cursor: pointer; }
  .total { display: flex; justify-content: space-between; color: var(--muted); }
  .total strong { color: var(--ink); }
</style>
</head>
<body>
<main>
  <h1>Lisbon, May 14–17</h1>
  <p class="lede">Five of us. Tick things off as you go.</p>
  <nav aria-label="Days"></nav>
  <ol></ol>
  <section class="split">
    <h2>Split a cost</h2>
    <form>
      <input name="item" placeholder="What was it?" aria-label="Item" required>
      <input name="cost" type="number" min="0" step="0.01" placeholder="€" aria-label="Cost in euros" required>
      <button>Add</button>
    </form>
    <div class="total"><span>Each of 5 pays</span><strong data-share>€164.00</strong></div>
  </section>
</main>
<script>
  const days = {
    "Lisbon": [["10:00", "Drop bags at the Alfama flat"], ["13:00", "Tram 28 from Martim Moniz"], ["19:30", "Sunset at Santa Luzia"], ["21:00", "Dinner near the flat"]],
    "Sintra": [["08:40", "Train from Rossio"], ["10:00", "Pena Palace"], ["13:00", "Lunch in the old town"], ["15:30", "Quinta da Regaleira"]],
    "Belém": [["08:30", "Pastéis de Belém"], ["10:00", "Jerónimos Monastery"], ["14:00", "MAAT and the river walk"]],
  };
  const nav = document.querySelector("nav");
  const list = document.querySelector("ol");
  const done = new Set();
  function show(day) {
    for (const button of nav.children) button.setAttribute("aria-pressed", String(button.textContent === day));
    list.replaceChildren(...days[day].map(([time, what]) => {
      const item = document.createElement("li");
      const key = day + what;
      item.innerHTML = '<time></time><label><input type="checkbox"><span></span></label>';
      item.querySelector("time").textContent = time;
      item.querySelector("span").textContent = what;
      const box = item.querySelector("input");
      box.checked = done.has(key);
      box.addEventListener("change", () => (box.checked ? done.add(key) : done.delete(key)));
      return item;
    }));
  }
  for (const day of Object.keys(days)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = day;
    button.addEventListener("click", () => show(day));
    nav.append(button);
  }
  show("Lisbon");
  let total = 820;
  const form = document.querySelector("form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    total += Number(form.cost.value) || 0;
    document.querySelector("[data-share]").textContent = "€" + (total / 5).toFixed(2);
    form.reset();
  });
</script>
</body>
</html>
`;

export function appDocument(theme: "light" | "dark"): string {
  return APP_SOURCE.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`);
}
