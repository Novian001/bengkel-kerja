// Regression: every GET report route must answer 200 on the seeded dataset.
// These routes were not covered by the earlier suite, and `estimate-vs-actual` shipped with a
// column alias that referenced a table it was not selecting FROM — it returned 500 in production
// use while all 38 existing tests passed. A 500 on a read-only report is invisible to unit tests
// that never call it, so the contract is asserted at the HTTP boundary instead: a report either
// answers with data or the test fails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/http/server.js';

let app;
let base;

before(async () => {
  app = await start({ port: 0, dbFile: ':memory:' });
  base = app.url;
});

after(async () => { await app.close(); });

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const REPORTS = [
  '/api/reports/daily',
  '/api/reports/daily?date=2026-03-10',
  '/api/reports/estimate-vs-actual',
];

for (const path of REPORTS) {
  test(`report ${path} answers 200, never 500`, async () => {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} returned ${res.status}: ${JSON.stringify(res.body)}`);
  });
}

test('estimate-vs-actual values consumption at unit_cost, not at the quoted price', async () => {
  const res = await get('/api/reports/estimate-vs-actual');
  const rows = res.body.rows;
  assert.ok(rows.length >= 3, 'seeded dataset must have finished jobs with recorded hours');

  for (const row of rows) {
    assert.equal(typeof row.consumed_value, 'number');
    assert.ok(Number.isInteger(row.consumed_value), 'money must stay integer rupiah');
    assert.ok(row.consumed_value >= 0);
    assert.ok(row.quoted_labour >= 0);
  }

  // WO-2407 is the seeded over-run job: parts consumed cost more than the labour quoted. That is
  // only computable if consumption is joined to stock_items for its unit cost.
  const overrun = rows.find((r) => r.number === 'WO-2407');
  assert.ok(overrun, 'WO-2407 must appear in the estimate-vs-actual report');
  assert.ok(overrun.consumed_value > overrun.quoted_labour,
    'WO-2407 consumed_value must exceed quoted labour, proving unit_cost was joined');
});

test('estimate-vs-actual excludes jobs with no recorded hours', async () => {
  const res = await get('/api/reports/estimate-vs-actual');
  for (const row of res.body.rows) {
    assert.notEqual(row.actual_hours, null);
  }
});

test('daily report carries every operational section', async () => {
  const res = await get('/api/reports/daily?date=2026-03-10');
  for (const key of ['bay_utilisation', 'bay_utilisation_pct', 'jobs_by_state', 'revenue_by_invoice']) {
    assert.ok(key in res.body, `daily report must include ${key}`);
  }
  assert.ok(res.body.bay_utilisation.length > 0, 'bays must be reported');
  assert.equal(typeof res.body.revenue_total, 'number');
  assert.ok(Number.isInteger(res.body.revenue_total), 'revenue_total must stay integer rupiah');
});
