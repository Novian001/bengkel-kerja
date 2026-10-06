// The trust boundary. REQUIREMENTS §3 asks for 4xx with a message on bad input; these tests
// drive the real node:http server over a real socket, because a mocked router would prove
// nothing about the status codes a customer of this API actually receives.
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

async function call(method, path, { body, role, staffName } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (role !== undefined) headers['x-role'] = role;
  if (staffName !== undefined) headers['x-staff'] = staffName;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const OWNER = { role: 'owner', staffName: 'Budi Santoso' };
const MECH = { role: 'mechanic', staffName: 'Andi Prasetyo' };

test('auth: an unknown role is 401, a known one is accepted, the default is owner', async () => {
  const bad = await call('GET', '/api/board', { role: 'manager' });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /unknown role/);
  assert.match(bad.body.error, /owner, advisor, mechanic, parts_counter/);

  // 401 comes before routing, so an unknown role on a bogus path still says 401
  assert.equal((await call('GET', '/api/nope', { role: 'root' })).status, 401);

  assert.equal((await call('GET', '/api/board')).status, 200);              // no header -> owner
  assert.equal((await call('GET', '/api/board', { role: 'parts' })).status, 200); // alias
});

test('routing: 404 for an unknown path, 405 for the wrong method', async () => {
  const nf = await call('GET', '/api/not-a-thing');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error, 'no such route');

  const wrongMethod = await call('DELETE', '/api/board');
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.body.error, /method DELETE not allowed/);
});

test('validation: missing plate, bad numbers and unknown states are 4xx with a message', async () => {
  const vehicles = (await call('GET', '/api/jobs')).body.jobs;

  // a complaint is mandatory: a job card with no complaint cannot defend a warranty claim
  const noComplaint = await call('POST', '/api/jobs', {
    ...OWNER, body: { vehicle_id: vehicles[0].vehicle_id, complaint: '   ' },
  });
  assert.equal(noComplaint.status, 400);
  assert.match(noComplaint.body.error, /complaint must not be blank/);

  const noVehicle = await call('POST', '/api/jobs', { ...OWNER, body: { complaint: 'x' } });
  assert.equal(noVehicle.status, 400);
  assert.match(noVehicle.body.error, /vehicle_id must be a positive integer/);

  const ghostVehicle = await call('POST', '/api/jobs', { ...OWNER, body: { vehicle_id: 999_999, complaint: 'x' } });
  assert.equal(ghostVehicle.status, 400);
  assert.match(ghostVehicle.body.error, /vehicle not found/);

  // qty 0 and a negative rate
  const job = (await call('POST', '/api/jobs', {
    ...OWNER, body: { vehicle_id: vehicles[0].vehicle_id, complaint: 'uji validasi', number: 'WO-H-1' },
  })).body.job;
  const est = (await call('POST', `/api/jobs/${job.id}/estimates`, { ...MECH, body: {} })).body.estimate;

  const qtyZero = await call('POST', `/api/estimates/${est.id}/lines`, {
    ...MECH, body: { kind: 'parts', description: 'x', part_id: 1, qty: 0 },
  });
  assert.equal(qtyZero.status, 400);
  assert.match(qtyZero.body.error, /qty must be >= 1/);

  const negativeRate = await call('POST', `/api/estimates/${est.id}/lines`, {
    ...MECH, body: { kind: 'labour', description: 'x', unit_hours: 1, unit_rate: -85_000 },
  });
  assert.equal(negativeRate.status, 400);
  assert.match(negativeRate.body.error, /unit_rate must be >= 0/);

  const floatMoney = await call('POST', `/api/estimates/${est.id}/lines`, {
    ...MECH, body: { kind: 'labour', description: 'x', unit_hours: 1, unit_rate: 85_000.5 },
  });
  assert.equal(floatMoney.status, 400);
  assert.match(floatMoney.body.error, /integer number of rupiah/);

  const fractionalHours = await call('POST', `/api/estimates/${est.id}/lines`, {
    ...MECH, body: { kind: 'labour', description: 'x', unit_hours: 0.3 },
  });
  assert.equal(fractionalHours.status, 400);
  assert.match(fractionalHours.body.error, /multiple of 0.25 h/);

  const phantomPart = await call('POST', `/api/estimates/${est.id}/lines`, {
    ...MECH, body: { kind: 'parts', description: 'x', part_id: 987_654, qty: 1 },
  });
  assert.equal(phantomPart.status, 404);
  assert.match(phantomPart.body.error, /stock item 987654 not found/);

  // an unknown target state is a client error naming the states that exist
  const unknownState = await call('POST', `/api/jobs/${job.id}/transition`, { ...OWNER, body: { to: 'teleported' } });
  assert.equal(unknownState.status, 400);
  assert.match(unknownState.body.error, /to must be one of/);
  assert.match(unknownState.body.error, /in_progress/);
  assert.deepEqual(unknownState.body.detail.allowed, ['intake', 'diagnosis', 'awaiting_approval', 'approved',
    'awaiting_parts', 'in_progress', 'qc', 'ready', 'completed', 'cancelled'],
  'the error detail lists the legal states for a client to render');
});

test('validation: a non-object body and malformed JSON are refused', async () => {
  const res = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);

  const arr = await call('POST', '/api/jobs', { ...OWNER, body: [1, 2, 3] });
  assert.equal(arr.status, 400);
  assert.match(arr.body.error, /must be a JSON object/);
});

test('role enforcement over HTTP: 403 for the wrong role, 409 for an illegal edge', async () => {
  const vehicles = (await call('GET', '/api/jobs')).body.jobs;
  const job = (await call('POST', '/api/jobs', {
    ...OWNER, body: { vehicle_id: vehicles[0].vehicle_id, complaint: 'uji role', number: 'WO-H-2' },
  })).body.job;

  // a mechanic may open the job but not approve money
  const checklist = app.db.prepare('SELECT id FROM job_checklist_items WHERE job_id = ?').all(job.id);
  for (const it of checklist) {
    assert.equal((await call('POST', `/api/jobs/${job.id}/checklist/${it.id}`, { ...MECH, body: { done: true } })).status, 200);
  }
  assert.equal((await call('POST', `/api/jobs/${job.id}/transition`, { ...MECH, body: { to: 'diagnosis' } })).status, 200);

  const est = (await call('POST', `/api/jobs/${job.id}/estimates`, { ...MECH, body: {} })).body.estimate;
  await call('POST', `/api/estimates/${est.id}/lines`, {
    ...MECH, body: { kind: 'labour', description: 'Ganti oli', unit_hours: 1, unit_rate: 85_000 },
  });
  await call('POST', `/api/estimates/${est.id}/submit`, { ...MECH, body: {} });
  assert.equal((await call('POST', `/api/jobs/${job.id}/transition`, { ...MECH, body: { to: 'awaiting_approval' } })).status, 200);

  // mechanic trying to approve: 403
  const forbidden = await call('POST', `/api/jobs/${job.id}/transition`, { ...MECH, body: { to: 'approved' } });
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body.error, /may not move a job awaiting_approval -> approved/);
  assert.deepEqual(forbidden.body.detail.allowedRoles, ['owner']);

  // jumping a step: 409 with the states that are legal from here
  const illegal = await call('POST', `/api/jobs/${job.id}/transition`, { ...OWNER, body: { to: 'completed' } });
  assert.equal(illegal.status, 409);
  assert.match(illegal.body.error, /illegal transition awaiting_approval -> completed/);
  // two of the edges share the target 'in_progress' (decide a variation), so compare as a set
  assert.deepEqual([...new Set(illegal.body.detail.allowed)].sort(),
    ['approved', 'awaiting_parts', 'cancelled', 'in_progress']);

  // and the state never moved
  const after = (await call('GET', `/api/jobs/${job.id}`)).body.job;
  assert.equal(after.state, 'awaiting_approval');

  // the owner can approve: the API path reserves the part exactly like the repo does
  const approved = await call('POST', `/api/jobs/${job.id}/transition`, { ...OWNER, body: { to: 'approved', channel: 'wa' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.job.state, 'approved');
});

test('bay conflict over HTTP is 409 and leaves nothing behind', async () => {
  const job = (await call('POST', '/api/jobs', {
    ...OWNER, body: { vehicle_id: (await call('GET', '/api/jobs')).body.jobs[0].vehicle_id, complaint: 'uji bay', number: 'WO-H-3' },
  })).body.job;
  const bay = (await call('GET', '/api/bays')).body.bays[0];

  const first = await call('POST', '/api/bays/bookings', {
    ...OWNER, body: { job_id: job.id, bay_id: bay.id, start_ts: '2026-06-01T02:00:00.000Z', duration_min: 120 },
  });
  assert.equal(first.status, 200);

  const blocksBefore = app.db.prepare('SELECT COUNT(*) AS n FROM bay_block WHERE job_id = ?').get(job.id).n;
  const other = (await call('POST', '/api/jobs', {
    ...OWNER, body: { vehicle_id: job.vehicle_id, complaint: 'uji bay 2', number: 'WO-H-4' },
  })).body.job;
  const clash = await call('POST', '/api/bays/bookings', {
    ...OWNER, body: { job_id: other.id, bay_id: bay.id, start_ts: '2026-06-01T03:00:00.000Z', duration_min: 60 },
  });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /already booked/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM bay_block WHERE job_id = ?').get(job.id).n, blocksBefore);

  // a bad timestamp is a 400, not a 500
  const badTs = await call('POST', '/api/bays/bookings', {
    ...OWNER, body: { job_id: job.id, bay_id: bay.id, start_ts: 'next tuesday-ish', duration_min: 60 },
  });
  assert.equal(badTs.status, 400);
});

test('board, stock low alert, order parts and reports are served from the seed', async () => {
  const board = (await call('GET', '/api/board')).body.board;
  assert.ok(board.length >= 10, 'the seed covers every state');
  assert.deepEqual(
    board.map((r) => r.state).sort(),
    ['approved', 'awaiting_approval', 'awaiting_parts', 'cancelled', 'completed', 'diagnosis', 'in_progress', 'intake', 'qc', 'ready'],
  );

  const low = (await call('GET', '/api/stock?low=1')).body.low_stock.map((r) => r.sku);
  for (const sku of ['FILTER-OLI-VFR', 'FILTER-UDARA-VFR', 'SEAL-POMPA-AIR-NMAX']) {
    assert.ok(low.includes(sku), `${sku} is below its reorder point in the seed`);
  }

  const ops = (await call('GET', '/api/order-parts')).body.open;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].sku, 'DISK-REM-DEPAN-NINJA250');
  assert.equal(ops[0].supplier, 'Sparepart Sumber Rejeki');
  assert.equal(ops[0].eta_date, '2026-03-11');

  const report = (await call('GET', '/api/reports/daily?day=2026-03-10')).body;
  assert.ok(report.jobs_by_state.length > 0);
  assert.equal(report.bay_utilisation.length, 3);
  assert.ok(report.bay_utilisation_pct > 0, 'the seed has booked bays');
  assert.equal(report.rework.rework_count_sum, 1, 'WO-2408 carries exactly one rework');
  // on 2026-03-10 the only QC check is WO-2408's FAIL (WO-2407's pass is dated 03-09), so the
  // day's rework rate is 100% of one check — the rework the owner is trying to see
  assert.equal(report.rework.qc_checks, 1);
  assert.equal(report.rework.qc_failed, 1);
  assert.equal(report.rework.rework_rate_pct, 100);

  // The VFR (Agus Salim) has WO-2400 completed+invoiced and WO-2402 in diagnosis from the seed.
  // The count is asserted as >= 2 because the earlier tests in this file also opened jobs on
  // whichever vehicle they picked; the SEED facts below are what this test is really about.
  const hist = (await call('GET', '/api/customers/history?plate=B%202345%20KLT')).body;
  assert.equal(hist.customer.name, 'Agus Salim');
  const numbers = hist.jobs.map((j) => j.number);
  assert.ok(numbers.includes('WO-2400'), 'the completed VFR job is in the history');
  assert.ok(numbers.includes('WO-2402'), 'the live VFR job is in the history');
  assert.ok(hist.job_count >= 2);
  assert.equal(hist.lifetime_value, 352_865, 'lifetime value is the seeded invoice total');
  assert.equal(hist.last_visit.number, numbers[0], 'last visit is the most recent job');

  assert.equal((await call('GET', '/api/customers/history?plate=B 0000 XXX')).status, 404);
  assert.equal((await call('GET', '/api/customers/history')).status, 400);
});

test('a completed job cannot be reopened over HTTP', async () => {
  const done = (await call('GET', '/api/jobs')).body.jobs.find((j) => j.state === 'completed');
  const res = await call('POST', `/api/jobs/${done.id}/transition`, { ...OWNER, body: { to: 'in_progress' } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /terminal/);
});
