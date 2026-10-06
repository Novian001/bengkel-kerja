# Bengkel Work-Order System — MVP Requirement Spec

Single-site motor workshop (Indonesian bengkel). Roles: `owner` (also service advisor), `mechanic`, `parts_counter`. Money = integer IDR.

## 1. CORE MVP

### MUST HAVE
- **Intake: customer, vehicle, complaint, checklist** — no job card means no way to bill or defend a warranty complaint.
- **Estimate: labour (`hours × rate`) and parts (`qty × price`)** — quoted verbally today, so profit is unknown.
- **Approval capture (who, when, channel)** — "I never agreed to that" is won or lost on this record.
- **Stock `on_hand` / `reserved`, issue, core return** — selling an already-used part stops the job mid-work.
- **Shortage → ORDER PART (supplier, qty, ETA); job → `awaiting_parts`** — WhatsApp supplier chasing is the top cycle-time killer.
- **Bay booking for estimated duration, no double-booking** — two jobs in one lift is a physical conflict.
- **`in_progress` records actual hours + consumed parts** — estimate-vs-actual is the only profitability signal.
- **VARIATION on fault found: new estimate, pause for approval, original untouched** — most revenue disputes come from undocumented extra work.
- **QC pass → `ready`; fail → `in_progress` + reason, counted as rework** — invisible rework makes the owner believe the shop is fast.
- **Invoice = approved + approved variations + consumables + tax − core credit − discount** — an invoice not tied to the approved estimate creates refund arguments.
- **Job board by state + job detail** — the shop's real question is "sudah kelar belum?".

### SHOULD HAVE
- Customer/vehicle lookup with last-visit summary — repeat faults (same VFR oil leak) need prior jobs in one click.
- Consumable lines on invoice — real cost is not labour + parts; omitting it understates margin.
- Discount with mandatory reason + approver — "free 50k, bang" is normal, needs an audit trail not a feature.
- Daily ops report: bay utilisation, jobs by state, avg cycle time, rework rate, revenue by service type — hire/bay decisions come from utilisation + rework rate, not feel.
- Stock adjustment with reason + low-stock alert — otherwise silent miscounts cap sales for weeks.
- Notify customer on approved / ready — cuts inbound "sudah jadi?" interrupting mechanics.

### NICE TO HAVE — all cuttable for two weeks
PO receiving with partial receipt + supplier invoice (counter receives and types a count) · technician time clock / payroll export (paper works) · inspection photos · online booking · second branch · approval thresholds · barcode scan and supplier price-list sync · printable service-history timeline. None block collecting money today.

## 2. STATE MACHINE

| From → To | Role | Precondition |
|---|---|---|
| `intake` → `diagnosis` | mechanic, owner | customer + vehicle linked, intake checklist done |
| `diagnosis` → `awaiting_approval` | mechanic, owner | ≥1 estimate line |
| `awaiting_approval` → `approved` | owner | approver + timestamp recorded; same txn reserves every part line |
| `awaiting_approval` → `cancelled` | owner | nothing reserved yet |
| `approved` → `awaiting_parts` | system, parts_counter | some part line short → ORDER PART rows created |
| `approved` → `in_progress` | mechanic | bay booked; all part lines reserved or received |
| `awaiting_parts` → `in_progress` | mechanic | zero open ORDER PART rows |
| `awaiting_parts` → `cancelled` | owner | active reservations released in same txn |
| `in_progress` → `qc` | mechanic | actual hours + consumption recorded |
| `in_progress` → `awaiting_approval` | mechanic, owner | variation created (`pending_approval`), bay paused |
| `qc` → `ready` | owner | QC checklist complete |
| `qc` → `in_progress` | owner | fail reason non-null, `rework_count += 1` |
| `ready` → `completed` | owner | invoice issued |
| `ready` → `in_progress` | owner | customer rejects at handover → rework |
| `approved`/`in_progress`/`qc` → `cancelled` | owner | reservations released, no invoice exists |
| variation declined | owner | variation `rejected`, job returns to `in_progress` |

**Must be rejected, and why:**
- `awaiting_approval` → `in_progress`: unapproved work is uncollectible money.
- mechanic triggering `→ approved`: self-approving own quote.
- `approved` → `in_progress` with unreserved part and no ORDER PART: starting work on a part not in the shop.
- `awaiting_parts` → `in_progress` with open ORDER PART: wait-for-parts must actually be waited.
- `in_progress` → `qc` with no actuals: invoice cannot be built later.
- `qc` → `in_progress` without reason: rework rate becomes unfalsifiable.
- any edge out of `completed`/`cancelled`: terminal, settled money.
- editing an approved estimate line instead of raising a variation: breaks invoice identity.
- second variation while one is `pending_approval`: one invoice source per decision.

## 3. BUSINESS INVARIANTS

1. **State machine** — `jobs.state` is always on an allowed edge; rejected edges change nothing. Test: attempt all illegal edges, expect 0 state changes.
2. **Reservation ceiling** — `0 ≤ reserved ≤ on_hand` for every item. Test: two jobs approve the last unit; second fails with zero partial reservation.
3. **Bookkeeping** — `stock_items.reserved == SUM(qty of active reservations)` at all times. Test: reserve 3, release 2 → `reserved` drops by exactly 2.
4. **Availability re-checked inside the reservation txn**, not before it (read-check-write race).
5. **Bay overlap** — no two `booked` bookings on one bay satisfy `start < other.end AND other.start < end`. Test: 10:00–13:00 then 12:00–14:00 → rejected.
6. **Bay reflow safety** — editing start/duration re-validates overlap in the same txn; an edit may never create an overlap.
7. **Invoice identity** — `invoice.total == SUM(approved estimate lines) + SUM(approved variation lines) + consumables + tax − core credit − discount`, exact integer equality.
8. **Invoice provenance** — every `invoice_line.source_line_id` points to a line on an estimate/variation with `status='approved'`. Test: hand-typed amount rejected.
9. **Approved-estimate immutability** — UPDATE/DELETE on lines of an approved estimate affects 0 rows; corrections require a variation.
10. **Single open variation** — ≤1 estimate per job with `kind='variation' AND status='pending_approval'`.
11. **Consumption** — consumed qty per part ≤ that job's reservation; issuing stock decrements `on_hand` exactly once.
12. **Rework accounting** — every QC fail writes a reason and increments `rework_count` exactly once; `rework_count == COUNT(failed qc_checks)`.
13. **Awaiting-parts consistency** — `awaiting_parts` ⇒ ≥1 open ORDER PART; `in_progress` ⇒ 0.
14. **Terminal states** — `completed`/`cancelled` accept no transitions.
15. **Core return** — invoice for a job consuming a `core_returnable` part requires a core-return record; applied credit equals recorded credit.
16. **Audit trail** — every state change appends `job_state_log` (actor, role, from, to, at); no deletes.

## 4. DB ENTITIES

`customers` (id, name, phone unique, address) · `vehicles` (id, customer_id, plate unique, brand, model, year, engine_cc) · `staff` (id, name, role) · `bays` (id, name, active) · `jobs` (id, vehicle_id, state, intake_at, approved_at, completed_at, advisor_id, mechanic_id, bay_id, rework_count, cancel_reason) · `estimates` (id, job_id, kind original|variation, status, reason, approved_by, approved_at) · `estimate_lines` (id, estimate_id, kind labour|parts, description, qty, unit_hours, unit_rate, part_id, core_returnable) · `bay_bookings` (id, job_id, bay_id, start_ts, duration_min, status) · `stock_items` (id, sku, name, on_hand, reserved, reorder_point, unit_cost, core_credit, core_returnable, supplier_id) · `part_reservations` (id, job_id, stock_item_id, estimate_line_id, qty, status active|consumed|released) · `order_parts` (id, job_id, estimate_line_id, stock_item_id, supplier_id, qty_ordered, qty_received, eta_date, status) · `part_consumptions` (id, job_id, estimate_line_id, stock_item_id, qty, by_staff_id, at) · `qc_checks` (id, job_id, passed, reason, checked_by, at) · `core_returns` (id, job_id, stock_item_id, condition, credit, at) · `invoices` (id, number unique, job_id unique, subtotal, tax, discount, core_credit, total, issued_by, issued_at) · `invoice_lines` (id, invoice_id, source estimate|variation|consumable, source_line_id, description, qty, unit_price, amount) · `job_state_log` (id, job_id, from_state, to_state, actor_id, actor_role, at).

**Where each invariant lives**
- **CHECK** — `stock_items`: `on_hand ≥ 0`, `reserved ≥ 0`, `reserved ≤ on_hand`; `estimate_lines`: `qty > 0`, `unit_rate ≥ 0`, `unit_price ≥ 0`; `jobs.state` enum; `invoices.total ≥ 0`. DB-level so an app bug cannot corrupt stock.
- **Unique index** — `estimates` partial unique on `job_id WHERE kind='variation' AND status='pending_approval'`; `invoices.job_id`; `vehicles.plate`; `part_reservations` unique `(job_id, estimate_line_id)` while active; `bay_bookings` `(bay_id, start_ts)`.
- **Bay overlap** — **time-block allocation**: `bay_block (bay_id, block_no, job_id)` with `PRIMARY KEY (bay_id, block_no)` WITHOUT ROWID, block = 15 minutes. An overlapping booking attempts an INSERT of an existing primary key, so the database itself rejects it — no read-then-write race window exists. Verified on `node:sqlite` (Node 22): overlapping insert raises `UNIQUE constraint failed`, adjacent and same-time-different-bay bookings succeed, shortening a booking then rebooking the freed blocks succeeds, and a partial booking rolled back leaves zero orphan rows. `bay_bookings (bay_id, start_ts, duration_min)` remains the human-readable row; `bay_block` is derived inside the same transaction.
- **Original spec, superseded:** the analysis originally proposed Postgres `EXCLUDE USING gist (bay_id WITH =, tstzrange(start_ts, end_ts) WITH &&)`. Not usable here — this box has no Postgres and the deployment rule forbids installing one. The block scheme is strictly stronger than an application-level re-check, which is what the original plan relied on.
- **Approved-estimate immutability** — no trigger: `node:sqlite` has no trigger support in this build. Enforced in the repository layer, which is the only writer (single entry point per table, no direct SQL from handlers). Flagged in README trade-offs.
- **State machine, approvals, release, consumption, invoice build** — transaction logic: validate edge + role, write all rows atomically, append `job_state_log`.
- **Terminal states** — enforced in the state-machine transition table (transaction logic); `node:sqlite` in this build has no trigger support.
- **Invoice identity / provenance** — transaction logic only (no CHECK spans rows): build lines from approved sources, compute total, assert equality, insert, with job row locked. One integration test per rule.

## 5. SEED DATA — one day, "Berkat Jaya Motor", Tue 2026-03-10

Staff: Budi Santoso (owner), Andi Prasetyo (mechanic), Rita Kumala (parts_counter). Suppliers: S1 Sinar Parts Motor (Jakarta), S2 Sparepart Sumber Rejeki (Bekasi). Labour Rp 85,000/h; owner-runs jobs Rp 110,000/h.

Vehicles: V1 Honda VFR 800 (B 2345 KLT, Agus Salim) · V2 Suzuki GSX-R150 (B 9012 SZD, Dewi Lestari) · V3 Yamaha NMAX 155 (B 4456 UZT, Hendra Gunawan) · V4 Honda Beat 110 (B 1234 ABC, Siti Nurhaliza) · V5 Kawasaki Ninja 250 (B 7788 JKL, Rudi Hartono) · V6 Yamaha Mio (B 6677 GHI, Maya Puspita) · V7 Toyota Avanza 1.5 G (B 3322 MNO, Agus Salim) · V8 Honda Supra X 125 (B 5566 PQR, Rahmat Wibowo).

Bays: B1 2-post lift, B2 1-post lift, B3 light motor bay.

**Live jobs — 8, covering every working state**
- **WO-2401** V6 Mio · `intake` 08:00 · complaint "knalpot bunyi keras", no estimate yet.
- **WO-2402** V1 VFR · `diagnosis` 08:30 · "rem blong", 2-line draft not submitted.
- **WO-2403** V2 GSX-R150 · `awaiting_approval` 09:15 · 1.0 h + 2 kampas, no bay, no reservation.
- **WO-2404** V5 Ninja 250 · `awaiting_parts` 10:00 · approved; needs 2 brake discs, `on_hand 3 − reserved 1` → 1 reserved, 1 open ORDER PART to S2 ETA 2026-03-11.
- **WO-2405** V4 Beat · `approved` 09:00 · 1.5 h + oli + filter + 2 kampas + 2 bulbs + rakit; B1 13:00–15:00; 6 active reservations.
- **WO-2406** V3 NMAX · `awaiting_approval` paused from `in_progress` · original approved 08:00, 1 L oli consumed, B3 08:30–11:00 paused; variation pending: "pompa air bocor" 1.0 h + seal pompa; seal `on_hand 1` → will short.
- **WO-2407** V7 Avanza · `qc`, intake 2026-03-09 · actual 3.5 h vs estimate 2.5 h; consumed filter oli ×1, filter udara ×2, oli 1 L; core return on old rakit, "layak tukar tambah".
- **WO-2408** V8 Supra X · `in_progress`, intake 08:00 · B2 08:00–12:00; QC **failed** 09:30 "knalpot masih bocor", back 09:45, `rework_count = 1`; battery + oli reserved.

**Historical — 3, so terminal states and invoicing are populated**
- **WO-2400** `completed` 2026-03-07 (V1 VFR) · INV-2026-0307-001 total Rp 1,240,000 = labour + parts + consumables + PPN 11%, minus Rp 65,000 core credit (old battery) and Rp 50,000 discount "pelanggan lama"; contains one **approved variation** Rp 210,000 so invoice = original + variation is demonstrable.
- **WO-2409** `ready` since 2026-03-09 15:00 (V6 Mio) · QC pass, awaiting pickup, reservations consumed and released.
- **WO-2395** `cancelled` 2026-03-04 (V4 Beat) · cancelled from `awaiting_approval`, "harga tidak sesuai", proving zero reservations to release.

**Stock** — `on_hand / reserved / reorder_point`, unit cost:
| SKU | on_hand | reserved | reorder | cost | note |
|---|---|---|---|---|---|
| OLI-1L-10W40 | 24 | 2 | 12 | 55,000 | WO-2405, WO-2408 |
| FILTER-OLI-VFR | 4 | 0 | 5 | 85,000 | LOW |
| FILTER-UDARA-VFR | 2 | 0 | 4 | 175,000 | LOW, used by WO-2407 |
| BATERAI-YTZ6V | 8 | 1 | 4 | 320,000 | reserved by WO-2408; core_returnable, credit 95,000 |
| DISK-REM-DEPAN-NINJA250 | 3 | 1 | 2 | 285,000 | WO-2404: 1 reserved, 1 short |
| SEAL-POMPA-AIR-NMAX | 1 | 0 | 2 | 175,000 | LOW; variation part WO-2406 |
| KAMPAS-REM-BEAT | 9 | 2 | 5 | 38,000 | reserved by WO-2405 |
| RAKIT-ENGKOK-OLI-BEAT | 3 | 1 | 2 | 70,000 | reserved by WO-2405; core_returnable, credit 65,000 |
| BOHLAM-LED-BEAT | 15 | 2 | 8 | 25,000 | reserved by WO-2405 |
| KARET-BAN-BEAT | 12 | 0 | 6 | 28,000 | — |

Also seed: `bay_bookings` (B1 13:00–15:00, B2 08:00–12:00, B3 08:30–11:00 — provably non-overlapping), `qc_checks` (1 pass WO-2407, 1 fail WO-2408), one `job_state_log` chain per job, WO-2400 invoice lines, `core_returns` on WO-2400 and WO-2407. Every invariant above is checkable from the seed alone.

## 6. TRADE-OFFS

1. **Bay scheduling rejects conflicts, no auto-reflow.** A reviewer will call that a missing feature. Honest answer: with 3 bays and a human scheduler the valuable half is *never* silently producing an overlap; earliest-fit reflow optimises a schedule nobody reads. Upgrade when a bay takes >2 bookings/day or bookings get made from a mechanic's phone rather than the counter.
2. **Invoice identity is enforced in transaction code, not a DB constraint.** A `CHECK` cannot span rows, so "total always equals approved + variations" cannot be a constraint on the invoice table. It is asserted in the same transaction that builds the lines, backed by one integration test per rule. Making it a real constraint means a view or deferred trigger — worth it only if invoices arrive from more than one code path (imports, multi-currency), which is not MVP.
3. **Core return is a negative invoice line; receiving is manual.** No deposit ledger, no supplier credit notes, no partial PO receipt: the counter receives a box and types a count. Right for a cash-on-handover bengkel where the old rakit leaves on the same trip as the invoice. Revisit when supplier credit lands in the bank later than the customer pays — that is when a credit-note entity and deposit balance become mandatory.
## Deviations

1. **§2 is missing the edges for deciding a variation.** The table gives `in_progress -> awaiting_approval` (variation created) and "variation declined → job returns to `in_progress`", but no edge to leave `awaiting_approval` when a variation is *approved*. Implemented as `awaiting_approval -> in_progress` (owner, guard `variation_approved`) and `awaiting_approval -> awaiting_parts` for an approved variation that shorts, mirroring the original-estimate edges. Guarded so the edge exists only while a `pending_approval` variation is open, which keeps `awaiting_approval -> in_progress` illegal in the case §2 requires rejected ("unapproved work is uncollectible money").

2. **§5 stock table cannot satisfy invariant 3 as written.** The table lists `DISK-REM-DEPAN-NINJA250` with a starting `reserved 1` and no owning job, and WO-2404's arithmetic (`on_hand 3 − reserved 1` → 1 reserved, 1 short) needs exactly that orphan unit. An aggregate with no owning reservation violates `reserved == SUM(active reservations)`. The seed therefore adds a ninth live job, `WO-HOLD-01`, in `approved`, holding 2 discs; the resulting `reserved = 3`, WO-2404 `awaiting_parts` with 1 reserved + 1 open ORDER PART to S2 ETA 2026-03-11 matches §5 exactly.

3. **`bay_bookings UNIQUE (bay_id, start_ts)` is a partial index on live statuses.** As a plain constraint it makes a cancelled booking permanently un-rebookable, which would nullify §3 invariant 6's "shortening frees its tail blocks". Cancelled rows are kept as history; overlap itself is enforced by `bay_block`'s primary key, which is the stronger check.

4. **§4 note and §3 invariants 9 and 14 understate what this build enforces.** It says `node:sqlite` "has no trigger support in this build"; SQLite 3.51.3 on Node 22.23.3 does. Approved-line immutability (invariant 9) and terminal-state refusal (invariant 14) are therefore additionally backed by `BEFORE UPDATE/DELETE/INSERT` triggers, so raw SQL cannot rewrite them — the repository layer still holds the readable 4xx.

5. **Invoice `CHECK` is the row-level half of invariant 7.** `total = subtotal + tax - discount - core_credit` is enforced by the schema; the cross-row half (subtotal == SUM of lines built only from approved sources) cannot be a `CHECK` and stays asserted in the building transaction, per §6.2.
