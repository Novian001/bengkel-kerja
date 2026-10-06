// REQUIREMENTS §3 invariants 5 and 6. The point of the block table is that an overlap is a
// PRIMARY KEY collision, so these tests assert on the DB error, not just on an app-level
// pre-check: if someone later "fixes" the failure by removing the check, this file fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededDb, get, all, jobs, bays, skuId, vehicleId, toAwaitingApproval } from './helpers.mjs';

const T = (hhmm) => new Date(`2026-05-04T${hhmm}:00.000Z`).toISOString();

function mkJob(db, number) {
  return jobs.createJob(db, { vehicleId: vehicleId(db, 'B 6677 GHI'), complaint: 'test', number });
}

test('invariant 5: an overlapping booking is rejected by the DB', () => {
  const db = seededDb();
  const [b1, b2, b3] = bays.bays(db).map((b) => b.id);
  const a = mkJob(db, 'WO-B-1');
  const b = mkJob(db, 'WO-B-2');

  bays.createBooking(db, { jobId: a.id, bayId: b1, startTs: T('10:00'), durationMin: 180 }); // 10:00-13:00
  const before = get(db, 'SELECT COUNT(*) AS n FROM bay_block').n;

  // 12:00-14:00 overlaps the tail
  assert.throws(
    () => bays.createBooking(db, { jobId: b.id, bayId: b1, startTs: T('12:00'), durationMin: 120 }),
    (e) => e.status === 409 && /already booked/.test(e.message),
  );
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bay_block').n, before, 'a rejected booking leaves no orphan blocks');
  assert.equal(all(db, 'SELECT * FROM bay_bookings WHERE job_id = ?', b.id).length, 0, 'no half-written booking row');

  // a containment, and a booking that swallows the first one, are both overlaps
  assert.throws(() => bays.createBooking(db, { jobId: b.id, bayId: b1, startTs: T('11:00'), durationMin: 30 }), /already booked/);
  assert.throws(() => bays.createBooking(db, { jobId: b.id, bayId: b1, startTs: T('09:00'), durationMin: 300 }), /already booked/);
  assert.throws(() => bays.createBooking(db, { jobId: b.id, bayId: b1, startTs: T('10:15'), durationMin: 30 }), /already booked/);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bay_block').n, before);
  db.close();
});

test('invariant 5: adjacent bookings and the same time on another bay are both allowed', () => {
  const db = seededDb();
  const [b1, b2] = bays.bays(db).map((b) => b.id);
  const a = mkJob(db, 'WO-B-3');
  const b = mkJob(db, 'WO-B-4');
  const c = mkJob(db, 'WO-B-5');

  bays.createBooking(db, { jobId: a.id, bayId: b1, startTs: T('10:00'), durationMin: 120 }); // 10:00-12:00
  // back to back: end == next start is NOT an overlap
  bays.createBooking(db, { jobId: b.id, bayId: b1, startTs: T('12:00'), durationMin: 60 });
  // same wall-clock time, different lift: two jobs, two bays, no conflict
  bays.createBooking(db, { jobId: c.id, bayId: b2, startTs: T('10:00'), durationMin: 120 });

  assert.equal(all(db, 'SELECT * FROM bay_bookings WHERE job_id IN (?, ?, ?) ORDER BY id', a.id, b.id, c.id).length, 3);
  // count this test's blocks by booking, not by bay: the seed already occupies both lifts today
  const blocksOf = (jobId) => get(db, `SELECT COUNT(*) AS n FROM bay_block k
                                        JOIN bay_bookings bk ON bk.id = k.booking_id
                                       WHERE bk.job_id = ?`, jobId).n;
  assert.equal(blocksOf(a.id), 8);
  assert.equal(blocksOf(b.id), 4);
  assert.equal(blocksOf(c.id), 8);
  // and the two lifts really are independent: the same blocks coexist on B1 and B2
  assert.equal(get(db, `SELECT COUNT(DISTINCT block_no) AS n FROM bay_block WHERE bay_id = ? AND block_no IN
                        (SELECT block_no FROM bay_block WHERE bay_id = ?)`, b1, b2).n, 8);
  db.close();
});

test('invariant 6: reflow frees the tail, and an edit may never create an overlap', () => {
  const db = seededDb();
  const [b1, b2] = bays.bays(db).map((b) => b.id);
  const a = mkJob(db, 'WO-B-6');
  const b = mkJob(db, 'WO-B-7');

  const first = bays.createBooking(db, { jobId: a.id, bayId: b1, startTs: T('10:00'), durationMin: 180 }); // 10-13
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bay_block WHERE booking_id = ?', first.id).n, 12);

  // shorten to 10:00-11:00: the tail blocks must disappear, so 12:00 becomes bookable
  bays.reflowBooking(db, first.id, { durationMin: 60 });
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bay_block WHERE booking_id = ?', first.id).n, 4);
  assert.equal(get(db, 'SELECT duration_min FROM bay_bookings WHERE id = ?', first.id).duration_min, 60);

  // the freed tail takes the other job
  bays.createBooking(db, { jobId: b.id, bayId: b1, startTs: T('12:00'), durationMin: 60 });
  assert.equal(all(db, 'SELECT * FROM bay_bookings WHERE job_id = ?', b.id).length, 1);

  // growing it back over that booking must be refused, not silently accepted
  assert.throws(
    () => bays.reflowBooking(db, first.id, { durationMin: 180 }),
    (e) => e.status === 409 && /already booked/.test(e.message),
  );
  assert.equal(get(db, 'SELECT duration_min FROM bay_bookings WHERE id = ?', first.id).duration_min, 60,
    'a refused reflow leaves the booking exactly as it was');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bay_block WHERE booking_id = ?', first.id).n, 4,
    'a refused reflow leaves no orphan blocks');

  // moving the whole booking to another bay is legal and moves its blocks with it
  bays.reflowBooking(db, first.id, { bayId: b2 });
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bay_block WHERE bay_id = ? AND booking_id = ?', b1, first.id).n, 0);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bay_block WHERE bay_id = ? AND booking_id = ?', b2, first.id).n, 4);
  db.close();
});

test('cancelling a booking frees its blocks and the slot is rebookable', () => {
  const db = seededDb();
  const [b1] = bays.bays(db).map((b) => b.id);
  const a = mkJob(db, 'WO-B-8');
  const b = mkJob(db, 'WO-B-9');
  const first = bays.createBooking(db, { jobId: a.id, bayId: b1, startTs: T('10:00'), durationMin: 120 });
  bays.cancelBooking(db, first.id);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM bay_block WHERE booking_id = ?', first.id).n, 0);
  bays.createBooking(db, { jobId: b.id, bayId: b1, startTs: T('10:00'), durationMin: 120 });
  db.close();
});

test('the seed bookings are provably non-overlapping, checked by block count not by eye', () => {
  const db = seededDb();
  // the seed's own three bookings, asserted from the data: WO-2405 B1 13:00-15:00 = 8 blocks,
  // WO-2408 B2 08:00-12:00 = 16, WO-2406 B3 08:30-11:00 = 10. Counts are per BOOKING, because
  // the historical bookings (WO-2400 on B1, WO-2407 and WO-2409 elsewhere) share the same bays.
  const seedBlocks = all(db, `
    SELECT j.number, COUNT(*) AS blocks, MIN(b.start_ts) AS from_ts, MAX(b.start_ts) AS to_ts
      FROM bay_block k JOIN bay_bookings b ON b.id = k.booking_id JOIN jobs j ON j.id = b.job_id
     WHERE j.intake_at >= '2026-03-10' AND j.intake_at < '2026-03-11'
     GROUP BY j.number ORDER BY j.number`);
  assert.deepEqual(seedBlocks.map((r) => [r.number, r.blocks]), [
    ['WO-2405', 8], ['WO-2406', 10], ['WO-2408', 16],
  ]);
  // no bay has two jobs on the same block, by construction of the primary key
  assert.equal(all(db, `SELECT bay_id, block_no, COUNT(*) AS n FROM bay_block GROUP BY bay_id, block_no HAVING n > 1`).length, 0);
  db.close();
});
