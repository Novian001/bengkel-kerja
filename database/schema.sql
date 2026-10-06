-- BengkelKerja schema. WHY: every invariant in REQUIREMENTS §3 that SQLite can express
-- (stock ceiling, money floors, bay overlap) lives here, not in JS, so an app bug
-- cannot corrupt stock or double-book a lift.
-- Money: integer rupiah (IDR), never float. rupiah has no minor unit in practice;
-- unit_rates and amounts are whole rupiah. Labour uses unit_hours (quarter-hour steps)
-- which may be fractional, so the line amount CHECK rounds once and stores the integer.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS suppliers (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  city  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','advisor','mechanic','parts_counter'))
);

CREATE TABLE IF NOT EXISTS customers (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  phone   TEXT NOT NULL UNIQUE,
  address TEXT
);

CREATE TABLE IF NOT EXISTS vehicles (
  id         INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  plate      TEXT NOT NULL UNIQUE,
  brand      TEXT NOT NULL,
  model      TEXT NOT NULL,
  year       INTEGER CHECK (year BETWEEN 1950 AND 2100),
  engine_cc  INTEGER CHECK (engine_cc > 0)
);

CREATE TABLE IF NOT EXISTS bays (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  vehicle_id    INTEGER NOT NULL REFERENCES vehicles(id),
  state         TEXT NOT NULL CHECK (state IN ('intake','diagnosis','awaiting_approval','approved',
                            'awaiting_parts','in_progress','qc','ready','completed','cancelled')),
  complaint     TEXT NOT NULL CHECK (length(trim(complaint)) > 0),
  intake_at     TEXT NOT NULL,
  approved_at   TEXT,
  completed_at  TEXT,
  advisor_id    INTEGER REFERENCES staff(id),
  mechanic_id   INTEGER REFERENCES staff(id),
  bay_id        INTEGER REFERENCES bays(id),
  actual_hours  REAL CHECK (actual_hours IS NULL OR actual_hours >= 0),
  rework_count  INTEGER NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
  cancel_reason TEXT,
  -- a cancelled job must say why; a completed one has its invoice as the record
  CHECK (state <> 'cancelled' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0))
);

-- Intake checklist: REQUIRED before diagnosis (REQUIREMENTS §2 precondition).
CREATE TABLE IF NOT EXISTS job_checklist_items (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id),
  label      TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  checked_at TEXT
);

CREATE TABLE IF NOT EXISTS estimates (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  kind        TEXT NOT NULL CHECK (kind IN ('original','variation')),
  status      TEXT NOT NULL CHECK (status IN ('draft','pending_approval','approved','rejected')),
  reason      TEXT,
  created_by  INTEGER REFERENCES staff(id),
  created_at  TEXT NOT NULL,
  approved_by INTEGER REFERENCES staff(id),
  approved_at TEXT,
  decided_at  TEXT,
  reject_reason TEXT
);

-- single open variation per job: one invoice source per decision (invariant 10)
CREATE UNIQUE INDEX IF NOT EXISTS ux_estimate_open_variation
  ON estimates(job_id) WHERE kind = 'variation' AND status = 'pending_approval';

CREATE TABLE IF NOT EXISTS estimate_lines (
  id               INTEGER PRIMARY KEY,
  estimate_id      INTEGER NOT NULL REFERENCES estimates(id),
  kind             TEXT NOT NULL CHECK (kind IN ('labour','parts')),
  description      TEXT NOT NULL,
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_hours       REAL CHECK (kind <> 'labour' OR (unit_hours IS NOT NULL AND unit_hours > 0)),
  unit_rate        INTEGER NOT NULL CHECK (unit_rate >= 0),
  part_id          INTEGER REFERENCES stock_items(id),
  core_returnable  INTEGER NOT NULL DEFAULT 0 CHECK (core_returnable IN (0,1)),
  amount           INTEGER NOT NULL CHECK (amount >= 0),
  -- line amount is derived, never trusted: labour = hours x rate, parts = qty x price
  CHECK (amount = CASE WHEN kind = 'labour'
                       THEN CAST(ROUND(unit_hours * unit_rate) AS INTEGER)
                       ELSE qty * unit_rate END),
  CHECK ((kind = 'parts') = (part_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS stock_items (
  id               INTEGER PRIMARY KEY,
  sku              TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  on_hand          INTEGER NOT NULL CHECK (on_hand >= 0),
  reserved         INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  reorder_point    INTEGER NOT NULL CHECK (reorder_point >= 0),
  unit_cost        INTEGER NOT NULL CHECK (unit_cost >= 0),
  core_credit      INTEGER NOT NULL DEFAULT 0 CHECK (core_credit >= 0),
  core_returnable  INTEGER NOT NULL DEFAULT 0 CHECK (core_returnable IN (0,1)),
  supplier_id      INTEGER REFERENCES suppliers(id),
  -- invariant 1: the reservation ceiling, DB-level
  CHECK (reserved <= on_hand)
);

CREATE TABLE IF NOT EXISTS bay_bookings (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id),
  bay_id       INTEGER NOT NULL REFERENCES bays(id),
  start_ts     TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  status       TEXT NOT NULL CHECK (status IN ('booked','paused','cancelled','done')),
  -- adjacent slots must be bookable, so uniqueness is per exact start only
  UNIQUE (bay_id, start_ts)
);

-- invariant 5/6: overlap is impossible because the block row is the booking.
-- 15-minute grid; an overlap is a duplicate PRIMARY KEY, so the DB rejects it
-- inside the INSERT — there is no read-then-write window to lose.
CREATE TABLE IF NOT EXISTS bay_block (
  bay_id      INTEGER NOT NULL REFERENCES bays(id),
  block_no    INTEGER NOT NULL CHECK (block_no >= 0),
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  booking_id  INTEGER NOT NULL REFERENCES bay_bookings(id),
  PRIMARY KEY (bay_id, block_no)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS part_reservations (
  id              INTEGER PRIMARY KEY,
  job_id          INTEGER NOT NULL REFERENCES jobs(id),
  stock_item_id   INTEGER NOT NULL REFERENCES stock_items(id),
  estimate_line_id INTEGER NOT NULL REFERENCES estimate_lines(id),
  qty             INTEGER NOT NULL CHECK (qty > 0),
  status          TEXT NOT NULL CHECK (status IN ('active','consumed','released')),
  created_at      TEXT NOT NULL,
  closed_at       TEXT
);

-- invariant: at most one ACTIVE reservation per job+line, so approving twice cannot
-- double-reserve (the second insert aborts)
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservation_active_line
  ON part_reservations(job_id, estimate_line_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS order_parts (
  id               INTEGER PRIMARY KEY,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  estimate_line_id INTEGER NOT NULL REFERENCES estimate_lines(id),
  stock_item_id    INTEGER NOT NULL REFERENCES stock_items(id),
  supplier_id      INTEGER NOT NULL REFERENCES suppliers(id),
  qty_ordered      INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_received     INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  eta_date         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open','received','cancelled')),
  CHECK (qty_received <= qty_ordered)
);

CREATE TABLE IF NOT EXISTS part_consumptions (
  id               INTEGER PRIMARY KEY,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  estimate_line_id INTEGER REFERENCES estimate_lines(id),
  stock_item_id    INTEGER NOT NULL REFERENCES stock_items(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  by_staff_id      INTEGER REFERENCES staff(id),
  at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qc_checks (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id),
  passed     INTEGER NOT NULL CHECK (passed IN (0,1)),
  reason     TEXT,
  checked_by INTEGER REFERENCES staff(id),
  at         TEXT NOT NULL,
  -- invariant 12: a fail without a reason is an unfalsifiable rework rate
  CHECK (passed = 1 OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);

CREATE TABLE IF NOT EXISTS core_returns (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id),
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
  condition     TEXT NOT NULL CHECK (condition IN ('layak_tukar_tambah','layak_jual','bukan_komponen')),
  credit        INTEGER NOT NULL CHECK (credit >= 0),
  at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY,
  number         TEXT NOT NULL UNIQUE,
  job_id         INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  subtotal       INTEGER NOT NULL CHECK (subtotal >= 0),
  tax            INTEGER NOT NULL DEFAULT 0 CHECK (tax >= 0),
  discount       INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  discount_reason TEXT,
  core_credit    INTEGER NOT NULL DEFAULT 0 CHECK (core_credit >= 0),
  total          INTEGER NOT NULL CHECK (total >= 0),
  issued_by      INTEGER REFERENCES staff(id),
  issued_at      TEXT NOT NULL,
  -- invariant 7: the identity, as far as one row can carry it
  CHECK (total = subtotal + tax - discount - core_credit)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id             INTEGER PRIMARY KEY,
  invoice_id     INTEGER NOT NULL REFERENCES invoices(id),
  source         TEXT NOT NULL CHECK (source IN ('estimate','variation','consumable')),
  source_line_id INTEGER NOT NULL,
  description    TEXT NOT NULL,
  qty            INTEGER NOT NULL CHECK (qty > 0),
  unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),
  amount         INTEGER NOT NULL CHECK (amount >= 0),
  CHECK (amount = qty * unit_price)
);

CREATE TABLE IF NOT EXISTS job_state_log (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  actor_id    INTEGER REFERENCES staff(id),
  actor_role  TEXT NOT NULL,
  at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id            INTEGER PRIMARY KEY,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id      INTEGER REFERENCES staff(id),
  at            TEXT NOT NULL
);

-- Notify-customer outbox. WHY a table and not a send: no outbound channel is in scope,
-- so the shop's "sudah jadi?" interrupt problem is solved by a durable queue the counter
-- can read. Delivery stays manual until an SMS/WhatsApp provider exists.
CREATE TABLE IF NOT EXISTS notifications (
  id      INTEGER PRIMARY KEY,
  job_id  INTEGER NOT NULL REFERENCES jobs(id),
  kind    TEXT NOT NULL,
  message TEXT NOT NULL,
  at      TEXT NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0 CHECK (sent IN (0,1))
);

CREATE INDEX IF NOT EXISTS ix_jobs_state            ON jobs(state);
CREATE INDEX IF NOT EXISTS ix_estimates_job         ON estimates(job_id);
CREATE INDEX IF NOT EXISTS ix_estimate_lines_est    ON estimate_lines(estimate_id);
CREATE INDEX IF NOT EXISTS ix_reservations_job      ON part_reservations(job_id, status);
CREATE INDEX IF NOT EXISTS ix_order_parts_job       ON order_parts(job_id, status);
CREATE INDEX IF NOT EXISTS ix_consumptions_job      ON part_consumptions(job_id);
CREATE INDEX IF NOT EXISTS ix_qc_job                ON qc_checks(job_id);
CREATE INDEX IF NOT EXISTS ix_state_log_job         ON job_state_log(job_id);
CREATE INDEX IF NOT EXISTS ix_notifications_unsent  ON notifications(sent);

-- Invariant 9 lives here as a trigger when the build supports it (this box does), and in
-- the repository layer as well. The repo check gives a readable 4xx; this makes a raw
-- UPDATE/DELETE from any other writer fail loudly instead of silently rewriting money.
DROP TRIGGER IF EXISTS trg_estimate_line_immutable_update;
CREATE TRIGGER trg_estimate_line_immutable_update BEFORE UPDATE ON estimate_lines
WHEN (SELECT e.status FROM estimates e WHERE e.id = OLD.estimate_id) = 'approved'
BEGIN SELECT RAISE(ABORT, 'estimate line is immutable once approved; raise a variation'); END;

DROP TRIGGER IF EXISTS trg_estimate_line_immutable_delete;
CREATE TRIGGER trg_estimate_line_immutable_delete BEFORE DELETE ON estimate_lines
WHEN (SELECT e.status FROM estimates e WHERE e.id = OLD.estimate_id) = 'approved'
BEGIN SELECT RAISE(ABORT, 'estimate line is immutable once approved; raise a variation'); END;

DROP TRIGGER IF EXISTS trg_estimate_line_no_insert_after_approval;
CREATE TRIGGER trg_estimate_line_no_insert_after_approval BEFORE INSERT ON estimate_lines
WHEN (SELECT e.status FROM estimates e WHERE e.id = NEW.estimate_id) = 'approved'
BEGIN SELECT RAISE(ABORT, 'estimate line is immutable once approved; raise a variation'); END;

-- invariant 14 at the storage layer: no writer, including SQL typed by hand, moves a
-- settled job
DROP TRIGGER IF EXISTS trg_jobs_terminal;
CREATE TRIGGER trg_jobs_terminal BEFORE UPDATE ON jobs
WHEN OLD.state IN ('completed','cancelled') AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'job is terminal'); END;
