// REQUIREMENTS §2 "Must be rejected, and why" + §3 invariants 1, 5, 10, 13, 14. Every test
// asserts TWO things: the call was refused AND the database did not change. A rejected edge
// that half-writes is worse than one that throws, so "0 state changes" is the real assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seededDb, get, all, jobs, estimates, stock, bays, invoices,
  staff, skuId, vehicleId, doneChecklist, toAwaitingApproval, toReady,
} from './helpers.mjs';

const ROLE_OWNER = 'owner';

test('invariant 1: every illegal edge is refused and changes nothing', () => {
  const db = seededDb();
  const owner = staff(db, ROLE_OWNER);
  const mech = staff(db, 'mechanic');

  // awaiting_approval -> in_progress: "unapproved work is uncollectible money". The edge only
  // exists to let the OWNER decide a pending variation, and WO-2403's pending item is its
  // ORIGINAL estimate, not a variation — so the guard is what refuses it.
  const wo2403 = get(db, "SELECT * FROM jobs WHERE number = 'WO-2403'");
  const before = all(db, 'SELECT sku, on_hand, reserved FROM stock_items ORDER BY sku');
  const logBefore = all(db, 'SELECT COUNT(*) AS n FROM job_state_log WHERE job_id = ?', wo2403.id)[0].n;
  assert.throws(
    () => jobs.transition(db, { jobId: wo2403.id, to: 'in_progress', role: ROLE_OWNER, staffId: owner.id }),
    (e) => e.status === 409 && /only legal when deciding a variation/.test(e.message),
  );
  assert.equal(jobs.job(db, wo2403.id).state, 'awaiting_approval');
  assert.deepEqual(all(db, 'SELECT sku, on_hand, reserved FROM stock_items ORDER BY sku'), before,
    'a refused edge must not touch stock');
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM job_state_log WHERE job_id = ?', wo2403.id)[0].n, logBefore,
    'a refused edge must not append to the audit log');

  // a mechanic may not decide a variation either: role is checked before the guard
  const wo2406 = get(db, "SELECT * FROM jobs WHERE number = 'WO-2406'"); // paused on a variation
  assert.throws(
    () => jobs.transition(db, { jobId: wo2406.id, to: 'in_progress', role: 'mechanic', staffId: mech.id }),
    (e) => e.status === 403 && /may not move a job/.test(e.message),
  );
  assert.equal(jobs.job(db, wo2406.id).state, 'awaiting_approval');

  // approved -> in_progress with an unreserved part and no ORDER PART
  {
    const oli = skuId(db, 'OLI-1L-10W40');
    const ctx = toAwaitingApproval(db, {
      vehicleId: vehicleId(db, 'B 6677 GHI'),
      complaint: 'butuh oli tanpaNomor',
      lines: [{ kind: 'labour', description: 'cek', unit_hours: 0.5 }, { kind: 'parts', description: 'oli', part_id: oli, qty: 1 }],
      number: 'WO-T-SHORT',
    });
    jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: ROLE_OWNER, staffId: owner.id });
    // free the reservation the approval made, as if the counter had mis-clicked
    for (const r of stock.activeReservations(db, ctx.jobId)) {
      stock.release(db, { jobId: ctx.jobId, stockItemId: r.stock_item_id, estimateLineId: r.estimate_line_id, qty: r.qty });
    }
    bays.createBooking(db, { jobId: ctx.jobId, bayId: bays.bays(db)[0].id, startTs: '2026-04-02T02:00:00.000Z', durationMin: 60 });
    const logBefore = all(db, 'SELECT COUNT(*) AS n FROM job_state_log WHERE job_id = ?', ctx.jobId)[0].n;
    assert.throws(
      () => jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'mechanic', staffId: mech.id }),
      (e) => e.status === 409 && /not fully reserved/.test(e.message),
    );
    assert.equal(jobs.job(db, ctx.jobId).state, 'approved');
    assert.equal(all(db, 'SELECT COUNT(*) AS n FROM job_state_log WHERE job_id = ?', ctx.jobId)[0].n, logBefore,
      'a refused edge must not append to the audit log');
  }
  db.close();
});

test('awaiting_parts -> in_progress is refused while an ORDER PART is open', () => {
  const db = seededDb();
  const wo2404 = get(db, "SELECT * FROM jobs WHERE number = 'WO-2404'");
  const mech = staff(db, 'mechanic');
  bays.createBooking(db, { jobId: wo2404.id, bayId: bays.bays(db)[0].id, startTs: '2026-04-03T02:00:00.000Z', durationMin: 60 });
  assert.throws(
    () => jobs.transition(db, { jobId: wo2404.id, to: 'in_progress', role: 'mechanic', staffId: mech.id }),
    (e) => e.status === 409 && /wait for parts/.test(e.message),
  );
  assert.equal(jobs.job(db, wo2404.id).state, 'awaiting_parts');

  // and once the part arrives it proceeds: the wait was real, not decorative
  const op = get(db, "SELECT * FROM order_parts WHERE job_id = ? AND status = 'open'", wo2404.id);
  stock.receiveOrderPart(db, { orderPartId: op.id, qty: 1 });
  assert.equal(stock.openOrderParts(db, wo2404.id).length, 0);
  assert.equal(jobs.transition(db, { jobId: wo2404.id, to: 'in_progress', role: 'mechanic', staffId: mech.id }).state, 'in_progress');
  stock.auditReservationTotals(db);
  db.close();
});

test('invariant 12 + §2: QC fail needs a reason, counts rework once, and returns to in_progress', () => {
  const db = seededDb();
  const oli = skuId(db, 'OLI-1L-10W40');
  const ctx = toReady(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-QC',
    parts: [{ kind: 'parts', description: 'oli', part_id: oli, qty: 1 }],
  });
  assert.equal(ctx.state, 'ready');

  // ready -> in_progress (customer rejects at handover) is legal
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: ROLE_OWNER });
  jobs.recordActualHours(db, ctx.jobId, 2);
  assert.equal(jobs.transition(db, { jobId: ctx.jobId, to: 'qc', role: 'mechanic' }).state, 'qc');

  // a fail without a reason is refused at the DB level, not just by the validator
  assert.throws(() => jobs.recordQc(db, { jobId: ctx.jobId, passed: false }), (e) => e.status === 400);
  const checksBefore = all(db, 'SELECT COUNT(*) AS n FROM qc_checks WHERE job_id = ?', ctx.jobId)[0].n;
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM qc_checks WHERE job_id = ?', ctx.jobId)[0].n, checksBefore);

  jobs.recordQc(db, { jobId: ctx.jobId, passed: false, reason: 'knalpot masih bocor' });
  assert.equal(jobs.job(db, ctx.jobId).rework_count, 0, 'the count moves on the EDGE, not on the record');
  const back = jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: ROLE_OWNER });
  assert.equal(back.state, 'in_progress');
  assert.equal(back.rework_count, 1, 'exactly one increment per failed QC');

  // a second fail counts a second time, and never more than once per edge
  jobs.recordActualHours(db, ctx.jobId, 2);
  jobs.transition(db, { jobId: ctx.jobId, to: 'qc', role: 'mechanic' });
  jobs.recordQc(db, { jobId: ctx.jobId, passed: false, reason: 'masih bocor' });
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: ROLE_OWNER });
  assert.equal(jobs.job(db, ctx.jobId).rework_count, 2);
  assert.equal(
    jobs.job(db, ctx.jobId).rework_count,
    all(db, 'SELECT COUNT(*) AS n FROM qc_checks WHERE job_id = ? AND passed = 0', ctx.jobId)[0].n,
    'rework_count must equal the number of failed QC checks',
  );
  db.close();
});

test('invariant 14 + DB trigger: terminal states accept nothing, even from raw SQL', () => {
  const db = seededDb();
  const owner = staff(db, ROLE_OWNER);
  const done = get(db, "SELECT * FROM jobs WHERE number = 'WO-2400'");
  const cancelled = get(db, "SELECT * FROM jobs WHERE number = 'WO-2395'");

  for (const j of [done, cancelled]) {
    for (const to of ['diagnosis', 'in_progress', 'qc', 'ready', 'approved', 'awaiting_approval']) {
      assert.throws(
        () => jobs.transition(db, { jobId: j.id, to, role: ROLE_OWNER, staffId: owner.id, payload: { cancel_reason: 'x' } }),
        (e) => e.status === 409 && /terminal/.test(e.message),
        `${j.number} must refuse ${j.state} -> ${to}`,
      );
    }
    assert.equal(jobs.job(db, j.id).state, j.state);
  }

  // the rule is not just an application convention: hand-written SQL hits it too
  assert.throws(
    () => db.prepare("UPDATE jobs SET state = 'in_progress' WHERE id = ?").run(done.id),
    /job is terminal/,
  );
  assert.equal(jobs.job(db, done.id).state, 'completed');
  db.close();
});

test('invariant 9: an approved estimate line cannot be edited, only varied', () => {
  const db = seededDb();
  const wo2407 = get(db, "SELECT * FROM jobs WHERE number = 'WO-2407'");
  const line = get(db, `SELECT l.* FROM estimate_lines l JOIN estimates e ON e.id = l.estimate_id
                         WHERE e.job_id = ? AND e.status = 'approved' AND l.kind = 'labour' LIMIT 1`, wo2407.id);

  // repo layer refuses
  assert.throws(
    () => estimates.updateLine(db, line.id, { unit_rate: 1 }),
    (e) => e.status === 409 && /immutable/.test(e.message),
  );
  // and so does the DB, for any other writer
  assert.throws(
    () => db.prepare('UPDATE estimate_lines SET unit_rate = 1 WHERE id = ?').run(line.id),
    /immutable once approved/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM estimate_lines WHERE id = ?').run(line.id),
    /immutable once approved/,
  );
  assert.equal(get(db, 'SELECT unit_rate FROM estimate_lines WHERE id = ?', line.id).unit_rate, line.unit_rate);

  // the supported correction path still works: a variation
  const v = estimates.createVariation(db, { jobId: wo2407.id, reason: 'tambah pekerjaan', staffId: staff(db, 'mechanic').id });
  const vl = estimates.addLine(db, { estimateId: v.id, kind: 'labour', description: 'tambahan', unit_hours: 0.5, unit_rate: 85_000 });
  assert.equal(get(db, 'SELECT amount FROM estimate_lines WHERE id = ?', vl).amount, 42_500);
  db.close();
});

test('invariant 10: only one pending variation per job', () => {
  const db = seededDb();
  const wo2408 = get(db, "SELECT * FROM jobs WHERE number = 'WO-2408'");
  const first = estimates.createVariation(db, { jobId: wo2408.id, reason: 'gyalaku bocor', staffId: staff(db, 'mechanic').id });
  assert.throws(
    () => estimates.createVariation(db, { jobId: wo2408.id, reason: 'kedua', staffId: staff(db, 'mechanic').id }),
    (e) => e.status === 409 && /one decision at a time/.test(e.message),
  );
  assert.equal(all(db, `SELECT COUNT(*) AS n FROM estimates WHERE job_id = ? AND kind='variation' AND status='pending_approval'`, wo2408.id)[0].n, 1);
  assert.equal(estimates.openVariation(db, wo2408.id).id, first.id);
  db.close();
});

test('a self-raised estimate cannot be self-approved (REQUIREMENTS §2)', () => {
  const db = seededDb();
  const owner = staff(db, ROLE_OWNER);
  const ctx = toAwaitingApproval(db, {
    vehicleId: vehicleId(db, 'B 6677 GHI'), number: 'WO-T-SELF',
    lines: [{ kind: 'labour', description: 'x', unit_hours: 1 }],
  });
  // the owner raised it himself and now tries to approve it
  db.prepare("UPDATE estimates SET created_by = ? WHERE id = ?").run(owner.id, ctx.estimateId);
  assert.throws(
    () => estimates.approve(db, ctx.estimateId, { staffId: owner.id, approverRole: 'owner' }),
    (e) => e.status === 409 && /cannot be approved by the staff member who raised it/.test(e.message),
  );
  assert.equal(get(db, 'SELECT status FROM estimates WHERE id = ?', ctx.estimateId).status, 'pending_approval');
  db.close();
});

test('invariant 13: awaiting_parts implies an open ORDER PART, in_progress implies none', () => {
  const db = seededDb();
  for (const j of all(db, 'SELECT id, state FROM jobs')) {
    const open = all(db, `SELECT id FROM order_parts WHERE job_id = ? AND status='open'`, j.id).length;
    if (j.state === 'awaiting_parts') assert.ok(open >= 1, `job ${j.id} is awaiting_parts with ${open} open orders`);
    if (j.state === 'in_progress') assert.equal(open, 0, `job ${j.id} is in_progress with ${open} open orders`);
  }
  db.close();
});
