// WHY the transition table is duplicated here: the drawer must SHOW the illegal edges with their
// reason instead of hiding them, and a hidden button teaches nobody. This is a literal mirror of
// backend/src/state-machine.js — the server stays the authority; if the two ever disagree the
// server's 403/409 is displayed verbatim, which is the whole point of the app.
// Manual sync: if you change TRANSITIONS in the backend, change it here in the same commit.

export const STATES = [
  'intake', 'diagnosis', 'awaiting_approval', 'awaiting_parts', 'approved',
  'in_progress', 'qc', 'ready', 'completed', 'cancelled',
];

export const STATE_LABEL = {
  intake: 'Intake',
  diagnosis: 'Diagnosis',
  awaiting_approval: 'Menunggu Persetujuan',
  awaiting_parts: 'Menunggu Part',
  approved: 'Disetujui',
  in_progress: 'Dikerjakan',
  qc: 'QC',
  ready: 'Siap Diserah',
  completed: 'Selesai',
  cancelled: 'Batal',
};

/** Short label for board column heads, where the full name would wrap. */
export const STATE_SHORT = {
  intake: 'Intake',
  diagnosis: 'Diagnosis',
  awaiting_approval: 'Tunggu Approve',
  awaiting_parts: 'Tunggu Part',
  approved: 'Disetujui',
  in_progress: 'Dikerjakan',
  qc: 'QC',
  ready: 'Siap Diserah',
  completed: 'Selesai',
  cancelled: 'Batal',
};

/**
 * Icon per state. A glyph is NOT colour-alone signalling: every state also carries its label and
 * its column heading, so the board stays readable in monochrome or with any colour vision.
 * Drawn characters, one consistent stroke weight, no emoji.
 */
export const STATE_GLYPH = {
  intake: '\u25CB',           // open circle
  diagnosis: '\u25D4',        // circle with upper half black
  awaiting_approval: '\u2754',// white question mark
  awaiting_parts: '\u231B',   // hourglass
  approved: '\u2713',         // check
  in_progress: '\u25B8',      // small right triangle (running)
  qc: '\u25A3',              // diamond (inspection)
  ready: '\u2691',            // flag
  completed: '\u25CF',        // filled circle
  cancelled: '\u2715',        // cross
};

/** Board lanes: three columns of LIVE work; closed states go to the archive strip. */
export const LANES = [
  { id: 'masuk', title: 'Masuk & Diagnosis', hint: 'Kendaraan diterima, teknisi memeriksa', states: ['intake', 'diagnosis'] },
  { id: 'tunggu', title: 'Tunggu & Disetujui', hint: 'Butuh keputusan pelanggan atau part', states: ['awaiting_approval', 'awaiting_parts', 'approved'] },
  { id: 'kerja', title: 'Di Kerjakan', hint: 'Bengkel aktif, termasuk QC dan serah terima', states: ['in_progress', 'qc', 'ready'] },
];
export const CLOSED_STATES = ['completed', 'cancelled'];

/**
 * Edge table, straight from backend/src/state-machine.js.
 * Two roles for one target (awaiting_approval -> in_progress happens twice, once per variation
 * decision) are merged on the target so the drawer shows ONE button with both reasons listed.
 */
const RAW = {
  intake: [
    { to: 'diagnosis', roles: ['mechanic', 'owner'], guard: 'intake_checklist_done', why: 'checklist intake belum lengkap' },
  ],
  diagnosis: [
    { to: 'awaiting_approval', roles: ['mechanic', 'owner'], guard: 'estimate_has_lines', why: 'estimate asli minimal harus ada dan sudah disubmit' },
  ],
  awaiting_approval: [
    { to: 'approved', roles: ['owner'], guard: 'estimate_approved_with_provenance', why: 'estimate belum disetujui owner' },
    { to: 'cancelled', roles: ['owner'], guard: 'nothing_reserved', why: 'hanya sah bila belum ada reservasi aktif' },
    { to: 'in_progress', roles: ['owner'], guard: 'variation_approved|variation_declined', why: 'hanya sah untuk memutuskan variation (setuju atau decline)' },
    { to: 'awaiting_parts', roles: ['owner'], guard: 'variation_approved', why: 'variation disetujui tapi part-nya kosong' },
  ],
  approved: [
    { to: 'awaiting_parts', roles: ['parts_counter', 'owner'], guard: 'shortage_creates_orders', why: 'membuka order part untuk part yang kosong' },
    { to: 'in_progress', roles: ['mechanic'], guard: 'bay_booked_and_parts_ready', why: 'butuh bay ter-booking dan part siap' },
    { to: 'cancelled', roles: ['owner'], guard: 'no_invoice', why: 'tidak bisa batal kalau sudah ada invoice' },
  ],
  awaiting_parts: [
    { to: 'in_progress', roles: ['mechanic'], guard: 'no_open_order_parts', why: 'masih ada order part yang belum diterima' },
    { to: 'cancelled', roles: ['owner'], guard: 'no_invoice', why: 'tidak bisa batal kalau sudah ada invoice' },
  ],
  in_progress: [
    { to: 'qc', roles: ['mechanic'], guard: 'actuals_recorded', why: 'jam kerja aktual belum dicatat' },
    { to: 'awaiting_approval', roles: ['mechanic', 'owner'], guard: 'variation_pending', why: 'butuh ada variation pending untuk diputuskan pelanggan' },
    { to: 'cancelled', roles: ['owner'], guard: 'no_invoice', why: 'tidak bisa batal kalau sudah ada invoice' },
  ],
  qc: [
    { to: 'ready', roles: ['owner'], guard: 'qc_passed', why: 'QC terakhir harus lulus' },
    { to: 'in_progress', roles: ['owner'], guard: 'qc_failed_counts_rework', why: 'QC terakhir harus gagal (rework)' },
    { to: 'cancelled', roles: ['owner'], guard: 'no_invoice', why: 'tidak bisa batal kalau sudah ada invoice' },
  ],
  ready: [
    { to: 'completed', roles: ['owner'], guard: 'invoice_issued', why: 'butuh invoice terbit' },
    { to: 'in_progress', roles: ['owner'], guard: 'handover_rejected', why: 'serah terima ditolak pelanggan' },
  ],
  completed: [],
  cancelled: [],
};

/** Build the per-state edge list once, merging duplicate targets. */
export const EDGES = Object.fromEntries(STATES.map((s) => {
  const byTo = new Map();
  for (const e of RAW[s]) {
    const seen = byTo.get(e.to);
    if (seen) {
      seen.roles = [...new Set([...seen.roles, ...e.roles])];
      seen.why = `${seen.why} · ${e.why}`;
    } else {
      byTo.set(e.to, { ...e });
    }
  }
  return [s, [...byTo.values()]];
}));

export const isTerminal = (state) => EDGES[state].length === 0;

export function edgesFor(state) { return EDGES[state] ?? []; }

export function roleAllowed(edge, role) { return edge.roles.includes(role); }

export function roleSentence(role) { return `role '${role}'`; }

/**
 * Guard hints computed from the job detail the server already sent. These are DELIBERATELY
 * conservative: a hint only blocks the button when the loaded payload proves the guard fails
 * (`block` true). Everything else stays clickable so the server's own message — the one written
 * to be human-readable — is what the operator reads. No client-side guess outranks the backend.
 */
export function guardHint(detail, to) {
  const job = detail?.job;
  if (!job) return { block: false, text: '' };
  const state = job.state;
  const lastQc = detail.qc_checks?.[detail.qc_checks.length - 1] ?? null;
  const openOrders = (detail.order_parts ?? []).filter((o) => o.status === 'open');
  const bayBooked = (detail.bay_bookings ?? []).some((b) => b.status === 'booked');
  const activeResv = (detail.reservations ?? []).length;

  if (state === 'intake' && to === 'diagnosis') {
    return { block: false, text: 'butuh checklist intake lengkap' };
  }
  if (state === 'diagnosis' && to === 'awaiting_approval') {
    const est = (detail.estimates ?? []).find((e) => e.kind === 'original');
    if (!est) return { block: true, text: 'belum ada estimate asli' };
    if (est.lines.length === 0) return { block: true, text: 'estimate asli belum punya baris' };
    if (est.status !== 'pending_approval') {
      return { block: true, text: `estimate berstatus ${est.status}; disubmit dulu` };
    }
    return { block: false, text: 'estimate siap diapprove' };
  }
  if (state === 'approved' && to === 'in_progress') {
    if (!bayBooked) return { block: true, text: 'belum ada bay ter-booking' };
    return { block: false, text: 'bay ter-booking' };
  }
  if (state === 'awaiting_parts' && to === 'in_progress') {
    if (openOrders.length > 0) {
      return { block: true, text: `${openOrders.length} order part masih open` };
    }
    return { block: false, text: 'semua order part diterima' };
  }
  if (state === 'in_progress' && to === 'qc') {
    if (job.actual_hours === null) return { block: true, text: 'jam kerja aktual belum dicatat' };
    return { block: false, text: `jam aktual ${job.actual_hours} jam tercatat` };
  }
  if (state === 'qc' && to === 'ready') {
    if (!lastQc) return { block: true, text: 'belum ada hasil QC' };
    if (!lastQc.passed) return { block: true, text: `QC terakhir gagal: ${lastQc.reason ?? 'tanpa alasan'}` };
    return { block: false, text: 'QC terakhir lulus' };
  }
  if (state === 'qc' && to === 'in_progress') {
    if (lastQc && lastQc.passed) {
      return { block: true, text: 'QC terakhir lulus; edge ini khusus rework' };
    }
    return { block: false, text: 'rework dihitung otomatis bila QC gagal' };
  }
  if (state === 'ready' && to === 'completed') {
    if (!detail.invoice) return { block: true, text: 'invoice belum terbit — tutup dengan invoice dulu' };
    return { block: false, text: `invoice ${detail.invoice.number} terbit` };
  }
  if (to === 'cancelled' && activeResv > 0 && state === 'awaiting_approval') {
    return { block: true, text: `${activeResv} reservasi aktif masih ada` };
  }
  return { block: false, text: '' };
}

/** Label for a transition button. */
export function edgeLabel(to) {
  return {
    diagnosis: 'Mulai diagnosis',
    awaiting_approval: 'Kirim ke pelanggan',
    approved: 'Setujui estimate',
    awaiting_parts: 'Tunggu part',
    in_progress: 'Mulai dikerjakan',
    qc: 'Kirim ke QC',
    ready: 'Tandai siap serah',
    completed: 'Selesaikan',
    cancelled: 'Batalkan WO',
  }[to] ?? STATE_LABEL[to] ?? to;
}
