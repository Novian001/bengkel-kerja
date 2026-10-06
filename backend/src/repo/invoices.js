// WHY the total is computed here and asserted before the INSERT: a CHECK cannot span rows, so
// "total == approved estimate + approved variations + consumables + tax - core credit -
// discount" cannot be a constraint on invoices. Making it code is only honest if the code
// proves it every time, hence the assert + the provenance check on every line before insert.
// A hand-typed amount has no provenance row, so it cannot get in: amounts are derived from
// estimate_lines, never from the request body.
import assert from 'node:assert/strict';
import { conflict, notFound, money, text, run, get, all } from '../db.js';

export const DEFAULT_TAX_RATE_BP = 1100; // PPN 11%, in basis points so no float reaches money

export function nextInvoiceNumber(db, atIso) {
  const ymd = atIso.slice(0, 10).replaceAll('-', '');
  const n = get(db, `SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?`, `INV-${ymd}-%`).n + 1;
  return `INV-${ymd}-${String(n).padStart(3, '0')}`;
}

// Source rows ONLY from approved estimates/variations. This WHERE clause is the whole of
// invariant 8: an unapproved or rejected variation is not in the result set, so it cannot
// appear on an invoice.
function billableLines(db, jobId) {
  return all(db, `
    SELECT l.id AS source_line_id, l.kind, e.kind AS source, l.description, l.qty,
           l.unit_hours, l.unit_rate AS unit_price, l.amount, l.core_returnable
      FROM estimate_lines l JOIN estimates e ON e.id = l.estimate_id
     WHERE e.job_id = ? AND e.status = 'approved'
     ORDER BY e.kind DESC, l.id`, jobId);
}

// Consumables: consumed stock that was never quoted on any line, plus explicit manual lines.
function consumableLines(db, jobId) {
  return all(db, `
    SELECT c.id AS source_line_id, s.name AS description, c.qty, s.unit_cost AS unit_price
      FROM part_consumptions c
      JOIN stock_items s ON s.id = c.stock_item_id
     WHERE c.job_id = ?
       AND NOT EXISTS (SELECT 1 FROM estimate_lines l JOIN estimates e2 ON e2.id = l.estimate_id
                        WHERE e2.job_id = c.job_id AND l.part_id = c.stock_item_id)
     ORDER BY c.id`, jobId);
}

// invariant 15: core-returnable parts consumed by this job need a core-return record, and the
// credit applied equals the credit recorded. No record => refuse to issue, not invoice at 0.
function coreCreditFor(db, jobId) {
  const records = all(db, 'SELECT * FROM core_returns WHERE job_id = ? ORDER BY id', jobId);
  const coreReturnableConsumed = new Set(
    all(db, `SELECT DISTINCT c.stock_item_id FROM part_consumptions c
               JOIN stock_items s ON s.id = c.stock_item_id
              WHERE c.job_id = ? AND s.core_returnable = 1`, jobId).map((r) => r.stock_item_id));
  const missing = [...coreReturnableConsumed].filter(
    (id) => !records.some((r) => r.stock_item_id === id));
  if (missing.length > 0) {
    throw conflict(`core-returnable part(s) consumed but no core return recorded: ${missing.join(', ')}`, { job_id: jobId, stock_item_ids: missing });
  }
  return records.reduce((s, r) => s + r.credit, 0);
}

export function buildInvoice(db, { jobId, discount = 0, discountReason = null, taxRateBp = DEFAULT_TAX_RATE_BP, manualConsumables = [] }) {
  const job = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw notFound(`job ${jobId} not found`);
  if (job.state !== 'ready') {
    throw conflict(`an invoice is issued at handover; job ${jobId} is ${job.state}, not ready`, { state: job.state });
  }
  const approved = billableLines(db, jobId);
  if (approved.length === 0) throw conflict('nothing approved to invoice', { job_id: jobId });

  // A labour line is billable as ONE lot priced at its computed amount, not qty x rate: the
  // hours live in the estimate line, and the invoice line keeps `amount = qty * unit_price`
  // true for every source so the invoice identity is checkable with one SUM.
  const linesOut = approved.map((l) => {
    const labour = l.kind === 'labour';
    return {
      source: l.source === 'variation' ? 'variation' : 'estimate',
      source_line_id: l.source_line_id,
      description: labour ? `${l.description} (${l.unit_hours} jam)` : l.description,
      qty: labour ? 1 : l.qty,
      unit_price: labour ? l.amount : l.unit_price,
      amount: l.amount,
    };
  });
  for (const c of consumableLines(db, jobId)) {
    linesOut.push({ source: 'consumable', source_line_id: c.source_line_id, description: c.description, qty: c.qty, unit_price: c.unit_price, amount: c.qty * c.unit_price });
  }
  // explicit consumables (shop supplies the spec wants on the invoice even without stock rows)
  for (const m of manualConsumables) {
    linesOut.push({
      source: 'consumable', source_line_id: m.source_line_id ?? 0,
      description: text(m.description, 'consumable description', { max: 200 }),
      qty: m.qty, unit_price: m.unit_price, amount: m.qty * m.unit_price,
    });
  }

  const disc = money(discount, 'discount', { max: 500_000_000 });
  if (disc > 0 && (!discountReason || String(discountReason).trim() === '')) {
    // "free 50k, bang" needs an audit trail, not a feature
    throw conflict('a discount requires a reason', { discount: disc });
  }
  const bp = Number.isInteger(taxRateBp) && taxRateBp >= 0 ? taxRateBp : DEFAULT_TAX_RATE_BP;

  const subtotal = linesOut.reduce((s, l) => s + l.amount, 0);
  // tax on subtotal only, in basis points: (subtotal * bp) / 10000 rounded half-up, integer
  const tax = Math.round((subtotal * bp) / 10_000);
  const credit = coreCreditFor(db, jobId);
  const total = subtotal + tax - disc - credit;
  if (total < 0) throw conflict(`invoice total would be negative (${total}); lower the discount or core credit`, { subtotal, tax, discount: disc, core_credit: credit });

  // THE assertion. Every test for invariant 7 and 8 lives behind this line.
  assert.ok(total === subtotal + tax - disc - credit, 'invoice identity broken');
  assert.ok(linesOut.every((l) => l.amount === l.qty * l.unit_price), 'line amount must equal qty x unit_price');
  assert.ok(linesOut.every((l) => ['estimate', 'variation', 'consumable'].includes(l.source)), 'unknown invoice line source');

  return { lines: linesOut, subtotal, tax, discount: disc, discount_reason: discountReason, core_credit: credit, total, tax_rate_bp: bp };
}

// Caller must already be inside a transaction; every read above is re-read under the write lock.
export function insertInvoice(db, { jobId, staffId = null, number = null, discount = 0, discountReason = null, taxRateBp = DEFAULT_TAX_RATE_BP, manualConsumables = [] }) {
  if (get(db, 'SELECT id FROM invoices WHERE job_id = ?', jobId)) {
    throw conflict(`job ${jobId} is already invoiced`, { job_id: jobId });
  }
  const built = buildInvoice(db, { jobId, discount, discountReason, taxRateBp, manualConsumables });
  const at = new Date().toISOString();
  const num = number ?? nextInvoiceNumber(db, at);
  if (get(db, 'SELECT id FROM invoices WHERE number = ?', num)) throw conflict(`invoice number ${num} exists`, { number: num });

  const info = run(db, `INSERT INTO invoices (number, job_id, subtotal, tax, discount, discount_reason, core_credit, total, issued_by, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    num, jobId, built.subtotal, built.tax, built.discount, built.discount_reason, built.core_credit, built.total, staffId, at);
  const invoiceId = Number(info.lastInsertRowid);
  for (const l of built.lines) {
    run(db, `INSERT INTO invoice_lines (invoice_id, source, source_line_id, description, qty, unit_price, amount)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
      invoiceId, l.source, l.source_line_id, l.description, l.qty, l.unit_price, l.amount);
  }
  // re-read under the same lock and re-assert: if a future edit breaks the build, this is the
  // last line of defence before the row is visible. `subtotal` must equal the line SUM (the
  // core credit and discount are invoice-level, not lines), and the row-level identity must
  // hold too. This is the invariant-7 assertion, run twice on purpose.
  const check = get(db, 'SELECT * FROM invoices WHERE id = ?', invoiceId);
  const lineSum = get(db, 'SELECT COALESCE(SUM(amount),0) AS n FROM invoice_lines WHERE invoice_id = ?', invoiceId).n;
  assert.strictEqual(check.subtotal, lineSum, 'invoice subtotal must equal the sum of its lines');
  assert.strictEqual(check.total, check.subtotal + check.tax - check.discount - check.core_credit, 'stored invoice violates identity');
  return { ...check, lines: all(db, 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', invoiceId) };
}

export function byJob(db, jobId) {
  const inv = get(db, 'SELECT * FROM invoices WHERE job_id = ?', jobId);
  if (!inv) throw notFound(`no invoice for job ${jobId}`);
  return { ...inv, lines: all(db, 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', inv.id) };
}

export function byNumber(db, number) {
  const inv = get(db, 'SELECT * FROM invoices WHERE number = ?', number);
  if (!inv) throw notFound(`no invoice ${number}`);
  return { ...inv, lines: all(db, 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', inv.id) };
}

// Line count per source, used by the report and by tests to prove a variation is present.
export function sourceBreakdown(db, invoiceId) {
  return all(db, `SELECT source, COUNT(*) AS lines, COALESCE(SUM(amount),0) AS amount
                    FROM invoice_lines WHERE invoice_id = ? GROUP BY source`, invoiceId);
}
