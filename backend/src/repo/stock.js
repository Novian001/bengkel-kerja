// WHY this module owns reserved: `stock_items.reserved` is a cache of
// SUM(active part_reservations.qty). Two writers maintaining it by hand is how shops lose
// stock, so this file is the ONLY place that touches `reserved`, and every mutation is
// guarded UPDATE ... WHERE reserved + delta BETWEEN 0 AND on_hand with a changed-row check.
// A 0-row update means the invariant would break, so we abort rather than write a lie.
import { conflict, notFound, bad, qty, money, text, run, get, all } from '../db.js';

export function item(db, id) {
  const it = get(db, 'SELECT * FROM stock_items WHERE id = ?', id);
  if (!it) throw notFound(`stock item ${id} not found`);
  return it;
}

export function bySku(db, sku) {
  const it = get(db, 'SELECT * FROM stock_items WHERE sku = ?', sku);
  if (!it) throw notFound(`stock item '${sku}' not found`);
  return it;
}

export function list(db) { return all(db, 'SELECT * FROM stock_items ORDER BY sku'); }

// invariant 3, asserted on demand: the cached counter and the reservation rows must agree.
export function lowStock(db) {
  return all(db, 'SELECT * FROM stock_items WHERE on_hand - reserved <= reorder_point ORDER BY sku');
}

export function auditReservationTotals(db) {
  const drift = all(db, `
    SELECT s.id, s.sku, s.reserved,
           COALESCE((SELECT SUM(r.qty) FROM part_reservations r
                      WHERE r.stock_item_id = s.id AND r.status = 'active'), 0) AS actual
    FROM stock_items s
    WHERE s.reserved <> COALESCE((SELECT SUM(r.qty) FROM part_reservations r
                      WHERE r.stock_item_id = s.id AND r.status = 'active'), 0)`);
  if (drift.length) throw conflict('stock bookkeeping drift: reserved <> SUM(active reservations)', { drift });
  return true;
}

function moveReserved(db, stockItemId, delta) {
  // Guarded update: the CHECK backs us up, the WHERE + changes check turns a would-be
  // violation into a clean error inside this transaction instead of a rollback mid-write.
  const res = run(db, `
    UPDATE stock_items SET reserved = reserved + ?
     WHERE id = ? AND reserved + ? >= 0 AND reserved + ? <= on_hand`,
    delta, stockItemId, delta, delta);
  if (res.changes !== 1) {
    const it = item(db, stockItemId);
    throw conflict(
      delta > 0
        ? `insufficient stock for ${it.sku}: available ${it.on_hand - it.reserved}, requested ${delta}`
        : `cannot release ${-delta} from ${it.sku}: only ${it.reserved} reserved`,
      { sku: it.sku, on_hand: it.on_hand, reserved: it.reserved, delta },
    );
  }
}

export function available(db, stockItemId) {
  const it = item(db, stockItemId);
  return it.on_hand - it.reserved;
}

// Reserve for one approved part line. Called from inside the approval transaction so the
// availability re-check and the write are serialised (invariant 4). Shortage is NOT an
// error here: the caller turns it into an ORDER PART, which is the spec's flow.
export function reserve(db, { jobId, stockItemId, estimateLineId, qty: q }) {
  const n = qty(q, 'reservation qty');
  const it = item(db, stockItemId);
  if (it.on_hand - it.reserved < n) {
    return { reserved: false, shortage: n - (it.on_hand - it.reserved), item: it };
  }
  moveReserved(db, stockItemId, n);
  run(db, `INSERT INTO part_reservations (job_id, stock_item_id, estimate_line_id, qty, status, created_at)
           VALUES (?, ?, ?, ?, 'active', ?)`,
    jobId, stockItemId, estimateLineId, n, new Date().toISOString());
  return { reserved: true, shortage: 0, item: item(db, stockItemId) };
}

// Release is idempotent-by-status, not idempotent-by-call: the WHERE status='active' makes a
// double release affect 0 rows and therefore throw, so a leak and a double credit are both
// impossible (invariant 2: released exactly once).
export function release(db, { jobId, stockItemId = null, estimateLineId = null, qty: q = null, reason = null }) {
  // node:sqlite rejects `undefined` as a bound value, so "no filter" must be an explicit NULL.
  // The filter is built as two optional clauses rather than `(? IS NULL OR col = ?)` because a
  // NULL stock_item_id must mean "any item", not "the item that is NULL".
  const where = ['job_id = ?', "status = 'active'"];
  const params = [jobId];
  if (stockItemId !== null) { where.push('stock_item_id = ?'); params.push(stockItemId); }
  if (estimateLineId !== null) { where.push('estimate_line_id = ?'); params.push(estimateLineId); }
  const rows = all(db, `SELECT * FROM part_reservations WHERE ${where.join(' AND ')} ORDER BY id`, ...params);
  // An explicit quantity that matches nothing is a caller bug — almost always a double release —
  // and silently returning 0 would hide it until a stock count disagreed with the ledger.
  // releaseAllForJob() on a job with nothing reserved stays a legitimate no-op (qty === null).
  if (rows.length === 0 && q !== null) {
    throw conflict(`no active reservation matches job ${jobId}${stockItemId !== null ? ` item ${stockItemId}` : ''} to release ${q} from`, { job_id: jobId, stock_item_id: stockItemId, estimate_line_id: estimateLineId, qty: q });
  }
  let released = 0;
  for (const r of rows) {
    const n = q === null ? r.qty : Math.min(qty(q, 'release qty'), r.qty);
    if (n <= 0) continue;
    moveReserved(db, r.stock_item_id, -n);
    const closed = r.qty === n
      ? run(db, `UPDATE part_reservations SET status='released', closed_at=? WHERE id=? AND status='active'`,
          new Date().toISOString(), r.id)
      : run(db, `UPDATE part_reservations SET qty = qty - ? WHERE id=? AND status='active'`, n, r.id);
    if (closed.changes !== 1) throw conflict(`reservation ${r.id} was already closed`, { id: r.id });
    released += n;
  }
  return { released, reason };
}

export function releaseAllForJob(db, jobId) {
  return release(db, { jobId, stockItemId: null, estimateLineId: null });
}

export function activeReservations(db, jobId) {
  return all(db, `SELECT * FROM part_reservations WHERE job_id = ? AND status = 'active' ORDER BY id`, jobId);
}

// Consume: reservation closes AND on_hand drops, exactly once (invariant 11). Splitting
// these would let a crash between them invent stock.
export function consume(db, { jobId, stockItemId, estimateLineId = null, qty: q, staffId = null, at = null }) {
  const n = qty(q, 'consume qty');
  const it = item(db, stockItemId);
  const resv = estimateLineId === null
    ? get(db, `SELECT * FROM part_reservations WHERE job_id=? AND stock_item_id=? AND status='active'`, jobId, stockItemId)
    : get(db, `SELECT * FROM part_reservations WHERE job_id=? AND estimate_line_id=? AND status='active'`, jobId, estimateLineId);
  if (!resv) throw conflict(`no active reservation for ${it.sku} on this job`, { sku: it.sku, jobId });
  if (resv.qty < n) throw conflict(`consumption exceeds reservation for ${it.sku}: reserved ${resv.qty}, asked ${n}`, { reserved: resv.qty, asked: n });

  at = at ?? new Date().toISOString();
  // release the reservation slice first, then issue from on_hand: both are guarded and both
  // are inside the caller's transaction, so partial states cannot survive a failure
  moveReserved(db, resv.stock_item_id, -n);
  if (resv.qty === n) {
    run(db, `UPDATE part_reservations SET status='consumed', closed_at=? WHERE id=? AND status='active'`, at, resv.id);
  } else {
    run(db, `UPDATE part_reservations SET qty = qty - ? WHERE id=? AND status='active'`, n, resv.id);
  }
  const issued = run(db, `UPDATE stock_items SET on_hand = on_hand - ? WHERE id = ? AND on_hand - ? >= 0`, n, resv.stock_item_id, n);
  if (issued.changes !== 1) throw conflict(`cannot issue ${n} x ${it.sku}: on_hand is ${it.on_hand}`, { on_hand: it.on_hand });
  run(db, `INSERT INTO part_consumptions (job_id, estimate_line_id, stock_item_id, qty, by_staff_id, at)
           VALUES (?, ?, ?, ?, ?, ?)`, jobId, estimateLineId, resv.stock_item_id, n, staffId, at);
  return { consumed: n, item: item(db, resv.stock_item_id) };
}

// Consumables are shop supplies that were never quoted, so there is no reservation to draw
// on. Issuing them still decrements on_hand and still writes a part_consumptions row, because
// the invoice's consumable lines read that table — the difference from consume() is only the
// missing reservation.
export function issueUnreserved(db, { jobId, stockItemId, qty: q, staffId = null }) {
  const n = qty(q, 'issue qty');
  const it = item(db, stockItemId);
  const res = run(db, 'UPDATE stock_items SET on_hand = on_hand - ? WHERE id = ? AND on_hand - ? >= 0', n, stockItemId, n);
  if (res.changes !== 1) throw conflict(`cannot issue ${n} x ${it.sku}: on_hand is ${it.on_hand}`, { on_hand: it.on_hand, asked: n });
  run(db, `INSERT INTO part_consumptions (job_id, estimate_line_id, stock_item_id, qty, by_staff_id, at)
           VALUES (?, NULL, ?, ?, ?, ?)`, jobId, stockItemId, n, staffId, new Date().toISOString());
  return { consumed: n, item: item(db, stockItemId) };
}

// Stock adjustment with a mandatory reason: a silent miscount caps sales for weeks.
export function adjust(db, { stockItemId, delta, reason, staffId = null }) {
  if (!Number.isInteger(delta) || delta === 0) throw bad('adjustment delta must be a non-zero integer', { delta });
  const why = text(reason, 'adjustment reason', { max: 200 });
  const it = item(db, stockItemId);
  if (delta < 0 && it.on_hand + delta < it.reserved) {
    throw conflict(`adjustment would push ${it.sku} below its reservations`, { on_hand: it.on_hand, reserved: it.reserved, delta });
  }
  run(db, 'UPDATE stock_items SET on_hand = on_hand + ? WHERE id = ?', delta, stockItemId);
  run(db, 'INSERT INTO stock_adjustments (stock_item_id, delta, reason, actor_id, at) VALUES (?, ?, ?, ?, ?)',
    stockItemId, delta, why, staffId, new Date().toISOString());
  return item(db, stockItemId);
}

// Shortage -> ORDER PART with supplier + ETA. Quantity ordered is the full line qty, not
// just the shortfall: the reserved slice may be consumed by this job, and re-ordering only
// the delta would leave the shelf permanently short.
export function orderPart(db, { jobId, estimateLineId, stockItemId, qty: q, etaDate, staffId = null }) {
  const n = qty(q, 'order qty');
  const it = item(db, stockItemId);
  if (!it.supplier_id) throw conflict(`${it.sku} has no supplier on file; cannot order`, { sku: it.sku });
  const eta = text(etaDate, 'eta_date', { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eta)) throw bad('eta_date must be YYYY-MM-DD', { eta_date: etaDate });
  const dup = get(db, `SELECT id FROM order_parts WHERE job_id=? AND estimate_line_id=? AND status='open'`, jobId, estimateLineId);
  if (dup) throw conflict(`an open order part already exists for line ${estimateLineId}`, { id: dup.id });
  const info = run(db, `INSERT INTO order_parts (job_id, estimate_line_id, stock_item_id, supplier_id, qty_ordered, qty_received, eta_date, status)
           VALUES (?, ?, ?, ?, ?, 0, ?, 'open')`, jobId, estimateLineId, stockItemId, it.supplier_id, n, eta);
  return { id: Number(info.lastInsertRowid), sku: it.sku, qty_ordered: n, eta_date: eta };
}

// Receiving an order part books it in and (re)reserves against the job's line.
export function receiveOrderPart(db, { orderPartId, qty: q, etaDate = null }) {
  const op = get(db, 'SELECT * FROM order_parts WHERE id = ?', orderPartId);
  if (!op) throw notFound(`order part ${orderPartId} not found`);
  if (op.status !== 'open') throw conflict(`order part ${orderPartId} is ${op.status}`, { status: op.status });
  const n = qty(q, 'receive qty');
  if (op.qty_received + n > op.qty_ordered) {
    throw conflict(`receiving ${n} exceeds qty_ordered ${op.qty_ordered} (already received ${op.qty_received})`, { ...op });
  }
  run(db, 'UPDATE stock_items SET on_hand = on_hand + ? WHERE id = ?', n, op.stock_item_id);
  run(db, 'UPDATE order_parts SET qty_received = qty_received + ?, status = ? WHERE id = ?',
    n, op.qty_received + n >= op.qty_ordered ? 'received' : 'open', orderPartId);
  if (etaDate) run(db, 'UPDATE order_parts SET eta_date = ? WHERE id = ?', etaDate, orderPartId);
  const got = get(db, 'SELECT * FROM order_parts WHERE id = ?', orderPartId);
  if (got.status !== 'received') return got;

  // Fully received: the job's reservation for that line must total the LINE qty (a partial
  // reservation may already exist from approval time), so top it up rather than re-reserve.
  const line = get(db, 'SELECT * FROM estimate_lines WHERE id = ?', op.estimate_line_id);
  const active = get(db,
    `SELECT * FROM part_reservations WHERE job_id=? AND estimate_line_id=? AND status='active'`,
    op.job_id, op.estimate_line_id);
  const need = line.qty - (active ? active.qty : 0);
  if (need > 0) {
    if (available(db, op.stock_item_id) < need) {
      throw conflict(`received ${op.stock_item_id} but still short ${need - available(db, op.stock_item_id)} for line ${line.id}`, { line_id: line.id });
    }
    moveReserved(db, op.stock_item_id, need);
    if (active) run(db, 'UPDATE part_reservations SET qty = qty + ? WHERE id = ?', need, active.id);
    else {
      run(db, `INSERT INTO part_reservations (job_id, stock_item_id, estimate_line_id, qty, status, created_at)
               VALUES (?, ?, ?, ?, 'active', ?)`, op.job_id, op.stock_item_id, op.estimate_line_id, need, new Date().toISOString());
    }
  }
  return got;
}

export function openOrderParts(db, jobId) {
  return all(db, `SELECT * FROM order_parts WHERE job_id = ? AND status = 'open' ORDER BY id`, jobId);
}
