// WHY a 15-minute block table instead of a SELECT-then-INSERT overlap check: block_no is a
// deterministic function of start_ts, so "these two bookings overlap" becomes "these two
// bookings want the same PRIMARY KEY", and the DB refuses it inside the INSERT. The
// read-then-write race the spec warns about does not exist because there is no read.
// trade-off (spec §6.1): conflicts are rejected, never auto-reflowed.
import { conflict, notFound, bad, qty, tx, run, get, all, ValidationError } from '../db.js';

export const BLOCK_MIN = 15;

export function bays(db) { return all(db, 'SELECT * FROM bays WHERE active = 1 ORDER BY id'); }

export function bay(db, id) {
  const b = get(db, 'SELECT * FROM bays WHERE id = ?', id);
  if (!b) throw notFound(`bay ${id} not found`);
  return b;
}

function blockRange(startIso, durationMin) {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw bad('start_ts is not a valid timestamp', { start_ts: startIso });
  // epoch minutes / 15 = absolute block number, so the same wall-clock slot always maps to
  // the same block on any day and block numbers stay comparable
  const first = Math.floor(start.getTime() / 60000 / BLOCK_MIN);
  const count = Math.ceil(durationMin / BLOCK_MIN);
  if (count < 1) throw bad('duration_min must cover at least one block', { duration_min: durationMin });
  return { first, count, start };
}

function insertBlocks(db, { bayId, jobId, bookingId, startIso, durationMin }) {
  const { first, count } = blockRange(startIso, durationMin);
  for (let i = 0; i < count; i++) {
    try {
      run(db, 'INSERT INTO bay_block (bay_id, block_no, job_id, booking_id) VALUES (?, ?, ?, ?)',
        bayId, first + i, jobId, bookingId);
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      const msg = String(e.message ?? '');
      if (msg.includes('UNIQUE constraint failed') || msg.includes('constraint failed')) {
        throw conflict(`bay ${bayId} is already booked at that time (15-min block collision)`, { bay_id: bayId, start_ts: startIso, duration_min: durationMin });
      }
      throw e;
    }
  }
}

export function booking(db, id) {
  const b = get(db, 'SELECT * FROM bay_bookings WHERE id = ?', id);
  if (!b) throw notFound(`booking ${id} not found`);
  return b;
}

export function bookingsForJob(db, jobId) {
  return all(db, `SELECT * FROM bay_bookings WHERE job_id = ? AND status <> 'cancelled' ORDER BY start_ts`, jobId);
}

export function bookingsForBay(db, bayId, dayIso) {
  const from = `${dayIso}T00:00:00.000Z`;
  const to = `${dayIso}T24:00:00.000Z`;
  return all(db, `SELECT b.* FROM bay_bookings b
                    WHERE b.bay_id = ? AND b.status = 'booked'
                      AND b.start_ts >= ? AND b.start_ts < ?
                    ORDER BY b.start_ts`, bayId, from, to);
}

// The transaction lives HERE, not in the HTTP handler: "a rejected booking leaves zero orphan
// rows" is a property of the invariant, and a caller that forgets to wrap itself in tx() must
// not be able to write half a booking. tx() is re-entrant, so callers that already hold the
// lock simply join it.
export function createBooking(db, { jobId, bayId, startTs, durationMin, status = 'booked' }) {
  return tx(db, () => createBookingIn(db, { jobId, bayId, startTs, durationMin, status }));
}

function createBookingIn(db, { jobId, bayId, startTs, durationMin, status = 'booked' }) {
  bay(db, bayId);
  if (!['booked', 'paused'].includes(status)) throw bad(`booking status must be booked|paused`, { status });
  const mins = qty(durationMin, 'duration_min', { max: 24 * 60 });
  // parsed and validated here: Date.toISOString() throws a RangeError on junk, which would
  // surface as a 500 instead of a 400
  if (typeof startTs !== 'string' || Number.isNaN(new Date(startTs).getTime())) {
    throw bad('start_ts must be an ISO-8601 timestamp', { start_ts: startTs });
  }
  const iso = new Date(startTs).toISOString();
  // blocks first, row second: if the human-readable row insert fails, the whole txn rolls
  // back and leaves zero orphan blocks
  let info;
  try {
    info = run(db, `INSERT INTO bay_bookings (job_id, bay_id, start_ts, duration_min, status) VALUES (?, ?, ?, ?, ?)`,
      jobId, bayId, iso, mins, status);
  } catch (e) {
    // ux_booking_live_start fires BEFORE bay_block does, so without this the caller sees a raw
    // SQLite index name instead of the reason. The bay screen exists to show this collision, so
    // the message has to say what happened and on what, in the shop's terms.
    const msg = String(e.message ?? '');
    if (msg.includes('UNIQUE constraint failed') && msg.includes('bay_bookings')) {
      const clash = get(db, `SELECT job_id, start_ts, duration_min FROM bay_bookings
                              WHERE bay_id = ? AND start_ts = ? AND status IN ('booked','paused')`,
        bayId, iso);
      throw conflict(
        `bay ${bayId} already has a booking at ${iso} (${clash ? clash.duration_min : '?'} min)` +
        (clash ? ` — held by WO job ${clash.job_id}` : '') +
        '. Slot diblokir per 15 menit; pilih jam lain atau perpendek durasi.',
        { bay_id: bayId, start_ts: iso, duration_min: mins, conflicting_job_id: clash?.job_id ?? null });
    }
    throw e;
  }
  const bookingId = Number(info.lastInsertRowid);
  insertBlocks(db, { bayId, jobId, bookingId, startIso: iso, durationMin: mins });
  return booking(db, bookingId);
}

// Reflow (invariant 6): release own tail blocks, then re-insert the new range in the same
// transaction. An edit can never create an overlap because the re-insert hits the same
// PRIMARY KEY path as a fresh booking. Shortening frees the tail; the tail is rebookable.
export function reflowBooking(db, id, patch) {
  return tx(db, () => reflowBookingIn(db, id, patch));
}

function reflowBookingIn(db, id, { startTs = null, durationMin = null, bayId = null, status = null }) {
  const b = booking(db, id);
  if (startTs !== null && (typeof startTs !== 'string' || Number.isNaN(new Date(startTs).getTime()))) {
    throw bad('start_ts must be an ISO-8601 timestamp', { start_ts: startTs });
  }
  const newStart = startTs === null ? b.start_ts : new Date(startTs).toISOString();
  const newMins = durationMin === null ? b.duration_min : qty(durationMin, 'duration_min', { max: 24 * 60 });
  const newBay = bayId === null ? b.bay_id : bayId;
  const newStatus = status === null ? b.status : status;
  if (newBay !== b.bay_id) bay(db, newBay);
  if (['cancelled', 'done'].includes(newStatus)) {
    return cancelBookingIn(db, id);
  }
  run(db, 'DELETE FROM bay_block WHERE booking_id = ?', id);
  run(db, 'UPDATE bay_bookings SET bay_id = ?, start_ts = ?, duration_min = ?, status = ? WHERE id = ?',
    newBay, newStart, newMins, newStatus, id);
  insertBlocks(db, { bayId: newBay, jobId: b.job_id, bookingId: id, startIso: newStart, durationMin: newMins });
  return booking(db, id);
}

// A paused variation still holds the slot, so blocks stay; status is the only change.
export function pauseBooking(db, id) { return reflowBookingIn(db, id, { status: 'paused' }); }
export function resumeBooking(db, id) { return reflowBookingIn(db, id, { status: 'booked' }); }

export function cancelBooking(db, id) {
  return tx(db, () => cancelBookingIn(db, id));
}

function cancelBookingIn(db, id) {
  const b = booking(db, id);
  run(db, `UPDATE bay_bookings SET status = 'cancelled' WHERE id = ?`, id);
  run(db, 'DELETE FROM bay_block WHERE booking_id = ?', id);
  return booking(db, id);
}

// Called from inside jobs.transition()'s transaction; each cancel is a plain write so it joins
// that transaction instead of trying to nest another one.
export function cancelAllForJob(db, jobId) {
  const rows = bookingsForJob(db, jobId);
  for (const r of rows) cancelBookingIn(db, r.id);
  return rows.length;
}

export function blockCount(db, bayId) {
  return get(db, 'SELECT COUNT(*) AS n FROM bay_block WHERE bay_id = ?', bayId).n;
}
