// WHY the seed drives the repo layer instead of raw INSERTs: REQUIREMENTS §5 claims "every
// invariant is checkable from the seed alone". Typed INSERTs would make that false the moment
// a rule moved into code. Here the same transition()/reserve()/createBooking() calls the HTTP
// layer uses are executed, so a seed that loads is an integration test of every path below
// `ready`, and `reserved` on stock_items is never typed — it is derived.
//
// One day: Tue 2026-03-10, "Berkat Jaya Motor". Wall-clock WIB (+07:00) converted to UTC
// ISO by Date, so the data sorts and compares correctly without a timezone column.
import { tx, run, get, all } from './db.js';
import * as jobs from './repo/jobs.js';
import * as estimates from './repo/estimates.js';
import * as stock from './repo/stock.js';
import * as bays from './repo/bays.js';
import { insertInvoice } from './repo/invoices.js';

const WIB = (hhmm, day = '2026-03-10') => new Date(`${day}T${hhmm}:00+07:00`).toISOString();

const LABOUR = 85_000; // Rp 85,000/h
const OWNER = 110_000; // owner-runs jobs Rp 110,000/h

export function seed(db, { log = () => {} } = {}) {
  if (get(db, 'SELECT COUNT(*) AS n FROM jobs').n > 0) {
    log('seed: skipped, jobs already present');
    return { skipped: true };
  }
  return tx(db, () => walk(db, log));
}

function walk(db, log) {
  // ---------------------------------------------------------------- suppliers & staff
  const S1 = Number(run(db, `INSERT INTO suppliers (name, city) VALUES ('Sinar Parts Motor', 'Jakarta')`).lastInsertRowid);
  const S2 = Number(run(db, `INSERT INTO suppliers (name, city) VALUES ('Sparepart Sumber Rejeki', 'Bekasi')`).lastInsertRowid);
  const BUDI = Number(run(db, `INSERT INTO staff (name, role) VALUES ('Budi Santoso', 'owner')`).lastInsertRowid);
  const ANDI = Number(run(db, `INSERT INTO staff (name, role) VALUES ('Andi Prasetyo', 'mechanic')`).lastInsertRowid);
  const RITA = Number(run(db, `INSERT INTO staff (name, role) VALUES ('Rita Kumala', 'parts_counter')`).lastInsertRowid);
  const owner = BUDI;

  // ---------------------------------------------------------------- customers & vehicles
  const cust = (name, phone, address) =>
    Number(run(db, 'INSERT INTO customers (name, phone, address) VALUES (?, ?, ?)', name, phone, address).lastInsertRowid);
  const veh = (cid, plate, brand, model, year, cc) =>
    Number(run(db, 'INSERT INTO vehicles (customer_id, plate, brand, model, year, engine_cc) VALUES (?, ?, ?, ?, ?, ?)',
      cid, plate, brand, model, year, cc).lastInsertRowid);

  const cAgus = cust('Agus Salim', '0812-1000-0001', 'Jl. Kebagusan Raya 12, Jakarta Selatan');
  const cDewi = cust('Dewi Lestari', '0813-2000-0002', 'Jl. Bintaro 8, Jakarta Selatan');
  const cHendra = cust('Hendra Gunawan', '0815-3000-0003', 'Jl. Pasar Minggu 21, Jakarta Selatan');
  const cSiti = cust('Siti Nurhaliza', '0817-4000-0004', 'Jl. Maharaja 5, Depok');
  const cRudi = cust('Rudi Hartono', '0819-5000-0005', 'Jl. Melati 9, Tangerang');
  const cMaya = cust('Maya Puspita', '0821-6000-0006', 'Jl. Kenanga 3, Jakarta Timur');
  const cRahmat = cust('Rahmat Wibowo', '0823-7000-0007', 'Jl. Anggrek 7, Bekasi');

  const V1 = veh(cAgus, 'B 2345 KLT', 'Honda', 'VFR 800', 2015, 782);
  const V2 = veh(cDewi, 'B 9012 SZD', 'Suzuki', 'GSX-R150', 2018, 150);
  const V3 = veh(cHendra, 'B 4456 UZT', 'Yamaha', 'NMAX 155', 2020, 155);
  const V4 = veh(cSiti, 'B 1234 ABC', 'Honda', 'Beat 110', 2021, 110);
  const V5 = veh(cRudi, 'B 7788 JKL', 'Kawasaki', 'Ninja 250', 2019, 249);
  const V6 = veh(cMaya, 'B 6677 GHI', 'Yamaha', 'Mio', 2016, 125);
  const V7 = veh(cAgus, 'B 3322 MNO', 'Toyota', 'Avanza 1.5 G', 2017, 1496);
  const V8 = veh(cRahmat, 'B 5566 PQR', 'Honda', 'Supra X 125', 2018, 125);

  const B1 = Number(run(db, "INSERT INTO bays (name, active) VALUES ('B1 2-post lift', 1)").lastInsertRowid);
  const B2 = Number(run(db, "INSERT INTO bays (name, active) VALUES ('B2 1-post lift', 1)").lastInsertRowid);
  const B3 = Number(run(db, "INSERT INTO bays (name, active) VALUES ('B3 light motor bay', 1)").lastInsertRowid);

  // on_hand per spec. reserved stays 0 here on purpose: the walk below builds every
  // reservation, so the `reserved` column in the spec table is a VERIFIED OUTCOME, not input.
  const si = (sku, name, onHand, reorder, cost, opts = {}) =>
    Number(run(db, `INSERT INTO stock_items (sku, name, on_hand, reserved, reorder_point, unit_cost, core_credit, core_returnable, supplier_id)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      sku, name, onHand, reorder, cost, opts.credit ?? 0, opts.core ? 1 : 0, opts.supplier ?? S1).lastInsertRowid);

  const OLI = si('OLI-1L-10W40', 'Oli 1L 10W-40', 24, 12, 55_000);
  const FO = si('FILTER-OLI-VFR', 'Filter oli VFR 800', 4, 5, 85_000);
  const FU = si('FILTER-UDARA-VFR', 'Filter udara VFR 800', 2, 4, 175_000);
  const BAT = si('BATERAI-YTZ6V', 'Baterai YTZ6V', 8, 4, 320_000, { core: true, credit: 95_000 });
  const DISK = si('DISK-REM-DEPAN-NINJA250', 'Disk rem depan Ninja 250', 3, 2, 285_000, { supplier: S2 });
  const SEAL = si('SEAL-POMPA-AIR-NMAX', 'Seal pompa air NMAX', 1, 2, 175_000);
  const KAMPAS = si('KAMPAS-REM-BEAT', 'Kampas rem Beat', 9, 5, 38_000);
  const RAKIT = si('RAKIT-ENGKOK-OLI-BEAT', 'Rakit engkok oli Beat', 3, 2, 70_000, { core: true, credit: 65_000 });
  const BOHLAM = si('BOHLAM-LED-BEAT', 'Bohlam LED Beat', 15, 8, 25_000);
  const BAN = si('KARET-BAN-BEAT', 'Karet ban Beat', 12, 6, 28_000);

  // ---------------------------------------------------------------- walk helpers
  const mk = (number, vehicleId, complaint, intakeAt) =>
    jobs.createJob(db, { vehicleId, complaint, intakeAt, number, advisorId: owner, mechanicId: ANDI });
  const checklistDone = (jobId) => {
    for (const it of all(db, 'SELECT id FROM job_checklist_items WHERE job_id = ?', jobId)) {
      jobs.checkItem(db, it.id, { done: true, staffId: ANDI });
    }
  };
  const orig = (jobId, staffId) => estimates.createOriginal(db, { jobId, staffId });
  const lab = (estId, description, h, rate = LABOUR, role = 'mechanic') =>
    estimates.addLine(db, { estimateId: estId, kind: 'labour', description, unit_hours: h, unit_rate: rate, staffRole: role });
  const part = (estId, description, partId, q, unitRate = null) =>
    estimates.addLine(db, {
      estimateId: estId, kind: 'parts', description, part_id: partId, qty: q,
      unit_rate: unitRate ?? get(db, 'SELECT unit_cost FROM stock_items WHERE id = ?', partId).unit_cost,
    });
  const move = (jobId, to, role, staffId, payload = {}) => jobs.transition(db, { jobId, to, role, staffId, payload });
  // The seed demonstrates ONE day, so its QC checks and stock issues are dated to that day
  // rather than to whenever the seed happens to run. Without this, the daily ops report for
  // 2026-03-10 would be empty no matter how correct the rows are.
  const consume = (jobId, partId, q, lineId = null, at = null) =>
    stock.consume(db, { jobId, stockItemId: partId, qty: q, estimateLineId: lineId, staffId: ANDI, at });

  // ================================================================ HISTORICAL
  // WO-2400 completed 2026-03-07 (VFR): labour + parts + consumables + PPN 11%, minus a
  // 65k core credit and a 50k discount, and it contains ONE APPROVED VARIATION so
  // "invoice total = original + variation" is demonstrable from the data alone.
  {
    const j = mk('WO-2400', V1, 'rem blong + servis rutin', WIB('09:00', '2026-03-07'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Ganti kampas rem depan', 1.0, OWNER, 'owner');                    // 110,000
    lab(e.id, 'Bleed rem belakang', 0.5, OWNER, 'owner');                       //  55,000
    part(e.id, 'Kampas rem', KAMPAS, 2);                                        //  76,000
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    move(j.id, 'approved', 'owner', owner);
    bays.createBooking(db, { jobId: j.id, bayId: B1, startTs: WIB('09:30', '2026-03-07'), durationMin: 120 });
    move(j.id, 'in_progress', 'mechanic', ANDI);
    consume(j.id, KAMPAS, 1, get(db, `SELECT l.id FROM estimate_lines l JOIN estimates e ON e.id=l.estimate_id
                                        WHERE e.job_id=? AND l.part_id=?`, j.id, KAMPAS).id);

    // variation: squeal found after teardown -> paused, decided, resumed
    const v = estimates.createVariation(db, { jobId: j.id, reason: 'rem depan berdecit setelah bongkar', staffId: ANDI });
    lab(v.id, 'Bersih kali rem + ganti grease', 0.75, OWNER, 'owner');          //  82,500
    part(v.id, 'Grease rem', RAKIT, 1);                                         //  70,000  (variation total 152,500)
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    move(j.id, 'in_progress', 'owner', owner, { channel: 'wa' });               // variation approved
    consume(j.id, RAKIT, 1, get(db, `SELECT l.id FROM estimate_lines l JOIN estimates e ON e.id=l.estimate_id
                                      WHERE e.job_id=? AND l.part_id=?`, j.id, RAKIT).id);
    jobs.recordActualHours(db, j.id, 3.0);
    move(j.id, 'qc', 'mechanic', ANDI);
    jobs.recordQc(db, { jobId: j.id, passed: true, staffId: owner, at: WIB('13:00', '2026-03-07') });
    move(j.id, 'ready', 'owner', owner);
    // consumable not on any estimate line: the invoice must still carry it
    stock.issueUnreserved(db, { jobId: j.id, stockItemId: BAN, qty: 1, staffId: RITA });
    jobs.recordCoreReturn(db, { jobId: j.id, stockItemId: RAKIT, condition: 'layak_tukar_tambah', credit: 65_000, staffId: RITA });
    // subtotal 110,000+55,000+76,000 + 152,500 variation + 28,000 consumable = 421,500
    // tax 11% = 46,365; minus core 65,000 and discount 50,000 -> 352,865
    insertInvoice(db, {
      jobId: j.id, staffId: owner, number: 'INV-2026-0307-001',
      discount: 50_000, discountReason: 'pelanggan lama',
    });
    move(j.id, 'completed', 'owner', owner);
    log('seed: WO-2400 completed + invoiced');
  }

  // WO-2395 cancelled 2026-03-04 from awaiting_approval: proves the zero-reservation release.
  {
    const j = mk('WO-2395', V4, 'ganti kampas +oli', WIB('10:00', '2026-03-04'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    part(e.id, 'Kampas rem', KAMPAS, 2);
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    // cancel needs a reason; it is a terminal state and the CHECK demands the reason be stored
    move(j.id, 'cancelled', 'owner', owner, { cancel_reason: 'harga tidak sesuai' });
    log('seed: WO-2395 cancelled');
  }

  // WO-2409 ready since 2026-03-09 15:00 (Mio): QC pass, reservations consumed and released.
  {
    const j = mk('WO-2409', V6, 'ganti rakit oli', WIB('13:00', '2026-03-09'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Ganti rakit oli', 0.5, LABOUR);
    part(e.id, 'Rakit engkok oli', RAKIT, 1);
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    move(j.id, 'approved', 'owner', owner);
    bays.createBooking(db, { jobId: j.id, bayId: B3, startTs: WIB('14:00', '2026-03-09'), durationMin: 60 });
    move(j.id, 'in_progress', 'mechanic', ANDI);
    consume(j.id, RAKIT, 1, get(db, `SELECT l.id FROM estimate_lines l WHERE l.estimate_id=? AND l.part_id=?`, e.id, RAKIT).id, WIB('14:30', '2026-03-09'));
    jobs.recordActualHours(db, j.id, 0.5);
    move(j.id, 'qc', 'mechanic', ANDI);
    jobs.recordQc(db, { jobId: j.id, passed: true, staffId: owner, at: WIB('15:00', '2026-03-09') });
    move(j.id, 'ready', 'owner', owner);
    // the qc -> ready edge releases any unconsumed reservation, so "ready, awaiting pickup"
    // leaves the shelf with the stock the job did not use
    log('seed: WO-2409 ready');
  }

  // ================================================================ LIVE, 2026-03-10
  // WO-2401 intake 08:00 (Mio): complaint only, no estimate yet.
  mk('WO-2401', V6, 'knalpot bunyi keras', WIB('08:00'));

  // WO-2402 diagnosis 08:30 (VFR): 2-line DRAFT, not submitted.
  {
    const j = mk('WO-2402', V1, 'rem blong', WIB('08:30'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Bleed rem depan', 0.5);
    part(e.id, 'Minyak rem', KAMPAS, 1);
    log('seed: WO-2402 diagnosis + draft estimate');
  }

  // WO-2403 awaiting_approval 09:15 (GSX-R150): 1.0 h + 2 kampas, no bay, no reservation.
  {
    const j = mk('WO-2403', V2, 'ganti kampas rem', WIB('09:15'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Ganti kampas rem', 1.0);
    part(e.id, 'Kampas rem', KAMPAS, 2);
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    log('seed: WO-2403 awaiting_approval');
  }

  // WO-2404 awaiting_parts 10:00 (Ninja 250): approved, 2 discs needed. The counter already
  // holds 1 of the 3 on the shelf for another job, so approval reserves 1 and opens an ORDER
  // PART for 1 to S2, ETA 2026-03-11. That is the partial-reservation path in its natural
  // state, driven by real calls rather than by typing `reserved = 1`.
  {
    // A counter hold is a real job in `approved` state that has claimed two discs and not yet
    // started. It exists because the spec's stock table gives DISK a starting `reserved = 1`
    // "without saying who holds it", and an aggregate with no owner cannot satisfy invariant
    // 3 (`reserved == SUM(active reservations)`). So the seed models the missing owner as a
    // ninth live job instead of typing a number the ledger cannot account for. It claims 2 so
    // that DISK (on_hand 3) offers exactly 1 to WO-2404, which is what produces the spec's
    // "1 reserved, 1 short -> ORDER PART to S2 ETA 2026-03-11".
    const hold = mk('WO-HOLD-01', V5, 'reservasi disk untuk pelanggan walk-in, lift penuh', WIB('09:50'));
    checklistDone(hold.id);
    move(hold.id, 'diagnosis', 'mechanic', ANDI);
    const eHold = orig(hold.id, RITA);
    part(eHold.id, 'Disk rem depan (reservasi walk-in)', DISK, 2);
    estimates.submit(db, eHold.id, { staffId: RITA });
    move(hold.id, 'awaiting_approval', 'mechanic', ANDI);
    move(hold.id, 'approved', 'owner', owner);            // reserves 2 discs for WO-HOLD-01

    const j = mk('WO-2404', V5, 'rem blong, minta ganti disk depan', WIB('10:00'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Bongkar + pasang disk rem', 1.0);
    part(e.id, 'Disk rem depan', DISK, 2);
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    // eta is a counter decision, not a guess: pass it in so the ORDER PART row is exact
    move(j.id, 'approved', 'owner', owner, { etaDate: '2026-03-11' });
    log('seed: WO-2404 awaiting_parts');
  }

  // WO-2405 approved 09:00 (Beat): 1.5 h + oli + filter + 2 kampas + 2 bulbs + rakit,
  // B1 13:00-15:00, six active reservations. Stock is ample, so it lands in `approved`.
  {
    const j = mk('WO-2405', V4, 'servis berkala + lampu mati', WIB('09:00'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Servis berkala', 1.5);
    part(e.id, 'Oli 1L 10W-40', OLI, 1);
    part(e.id, 'Filter oli', FO, 1);
    part(e.id, 'Kampas rem', KAMPAS, 2);
    part(e.id, 'Bohlam LED', BOHLAM, 2);
    part(e.id, 'Rakit engkok oli', RAKIT, 1);
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    move(j.id, 'approved', 'owner', owner);
    bays.createBooking(db, { jobId: j.id, bayId: B1, startTs: WIB('13:00'), durationMin: 120 });
    log('seed: WO-2405 approved + bay B1 13:00-15:00');
  }

  // WO-2406 awaiting_approval paused from in_progress (NMAX): original approved 08:00, 1 L
  // oli consumed, B3 08:30-11:00 paused; pending variation "pompa air bocor" 1.0 h + seal,
  // and the seal has on_hand 1 reserved by nothing -> the variation WILL short when approved.
  {
    const j = mk('WO-2406', V3, 'overheating ringan, ganti oli', WIB('08:00'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Ganti oli + cekcooling', 0.5);
    part(e.id, 'Oli 1L 10W-40', OLI, 1);
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    move(j.id, 'approved', 'owner', owner);
    bays.createBooking(db, { jobId: j.id, bayId: B3, startTs: WIB('08:30'), durationMin: 150 });
    move(j.id, 'in_progress', 'mechanic', ANDI);
    consume(j.id, OLI, 1, get(db, 'SELECT id FROM estimate_lines WHERE estimate_id = ? AND part_id = ?', e.id, OLI).id);
    const v = estimates.createVariation(db, { jobId: j.id, reason: 'pompa air bocor', staffId: ANDI });
    lab(v.id, 'Bongkar pompa air + ganti seal', 1.0);
    part(v.id, 'Seal pompa air', SEAL, 1);
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    log('seed: WO-2406 paused on pending variation');
  }

  // WO-2407 qc (Avanza), intake 2026-03-09: actual 3.5 h vs estimate 2.5 h, consumed filter
  // oli x1, filter udara x2, oli 1 L; core return on old rakit "layak tukar tambah".
  {
    const j = mk('WO-2407', V7, 'oli + filter + knalpot', WIB('09:00', '2026-03-09'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Servis 25.000 km', 2.5);
    part(e.id, 'Filter oli', FO, 1);
    part(e.id, 'Filter udara', FU, 2);
    part(e.id, 'Oli 1L 10W-40', OLI, 1);
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    move(j.id, 'approved', 'owner', owner);
    bays.createBooking(db, { jobId: j.id, bayId: B2, startTs: WIB('09:30', '2026-03-09'), durationMin: 240 });
    move(j.id, 'in_progress', 'mechanic', ANDI);
    consume(j.id, FO, 1, get(db, 'SELECT id FROM estimate_lines WHERE estimate_id=? AND part_id=?', e.id, FO).id);
    consume(j.id, FU, 2, get(db, 'SELECT id FROM estimate_lines WHERE estimate_id=? AND part_id=?', e.id, FU).id);
    consume(j.id, OLI, 1, get(db, 'SELECT id FROM estimate_lines WHERE estimate_id=? AND part_id=?', e.id, OLI).id);
    jobs.recordActualHours(db, j.id, 3.5);
    move(j.id, 'qc', 'mechanic', ANDI);
    jobs.recordQc(db, { jobId: j.id, passed: true, staffId: owner, at: WIB('14:00', '2026-03-09') });
    jobs.recordCoreReturn(db, { jobId: j.id, stockItemId: RAKIT, condition: 'layak_tukar_tambah', credit: 65_000, staffId: RITA, at: WIB('14:10', '2026-03-09') });
    log('seed: WO-2407 qc, actual 3.5h vs quoted 2.5h');
  }

  // WO-2408 in_progress (Supra X), intake 08:00: B2 08:00-12:00; QC FAILED 09:30 "knalpot
  // masih bocor", back 09:45, rework_count = 1; battery + oli reserved.
  {
    const j = mk('WO-2408', V8, 'ganti aki + knalpot bocor', WIB('08:00'));
    checklistDone(j.id);
    move(j.id, 'diagnosis', 'mechanic', ANDI);
    const e = orig(j.id, ANDI);
    lab(e.id, 'Ganti aki + cek knalpot', 1.0);
    part(e.id, 'Baterai YTZ6V', BAT, 1);
    part(e.id, 'Oli 1L 10W-40', OLI, 1);
    estimates.submit(db, e.id, { staffId: ANDI });
    move(j.id, 'awaiting_approval', 'mechanic', ANDI);
    move(j.id, 'approved', 'owner', owner);
    bays.createBooking(db, { jobId: j.id, bayId: B2, startTs: WIB('08:00'), durationMin: 240 });
    move(j.id, 'in_progress', 'mechanic', ANDI);
    // fail then rework, both through the real edges, so rework_count increments exactly once
    jobs.recordActualHours(db, j.id, 1.5);
    move(j.id, 'qc', 'mechanic', ANDI);
    jobs.recordQc(db, { jobId: j.id, passed: false, reason: 'knalpot masih bocor', staffId: owner, at: WIB('09:30') });
    move(j.id, 'in_progress', 'owner', owner);
    log('seed: WO-2408 in_progress after one failed QC');
  }

  // ---------------------------------------------------------------- verify from data alone
  stock.auditReservationTotals(db); // invariant 3, on the seed itself
  log('seed: complete');

  return {
    jobs: get(db, 'SELECT COUNT(*) AS n FROM jobs').n,
    estimates: get(db, 'SELECT COUNT(*) AS n FROM estimates').n,
    reservations_active: get(db, "SELECT COUNT(*) AS n FROM part_reservations WHERE status='active'").n,
    order_parts_open: get(db, "SELECT COUNT(*) AS n FROM order_parts WHERE status='open'").n,
    invoices: get(db, 'SELECT COUNT(*) AS n FROM invoices').n,
    by_state: all(db, 'SELECT state, COUNT(*) AS n FROM jobs GROUP BY state ORDER BY state'),
  };
}

