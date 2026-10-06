// WHY one function owns the connection: PRAGMA state is per-connection and the whole
// point of this repo is that the DB enforces money and stock rules. If callers opened
// their own connection they would silently get foreign_keys=OFF and a weaker system.
// `PRAGMA foreign_keys` is also a no-op inside a transaction, so it is set here, at open.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function openDb(file = join(HERE, '..', 'data', 'bengkel.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL'); // readers (job board) never block the counter writing
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

// WHY migrate separately from open: schema.sql is plain SQL, so `sqlite3 db < file` is a
// valid manual path and a reader can diff the DB against the repo without running code.
export function migrate(db) {
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
}

// WHY BEGIN IMMEDIATE everywhere money moves: reservation and bay writes are
// read-check-write. A deferred transaction can be upgraded after another writer commits,
// and the upgrade can fail (SQLITE_BUSY_SNAPSHOT) exactly when two jobs race for the last
// part. IMMEDIATE takes the write lock up front, so the availability re-check inside the
// reservation txn (invariant 4) is actually serialised.
//
// Re-entrant on purpose: jobs.closeJobWithInvoice() wraps "issue invoice" and "move the job"
// in one transaction, and nested BEGINs are a hard error in SQLite. A depth counter on the
// connection makes the inner call a no-op that joins the outer one, so there is still exactly
// one commit point.
const BEGIN_DEPTH = Symbol('txDepth');

export function tx(db, fn) {
  const depth = (db[BEGIN_DEPTH] ?? 0);
  if (depth > 0) {
    db[BEGIN_DEPTH] = depth + 1;
    try {
      return fn();
    } finally {
      db[BEGIN_DEPTH] = depth;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  db[BEGIN_DEPTH] = 1;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* rollback of an already-aborted txn is not an error worth masking */ }
    throw e;
  } finally {
    db[BEGIN_DEPTH] = 0;
  }
}

// One error shape for every repo and HTTP layer: a 4xx problem (bad input, illegal edge,
// insufficient stock) is ValidationError and must not be logged as a 500.
export class ValidationError extends Error {
  constructor(message, status = 400, detail = null) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
    this.detail = detail;
  }
}

export const bad = (msg, detail) => new ValidationError(msg, 400, detail);
export const conflict = (msg, detail) => new ValidationError(msg, 409, detail);
export const notFound = (msg) => new ValidationError(msg, 404);

export function all(db, sql, ...params) { return db.prepare(sql).all(...params); }
export function get(db, sql, ...params) { return db.prepare(sql).get(...params); }
export function run(db, sql, ...params) { return db.prepare(sql).run(...params); }

// Every caller that writes a number that is money-ish or qty-ish funnels through here, so
// "validation at every trust boundary" is one check, not a convention to remember.
export function money(value, field, { min = 0, max = 2_000_000_000 } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw bad(`${field} must be an integer number of rupiah`, { field, got: value });
  }
  if (value < min) throw bad(`${field} must be >= ${min}`, { field, got: value });
  if (value > max) throw bad(`${field} exceeds sane ceiling ${max}`, { field, got: value });
  return value;
}

export function qty(value, field, { min = 1, max = 100_000 } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw bad(`${field} must be an integer quantity`, { field, got: value });
  }
  if (value < min) throw bad(`${field} must be >= ${min}`, { field, got: value });
  if (value > max) throw bad(`${field} exceeds sane ceiling ${max}`, { field, got: value });
  return value;
}

// Quarter-hour steps: a labour line is booked, so 0.25 h is the finest truth worth storing.
export function hours(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw bad(`${field} must be a positive number of hours`, { field, got: value });
  }
  if (value > 500) throw bad(`${field} exceeds sane ceiling 500 h`, { field, got: value });
  if (Math.abs(value * 4 - Math.round(value * 4)) > 1e-9) {
    throw bad(`${field} must be a multiple of 0.25 h`, { field, got: value });
  }
  return Math.round(value * 4) / 4;
}

export function text(value, field, { max = 500, min = 1 } = {}) {
  if (typeof value !== 'string') throw bad(`${field} must be a string`, { field, got: value });
  const t = value.trim();
  if (t.length < min) throw bad(`${field} must not be blank`, { field });
  if (t.length > max) throw bad(`${field} must be <= ${max} characters`, { field, max });
  return t;
}

export function isoOrThrow(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    throw bad(`${field} must be an ISO-8601 date or timestamp`, { field, got: value });
  }
  return new Date(value.replace(' ', 'T')).toISOString();
}

export function dateOnlyOrThrow(value, field) {
  const iso = isoOrThrow(value, field);
  return iso.slice(0, 10);
}

export function oneOf(value, field, allowed) {
  // `allowed` is machine-readable in the error detail so a client can render the legal set
  // instead of scraping it out of the human-readable message.
  if (!allowed.includes(value)) throw bad(`${field} must be one of ${allowed.join(', ')}`, { field, got: value, allowed });
  return value;
}
