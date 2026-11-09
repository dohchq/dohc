// Sample pages for design review only. The real page comes from the server's live document session.
export interface SamplePage {
  readonly path: string;
  readonly title: string;
  readonly icon?: string;
  readonly properties: readonly { name: string; value: string; opens?: boolean }[];
  readonly markdown: string;
  /** Raw HTML or reference links: dohc can't edit it yet without changing parts it can't show. */
  readonly lossy?: boolean;
  /** History's answer about the original, which the server gives before Edit anyway. */
  readonly history?: "kept" | "untracked" | "unconfirmed";
  /** Over 2 MiB on disk: only the start arrives, read-only. */
  readonly large?: boolean;
}

const packing = `Pack light: the flat has a washer, and the trams are steep.

## Clothes

- Walking shoes, already broken in
- A light jacket for the evenings by the river
- Swimwear for Cascais

## Documents

1. Passports
2. The flat's check-in code, from Maya's message
3. Train tickets to Porto, once Nova books the 8:09

> Sam: bring the adapter. Portugal uses type F.

## Shared

- Sunscreen
- First-aid kit
- A deck of cards for the train
`;

const budget = `Shared costs for the Lisbon trip, split four ways.

<table><tr><td>Flat</td><td>€1,120</td></tr><tr><td>Trains</td><td>€184</td></tr></table>

See the [exchange rates][rates] before paying.

[rates]: https://example.com/rates
`;

// About 2,400 lines, standing in for the start of a file over the 2 MiB limit.
const itinerary = Array.from({ length: 300 }, (_, day) => `## Day ${day + 1}

- 09:00 Breakfast near the flat
- 11:00 Walk to the next viewpoint
- 13:30 Lunch, then the tram back
- 16:00 Free afternoon
- 20:00 Dinner by the river
`).join("\n");

// A long page that stays editable: about 2,100 lines, well under the 2 MiB limit.
const journal = Array.from({ length: 350 }, (_, entry) => `## Entry ${entry + 1}

Walked from the flat down to the river, then up through Alfama for coffee. The trams were full again.

- Spent: €${(entry % 9) + 4}
- Steps: ${8000 + entry * 13}
`).join("\n");

export const samplePages: Record<string, SamplePage> = {
  "trip/journal.md": { path: "trip/journal.md", title: "Journal", icon: "📓", markdown: journal, properties: [{ name: "Trip", value: "Lisbon, Nov 12–19" }] },
  "trip/packing-list.md": {
    path: "trip/packing-list.md", title: "Packing list", icon: "🧳", markdown: packing,
    properties: [{ name: "Trip", value: "Lisbon, Nov 12–19" }, { name: "Owner", value: "Ice" }, { name: "Itinerary", value: "itinerary/days.md", opens: true }],
  },
  "trip/budget.md": { path: "trip/budget.md", title: "Budget", icon: "💶", markdown: budget, lossy: true, history: "kept", properties: [] },
  "itinerary/days.md": { path: "itinerary/days.md", title: "Days", markdown: itinerary, large: true, properties: [] },
};

/** The file chat rows are named after the file; the page lives at its path. */
export const pagePathForFile: Record<string, string> = {
  "packing-list.md": "trip/packing-list.md",
  "budget.md": "trip/budget.md",
};
