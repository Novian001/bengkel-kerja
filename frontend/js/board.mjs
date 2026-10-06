// WHY the board is three lanes instead of ten columns: a ten-column kanban of one card each is a
// wall of empty chrome that the advisor cannot scan. Three lanes hold the live work, each state
// is a labelled group inside a lane, and closed states collapse into an archive strip the operator
// opens when they need history. The state COUNT comes from /api/board; the CARDS come from
// /api/jobs, which is the only endpoint that carries plate, customer and complaint.

import { api, rp, when, num } from './api.mjs';
import { h, mount, frag, emptyState, errorBlock, skeleton, stateBadge } from './dom.mjs';
import { LANES, CLOSED_STATES, STATES, STATE_LABEL, STATE_SHORT, STATE_GLYPH } from './fsm.mjs';

/** Board state lives in one object so the drawer and the board cannot disagree. */
export const boardState = {
  jobs: [],
  counts: new Map(),
  loading: true,
  error: null,
  archiveOpen: false,
  /** <=900px: only the selected state renders. null = all lanes stacked (desktop). */
  mobileState: null,
};

/** awaiting_parts jobs carry an ETA from their open order part; this is the blocked-until marker. */
function blockedUntil(job, ordersByJob) {
  if (job.state !== 'awaiting_parts') return null;
  const orders = ordersByJob.get(job.id) ?? [];
  const open = orders.filter((o) => o.status === 'open');
  if (open.length === 0) return null;
  const eta = open.map((o) => o.eta_date).filter(Boolean).sort()[0];
  return eta ? { eta, count: open.length } : { eta: null, count: open.length };
}

export async function loadBoard(root, { onOpenJob }) {
  boardState.loading = true;
  boardState.error = null;
  renderBoard(root, { onOpenJob });
  try {
    const [jobsRes, boardRes, ordersRes] = await Promise.all([
      api.get('/api/jobs', 'memuat papan kerja'),
      api.get('/api/board', 'memuat hitungan papan'),
      api.get('/api/order-parts', 'memuat order part'),
    ]);
    boardState.jobs = jobsRes.jobs;
    boardState.counts = new Map(boardRes.board.map((r) => [r.state, r.jobs]));
    boardState.orders = ordersRes.open;
    boardState.loading = false;
  } catch (err) {
    boardState.error = err;
    boardState.loading = false;
  }
  renderBoard(root, { onOpenJob });
}

function jobCard(job, ordersByJob, onOpenJob) {
  const blocked = blockedUntil(job, ordersByJob);
  const meta = [
    h('span', { class: 'card-plate' }, job.plate),
    h('span', { class: 'card-sep', 'aria-hidden': 'true' }, '\u00B7'),
    h('span', { class: 'card-customer' }, job.customer),
  ];
  return h('li', {},
    h('button', {
      type: 'button',
      class: 'job-card',
      dataset: { state: job.state },
      'aria-label': `Buka ${job.number}, ${job.plate}, ${job.customer}, status ${STATE_LABEL[job.state]}`,
      onclick: () => onOpenJob(job.id),
    },
      h('span', { class: 'card-top' },
        h('span', { class: 'card-wo' }, job.number),
        job.rework_count > 0
          ? h('span', { class: 'badge badge-rework', title: `${job.rework_count}× rework` },
              h('span', { 'aria-hidden': 'true' }, '\u21BB'), `${job.rework_count} rework`)
          : null),
      h('span', { class: 'card-meta' }, meta),
      h('span', { class: 'card-complaint', title: job.complaint }, job.complaint),
      h('span', { class: 'card-foot' },
        h('span', { class: 'card-mech' },
          h('span', { class: 'card-mech-label' }, 'Mekanik'),
          job.mechanic_id ? `M${job.mechanic_id}` : 'belum ditugaskan'),
        job.actual_hours !== null
          ? h('span', { class: 'card-hours' }, `${job.actual_hours} jam aktual`)
          : null),
      blocked
        ? h('span', { class: 'card-blocked' },
            h('span', { 'aria-hidden': 'true' }, '\u231B'),
            blocked.eta
              ? `tertahan sampai ${when(blocked.eta, { withTime: false })}`
              : `${blocked.count} order part belum datang`)
        : null));
}

function stateGroup(state, jobs, ordersByJob, onOpenJob) {
  const count = boardState.counts.get(state);
  const heading = h('h4', { class: 'group-head', id: `grp-${state}` },
    h('span', { class: 'group-glyph', 'aria-hidden': 'true', dataset: { state } }, STATE_GLYPH[state]),
    h('span', { class: 'group-name' }, STATE_LABEL[state]),
    h('span', { class: 'group-count' }, String(count ?? jobs.length)));
  if (jobs.length === 0) {
    return h('section', { class: 'state-group', dataset: { state } },
      heading,
      h('p', { class: 'group-empty' },
        count === 0 ? 'Kosong — tidak ada WO di tahap ini.' : 'Memuat…'));
  }
  return h('section', { class: 'state-group', dataset: { state } },
    heading,
    h('ul', { class: 'card-list', 'aria-labelledby': `grp-${state}` },
      jobs.map((j) => jobCard(j, ordersByJob, onOpenJob))));
}

function lane(laneDef, jobsByState, ordersByJob, onOpenJob) {
  const total = laneDef.states.reduce((s, st) => s + (boardState.counts.get(st) ?? 0), 0);
  return h('section', { class: 'lane', 'aria-labelledby': `lane-${laneDef.id}` },
    h('header', { class: 'lane-head' },
      h('h3', { id: `lane-${laneDef.id}` }, laneDef.title),
      h('span', { class: 'lane-count' }, `${num.format(total)} WO`)),
    h('p', { class: 'lane-hint' }, laneDef.hint),
    ...laneDef.states.map((st) => stateGroup(st, jobsByState.get(st) ?? [], ordersByJob, onOpenJob)));
}

function archiveStrip(jobsByState, ordersByJob, onOpenJob) {
  const jobs = CLOSED_STATES.flatMap((st) => jobsByState.get(st) ?? []);
  const closed = boardState.counts.get('completed') ?? 0;
  const cancelled = boardState.counts.get('cancelled') ?? 0;
  const total = closed + cancelled;
  if (total === 0) {
    return h('section', { class: 'archive' },
      h('h3', { class: 'archive-head' }, 'Arsip WO'),
      h('p', { class: 'empty-next' },
        'Belum ada WO selesai atau batal. Setelah WO ditutup di stage "Siap Diserah", nomor invoice dan arsipnya muncul di sini.'));
  }
  if (!boardState.archiveOpen) {
    return h('section', { class: 'archive' },
      h('h3', { class: 'archive-head' }, 'Arsip WO'),
      h('p', { class: 'archive-line' },
        `${num.format(closed)} selesai`, h('span', { class: 'card-sep' }, '\u00B7'),
        `${num.format(cancelled)} batal`),
      h('button', {
        type: 'button', class: 'btn btn-ghost', 'aria-expanded': 'false',
        onclick: (e) => { boardState.archiveOpen = true; e.currentTarget.closest('.archive').dataset.open = '1'; },
      }, 'Buka arsip'));
  }
  return h('section', { class: 'archive', dataset: { open: '1' } },
    h('h3', { class: 'archive-head' }, 'Arsip WO'),
    h('button', {
      type: 'button', class: 'btn btn-ghost',
      onclick: (e) => {
        boardState.archiveOpen = false;
        const strip = e.currentTarget.closest('.archive');
        strip.dataset.open = '0';
        strip.replaceChildren(...archiveStrip(jobsByState, ordersByJob, onOpenJob).childNodes);
      },
    }, 'Tutup arsip'),
    ...CLOSED_STATES.map((st) => stateGroup(st, jobsByState.get(st) ?? [], ordersByJob, onOpenJob)));
}

export function renderBoard(root, { onOpenJob }) {
  const jobsByState = new Map(STATES.map((s) => [s, []]));
  for (const j of boardState.jobs) jobsByState.get(j.state)?.push(j);
  const ordersByJob = new Map();
  for (const o of boardState.orders ?? []) {
    if (!ordersByJob.has(o.job_id)) ordersByJob.set(o.job_id, []);
    ordersByJob.get(o.job_id).push(o);
  }

  if (boardState.error) {
    mount(root, errorBlock(boardState.error, { action: 'memuat papan kerja' }),
      h('p', { class: 'empty-next' },
        'Periksa server di http://127.0.0.1:4310/health, lalu muat ulang halaman.'));
    return;
  }
  if (boardState.loading) {
    mount(root, skeleton(6));
    return;
  }

  const head = h('div', { class: 'board-head' },
    h('h2', { class: 'screen-title' }, 'Papan Work Order'),
    h('p', { class: 'screen-sub' },
      'Klik kartu untuk membuka WO. Tombol status di dalam drawer hanya menyala untuk role Anda.'));

  // <=900px: a state picker replaces the three lanes. Same data, one column, no horizontal scroll.
  const picker = h('div', { class: 'state-picker' },
    h('label', { class: 'picker-label', for: 'board-state-picker' }, 'Tahap'),
    h('select', {
      class: 'input', id: 'board-state-picker',
      onchange: (e) => { boardState.mobileState = e.target.value || null; renderBoard(root, { onOpenJob }); },
    },
      h('option', { value: '' }, 'Semua tahap'),
      ...STATES.filter((s) => !CLOSED_STATES.includes(s)).map((s) =>
        h('option', { value: s, selected: s === boardState.mobileState },
          `${STATE_LABEL[s]} (${boardState.counts.get(s) ?? 0})`))));

  const lanesHost = h('div', { class: 'lanes', dataset: { mode: boardState.mobileState ? 'single' : 'lanes' } });
  if (boardState.mobileState) {
    const st = boardState.mobileState;
    lanesHost.append(stateGroup(st, jobsByState.get(st) ?? [], ordersByJob, onOpenJob));
  } else {
    for (const l of LANES) lanesHost.append(lane(l, jobsByState, ordersByJob, onOpenJob));
  }

  const totalOpen = STATES
    .filter((s) => !CLOSED_STATES.includes(s))
    .reduce((n, s) => n + (boardState.counts.get(s) ?? 0), 0);
  const summary = totalOpen === 0
    ? emptyState('Belum ada work order terbuka.',
      'Buat WO baru dari backend (POST /api/jobs) atau ubah tanggal seed; papan ini akan langsung terisi.',
      h('code', { class: 'inline-code' }, 'curl -X POST /api/jobs …'))
    : null;

  mount(root, head, picker, summary, lanesHost, archiveStrip(jobsByState, ordersByJob, onOpenJob));
}
