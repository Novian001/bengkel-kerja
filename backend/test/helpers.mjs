// WHY a shared harness instead of a base class: every test needs the same three things — a
// migrated in-memory DB, the seeded baseline, and a way to drive a job through the workflow.
// Exporting them as plain functions keeps each test file self-describing and lets a test use a
// bare DB when it wants to prove something about the schema alone, with no fixture in the way.
import { openDb, migrate, get, all, tx, ValidationError } from '../src/db.js';
import { seed } from '../src/seed.js';
import * as jobs from '../src/repo/jobs.js';
import * as estimates from '../src/repo/estimates.js';
import * as stock from '../src/repo/stock.js';
import * as bays from '../src/repo/bays.js';
import * as invoices from '../src/repo/invoices.js';

export { get, all, tx, ValidationError, jobs, estimates, stock, bays, invoices };

export function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

export function seededDb() {
  const db = emptyDb();
  seed(db);
  return db;
}

export function staff(db, role) {
  return get(db, 'SELECT * FROM staff WHERE role = ?', role);
}

export function skuId(db, sku) {
  return get(db, 'SELECT id FROM stock_items WHERE sku = ?', sku).id;
}

export function jobNumber(db, number) {
  return get(db, 'SELECT * FROM jobs WHERE number = ?', number);
}

export function doneChecklist(db, jobId) {
  for (const it of all(db, 'SELECT id FROM job_checklist_items WHERE job_id = ?', jobId)) {
    jobs.checkItem(db, it.id, { done: true });
  }
}

// Walk a job to `awaiting_approval` with the given lines. Returns { jobId, estimateId }.
export function toAwaitingApproval(db, { vehicleId, complaint = 'test complaint', lines, number = null }) {
  const j = jobs.createJob(db, { vehicleId, complaint, number });
  doneChecklist(db, j.id);
  jobs.transition(db, { jobId: j.id, to: 'diagnosis', role: 'mechanic' });
  const e = estimates.createOriginal(db, { jobId: j.id });
  for (const l of lines) estimates.addLine(db, { ...l, estimateId: e.id });
  estimates.submit(db, e.id, {});
  jobs.transition(db, { jobId: j.id, to: 'awaiting_approval', role: 'mechanic' });
  return { jobId: j.id, estimateId: e.id };
}

// Walk a job all the way to `ready`, with the quoted parts actually consumed. The invoice is
// issued separately so the invoice test can control discount and core-credit numbers.
export function toReady(db, {
  vehicleId, complaint = 'test complaint', number = null,
  labour = { kind: 'labour', description: 'lapangan', unit_hours: 1 },
  parts = [], consumeParts = true, coreReturn = null, actualHours = 1, bookBay = true,
}) {
  const ctx = toAwaitingApproval(db, { vehicleId, complaint, number, lines: [labour, ...parts] });
  const owner = staff(db, 'owner');
  const mech = staff(db, 'mechanic');
  const after = jobs.transition(db, { jobId: ctx.jobId, to: 'approved', role: 'owner', staffId: owner.id });
  if (after.state !== 'approved') return { ...ctx, state: after.state }; // landed on awaiting_parts
  if (bookBay) {
    bays.createBooking(db, {
      jobId: ctx.jobId, bayId: bays.bays(db)[0].id,
      startTs: new Date('2026-04-01T02:00:00Z').toISOString(), durationMin: 60,
    });
  }
  jobs.transition(db, { jobId: ctx.jobId, to: 'in_progress', role: 'mechanic', staffId: mech.id });
  if (consumeParts) {
    for (const l of estimates.lines(db, ctx.estimateId).filter((x) => x.kind === 'parts')) {
      stock.consume(db, { jobId: ctx.jobId, stockItemId: l.part_id, estimateLineId: l.id, qty: l.qty });
    }
  }
  jobs.recordActualHours(db, ctx.jobId, actualHours);
  jobs.transition(db, { jobId: ctx.jobId, to: 'qc', role: 'mechanic', staffId: mech.id });
  if (coreReturn) jobs.recordCoreReturn(db, { jobId: ctx.jobId, ...coreReturn });
  jobs.recordQc(db, { jobId: ctx.jobId, passed: true, staffId: owner.id });
  jobs.transition(db, { jobId: ctx.jobId, to: 'ready', role: 'owner', staffId: owner.id });
  return { ...ctx, state: 'ready' };
}

export function vehicleId(db, plate) {
  return get(db, 'SELECT id FROM vehicles WHERE plate = ?', plate).id;
}
