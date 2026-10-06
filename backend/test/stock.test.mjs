// REQUIREMENTS §3 invariants 2, 3, 4, 11 plus §2's "reservation ceiling" test: two jobs approve
// the last unit; the second fails with zero partial reservation. The last assertion is the
// important one — a refusal that leaves half a reservation behind is how shops lose stock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seededDb, get, all, jobs, estimates, stock, bays, staff, skuId, vehicleId,
  toAwaitingApproval, toReady,
} from './helpers.mjs';

test('invariant 3: reserved == SUM(active reservations), and release moves it by exactly qty', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  stock.auditReservationTotals(db); // the seed itself is consistent

  const oli = skuId(db, 'OLI-1L-10W40');
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-R1',
    lines: [{ kind: 'labour', description: 'x', unit_hours: 0.5 }, { kind: 'parts', description: 'oli', part_id: oli, qty: 3 }],
  });
  const base = get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved;
  jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved, base + 3);
  stock.auditReservationTotals(db);

  // reserve 3, release 2 -> drops by exactly 2
  const { released } = stock.release(db, { jobId: ctx.jobId, stockItemId: oli, estimateLineId: null, qty: 2 });
  assert.equal(released, 2);
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved, base + 1);
  stock.auditReservationTotals(db);

  // the residue is still one active reservation, and the cancelled job gives it all back
  assert.equal(stock.activeReservations(db, ctx.jobId).length, 1);
  jobs.transition(db, { jobId: ctx.jobId, to: 'cancelled', role: 'owner', staffId: owner.id, payload: { cancel_reason: 'batal' } });
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved, base);
  stock.auditReservationTotals(db);
  db.close();
});

test('invariant 2: a double release is impossible, and releasing twice throws', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-R2',
    lines: [{ kind: 'parts', description: 'oli', part_id: skuId(db, 'OLI-1L-10W40'), qty: 1 }],
  });
  const oli = skuId(db, 'OLI-1L-10W40');
  const base = get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved;
  jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved, base + 1);

  assert.equal(stock.release(db, { jobId: ctx.jobId, stockItemId: oli, qty: 1 }).released, 1);
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved, base);
  assert.throws(
    () => stock.release(db, { jobId: ctx.jobId, stockItemId: oli, qty: 1 }),
    (e) => e.status === 409 && /no active reservation matches/.test(e.message),
    'releasing an already-closed reservation must be refused, not silently ignored',
  );
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', oli).reserved, base, 'no double credit');
  stock.auditReservationTotals(db);
  db.close();
});

test('invariant 2 ceiling: the second job to approve the last unit gets NOTHING reserved', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  // shrink an item to exactly one free unit so the race is deterministic
  const seal = skuId(db, 'SEAL-POMPA-AIR-NMAX'); // on_hand 1, reserved 0
  assert.equal(get(db, 'SELECT on_hand - reserved AS free FROM stock_items WHERE id = ?', seal).free, 1);

  const mkCtx = (number) => toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number,
    lines: [{ kind: 'parts', description: 'seal', part_id: seal, qty: 1 }],
  });
  const first = mkCtx('WO-T-RACE-1');
  const second = mkCtx('WO-T-RACE-2');

  assert.equal(jobs.transition(db, { jobId: first.jobId, to: 'approved', role: 'owner', staffId: owner.id }).state, 'approved');
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', seal).reserved, 1);
  assert.equal(stock.activeReservations(db, first.jobId).length, 1);

  // the loser reserves nothing and is parked in awaiting_parts with a real ORDER PART
  const lost = jobs.transition(db, { jobId: second.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  assert.equal(lost.state, 'awaiting_parts');
  assert.equal(stock.activeReservations(db, second.jobId).length, 0, 'zero partial reservation');
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', seal).reserved, 1, 'reserved did not move');
  assert.equal(get(db, 'SELECT on_hand FROM stock_items WHERE id = ?', seal).on_hand, 1, 'on_hand untouched');

  const op = all(db, `SELECT * FROM order_parts WHERE job_id = ? AND status='open'`, second.jobId);
  assert.equal(op.length, 1);
  assert.equal(op[0].qty_ordered, 1);
  assert.equal(op[0].stock_item_id, seal);
  stock.auditReservationTotals(db);
  db.close();
});

test('invariant 11: consume deducts on_hand exactly once and closes the reservation', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const kampas = skuId(db, 'KAMPAS-REM-BEAT');
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-CONS',
    lines: [{ kind: 'labour', description: 'x', unit_hours: 0.5 }, { kind: 'parts', description: 'kampas', part_id: kampas, qty: 2 }],
  });
  jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  bays.createBooking(db, { jobId: ctx.jobId, bayId: bays.bays(db)[0].id, startTs: '2026-04-04T02:00:00.000Z', durationMin: 60 });
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'mechanic' });

  const onHand = get(db, 'SELECT on_hand FROM stock_items WHERE id = ?', kampas).on_hand;
  const line = estimates.lines(db, ctx.estimateId).find((l) => l.kind === 'parts');
  stock.consume(db, { jobId: ctx.jobId, stockItemId: kampas, estimateLineId: line.id, qty: 2 });

  assert.equal(get(db, 'SELECT on_hand FROM stock_items WHERE id = ?', kampas).on_hand, onHand - 2);
  assert.equal(stock.activeReservations(db, ctx.jobId).length, 0);
  assert.equal(get(db, `SELECT status FROM part_reservations WHERE job_id = ?`, ctx.jobId).status, 'consumed');
  assert.equal(all(db, 'SELECT qty FROM part_consumptions WHERE job_id = ?', ctx.jobId)[0].qty, 2);

  // consuming again is refused: no second deduction
  assert.throws(
    () => stock.consume(db, { jobId: ctx.jobId, stockItemId: kampas, estimateLineId: line.id, qty: 1 }),
    (e) => e.status === 409 && /no active reservation/.test(e.message),
  );
  assert.equal(get(db, 'SELECT on_hand FROM stock_items WHERE id = ?', kampas).on_hand, onHand - 2);
  stock.auditReservationTotals(db);
  db.close();
});

test('invariant 11: consumption may not exceed the reservation', () => {
  const db = seededDb();
  const owner = staff(db, 'owner');
  const bohl = skuId(db, 'BOHLAM-LED-BEAT');
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-CONS2',
    lines: [{ kind: 'parts', description: 'bohlam', part_id: bohl, qty: 2 }],
  });
  jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  bays.createBooking(db, { jobId: ctx.jobId, bayId: bays.bays(db)[0].id, startTs: '2026-04-05T02:00:00.000Z', durationMin: 60 });
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'mechanic' });
  const line = estimates.lines(db, ctx.estimateId).find((l) => l.kind === 'parts');
  assert.throws(
    () => stock.consume(db, { jobId: ctx.jobId, stockItemId: bohl, estimateLineId: line.id, qty: 3 }),
    (e) => e.status === 409 && /exceeds reservation/.test(e.message),
  );
  assert.equal(get(db, 'SELECT reserved FROM stock_items WHERE id = ?', bohl).reserved > 0, true);
  stock.auditReservationTotals(db);
  db.close();
});

test('invariant 1: the DB CHECK refuses reserved > on_hand even from raw SQL', () => {
  const db = seededDb();
  const oli = skuId(db, 'OLI-1L-10W40');
  assert.throws(
    () => db.prepare('UPDATE stock_items SET reserved = on_hand + 1 WHERE id = ?').run(oli),
    /CHECK constraint failed: reserved <= on_hand/,
  );
  assert.throws(
    () => db.prepare('UPDATE stock_items SET on_hand = -1 WHERE id = ?').run(oli),
    /CHECK constraint failed: on_hand >= 0/,
  );
  assert.throws(
    () => db.prepare('UPDATE stock_items SET reserved = -1 WHERE id = ?').run(oli),
    /CHECK constraint failed/,
  );
  db.close();
});

test('stock adjustment needs a reason and cannot break reservations', () => {
  const db = seededDb();
  const oli = skuId(db, 'OLI-1L-10W40');
  assert.throws(() => stock.adjust(db, { stockItemId: oli, delta: 5, reason: '  ' }), (e) => e.status === 400);
  assert.throws(
    () => stock.adjust(db, { stockItemId: oli, delta: -100, reason: 'salah hitung' }),
    (e) => e.status === 409 && /below its reservations/.test(e.message),
  );
  const after = stock.adjust(db, { stockItemId: oli, delta: 5, reason: 'opname triwulan' });
  assert.equal(after.on_hand, get(db, 'SELECT on_hand FROM stock_items WHERE id = ?', oli).on_hand);
  assert.equal(all(db, 'SELECT reason FROM stock_adjustments WHERE stock_item_id = ? ORDER BY id DESC LIMIT 1', oli)[0].reason, 'opname triwulan');
  db.close();
});

test('receiving an ORDER PART tops the job reservation back up to the line qty', () => {
  const db = seededDb();
  const wo2404 = get(db, "SELECT * FROM jobs WHERE number = 'WO-2404'");
  const line = get(db, `SELECT l.* FROM estimate_lines l JOIN estimates e ON e.id = l.estimate_id
                         WHERE e.job_id = ? AND l.part_id = (SELECT id FROM stock_items WHERE sku='DISK-REM-DEPAN-NINJA250')`, wo2404.id);
  const op = get(db, `SELECT * FROM order_parts WHERE job_id = ? AND status='open'`, wo2404.id);
  assert.equal(stock.activeReservations(db, wo2404.id)[0].qty, 1);

  stock.receiveOrderPart(db, { orderPartId: op.id, qty: 1 });
  assert.equal(get(db, 'SELECT status FROM order_parts WHERE id = ?', op.id).status, 'received');
  assert.equal(stock.activeReservations(db, wo2404.id)[0].qty, line.qty, 'reservation now matches the line');
  assert.equal(stock.available(db, line.part_id), 0, 'the received disc is reserved, not free');
  stock.auditReservationTotals(db);
  db.close();
});
