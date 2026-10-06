// WHY estimates are append-only once approved: the invoice's entire credibility is "this is
// what the customer approved". Editing an approved line instead of raising a variation is
// the single listed way to break invoice identity, so this module never UPDATEs an approved
// line — corrections go through a variation, and every read of approved amounts is a read of
// a frozen row.
import { conflict, notFound, bad, money, qty, hours, text, run, get, all, oneOf } from '../db.js';
import * as stock from './stock.js';

export const LABOUR_RATE = 85_000;
export const OWNER_RATE = 110_000;

export function estimate(db, id) {
  const e = get(db, 'SELECT * FROM estimates WHERE id = ?', id);
  if (!e) throw notFound(`estimate ${id} not found`);
  return e;
}

export function lines(db, estimateId) {
  return all(db, 'SELECT * FROM estimate_lines WHERE estimate_id = ? ORDER BY id', estimateId);
}

export function original(db, jobId) {
  const e = get(db, `SELECT * FROM estimates WHERE job_id = ? AND kind = 'original' ORDER BY id LIMIT 1`, jobId);
  if (!e) throw notFound(`job ${jobId} has no original estimate`);
  return e;
}

export function openVariation(db, jobId) {
  return get(db, `SELECT * FROM estimates WHERE job_id = ? AND kind = 'variation' AND status = 'pending_approval'`, jobId);
}

export function variations(db, jobId) {
  return all(db, `SELECT * FROM estimates WHERE job_id = ? AND kind = 'variation' ORDER BY id`, jobId);
}

// Amounts are computed HERE, never accepted from the caller: a hand-typed amount is exactly
// the attack the invoice-provenance rule is meant to stop.
function lineAmount(kind, { unitHours, unitRate, qty: n }) {
  return kind === 'labour' ? Math.round(unitHours * unitRate) : n * unitRate;
}

function normaliseLine(db, input, { estimateId, defaultRate }) {
  const kind = oneOf(input.kind, 'line kind', ['labour', 'parts']);
  const description = text(input.description, 'description', { max: 200 });
  if (kind === 'labour') {
    const uh = hours(input.unit_hours ?? input.unitHours, 'unit_hours');
    const rate = money(input.unit_rate ?? input.unitRate ?? defaultRate, 'unit_rate', { max: 10_000_000 });
    const amount = lineAmount('labour', { unitHours: uh, unitRate: rate });
    return { kind, description, qty: 1, unit_hours: uh, unit_rate: rate, part_id: null, core_returnable: 0, amount };
  }
  const partId = input.part_id ?? input.partId;
  if (!Number.isInteger(partId)) throw bad('parts line requires integer part_id', { part_id: partId });
  const it = stock.item(db, partId); // 404 on unknown sku: a line cannot reference a phantom part
  const n = qty(input.qty, 'qty', { max: 999 });
  const rate = money(input.unit_rate ?? input.unitRate ?? it.unit_cost, 'unit_rate', { max: 10_000_000 });
  return {
    kind, description, qty: n, unit_hours: null, unit_rate: rate, part_id: partId,
    core_returnable: it.core_returnable, amount: lineAmount('parts', { qty: n, unitRate: rate }),
  };
}

function insertLine(db, estimateId, l) {
  const info = run(db, `INSERT INTO estimate_lines
      (estimate_id, kind, description, qty, unit_hours, unit_rate, part_id, core_returnable, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    estimateId, l.kind, l.description, l.qty, l.unit_hours, l.unit_rate, l.part_id, l.core_returnable, l.amount);
  return Number(info.lastInsertRowid);
}

function assertMutable(e) {
  if (['approved', 'rejected'].includes(e.status)) {
    throw conflict(`estimate ${e.id} is ${e.status} and its lines are immutable; raise a variation`, { id: e.id, status: e.status });
  }
}

export function createOriginal(db, { jobId, staffId = null, role = 'mechanic' }) {
  if (role !== 'owner' && role !== 'mechanic' && role !== 'advisor') {
    throw conflict(`role '${role}' may not open an estimate`, { role });
  }
  const dup = get(db, `SELECT id FROM estimates WHERE job_id = ? AND kind = 'original'`, jobId);
  if (dup) throw conflict(`job ${jobId} already has original estimate ${dup.id}`, { id: dup.id });
  const info = run(db, `INSERT INTO estimates (job_id, kind, status, created_by, created_at) VALUES (?, 'original', 'draft', ?, ?)`,
    jobId, staffId, new Date().toISOString());
  return estimate(db, Number(info.lastInsertRowid));
}

export function addLine(db, { estimateId, staffRole = 'mechanic', ...line }) {
  const e = estimate(db, estimateId);
  if (e.kind === 'original' && e.status !== 'draft') {
    throw conflict(`original estimate is ${e.status}; submit or raise a variation instead of editing`, { status: e.status });
  }
  assertMutable(e);
  const rate = e.kind === 'original' ? (staffRole === 'owner' ? OWNER_RATE : LABOUR_RATE) : null;
  return insertLine(db, estimateId, normaliseLine(db, line, { estimateId, defaultRate: rate }));
}

export function updateLine(db, lineId, { staffRole = 'mechanic', ...patch }) {
  const cur = get(db, 'SELECT * FROM estimate_lines WHERE id = ?', lineId);
  if (!cur) throw notFound(`estimate line ${lineId} not found`);
  const e = estimate(db, cur.estimate_id);
  assertMutable(e);
  const merged = {
    kind: patch.kind ?? cur.kind,
    description: patch.description ?? cur.description,
    qty: patch.qty ?? cur.qty,
    unit_hours: patch.unit_hours ?? patch.unitHours ?? cur.unit_hours,
    unit_rate: patch.unit_rate ?? patch.unitRate ?? cur.unit_rate,
    part_id: patch.part_id ?? patch.partId ?? cur.part_id,
  };
  const l = normaliseLine(db, merged, { estimateId: e.id, defaultRate: null });
  run(db, `UPDATE estimate_lines SET kind=?, description=?, qty=?, unit_hours=?, unit_rate=?, part_id=?, core_returnable=?, amount=? WHERE id=?`,
    l.kind, l.description, l.qty, l.unit_hours, l.unit_rate, l.part_id, l.core_returnable, l.amount, lineId);
  return get(db, 'SELECT * FROM estimate_lines WHERE id = ?', lineId);
}

export function removeLine(db, lineId) {
  const cur = get(db, 'SELECT * FROM estimate_lines WHERE id = ?', lineId);
  if (!cur) throw notFound(`estimate line ${lineId} not found`);
  const e = estimate(db, cur.estimate_id);
  assertMutable(e);
  if (e.status !== 'draft') throw conflict(`only draft lines can be removed; ${e.id} is ${e.status}`, { status: e.status });
  const used = get(db, 'SELECT id FROM part_reservations WHERE estimate_line_id = ? LIMIT 1', lineId);
  if (used) throw conflict(`line ${lineId} already has a reservation and cannot be removed`, { id: used.id });
  run(db, 'DELETE FROM estimate_lines WHERE id = ?', lineId);
  return { removed: lineId };
}

// diagnosis -> awaiting_approval: at least one line is the spec's precondition.
export function submit(db, estimateId, { staffId = null } = {}) {
  const e = estimate(db, estimateId);
  const n = get(db, 'SELECT COUNT(*) AS n FROM estimate_lines WHERE estimate_id = ?', estimateId).n;
  if (n < 1) throw conflict('an estimate needs at least one line before it can be submitted', { estimate_id: estimateId });
  if (!['draft', 'pending_approval'].includes(e.status)) {
    throw conflict(`estimate ${estimateId} is ${e.status} and cannot be submitted`, { status: e.status });
  }
  run(db, `UPDATE estimates SET status = 'pending_approval', decided_at = ? WHERE id = ?`, new Date().toISOString(), estimateId);
  return estimate(db, estimateId);
}

// Variation: new estimate on a paused job, original untouched (invariant 10 keeps only one
// open at a time, so there is never ambiguity about which decision the invoice should honour).
export function createVariation(db, { jobId, reason, staffId = null }) {
  const why = text(reason, 'variation reason', { max: 300 });
  if (openVariation(db, jobId)) {
    throw conflict(`job ${jobId} already has a pending variation; one decision at a time`, { id: openVariation(db, jobId).id });
  }
  const job = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw notFound(`job ${jobId} not found`);
  if (!['in_progress', 'qc'].includes(job.state)) {
    throw conflict(`a variation can only be raised from in_progress or qc; job is ${job.state}`, { state: job.state });
  }
  const info = run(db, `INSERT INTO estimates (job_id, kind, status, reason, created_by, created_at) VALUES (?, 'variation', 'pending_approval', ?, ?, ?)`,
    jobId, why, staffId, new Date().toISOString());
  return estimate(db, Number(info.lastInsertRowid));
}

export function approve(db, estimateId, { staffId = null, approverRole, channel = null, etaDate = null }) {
  const e = estimate(db, estimateId);
  if (e.status !== 'pending_approval') {
    throw conflict(`only a pending_approval estimate can be approved; ${estimateId} is ${e.status}`, { status: e.status });
  }
  // Self-approve is listed as a MUST-reject: the quote author must not be the approver.
  if (staffId !== null && e.created_by !== null && staffId === e.created_by && approverRole === 'owner') {
    throw conflict('an estimate cannot be approved by the staff member who raised it', { estimate_id: estimateId, staff_id: staffId });
  }
  const partLines = lines(db, estimateId).filter((l) => l.kind === 'parts');
  const now = new Date().toISOString();
  run(db, `UPDATE estimates SET status='approved', approved_by=?, approved_at=?, decided_at=? WHERE id=? AND status='pending_approval'`,
    staffId, now, now, estimateId);

  // Same transaction as the approval, deliberately: invariant 4 requires the availability
  // re-check to be serialised with the write, and invariant 2 requires "approve reserves
  // every part line" to be all-or-nothing.
  //
  // A line that is PARTLY available takes what is there and orders the shortfall: that is the
  // state the seed ships (WO-2404: 1 reserved + 1 open ORDER PART) and it is why
  // awaiting_parts exists as a state at all. A line with NOTHING available reserves nothing
  // and orders the whole qty, which is how "second job loses the race for the last unit"
  // shows up without leaking a partial reservation.
  const shortages = [];
  for (const l of partLines) {
    // Availability is re-read HERE, inside the txn, not by the caller: read-check-write
    // outside the write lock is exactly the race that lets two jobs take the last unit.
    const avail = stock.available(db, l.part_id);
    const take = Math.min(avail, l.qty);
    if (take > 0) stock.reserve(db, { jobId: e.job_id, stockItemId: l.part_id, estimateLineId: l.id, qty: take });
    if (take < l.qty) {
      shortages.push(stock.orderPart(db, {
        jobId: e.job_id, estimateLineId: l.id, stockItemId: l.part_id, qty: l.qty - take,
        etaDate: etaDate ?? defaultEta(), staffId,
      }));
    }
  }
  return { estimate: estimate(db, estimateId), approved_at: now, channel, shortages };
}

function defaultEta() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function reject(db, estimateId, { staffId = null, reason }) {
  const e = estimate(db, estimateId);
  if (e.status !== 'pending_approval') throw conflict(`estimate ${estimateId} is ${e.status}`, { status: e.status });
  const why = text(reason, 'reject reason', { max: 300 });
  run(db, `UPDATE estimates SET status='rejected', approved_by=?, decided_at=?, reject_reason=? WHERE id=?`,
    staffId, new Date().toISOString(), why, estimateId);
  return estimate(db, estimateId);
}

export function total(db, estimateId) {
  return get(db, 'SELECT COALESCE(SUM(amount),0) AS total FROM estimate_lines WHERE estimate_id = ?', estimateId).total;
}

// Only approved sources. Every caller that builds money uses this, so "unapproved variation
// must never appear on an invoice" is one WHERE clause rather than a rule to remember.
export function approvedTotals(db, jobId) {
  const originalTotal = get(db, `
    SELECT COALESCE(SUM(l.amount),0) AS total FROM estimate_lines l
      JOIN estimates e ON e.id = l.estimate_id
     WHERE e.job_id = ? AND e.kind = 'original' AND e.status = 'approved'`, jobId).total;
  const variationTotal = get(db, `
    SELECT COALESCE(SUM(l.amount),0) AS total FROM estimate_lines l
      JOIN estimates e ON e.id = l.estimate_id
     WHERE e.job_id = ? AND e.kind = 'variation' AND e.status = 'approved'`, jobId).total;
  return { originalTotal, variationTotal, total: originalTotal + variationTotal };
}

export function approvedLineRows(db, jobId) {
  return all(db, `
    SELECT l.*, e.kind AS source_kind FROM estimate_lines l
      JOIN estimates e ON e.id = l.estimate_id
     WHERE e.job_id = ? AND e.status = 'approved'
     ORDER BY e.kind, l.id`, jobId);
}

export function consumableLines(db, jobId, { taxable = true } = {}) {
  // Consumables are consumed parts that were never quoted: real cost is not labour+parts.
  return all(db, `
    SELECT c.id, c.qty, c.stock_item_id AS part_id, s.name AS description, s.unit_cost AS unit_price
      FROM part_consumptions c JOIN stock_items s ON s.id = c.stock_item_id
     WHERE c.job_id = ? AND NOT EXISTS (
       SELECT 1 FROM part_reservations r
        WHERE r.job_id = c.job_id AND r.stock_item_id = c.stock_item_id AND r.status <> 'released')
     ORDER BY c.id`, jobId).map((r) => ({ ...r, taxable }));
}
