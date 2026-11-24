export const schemaSql = `CREATE TABLE journal_lines(
  id INTEGER PRIMARY KEY, account TEXT NOT NULL, posted TEXT NOT NULL, memo TEXT NOT NULL,
  debit INTEGER NOT NULL, credit INTEGER NOT NULL
) STRICT;
CREATE INDEX journal_by_account ON journal_lines(account, posted, id);`;

export const importInput = {
  rows: Array.from({ length: 2500 }, (_, n) => ({
    row: n + 1,
    posted: `2026-10-${String((n % 31) + 1).padStart(2, "0")}`,
    memo: `Card settlement ${n + 1} — October marketplace, order and fee reconciliation, statement 2026-10`,
    net: 4000 + n,
    fee: 140 + (n % 31),
  })),
};

export const insertSql =
  "INSERT INTO journal_lines VALUES (?, 'bank', ?, ?, ?, 0), (?, 'fees', ?, ?, ?, 0), (?, 'sales', ?, ?, 0, ?), (?, 'tax', ?, ?, 0, ?)";
export const reportSql =
  "SELECT id, account, posted, memo, debit, credit, SUM(debit-credit) OVER (PARTITION BY account ORDER BY posted, id) AS balance FROM journal_lines ORDER BY account, posted, id";

export function journalParameters({ row, posted, memo, net, fee }) {
  const id = row * 4;
  return [
    id,
    posted,
    memo,
    net,
    id + 1,
    posted,
    memo,
    fee,
    id + 2,
    posted,
    memo,
    net + fee - 100,
    id + 3,
    posted,
    memo,
    100,
  ];
}

export const bulkFixture = `globalThis.operations = {
  importStatement(ctx, input) {
    return input.rows.map(({ row, posted, memo, net, fee }) => {
      const id = row * 4;
      ctx.db.execute(${JSON.stringify(insertSql)}, (${journalParameters.toString()})({ row, posted, memo, net, fee }));
      return { row, posted, memo, net, fee, firstJournalLine: id, lastJournalLine: id + 3 };
    });
  },
  trialBalance(ctx) {
    return ctx.db.query(${JSON.stringify(reportSql)});
  },
};`;
