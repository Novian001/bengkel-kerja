// REQUIREMENTS §3 invariants 7, 8 and 15. These are the tests that make the invoice defensible:
// exact integer equality on the total, every line traceable to an approved estimate line, and
// a core return required before the credit can be applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seededDb, get, all, jobs, estimates, stock, bays, invoices, staff, skuId, vehicleId,
  toAwaitingApproval, toReady,
} from './helpers.mjs';

test('invariant 7: invoice total == approved + approved variation + tax - core - discount', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const mech = staff(db, 'mechanic');
  const oli = skuId(db, 'OLI-1L-10W40');
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-INV',
    lines: [
      { kind: 'labour', description: 'Ganti oli', unit_hours: 1.5, unit_rate: 85_000 },  // 127,500
      { kind: 'parts', description: 'Oli 1L', part_id: oli, qty: 1, unit_rate: 60_000 }, //  60,000
    ],
  });
  jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  bays.createBooking(db, { jobId: ctx.jobId, bayId: bays.bays(db)[0].id, startTs: '2026-04-06T02:00:00.000Z', durationMin: 90 });
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'mechanic', staffId: mech.id });

  // a variation raised mid-work: the ORIGINAL estimate stays exactly as approved
  const originalBefore = estimates.lines(db, ctx.estimateId).map((l) => [l.id, l.amount]);
  const v = estimates.createVariation(db, { jobId: ctx.jobId, reason: 'ganti filter tambahan', staffId: mech.id });
  estimates.addLine(db, { estimateId: v.id, kind: 'labour', description: 'Bersih karburator', unit_hours: 1, unit_rate: 85_000 }); // 85,000
  jobs.transition(db, { jobId: ctx.jobId, to: 'awaiting_approval', role: 'mechanic', staffId: mech.id });
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'owner', staffId: owner.id });

  assert.deepEqual(estimates.lines(db, ctx.estimateId).map((l) => [l.id, l.amount]), originalBefore,
    'raising a variation must not touch the original lines');

  jobs.recordActualHours(db, ctx.jobId, 3);
  jobs.transition(db, { jobId: ctx.jobId, to: 'qc', role: 'mechanic', staffId: mech.id });
  jobs.recordQc(db, { jobId: ctx.jobId, passed: true, staffId: owner.id });
  jobs.transition(db, { jobId: ctx.jobId, to: 'ready', role: 'owner', staffId: owner.id });

  const inv = invoices.insertInvoice(db, { jobId: ctx.jobId, staffId: owner.id, discount: 20_000, discountReason: 'pelanggan lama' });

  // original 127,500 + 60,000 = 187,500; approved variation 85,000 -> subtotal 272,500
  // tax 11% of 272,500 = 29,975; discount 20,000 -> total 282,475
  assert.equal(inv.subtotal, 272_500);
  assert.equal(inv.tax, 29_975);
  assert.equal(inv.total, 282_475);
  assert.equal(inv.total, inv.subtotal + inv.tax - inv.discount - inv.core_credit);

  const totals = estimates.approvedTotals(db, ctx.jobId);
  assert.equal(totals.originalTotal, 187_500);
  assert.equal(totals.variationTotal, 85_000);
  assert.equal(inv.subtotal - totals.total, 0, 'subtotal must be exactly the approved money');

  // every line traces to an approved estimate line
  const sources = all(db, `SELECT il.*, e.status AS est_status FROM invoice_lines il
                             JOIN estimate_lines el ON el.id = il.source_line_id
                             JOIN estimates e ON e.id = el.estimate_id
                            WHERE il.invoice_id = ?`, inv.id);
  assert.equal(sources.length, inv.lines.length);
  for (const s of sources) assert.equal(s.est_status, 'approved');
  assert.equal(sources.filter((s) => s.source === 'variation').length, 1);
  db.close();
});

test('invariant 8: an unapproved variation never reaches the invoice', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const mech = staff(db, 'mechanic');
  const oli = skuId(db, 'OLI-1L-10W40');
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-INV2',
    lines: [
      { kind: 'labour', description: 'Ganti oli', unit_hours: 1, unit_rate: 85_000 },
      { kind: 'parts', description: 'Oli 1L', part_id: oli, qty: 1, unit_rate: 60_000 },
    ],
  });
  jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  bays.createBooking(db, { jobId: ctx.jobId, bayId: bays.bays(db)[0].id, startTs: '2026-04-09T02:00:00.000Z', durationMin: 60 });
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'mechanic', staffId: mech.id });

  // a REJECTED variation must never be billed: the customer said no, so the money is not owed
  // even though the work was estimated. Left in the DB as a declined quote, not deleted.
  const v = estimates.createVariation(db, { jobId: ctx.jobId, reason: 'keluhan baru ditemukan', staffId: mech.id });
  estimates.addLine(db, { estimateId: v.id, kind: 'labour', description: 'Pengerjaan tambahan 5 jam', unit_hours: 5, unit_rate: 85_000 });
  estimates.reject(db, v.id, { reason: 'pelanggan menolak', staffId: owner.id });

  jobs.recordActualHours(db, ctx.jobId, 1);
  jobs.transition(db, { jobId: ctx.jobId, to: 'qc', role: 'mechanic', staffId: mech.id });
  jobs.recordQc(db, { jobId: ctx.jobId, passed: true, staffId: owner.id });
  jobs.transition(db, { jobId: ctx.jobId, to: 'ready', role: 'owner', staffId: owner.id });

  const inv = invoices.insertInvoice(db, { jobId: ctx.jobId, staffId: owner.id });
  assert.equal(inv.subtotal, 145_000, 'only the approved original estimate is billed');
  assert.equal(inv.total, 145_000 + 15_950);
  assert.equal(inv.lines.some((l) => l.description.includes('tambahan')), false, 'the rejected variation must be absent');
  assert.equal(get(db, 'SELECT status FROM estimates WHERE id = ?', v.id).status, 'rejected');

  // a hand-typed amount cannot get in: the builder reads approved lines, never the caller
  assert.throws(
    () => invoices.insertInvoice(db, { jobId: ctx.jobId, number: 'INV-X', discount: 999_999_999 }),
    (e) => e.status === 409 && /already invoiced/.test(e.message),
  );
  const raw = all(db, 'SELECT * FROM invoices WHERE job_id = ?', ctx.jobId);
  assert.equal(raw.length, 1);
  db.close();
});

test('invariant 8: the DB refuses an invoice whose total does not match its own components', () => {
  const db = seededDb();
  const inv = get(db, "SELECT * FROM invoices WHERE number = 'INV-2026-0307-001'");
  assert.throws(
    () => db.prepare('UPDATE invoices SET total = 1 WHERE id = ?').run(inv.id),
    /CHECK constraint failed: total = subtotal \+ tax - discount - core_credit/,
  );
  assert.throws(
    () => db.prepare('UPDATE invoices SET total = 999999999 WHERE id = ?').run(inv.id),
    /CHECK constraint failed/,
  );
  assert.equal(get(db, 'SELECT total FROM invoices WHERE id = ?', inv.id).total, 352_865);
  db.close();
});

test('invariant 15: a core-returnable part needs a core-return record before it can be credited', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const mech = staff(db, 'mechanic');
  const bat = skuId(db, 'BATERAI-YTZ6V'); // core_returnable, credit 95,000
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-CORE',
    lines: [
      { kind: 'labour', description: 'Ganti aki', unit_hours: 1, unit_rate: 85_000 },
      { kind: 'parts', description: 'Baterai', part_id: bat, qty: 1, unit_rate: 350_000 },
    ],
  });
  jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  bays.createBooking(db, { jobId: ctx.jobId, bayId: bays.bays(db)[0].id, startTs: '2026-04-07T02:00:00.000Z', durationMin: 60 });
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'mechanic', staffId: mech.id });
  const line = estimates.lines(db, ctx.estimateId).find((l) => l.kind === 'parts');
  stock.consume(db, { jobId: ctx.jobId, stockItemId: bat, estimateLineId: line.id, qty: 1 });
  jobs.recordActualHours(db, ctx.jobId, 1);
  jobs.transition(db, { jobId: ctx.jobId, to: 'qc', role: 'mechanic', staffId: mech.id });
  jobs.recordQc(db, { jobId: ctx.jobId, passed: true, staffId: owner.id });
  jobs.transition(db, { jobId: ctx.jobId, to: 'ready', role: 'owner', staffId: owner.id });

  // the old battery came off but nobody wrote it down: the invoice is refused, not zero-credited
  assert.throws(
    () => invoices.insertInvoice(db, { jobId: ctx.jobId, staffId: owner.id }),
    (e) => e.status === 409 && /no core return recorded/.test(e.message),
  );
  assert.equal(all(db, 'SELECT * FROM invoices WHERE job_id = ?', ctx.jobId).length, 0);

  // recording it makes the credit exact
  jobs.recordCoreReturn(db, { jobId: ctx.jobId, stockItemId: bat, condition: 'layak_tukar_tambah', credit: 95_000 });
  const inv = invoices.insertInvoice(db, { jobId: ctx.jobId, staffId: owner.id });
  assert.equal(inv.subtotal, 435_000);        // 85,000 + 350,000
  assert.equal(inv.core_credit, 95_000);
  assert.equal(inv.total, 435_000 + 47_850 - 95_000);
  assert.equal(inv.total, inv.subtotal + inv.tax - inv.discount - inv.core_credit);
  db.close();
});

test('a discount without a reason is refused', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const ctx = toReady(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-DISC',
    labour: { kind: 'labour', description: 'x', unit_hours: 1, unit_rate: 85_000 },
    parts: [],
  });
  assert.throws(
    () => invoices.insertInvoice(db, { jobId: ctx.jobId, staffId: owner.id, discount: 50_000 }),
    (e) => e.status === 409 && /requires a reason/.test(e.message),
  );
  assert.equal(all(db, 'SELECT * FROM invoices WHERE job_id = ?', ctx.jobId).length, 0);
  const inv = invoices.insertInvoice(db, { jobId: ctx.jobId, staffId: owner.id, discount: 50_000, discountReason: 'janji lama' });
  assert.equal(inv.discount, 50_000);
  assert.equal(inv.discount_reason, 'janji lama');
  db.close();
});

test('consumables land on the invoice: real cost is not labour + parts', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const ban = skuId(db, 'KARET-BAN-BEAT'); // 28,000, never quoted on any line
  const ctx = toReady(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-CONSUM',
    labour: { kind: 'labour', description: 'x', unit_hours: 1, unit_rate: 85_000 },
    parts: [],
  });
  stock.issueUnreserved(db, { jobId: ctx.jobId, stockItemId: ban, qty: 2 });
  const inv = invoices.insertInvoice(db, { jobId: ctx.jobId, staffId: owner.id });
  const consumable = inv.lines.find((l) => l.source === 'consumable');
  assert.ok(consumable, 'the consumable must be billed');
  assert.equal(consumable.qty, 2);
  assert.equal(consumable.amount, 56_000);
  assert.equal(inv.subtotal, 85_000 + 56_000);
  assert.equal(inv.total, inv.subtotal + inv.tax);
  db.close();
});

test('an invoice is only issued at handover, and only once per job', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-EARLY',
    lines: [{ kind: 'labour', description: 'x', unit_hours: 1 }],
  });
  assert.throws(
    () => invoices.insertInvoice(db, { jobId: ctx.jobId, staffId: owner.id }),
    (e) => e.status === 409 && /not ready/.test(e.message),
  );
  // walk it the rest of the way, then close with an invoice in one transaction
  jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  bays.createBooking(db, { jobId: ctx.jobId, bayId: bays.bays(db)[0].id, startTs: '2026-04-08T02:00:00.000Z', durationMin: 60 });
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'mechanic', staffId: staff(db, 'mechanic').id });
  jobs.recordActualHours(db, ctx.jobId, 1);
  jobs.transition(db, { jobId: ctx.jobId, to: 'qc', role: 'mechanic' });
  jobs.recordQc(db, { jobId: ctx.jobId, passed: true, staffId: owner.id });
  jobs.transition(db, { jobId: ctx.jobId, to: 'ready', role: 'owner', staffId: owner.id });
  jobs.closeJobWithInvoice(db, {
    jobId: ctx.jobId, role: 'owner', staffId: owner.id,
    number: 'INV-T-CLOSE', discount: 10_000, discountReason: 'test',
  });
  assert.equal(jobs.job(db, ctx.jobId).state, 'completed');
  assert.equal(get(db, 'SELECT number FROM invoices WHERE job_id = ?', ctx.jobId).number, 'INV-T-CLOSE');
  assert.throws(
    () => jobs.closeJobWithInvoice(db, { jobId: ctx.jobId, role: 'owner', staffId: owner.id }),
    (e) => e.status === 409 && /already invoiced/.test(e.message),
    'closing twice must not mint a second invoice',
  );
  assert.equal(all(db, 'SELECT * FROM invoices WHERE job_id = ?', ctx.jobId).length, 1);
  db.close();
});
