// Eval corpus — ≥30 fixtures across the 3 wedge archetypes
// (messy notes / transcript / spreadsheet-ish). `golden` is the set of
// atoms a correct extraction should contain (matched by key; value
// checked when given). Deliberately covers numbers, money, dates,
// booleans, strings, and live-totals so the scorer exercises the whole
// FROZEN v0 grammar.

export type GoldenAtom = {
  key: string
  kind: 'value' | 'liveTotal'
  value?: string | number | boolean
}

export type Fixture = {
  id: string
  archetype: 'notes' | 'transcript' | 'spreadsheet'
  artifact: string
  golden: GoldenAtom[]
}

export const FIXTURES: Fixture[] = [
  // ── messy notes ──────────────────────────────────────────────
  { id: 'n01', archetype: 'notes', artifact: 'Logged 6 hours on Acme today, design work.', golden: [{ key: 'hours', kind: 'value', value: 6 }] },
  { id: 'n02', archetype: 'notes', artifact: 'rate is 150/hr for this client', golden: [{ key: 'rate', kind: 'value', value: 150 }] },
  { id: 'n03', archetype: 'notes', artifact: 'spent 2.5h debugging the webhook', golden: [{ key: 'hours', kind: 'value', value: 2.5 }] },
  { id: 'n04', archetype: 'notes', artifact: 'invoice due 2026-06-01, amount 4200', golden: [{ key: 'due', kind: 'value', value: '2026-06-01' }, { key: 'amount', kind: 'value', value: 4200 }] },
  { id: 'n05', archetype: 'notes', artifact: 'this engagement is billable, client is Northwind', golden: [{ key: 'billable', kind: 'value', value: true }, { key: 'client', kind: 'value', value: 'Northwind' }] },
  { id: 'n06', archetype: 'notes', artifact: 'standup: shipped 3 PRs, 0 incidents, mood good', golden: [{ key: 'prs', kind: 'value', value: 3 }, { key: 'incidents', kind: 'value', value: 0 }] },
  { id: 'n07', archetype: 'notes', artifact: 'follow up with Maya next week re: capacity', golden: [] },
  { id: 'n08', archetype: 'notes', artifact: 'burn this month ~ 38000, runway 11 months', golden: [{ key: 'burn', kind: 'value', value: 38000 }, { key: 'runway_months', kind: 'value', value: 11 }] },
  { id: 'n09', archetype: 'notes', artifact: 'not billable — internal tooling, 4 hrs', golden: [{ key: 'billable', kind: 'value', value: false }, { key: 'hours', kind: 'value', value: 4 }] },
  { id: 'n10', archetype: 'notes', artifact: 'client said the call "was difficult" but salvageable', golden: [{ key: 'note', kind: 'value', value: 'was difficult' }] },
  { id: 'n11', archetype: 'notes', artifact: 'team total billable this week should roll up automatically', golden: [{ key: 'billable_this_week', kind: 'liveTotal' }] },

  // ── meeting transcript ───────────────────────────────────────
  { id: 't01', archetype: 'transcript', artifact: 'Maya: I put about 8 hours into the Acme migration this week.', golden: [{ key: 'hours', kind: 'value', value: 8 }] },
  { id: 't02', archetype: 'transcript', artifact: 'Sam: our close rate is 22 percent right now.', golden: [{ key: 'close_rate', kind: 'value', value: 22 }] },
  { id: 't03', archetype: 'transcript', artifact: 'Lee: the contract is 12000 for the quarter, starts 2026-07-01.', golden: [{ key: 'amount', kind: 'value', value: 12000 }, { key: 'start', kind: 'value', value: '2026-07-01' }] },
  { id: 't04', archetype: 'transcript', artifact: 'Pat: yes it is signed. Jo: great, mark it won.', golden: [{ key: 'signed', kind: 'value', value: true }] },
  { id: 't05', archetype: 'transcript', artifact: 'Ana: we onboarded 5 customers, churned 1.', golden: [{ key: 'onboarded', kind: 'value', value: 5 }, { key: 'churned', kind: 'value', value: 1 }] },
  { id: 't06', archetype: 'transcript', artifact: 'Kim: nothing to report, all green.', golden: [] },
  { id: 't07', archetype: 'transcript', artifact: 'Ravi: NPS came in at 47, up from 41.', golden: [{ key: 'nps', kind: 'value', value: 47 }] },
  { id: 't08', archetype: 'transcript', artifact: 'Dee: client is Globex, priority high, due 2026-05-30.', golden: [{ key: 'client', kind: 'value', value: 'Globex' }, { key: 'due', kind: 'value', value: '2026-05-30' }] },
  { id: 't09', archetype: 'transcript', artifact: 'Mo: I spent 1.5 hours and it is not billable.', golden: [{ key: 'hours', kind: 'value', value: 1.5 }, { key: 'billable', kind: 'value', value: false }] },
  { id: 't10', archetype: 'transcript', artifact: 'Val: total revenue across the team this month — let the system total it.', golden: [{ key: 'revenue_this_month', kind: 'liveTotal' }] },
  { id: 't11', archetype: 'transcript', artifact: 'Tom: we shipped 14 tickets, 2 rolled back.', golden: [{ key: 'shipped', kind: 'value', value: 14 }, { key: 'rolled_back', kind: 'value', value: 2 }] },

  // ── spreadsheet-ish paste ────────────────────────────────────
  { id: 's01', archetype: 'spreadsheet', artifact: 'Client\tHours\tRate\nAcme\t6\t150', golden: [{ key: 'client', kind: 'value', value: 'Acme' }, { key: 'hours', kind: 'value', value: 6 }, { key: 'rate', kind: 'value', value: 150 }] },
  { id: 's02', archetype: 'spreadsheet', artifact: 'metric,value\nMRR,32000\nchurn,3', golden: [{ key: 'mrr', kind: 'value', value: 32000 }, { key: 'churn', kind: 'value', value: 3 }] },
  { id: 's03', archetype: 'spreadsheet', artifact: 'task,done\nspec,true\nbuild,false', golden: [{ key: 'spec', kind: 'value', value: true }, { key: 'build', kind: 'value', value: false }] },
  { id: 's04', archetype: 'spreadsheet', artifact: 'invoice,amount,due\nINV-9,4200,2026-06-15', golden: [{ key: 'amount', kind: 'value', value: 4200 }, { key: 'due', kind: 'value', value: '2026-06-15' }] },
  { id: 's05', archetype: 'spreadsheet', artifact: 'name\tbooked%\nMaya\t80\nLee\t65', golden: [{ key: 'maya_booked', kind: 'value', value: 80 }, { key: 'lee_booked', kind: 'value', value: 65 }] },
  { id: 's06', archetype: 'spreadsheet', artifact: 'header only, no data rows\ncol_a,col_b', golden: [] },
  { id: 's07', archetype: 'spreadsheet', artifact: 'quarter,target\nQ3,250000', golden: [{ key: 'target', kind: 'value', value: 250000 }] },
  { id: 's08', archetype: 'spreadsheet', artifact: 'client,status\nAcme,active\nGlobex,paused', golden: [{ key: 'acme_status', kind: 'value', value: 'active' }, { key: 'globex_status', kind: 'value', value: 'paused' }] },
  { id: 's09', archetype: 'spreadsheet', artifact: 'date,hours\n2026-05-01,7\n2026-05-02,5', golden: [{ key: 'hours', kind: 'value', value: 7 }, { key: 'hours', kind: 'value', value: 5 }] },
  { id: 's10', archetype: 'spreadsheet', artifact: 'total billable across all rows — computed', golden: [{ key: 'total_billable', kind: 'liveTotal' }] },
  { id: 's11', archetype: 'spreadsheet', artifact: 'rate\t-25 (credit)', golden: [{ key: 'rate', kind: 'value', value: -25 }] },
]
