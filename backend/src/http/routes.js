// WHY a hand-written router instead of a framework: the whole surface is ~25 paths and the
// interesting behaviour is the error shape, not the plumbing. A tiny table of [method, regex,
// handler] keeps every route visible in one screen and costs zero dependencies.
//
// The invariant boundary is here: this module NEVER writes to the DB. It parses, validates,
// calls one repo function, and maps thrown ValidationErrors to 4xx. Any 500 that escapes is a
// genuine bug rather than a business rule, which is what makes the 4xx tests meaningful.
import { actorFromHeaders } from '../auth.js';
import { bad, notFound, ValidationError, get, all, tx, dateOnlyOrThrow } from '../db.js';
import * as jobs from '../repo/jobs.js';
import * as estimates from '../repo/estimates.js';
import * as stock from '../repo/stock.js';
import * as bays from '../repo/bays.js';
import * as invoices from '../repo/invoices.js';
import * as reports from '../repo/reports.js';

const json = (v) => JSON.stringify(v);

// Body limit: a work order is kilobytes, not megabytes. An unbounded read is how a demo
// backend gets OOM-killed on a 2 GB box.
const MAX_BODY = 256 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw bad(`request body exceeds ${MAX_BODY} bytes`, { max: MAX_BODY });
    chunks.push(c);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw bad('body is not valid JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw bad('body must be a JSON object');
  }
  return parsed;
}

// staffId from x-staff name -> staff.id. Names are the demo identity; the header carries a
// name, not an id, because auth.js deliberately does not pretend to authenticate.
function staffIdOf(db, actor) {
  if (!actor.staffName) return null;
  return get(db, 'SELECT id FROM staff WHERE name = ?', actor.staffName)?.id ?? null;
}

function intParam(raw, field) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${field} must be a positive integer`, { got: raw });
  return n;
}

// ---------------------------------------------------------------- handlers

export const routes = [
  ['GET', /^\/health$/, () => ({ ok: true })],

  ['GET', /^\/api\/board$/, (db) => ({ board: jobs.board(db) })],

  ['GET', /^\/api\/jobs$/, (db, _m, { query }) => ({
    jobs: all(db, `SELECT j.*, v.plate, c.name AS customer
                    FROM jobs j JOIN vehicles v ON v.id = j.vehicle_id
                    JOIN customers c ON c.id = v.customer_id
                   ${query.state ? 'WHERE j.state = ?' : ''}
                   ORDER BY j.intake_at DESC, j.id DESC`, ...(query.state ? [query.state] : [])),
  })],

  ['POST', /^\/api\/jobs$/, (db, _m, { body, actor }) => ({
    job: jobs.createJob(db, {
      vehicleId: body.vehicle_id,
      complaint: body.complaint,
      intakeAt: body.intake_at,
      number: body.number ?? null,
      advisorId: body.advisor_id ?? staffIdOf(db, actor),
      mechanicId: body.mechanic_id ?? null,
      checklist: body.checklist ?? null,
    }),
  })],

  ['GET', /^\/api\/jobs\/(\d+)$/, (db, m) => jobs.detail(db, Number(m[1]))],

  ['POST', /^\/api\/jobs\/(\d+)\/transition$/, (db, m, { body, actor }) => ({
    job: jobs.transition(db, {
      jobId: Number(m[1]),
      to: body.to,
      role: actor.role,
      staffId: staffIdOf(db, actor),
      payload: {
        role: actor.role,
        channel: body.channel ?? null,
        etaDate: body.eta_date ?? null,
        cancel_reason: body.cancel_reason ?? null,
      },
    }),
  })],

  ['POST', /^\/api\/jobs\/(\d+)\/checklist\/(\d+)$/, (db, m, { body }) => ({
    item: jobs.checkItem(db, Number(m[2]), { done: body.done === true, staffId: body.staff_id ?? null }),
  })],

  ['POST', /^\/api\/jobs\/(\d+)\/hours$/, (db, m, { body }) => ({
    job: jobs.recordActualHours(db, Number(m[1]), body.actual_hours),
  })],

  ['POST', /^\/api\/jobs\/(\d+)\/qc$/, (db, m, { body, actor }) => ({
    check: jobs.recordQc(db, {
      jobId: Number(m[1]), passed: body.passed, reason: body.reason ?? null, staffId: staffIdOf(db, actor),
    }),
  })],

  ['POST', /^\/api\/jobs\/(\d+)\/consume$/, (db, m, { body, actor }) => ({
    result: stock.consume(db, {
      jobId: Number(m[1]), stockItemId: body.stock_item_id, estimateLineId: body.estimate_line_id ?? null,
      qty: body.qty, staffId: staffIdOf(db, actor),
    }),
  })],

  ['POST', /^\/api\/jobs\/(\d+)\/issue$/, (db, m, { body, actor }) => ({
    result: stock.issueUnreserved(db, {
      jobId: Number(m[1]), stockItemId: body.stock_item_id, qty: body.qty, staffId: staffIdOf(db, actor),
    }),
  })],

  ['POST', /^\/api\/jobs\/(\d+)\/core-return$/, (db, m, { body, actor }) => ({
    core_return: jobs.recordCoreReturn(db, {
      jobId: Number(m[1]), stockItemId: body.stock_item_id, condition: body.condition,
      credit: body.credit, staffId: staffIdOf(db, actor),
    }),
  })],

  ['POST', /^\/api\/jobs\/(\d+)\/close$/, (db, m, { body, actor }) => ({
    job: jobs.closeJobWithInvoice(db, {
      jobId: Number(m[1]), role: actor.role, staffId: staffIdOf(db, actor),
      number: body.number ?? null, discount: body.discount ?? 0,
      discountReason: body.discount_reason ?? null, taxRateBp: body.tax_rate_bp ?? undefined,
    }),
  })],

  // ---- estimates
  ['POST', /^\/api\/jobs\/(\d+)\/estimates$/, (db, m, { body, actor }) => {
    const jobId = Number(m[1]);
    if (body.kind === 'variation') {
      return { estimate: estimates.createVariation(db, { jobId, reason: body.reason, staffId: staffIdOf(db, actor) }) };
    }
    return { estimate: estimates.createOriginal(db, { jobId, staffId: staffIdOf(db, actor), role: actor.role }) };
  }],

  ['POST', /^\/api\/estimates\/(\d+)\/lines$/, (db, m, { body, actor }) => ({
    line_id: estimates.addLine(db, { ...body, estimateId: Number(m[1]), staffRole: actor.role }),
  })],

  ['PATCH', /^\/api\/estimates\/(\d+)\/lines\/(\d+)$/, (db, m, { body, actor }) => ({
    line: estimates.updateLine(db, Number(m[2]), { ...body, staffRole: actor.role }),
  })],

  ['DELETE', /^\/api\/estimates\/(\d+)\/lines\/(\d+)$/, (db, m) => estimates.removeLine(db, Number(m[2]))],

  ['POST', /^\/api\/estimates\/(\d+)\/submit$/, (db, m, { actor }) => ({
    estimate: estimates.submit(db, Number(m[1]), { staffId: staffIdOf(db, actor) }),
  })],

  // ---- stock
  ['GET', /^\/api\/stock$/, (db, _m, { query }) => (query.low === '1'
    ? { low_stock: stock.lowStock(db) }
    : { items: stock.list(db) })],

  ['POST', /^\/api\/stock\/(\d+)\/adjust$/, (db, m, { body, actor }) => ({
    item: stock.adjust(db, { stockItemId: Number(m[1]), delta: body.delta, reason: body.reason, staffId: staffIdOf(db, actor) }),
  })],

  ['GET', /^\/api\/order-parts$/, (db) => ({ open: all(db, `SELECT o.*, s.sku, s.name, sup.name AS supplier
                                                            FROM order_parts o JOIN stock_items s ON s.id = o.stock_item_id
                                                            JOIN suppliers sup ON sup.id = o.supplier_id
                                                           WHERE o.status = 'open' ORDER BY o.eta_date`) })],

  ['POST', /^\/api\/order-parts\/(\d+)\/receive$/, (db, m, { body }) => tx(db, () => ({
    order_part: stock.receiveOrderPart(db, { orderPartId: Number(m[1]), qty: body.qty, etaDate: body.eta_date ?? null }),
  }))],

  // ---- bays
  ['GET', /^\/api\/bays$/, (db) => ({ bays: bays.bays(db) })],

  ['POST', /^\/api\/bays\/bookings$/, (db, _m, { body }) => tx(db, () => ({
    booking: bays.createBooking(db, {
      jobId: body.job_id, bayId: body.bay_id, startTs: body.start_ts, durationMin: body.duration_min,
    }),
  }))],

  ['PATCH', /^\/api\/bays\/bookings\/(\d+)$/, (db, m, { body }) => tx(db, () => ({
    booking: bays.reflowBooking(db, Number(m[1]), {
      startTs: body.start_ts ?? null, durationMin: body.duration_min ?? null,
      bayId: body.bay_id ?? null, status: body.status ?? null,
    }),
  }))],

  ['GET', /^\/api\/bays\/(\d+)\/bookings$/, (db, m, { query }) => ({
    bookings: bays.bookingsForBay(db, Number(m[1]), dateOnlyOrThrow(query.day ?? new Date().toISOString().slice(0, 10), 'day')),
  })],

  // ---- invoices & reports
  ['GET', /^\/api\/invoices$/, (db) => ({ invoices: all(db, 'SELECT * FROM invoices ORDER BY issued_at DESC') })],

  ['GET', /^\/api\/invoices\/([\w-]+)$/, (db, m) => invoices.byNumber(db, m[1])],

  ['GET', /^\/api\/reports\/daily$/, (db, _m, { query }) => reports.dailyOps(db, dateOnlyOrThrow(query.day ?? new Date().toISOString().slice(0, 10), 'day'))],

  ['GET', /^\/api\/reports\/estimate-vs-actual$/, (db) => ({ rows: reports.estimateVsActual(db) })],

  ['GET', /^\/api\/customers\/history$/, (db, _m, { query }) => {
    if (!query.plate && !query.phone) throw bad('customer history needs ?plate= or ?phone=');
    const h = reports.customerHistory(db, { plate: query.plate ?? null, phone: query.phone ?? null });
    if (!h) throw notFound(`no customer for ${query.plate ?? query.phone}`);
    return h;
  }],
];

export function createHandler(db) {
  return async function handle(req, res) {
    const send = (status, payload) => {
      const body = json(payload);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      // auth first: an unknown role must be 401 even on a path that does not exist, or the
      // error code leaks which paths are real
      const actor = actorFromHeaders(req.headers);
      const query = Object.fromEntries(url.searchParams);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      let matched = null;
      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = path.match(re);
        if (m) { matched = [handler, m]; break; }
      }
      if (!matched) {
        const pathExists = routes.some(([, re]) => re.test(path));
        return send(pathExists ? 405 : 404, {
          error: pathExists ? `method ${req.method} not allowed` : 'no such route',
          path,
        });
      }
      const body = (req.method === 'POST' || req.method === 'PATCH') ? await readBody(req) : {};
      const [handler, m] = matched;
      send(200, handler(db, m, { body, query, actor }));
    } catch (e) {
      if (e instanceof ValidationError) {
        return send(e.status, { error: e.message, detail: e.detail ?? undefined });
      }
      // A DB constraint that escaped the repo layer is still a client error, not a 500: the
      // CHECKs in schema.sql exist precisely so bad money never lands, and saying so helps.
      const msg = String(e?.message ?? '');
      if (msg.includes('constraint failed') || msg.includes('UNIQUE constraint')) {
        return send(409, { error: `database constraint rejected the write: ${msg}` });
      }
      if (e?.status === 401) return send(401, { error: e.message });
      process.stderr.write(`[500] ${req.method} ${req.url}: ${e?.stack ?? e}\n`);
      send(500, { error: 'internal error' });
    }
  };
}
