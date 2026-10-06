// The happy path from REQUIREMENTS §3: intake -> approved -> in_progress -> qc -> ready ->
// completed -> invoiced, with every money number asserted rather than merely "truthy".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seededDb, get, all, jobs, estimates, stock, bays, invoices, staff, skuId,
} from './helpers.mjs';

test('happy path: intake -> completed -> invoiced with exact money', () => {
  // seeded so stock and bays exist, but the JOB is built here from nothing: this test proves the
  // code path, and the fixture only supplies the shop's shelves and lifts
  const db = seededDb();
  const c = db.prepare("INSERT INTO customers (name, phone) VALUES ('Test', '0899-0000')").run();
  const v = db.prepare("INSERT INTO vehicles (customer_id, plate, brand, model) VALUES (?, 'B TEST 01', 'Honda', 'Beat')").run(c.lastInsertRowid);
  const oli = skuId(db, 'OLI-1L-10W40');
  const bay = bays.bays(db)[0].id;

  const job = jobs.createJob(db, { vehicleId: v.lastInsertRowid, complaint: 'oli kapan ganti', number: 'WO-T-0001' });
  assert.equal(job.state, 'intake');
  assert.equal(job.rework_count, 0);

  for (const it of all(db, 'SELECT * FROM job_checklist_items WHERE job_id = ?', job.id)) {
    jobs.checkItem(db, it.id, { done: true });
  }
  assert.equal(jobs.transition(db, { jobId: job.id, to: 'diagnosis', role: 'mechanic' }).state, 'diagnosis');

  const est = estimates.createOriginal(db, { jobId: job.id });
  estimates.addLine(db, { estimateId: est.id, kind: 'labour', description: 'Ganti oli', unit_hours: 1, unit_rate: 85_000 });
  estimates.addLine(db, { estimateId: est.id, kind: 'parts', description: 'Oli 1L', part_id: oli, qty: 1 });
  estimates.submit(db, est.id, {});
  assert.equal(jobs.transition(db, { jobId: job.id, to: 'awaiting_approval', role: 'mechanic' }).state, 'awaiting_approval');

  // approval reserves the part in the same txn
  const oliBefore = get(db, 'SELECT on_hand, reserved FROM stock_items WHERE id = ?', oli);
  const approved = jobs.transition(db, { jobId: job.id, to: 'approved', role: 'owner', staffId: staff(db, 'owner').id });
  assert.equal(approved.state, 'approved');
  assert.ok(approved.approved_at, 'approved_at must be stamped at approval time');
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved, oliBefore.reserved + 1);

  bays.createBooking(db, { jobId: job.id, bayId: bay, startTs: '2026-04-01T02:00:00.000Z', durationMin: 90 });
  assert.equal(jobs.transition(db, { jobId: job.id, to: 'in_progress', role: 'mechanic', staffId: staff(db, 'mechanic').id }).state, 'in_progress');

  const line = estimates.lines(db, est.id).find((l) => l.kind === 'parts');
  stock.consume(db, { jobId: job.id, stockItemId: oli, estimateLineId: line.id, qty: 1 });
  assert.equal(get(db, 'SELECT on_hand FROM stock_items WHERE id = ?', oli).on_hand, oliBefore.on_hand - 1);

  jobs.recordActualHours(db, job.id, 1.25);
  assert.equal(jobs.transition(db, { jobId: job.id, to: 'qc', role: 'mechanic' }).state, 'qc');
  jobs.recordQc(db, { jobId: job.id, passed: true, staffId: staff(db, 'owner').id });
  assert.equal(jobs.transition(db, { jobId: job.id, to: 'ready', role: 'owner' }).state, 'ready');

  const inv = invoices.insertInvoice(db, { jobId: job.id, staffId: staff(db, 'owner').id });
  // labour 85,000 + parts 55,000 = subtotal 140,000; tax 11% = 15,400; no discount, no core
  assert.equal(inv.subtotal, 140_000);
  assert.equal(inv.tax, 15_400);
  assert.equal(inv.discount, 0);
  assert.equal(inv.core_credit, 0);
  assert.equal(inv.total, 155_400);
  assert.equal(inv.total, inv.subtotal + inv.tax - inv.discount - inv.core_credit);

  assert.equal(jobs.transition(db, { jobId: job.id, to: 'completed', role: 'owner' }).state, 'completed');
  assert.ok(jobs.job(db, job.id).completed_at);

  // the audit trail tells the whole story, with no deletes
  const log = all(db, 'SELECT from_state, to_state, actor_role FROM job_state_log WHERE job_id = ? ORDER BY id', job.id);
  assert.deepEqual(log.map((l) => l.to_state), [
    'intake', 'diagnosis', 'awaiting_approval', 'approved', 'in_progress', 'qc', 'ready', 'completed',
  ]);
  assert.deepEqual(log.map((l) => l.from_state), [
    null, 'intake', 'diagnosis', 'awaiting_approval', 'approved', 'in_progress', 'qc', 'ready',
  ]);
  db.close();
});

test('seed data alone satisfies every bookkeeping invariant (REQUIREMENTS §5)', () => {
  const db = seededDb();
  // invariant 3, straight from the fixture
  stock.auditReservationTotals(db);

  // invariant 1, on every row
  const bad = all(db, 'SELECT * FROM stock_items WHERE reserved > on_hand OR reserved < 0 OR on_hand < 0');
  assert.equal(bad.length, 0);

  // the eight live jobs + three historical, covering every working state
  const states = new Set(all(db, 'SELECT state FROM jobs').map((r) => r.state));
  for (const s of ['intake', 'diagnosis', 'awaiting_approval', 'awaiting_parts', 'approved', 'in_progress', 'qc', 'ready', 'completed', 'cancelled']) {
    assert.ok(states.has(s), `seed must contain a job in ${s}`);
  }

  // spec numbers for the seed, asserted not assumed
  const disk = get(db, "SELECT * FROM stock_items WHERE sku = 'DISK-REM-DEPAN-NINJA250'");
  assert.equal(disk.on_hand, 3);
  assert.equal(disk.reserved, 3);
  const wo2404 = get(db, "SELECT * FROM jobs WHERE number = 'WO-2404'");
  assert.equal(wo2404.state, 'awaiting_parts');
  const op = all(db, 'SELECT * FROM order_parts WHERE job_id = ? AND status = ?', wo2404.id, 'open');
  assert.equal(op.length, 1);
  assert.equal(op[0].qty_ordered, 1);
  assert.equal(op[0].eta_date, '2026-03-11');
  assert.equal(get(db, 'SELECT name FROM suppliers WHERE id = ?', op[0].supplier_id).name, 'Sparepart Sumber Rejeki');
  assert.equal(stock.activeReservations(db, wo2404.id).length, 1);

  // WO-2408: one failed QC, rework_count exactly 1
  const wo2408 = get(db, "SELECT * FROM jobs WHERE number = 'WO-2408'");
  assert.equal(wo2408.state, 'in_progress');
  assert.equal(wo2408.rework_count, 1);
  assert.equal(all(db, 'SELECT * FROM qc_checks WHERE job_id = ? AND passed = 0', wo2408.id).length, 1);

  // WO-2400 invoice: contains the approved variation, identity holds exactly
  const inv = invoices.byNumber(db, 'INV-2026-0307-001');
  assert.equal(inv.total, 352_865);
  assert.equal(inv.total, inv.subtotal + inv.tax - inv.discount - inv.core_credit);
  assert.ok(inv.lines.some((l) => l.source === 'variation'), 'the invoice must carry its approved variation');
  db.close();
});
