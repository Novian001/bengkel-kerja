// WHY every state change funnels through transition() here: the spec's value is "rejected
// edges change nothing", which needs (a) role+edge checked BEFORE any write and (b) every
// write for one edge inside one BEGIN IMMEDIATE with the state-log append. If handlers were
// allowed to `UPDATE jobs SET state=...` directly, the audit trail and the release-on-cancel
// rules would be optional. Handlers call transition(); nothing else moves a job.
import {
  tx, conflict, notFound, bad, money, qty, hours, text, run, get, all, oneOf, ValidationError,
} from '../db.js';
import { assertTransition, STATES } from '../state-machine.js';
import * as stock from './stock.js';
import * as bays from './bays.js';
import * as estimates from './estimates.js';
import { insertInvoice } from './invoices.js';

export function job(db, id) {
  const j = get(db, 'SELECT * FROM jobs WHERE id = ?', id);
  if (!j) throw notFound(`job ${id} not found`);
  return j;
}

export function jobByNumber(db, number) {
  const j = get(db, 'SELECT * FROM jobs WHERE number = ?', number);
  if (!j) throw notFound(`job ${number} not found`);
  return j;
}

// The job board: "sudah kelar belum?" is a GROUP BY, not a per-job lookup.
export function board(db) {
  return all(db, 'SELECT state, COUNT(*) AS jobs FROM jobs GROUP BY state ORDER BY state');
}

export function detail(db, id) {
  const j = job(db, id);
  const est = all(db, 'SELECT * FROM estimates WHERE job_id = ? ORDER BY id', id);
  return {
    job: j,
    estimates: est.map((e) => ({ ...e, lines: estimates.lines(db, e.id), total: estimates.total(db, e.id) })),
    reservations: stock.activeReservations(db, id),
    order_parts: stock.openOrderParts(db, id),
    consumptions: all(db, 'SELECT * FROM part_consumptions WHERE job_id = ? ORDER BY id', id),
    bay_bookings: bays.bookingsForJob(db, id),
    qc_checks: all(db, 'SELECT * FROM qc_checks WHERE job_id = ? ORDER BY id', id),
    core_returns: all(db, 'SELECT * FROM core_returns WHERE job_id = ? ORDER BY id', id),
    invoice: get(db, 'SELECT * FROM invoices WHERE job_id = ?', id) ?? null,
    state_log: all(db, 'SELECT * FROM job_state_log WHERE job_id = ? ORDER BY id', id),
  };
}

// ---------------------------------------------------------------- guards

function g_intake_checklist_done(db, j) {
  const open = get(db, 'SELECT COUNT(*) AS n FROM job_checklist_items WHERE job_id = ? AND done = 0', j.id).n;
  if (open > 0) throw conflict(`intake checklist has ${open} item(s) not done`, { job_id: j.id, open });
  if (!j.complaint.trim()) throw conflict('job has no complaint recorded', { job_id: j.id });
}

function g_estimate_has_lines(db, j) {
  const e = get(db, `SELECT * FROM estimates WHERE job_id = ? AND kind='original'`, j.id);
  if (!e) throw conflict('job has no original estimate', { job_id: j.id });
  if (e.status !== 'pending_approval') {
    throw conflict(`original estimate is ${e.status}; submit it for approval before moving on`, { status: e.status });
  }
  if (get(db, 'SELECT COUNT(*) AS n FROM estimate_lines WHERE estimate_id = ?', e.id).n < 1) {
    throw conflict('job has no estimate line', { job_id: j.id });
  }
}

function g_estimate_approved_with_provenance(db, j) {
  const e = get(db, `SELECT * FROM estimates WHERE job_id = ? AND kind='original' AND status='pending_approval'`, j.id);
  if (!e) throw conflict('no pending original estimate to approve', { job_id: j.id });
  return e;
}

function g_nothing_reserved(db, j) {
  const n = stock.activeReservations(db, j.id).length;
  if (n > 0) throw conflict(`cannot cancel before approval: ${n} active reservation(s) exist`, { job_id: j.id });
}

// Approving reserves every part line in one txn, so "shortage" means: some line got a
// partial-or-zero reservation and now has an ORDER PART. Invariant 13 then holds by
// construction: awaiting_parts <=> >=1 open order part.
function g_estimate_approved_with_provenanceAndReserve(db, j, payload = {}) {
  const e = g_estimate_approved_with_provenance(db, j);
  const res = estimates.approve(db, e.id, {
    staffId: payload.staffId ?? null,
    approverRole: payload.role ?? 'owner',
    channel: payload.channel ?? null,
    etaDate: payload.etaDate ?? null,
  });
  // a shortage during approval lands the job on awaiting_parts, not approved, so
  // invariant 13 holds by construction instead of by a later cleanup pass
  return res.shortages.length > 0 ? { ...res, next: 'awaiting_parts' } : { ...res, next: 'approved' };
}

function g_shortage_creates_orders(db, j) {
  // entering awaiting_parts from approved: every short line must already have an ORDER PART
  const short = all(db, `
    SELECT l.id, l.part_id, l.qty FROM estimate_lines l
      JOIN estimates e ON e.id = l.estimate_id
     WHERE e.job_id = ? AND e.status='approved' AND l.kind='parts'
       AND (SELECT COALESCE(SUM(r.qty),0) FROM part_reservations r
             WHERE r.estimate_line_id = l.id AND r.status='active') < l.qty`, j.id);
  if (short.length === 0) throw conflict('no short part line: nothing to order', { job_id: j.id });
  for (const l of short) {
    if (!get(db, `SELECT id FROM order_parts WHERE job_id=? AND estimate_line_id=? AND status='open'`, j.id, l.id)) {
      stock.orderPart(db, { jobId: j.id, estimateLineId: l.id, stockItemId: l.part_id, qty: l.qty, etaDate: null });
    }
  }
  return short;
}

function g_bay_booked_and_parts_ready(db, j) {
  if (!bays.bookingsForJob(db, j.id).some((b) => b.status === 'booked')) {
    throw conflict('job has no booked bay; book a lift before starting work', { job_id: j.id });
  }
  const short = all(db, `
    SELECT l.id FROM estimate_lines l
      JOIN estimates e ON e.id = l.estimate_id
     WHERE e.job_id = ? AND e.status='approved' AND l.kind='parts'
       AND (SELECT COALESCE(SUM(r.qty),0) FROM part_reservations r
             WHERE r.estimate_line_id = l.id AND r.status='active') < l.qty`, j.id);
  if (short.length > 0) {
    throw conflict(`cannot start work: ${short.length} approved part line(s) are not fully reserved and have no stock`, { job_id: j.id, lines: short.map((s) => s.id) });
  }
}

function g_no_open_order_parts(db, j) {
  const open = stock.openOrderParts(db, j.id);
  if (open.length > 0) {
    throw conflict(`wait for parts: ${open.length} open ORDER PART row(s) remain`, { job_id: j.id, open_order_parts: open.map((o) => o.id) });
  }
}

function g_actuals_recorded(db, j) {
  if (j.actual_hours === null) throw conflict('record actual hours before sending to QC', { job_id: j.id });
  // Consuming every quoted part is NOT mandatory (jobs swap parts out and old cores come off),
  // but actual hours IS: "invoice cannot be built later" is the listed reason for rejecting.
  return true;
}

function g_variation_pending(db, j) {
  const v = estimates.openVariation(db, j.id);
  if (!v) throw conflict('in_progress -> awaiting_approval requires a pending_approval variation', { job_id: j.id });
  return v;
}

function g_qc_passed(db, j) {
  const checks = all(db, 'SELECT * FROM qc_checks WHERE job_id = ? ORDER BY id', j.id);
  const last = checks.at(-1);
  if (!last) throw conflict('QC checklist is empty: run a QC check before marking ready', { job_id: j.id });
  if (!last.passed) throw conflict('latest QC check failed; rework before handing over', { job_id: j.id, at: last.at, reason: last.reason });
  return last;
}

function g_qc_failed_counts_rework(db, j) {
  const checks = all(db, 'SELECT * FROM qc_checks WHERE job_id = ? ORDER BY id', j.id);
  const last = checks.at(-1);
  if (!last) throw conflict('qc -> in_progress requires a failed QC check, not a hand-typed state', { job_id: j.id });
  if (last.passed) throw conflict('latest QC check passed; qc -> in_progress is a rework edge and needs a fail', { job_id: j.id });
  if (!last.reason || last.reason.trim() === '') throw conflict('QC fail requires a non-empty reason', { job_id: j.id });
  return last;
}

function g_invoice_issued(db, j) {
  if (!get(db, 'SELECT id FROM invoices WHERE job_id = ?', j.id)) {
    throw conflict('ready -> completed requires an issued invoice', { job_id: j.id });
  }
}

function g_no_invoice(db, j) {
  if (get(db, 'SELECT id FROM invoices WHERE job_id = ?', j.id)) {
    throw conflict('cannot cancel a job that already has an invoice: settled money', { job_id: j.id });
  }
}

function g_handover_rejected(db, j) {
  if (!get(db, 'SELECT id FROM qc_checks WHERE job_id = ?', j.id)) {
    throw conflict('ready -> in_progress (customer rejects) requires a QC/handover record', { job_id: j.id });
  }
}

function g_variation_approved(db, j, payload = {}) {
  const v = estimates.openVariation(db, j.id);
  if (!v) throw conflict('awaiting_approval -> in_progress is only legal when deciding a variation', { job_id: j.id });
  if (!v.reason || v.reason.trim() === '') throw conflict('variation has no reason recorded', { variation_id: v.id });
  return v;
}

function g_variation_declined(db, j) {
  const v = estimates.openVariation(db, j.id);
  if (!v) throw conflict('awaiting_approval -> in_progress is only legal when declining a variation', { job_id: j.id });
  return v;
}

const GUARDS = {
  intake_checklist_done: g_intake_checklist_done,
  estimate_has_lines: g_estimate_has_lines,
  estimate_approved_with_provenance: g_estimate_approved_with_provenanceAndReserve,
  nothing_reserved: g_nothing_reserved,
  shortage_creates_orders: g_shortage_creates_orders,
  bay_booked_and_parts_ready: g_bay_booked_and_parts_ready,
  no_open_order_parts: g_no_open_order_parts,
  actuals_recorded: g_actuals_recorded,
  variation_pending: g_variation_pending,
  qc_passed: g_qc_passed,
  qc_failed_counts_rework: g_qc_failed_counts_rework,
  invoice_issued: g_invoice_issued,
  no_invoice: g_no_invoice,
  handover_rejected: g_handover_rejected,
  variation_declined: g_variation_declined,
  variation_approved: g_variation_approved,
};

// Edge side effects, keyed by guard id so the effect can only ever run on the edge that owns
// it. They run AFTER every guard has passed and BEFORE the state write, inside the same txn.
const EFFECTS = {
  // At handover the job is finished with its stock: anything still reserved but unconsumed
  // goes back on the shelf, or a shop slowly sinks its own inventory into finished jobs.
  qc_passed(db, j) {
    const rel = stock.releaseAllForJob(db, j.id);
    if (rel.released > 0) bays.cancelAllForJob(db, j.id);
    return { released_qty: rel.released };
  },
  // a variation pauses the job, so the bay slot is held (not freed) while the customer
  // decides: releasing it would let another job jump the queue during a sales conversation
  variation_pending(db, j) {
    for (const b of bays.bookingsForJob(db, j.id)) if (b.status === 'booked') bays.pauseBooking(db, b.id);
  },
  variation_approved(db, j, ctx) {
    const v = g_variation_approved(db, j, ctx.payload);
    const res = estimates.approve(db, v.id, {
      staffId: ctx.staffId ?? null, approverRole: ctx.payload?.role ?? 'owner',
      channel: ctx.payload?.channel ?? null, etaDate: ctx.payload?.etaDate ?? null,
    });
    for (const b of bays.bookingsForJob(db, j.id)) if (b.status === 'paused') bays.resumeBooking(db, b.id);
    return { ...res, next: res.shortages.length > 0 ? 'awaiting_parts' : 'in_progress' };
  },
  shortage_creates_orders(db, j) {
    // entering awaiting_parts from approved: the guard already created the ORDER PARTs
    for (const b of bays.bookingsForJob(db, j.id)) if (b.status === 'booked') bays.pauseBooking(db, b.id);
  },
  qc_failed_counts_rework(db, j) {
    // invariant 12: exactly one increment per failed check, done here rather than at check
    // creation so the increment and the state move cannot diverge
    run(db, 'UPDATE jobs SET rework_count = rework_count + 1 WHERE id = ?', j.id);
  },
  no_invoice(db, j, ctx) {
    // Cancelling is a business decision, so the reason is mandatory and stored on the row:
    // "cancelled" without a why is the same unfalsifiable gap as a QC fail without a reason.
    const rel = stock.releaseAllForJob(db, j.id);
    bays.cancelAllForJob(db, j.id);
    for (const op of all(db, `SELECT id FROM order_parts WHERE job_id = ? AND status='open'`, j.id)) {
    run(db, `UPDATE order_parts SET status='cancelled' WHERE id = ?`, op.id);
    }
    return { released_qty: rel.released };
  },
  invoice_issued(db, j) {
    run(db, 'UPDATE jobs SET completed_at = ? WHERE id = ?', new Date().toISOString(), j.id);
  },
  variation_declined(db, j, ctx) {
    const v = estimates.openVariation(db, j.id);
    estimates.reject(db, v.id, { reason: 'variation declined by customer', staffId: ctx.staffId ?? null });
    for (const b of bays.bookingsForJob(db, j.id)) if (b.status === 'paused') bays.resumeBooking(db, b.id);
  },
};

// ---------------------------------------------------------------- writes

export function createJob(db, { vehicleId, complaint, intakeAt, advisorId = null, mechanicId = null, number = null, checklist = null }) {
  const c = text(complaint, 'complaint', { max: 500 });
  const at = intakeAt ? new Date(intakeAt).toISOString() : new Date().toISOString();
  // vehicle_id is validated as a positive integer before it is bound: node:sqlite throws a
  // TypeError on `undefined`, which would surface as a 500 instead of a 400
  if (!Number.isInteger(vehicleId) || vehicleId <= 0) throw bad('vehicle_id must be a positive integer', { vehicle_id: vehicleId });
  if (!get(db, 'SELECT id FROM vehicles WHERE id = ?', vehicleId)) throw bad('vehicle not found', { vehicle_id: vehicleId });
  const wo = number ?? nextJobNumber(db, at);
  if (get(db, 'SELECT id FROM jobs WHERE number = ?', wo)) throw conflict(`job number ${wo} exists`, { number: wo });
  const info = run(db, `INSERT INTO jobs (number, vehicle_id, state, complaint, intake_at, advisor_id, mechanic_id)
           VALUES (?, ?, 'intake', ?, ?, ?, ?)`, wo, vehicleId, c, at, advisorId, mechanicId);
  const id = Number(info.lastInsertRowid);
  for (const label of (checklist ?? DEFAULT_CHECKLIST)) {
    run(db, 'INSERT INTO job_checklist_items (job_id, label) VALUES (?, ?)', id, label);
  }
  run(db, 'INSERT INTO job_state_log (job_id, from_state, to_state, actor_role, at) VALUES (?, NULL, ?, ?, ?)', id, 'intake', ctxRole(db, advisorId), at);
  return job(db, id);
}

const DEFAULT_CHECKLIST = ['keluhan dicatat', 'kendaraan diperiksa', 'km dicatat', 'foto diambil'];

function ctxRole(db, staffId) {
  if (staffId === null) return 'owner';
  return get(db, 'SELECT role FROM staff WHERE id = ?', staffId)?.role ?? 'owner';
}

function nextJobNumber(db, at) {
  const d = new Date(at);
  const ymd = d.toISOString().slice(0, 10).replaceAll('-', '');
  const n = get(db, `SELECT COUNT(*) AS n FROM jobs WHERE number LIKE ?`, `WO-${ymd}-%`).n + 1;
  return `WO-${ymd}-${String(n).padStart(3, '0')}`;
}

export function checkItem(db, itemId, { done, staffId = null }) {
  const it = get(db, 'SELECT * FROM job_checklist_items WHERE id = ?', itemId);
  if (!it) throw notFound(`checklist item ${itemId} not found`);
  const at = done ? new Date().toISOString() : null;
  run(db, 'UPDATE job_checklist_items SET done = ?, checked_at = ? WHERE id = ?', done ? 1 : 0, at, itemId);
  if (done) run(db, 'INSERT INTO notifications (job_id, kind, message, at) VALUES (?, ?, ?, ?)', it.job_id, 'checklist', `intake checklist item done: ${it.label}`, at);
  return get(db, 'SELECT * FROM job_checklist_items WHERE id = ?', itemId);
}

// THE single write path for state. Every caller passes through here.
export function transition(db, { jobId, to, role, staffId = null, payload = {} }) {
  oneOf(to, 'to', STATES);
  return tx(db, () => {
    const j = job(db, jobId);
    const edgeDef = assertTransition(j.state, to, role); // 403/409 BEFORE any write
    // A guard may both validate and act (approval reserves parts and opens ORDER PARTs), and
    // it may return the state the job should actually land on. Both flow through `info`.
    const guardInfo = edgeDef.guard ? GUARDS[edgeDef.guard](db, j, payload, { staffId, role }) : null;
    const at = new Date().toISOString();
    const effect = EFFECTS[edgeDef.guard];
    const info = effect ? effect(db, j, { staffId, payload, role }) : guardInfo;
    const actualTo = info?.next ?? to; // approval with shortage lands on awaiting_parts
    if (actualTo !== to) assertTransition(j.state, actualTo, role);

    run(db, 'UPDATE jobs SET state = ?, cancel_reason = ? WHERE id = ? AND state = ?',
      actualTo, actualTo === 'cancelled' ? (text(payload.cancel_reason ?? '', 'cancel_reason', { max: 300 })) : j.cancel_reason,
      jobId, j.state);
    if (to === 'approved' || actualTo === 'approved') run(db, 'UPDATE jobs SET approved_at = ? WHERE id = ?', at, jobId);
    if (role === 'mechanic' && staffId !== null) run(db, 'UPDATE jobs SET mechanic_id = COALESCE(mechanic_id, ?) WHERE id = ?', staffId, jobId);
    run(db, 'INSERT INTO job_state_log (job_id, from_state, to_state, actor_id, actor_role, at) VALUES (?, ?, ?, ?, ?, ?)',
      jobId, j.state, actualTo, staffId, role, at);
    if (actualTo === 'ready') {
      run(db, 'INSERT INTO notifications (job_id, kind, message, at) VALUES (?, ?, ?, ?)',
        jobId, 'ready', 'kendaraan siap diambil', at);
    }
    if (actualTo === 'approved' || actualTo === 'awaiting_parts') {
      run(db, 'INSERT INTO notifications (job_id, kind, message, at) VALUES (?, ?, ?, ?)',
        jobId, 'approved', 'estimasi disetujui, pekerjaan akan dimulai', at);
    }
    return { ...job(db, jobId), state_log_appended: true, effect: info ?? null };
  });
}

// ---------------------------------------------------------------- operational writes

export function recordActualHours(db, jobId, value) {
  const h = hours(value, 'actual_hours');
  const j = job(db, jobId);
  if (!['in_progress', 'qc'].includes(j.state)) {
    throw conflict(`actuals can only be recorded while work is in progress; job is ${j.state}`, { state: j.state });
  }
  run(db, 'UPDATE jobs SET actual_hours = ? WHERE id = ?', h, jobId);
  return job(db, jobId);
}

// QC record. A FAIL is only recorded together with its reason (CHECK enforces), and the
// rework increment happens on the qc -> in_progress edge, once.
// `at` is overridable so the seed can date its checks to the day being demonstrated; the API
// never passes it, so a live QC check is always stamped now.
export function recordQc(db, { jobId, passed, reason = null, staffId = null, at = null }) {
  if (typeof passed !== 'boolean') throw bad('passed must be a boolean', { passed });
  const j = job(db, jobId);
  if (!['qc', 'in_progress'].includes(j.state)) {
    throw conflict(`QC can only be recorded in qc or in_progress; job is ${j.state}`, { state: j.state });
  }
  if (!passed && (!reason || String(reason).trim() === '')) throw bad('a failed QC needs a reason', { job_id: jobId });
  const why = reason === null ? null : text(reason, 'qc reason', { max: 300 });
  const info = run(db, 'INSERT INTO qc_checks (job_id, passed, reason, checked_by, at) VALUES (?, ?, ?, ?, ?)',
    jobId, passed ? 1 : 0, why, staffId, at ?? new Date().toISOString());
  return get(db, 'SELECT * FROM qc_checks WHERE id = ?', Number(info.lastInsertRowid));
}

export function recordCoreReturn(db, { jobId, stockItemId, condition, credit, staffId = null, at = null }) {
  const cond = oneOf(condition, 'condition', ['layak_tukar_tambah', 'layak_jual', 'bukan_komponen']);
  const cr = money(credit, 'credit', { max: 100_000_000 });
  const it = stock.item(db, stockItemId);
  if (!it.core_returnable) throw conflict(`${it.sku} is not a core-returnable part`, { sku: it.sku });
  const info = run(db, 'INSERT INTO core_returns (job_id, stock_item_id, condition, credit, at) VALUES (?, ?, ?, ?, ?)',
    jobId, stockItemId, cond, cr, at ?? new Date().toISOString());
  return get(db, 'SELECT * FROM core_returns WHERE id = ?', Number(info.lastInsertRowid));
}

// Convenience for the invoice path: issue + move ready -> completed in ONE txn so a job can
// never hold an invoice while sitting in `ready`.
export function closeJobWithInvoice(db, { jobId, role, staffId = null, number, discount = 0, discountReason = null, taxRateBp = 1100 }) {
  return tx(db, () => {
    insertInvoice(db, { jobId, staffId, number, discount, discountReason, taxRateBp });
    return transition(db, { jobId, to: 'completed', role, staffId, payload: {} });
  });
}
