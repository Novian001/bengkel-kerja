// WHY a report and not a dashboard endpoint per widget: hire/bay decisions come from
// utilisation + rework rate, so the numbers must be computable from one day of history with
// no in-memory state. Everything here is a single aggregate query against the ledger, so a
// wrong number is a wrong query and not a stale cache.
import { get, all } from '../db.js';
import { BLOCK_MIN } from './bays.js';

export function dayBounds(dayIso) {
  return { from: `${dayIso}T00:00:00.000Z`, to: `${dayIso}T23:59:59.999Z` };
}

// Booked blocks / bookable blocks per bay, from bay_block (not from bay_bookings rows): the
// block table is the truth about occupancy, so utilisation cannot disagree with the overlap
// rule that created it.
export function bayUtilisation(db, dayIso) {
  // block_no is an absolute epoch-minutes/15 index, so the day's first and last block are
  // computed from the SAME function the booking path uses. The window must run to the NEXT day
  // (exclusive) or it is empty for every booking except one landing exactly on midnight.
  const nextDay = new Date(new Date(`${dayIso}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  const firstBlock = (d) => Math.floor(new Date(`${d}T00:00:00.000Z`).getTime() / 60000 / BLOCK_MIN);
  const rows = all(db, `
    SELECT b.id, b.name,
           (SELECT COUNT(*) FROM bay_block k WHERE k.bay_id = b.id
              AND k.block_no >= ? AND k.block_no < ?) AS booked_blocks,
           (SELECT COUNT(*) FROM bay_bookings k WHERE k.bay_id = b.id AND k.status = 'booked'
              AND k.start_ts >= ? AND k.start_ts < ?) AS bookings
      FROM bays b WHERE b.active = 1 ORDER BY b.id`,
  firstBlock(dayIso), firstBlock(nextDay), `${dayIso}T00:00:00.000Z`, `${nextDay}T00:00:00.000Z`);
  const openHours = 10; // counter opens 08:00, closes 18:00
  const capacityBlocks = (openHours * 60) / BLOCK_MIN;
  return rows.map((r) => ({
    bay_id: r.id, name: r.name, bookings: r.bookings, booked_blocks: r.booked_blocks,
    capacity_blocks: capacityBlocks,
    utilisation_pct: Math.round((r.booked_blocks / capacityBlocks) * 1000) / 10,
  }));
}

export function jobsByState(db, dayIso) {
  return all(db, `SELECT state, COUNT(*) AS jobs FROM jobs WHERE intake_at <= ? GROUP BY state ORDER BY state`,
    `${dayIso}T23:59:59.999Z`);
}

// Cycle time = completed_at - intake_at in whole hours. Integer maths, no float average of
// timestamps.
export function averageCycleHours(db, dayIso) {
  const rows = all(db, `SELECT intake_at, completed_at FROM jobs
                          WHERE completed_at IS NOT NULL AND completed_at >= ? AND completed_at <= ?`,
    `${dayIso}T00:00:00.000Z`, `${dayIso}T23:59:59.999Z`);
  if (rows.length === 0) return { jobs: 0, avg_hours: null };
  const totalMin = rows.reduce((s, r) => s + (new Date(r.completed_at) - new Date(r.intake_at)) / 60000, 0);
  return { jobs: rows.length, avg_hours: Math.round((totalMin / rows.length) / 6) / 10 }; // 1 decimal
}

// rework rate = failed qc_checks / all qc_checks, plus the job-level rework_count so a
// reviewer can cross-check the two (invariant 12).
export function reworkRate(db, dayIso) {
  const { from, to } = dayBounds(dayIso);
  const q = get(db, `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END), 0) AS failed
                       FROM qc_checks WHERE at >= ? AND at <= ?`, from, to);
  // rework_count is summed over EVERY job, not just the finished ones: a job still being
  // reworked has already paid that cost, and hiding it would make the rate look better than
  // the shop actually is (invariant 12 wants the two to agree).
  const jobs = get(db, 'SELECT COALESCE(SUM(rework_count), 0) AS n FROM jobs');
  return {
    qc_checks: q.total, qc_failed: q.failed,
    rework_rate_pct: q.total === 0 ? 0 : Math.round((q.failed / q.total) * 1000) / 10,
    rework_count_sum: jobs.n,
  };
}

export function revenueBySource(db, dayIso) {
  const { from, to } = dayBounds(dayIso);
  return all(db, `SELECT i.number, i.total, i.tax, i.discount, i.core_credit,
                         (SELECT COALESCE(SUM(l.amount),0) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.source='estimate') AS labour_and_parts,
                         (SELECT COALESCE(SUM(l.amount),0) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.source='variation') AS variation,
                         (SELECT COALESCE(SUM(l.amount),0) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.source='consumable') AS consumables
                    FROM invoices i WHERE i.issued_at >= ? AND i.issued_at <= ? ORDER BY i.issued_at`, from, to);
}

// Estimate vs actual: the only profitability signal the shop has.
export function estimateVsActual(db) {
  return all(db, `
    SELECT j.id, j.number, j.actual_hours, j.rework_count,
           (SELECT COALESCE(SUM(l.amount),0) FROM estimate_lines l JOIN estimates e ON e.id=l.estimate_id
             WHERE e.job_id=j.id AND e.status='approved' AND l.kind='labour') AS quoted_labour,
           -- consumed_value is valued at CURRENT unit_cost, not at the quoted price: the shop's
           -- margin question is "did the parts we actually fitted cost us more than we quoted".
           (SELECT COALESCE(SUM(c.qty * si.unit_cost),0)
              FROM part_consumptions c JOIN stock_items si ON si.id = c.stock_item_id
             WHERE c.job_id=j.id) AS consumed_value
      FROM jobs j WHERE j.actual_hours IS NOT NULL ORDER BY j.id`);
}

export function dailyOps(db, dayIso) {
  const utilisation = bayUtilisation(db, dayIso);
  const states = jobsByState(db, dayIso);
  const cycle = averageCycleHours(db, dayIso);
  const rework = reworkRate(db, dayIso);
  const revenue = revenueBySource(db, dayIso);
  return {
    day: dayIso,
    bay_utilisation: utilisation,
    bay_utilisation_pct: Math.round((utilisation.reduce((s, r) => s + r.utilisation_pct, 0) / (utilisation.length || 1)) * 10) / 10,
    jobs_by_state: states,
    open_jobs: states.filter((s) => !['completed', 'cancelled'].includes(s.state)).reduce((s, r) => s + r.jobs, 0),
    average_cycle_hours: cycle.avg_hours,
    completed_today: cycle.jobs,
    rework,
    revenue_by_invoice: revenue,
    revenue_total: revenue.reduce((s, r) => s + r.total, 0),
    variation_revenue: revenue.reduce((s, r) => s + r.variation, 0),
  };
}

// Customer/vehicle lookup with last-visit summary: repeat faults (the same VFR oil leak) need
// prior jobs in one click.
export function customerHistory(db, { phone = null, plate = null }) {
  let customer = null;
  if (plate) {
    const v = get(db, 'SELECT * FROM vehicles WHERE plate = ?', plate);
    if (!v) return null;
    customer = get(db, 'SELECT * FROM customers WHERE id = ?', v.customer_id);
  } else if (phone) {
    customer = get(db, 'SELECT * FROM customers WHERE phone = ?', phone);
    if (!customer) return null;
  } else {
    throw new Error('customerHistory needs a plate or a phone');
  }
  const vehicles = all(db, 'SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id', customer.id);
  const jobs = all(db, `
    SELECT j.id, j.number, j.state, j.complaint, j.intake_at, j.completed_at, j.rework_count, v.plate
      FROM jobs j JOIN vehicles v ON v.id = j.vehicle_id
     WHERE v.customer_id = ? ORDER BY j.intake_at DESC`, customer.id);
  const last = jobs[0] ?? null;
  return {
    customer, vehicles, jobs, job_count: jobs.length,
    last_visit: last ? { number: last.number, plate: last.plate, complaint: last.complaint, at: last.intake_at } : null,
    lifetime_value: get(db, `SELECT COALESCE(SUM(total),0) AS v FROM invoices i JOIN jobs j2 ON j2.id=i.job_id
                              JOIN vehicles v2 ON v2.id=j2.vehicle_id WHERE v2.customer_id = ?`, customer.id).v,
  };
}
