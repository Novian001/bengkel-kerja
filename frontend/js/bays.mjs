// WHY the bay day view is a CSS grid of 15-min blocks and not a scrolling timeline: the workshop
// opens 08:00-18:00, so the whole day fits in one grid with no horizontal overflow at any width,
// and an overlap is visible as a cell that the server refused to double-book. The 409 message is
// rendered in full — the DB rejecting a second booking on the same (bay_id, start_ts) is the
// invariant this screen exists to demonstrate.

import { api, when, todayISO } from './api.mjs';
import { h, mount, errorBlock, skeleton, emptyState, toast } from './dom.mjs';

export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 18;
const BLOCK_MIN = 15;
const COLS = ((CLOSE_HOUR - OPEN_HOUR) * 60) / BLOCK_MIN; // 40 blocks

export const bayState = {
  bays: [], jobs: [], day: null, bookings: new Map(),
  loading: true, error: null, formError: null, formAction: null,
};

/** The seeded workshop day is 2026-03-10 (WIB); today would show an empty shop. */
const SEEDED_DAY = '2026-03-10';

export async function loadBays(root, day = SEEDED_DAY) {
  bayState.day = day;
  bayState.loading = true;
  bayState.error = null;
  bayState.formError = null;
  renderBays(root);
  try {
    const [bays, jobs] = await Promise.all([
      api.get('/api/bays', 'memuat daftar bay'),
      api.get('/api/jobs', 'memuat daftar WO'),
    ]);
    bayState.bays = bays.bays;
    bayState.jobs = jobs.jobs;
    const perBay = await Promise.all(bays.bays.map((b) =>
      api.get(`/api/bays/${b.id}/bookings?day=${day}`, `memuat booking ${b.name}`)));
    bayState.bookings = new Map(bays.bays.map((b, i) => [b.id, perBay[i].bookings]));
    bayState.loading = false;
  } catch (err) {
    bayState.error = err;
    bayState.loading = false;
  }
  renderBays(root);
}

// WHY +07:00 here too: the grid is a WALL-CLOCK grid of a workshop in WIB, and the seed stores
// 13:00 WIB as 06:00Z. Reading UTC hours would draw that booking in the 06:00 column. Reading local
// browser hours would make the layout depend on the viewer's timezone, which is worse: the same
// repo must look identical to a recruiter in Berlin. So the shop's zone is explicit, in both
// directions. Ponytail: a real multi-region product would carry the zone in the row; one shop does
// not need a timezone column.
const SHOP_OFFSET_MIN = 7 * 60; // WIB

const shopMinutes = (iso) => {
  const d = new Date(iso);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + SHOP_OFFSET_MIN;
};

const slotIndex = (startIso) => Math.floor((shopMinutes(startIso) - OPEN_HOUR * 60) / BLOCK_MIN);

const hhmm = (i) => {
  const total = OPEN_HOUR * 60 + i * BLOCK_MIN;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function jobNumberOf(jobId) {
  return bayState.jobs.find((j) => j.id === Number(jobId))?.number ?? `WO #${jobId}`;
}

function bookingForm(root) {
  const jobSel = h('select', { class: 'input', 'aria-label': 'Pilih work order' },
    ...bayState.jobs.map((j) => h('option', { value: j.id }, `${j.number} \u00B7 ${j.plate}`)));
  const baySel = h('select', { class: 'input', 'aria-label': 'Pilih bay' },
    ...bayState.bays.map((b) => h('option', { value: b.id }, b.name)));
  const time = h('input', { class: 'input', type: 'time', value: '09:00', step: '900', 'aria-label': 'Jam mulai' });
  const dur = h('select', { class: 'input', 'aria-label': 'Durasi' },
    ...[30, 60, 90, 120, 180, 240, 300, 360].map((m) =>
      h('option', { value: m, selected: m === 120 }, `${m} menit`)));

  const errHost = h('div', {});
  const submit = async (btn) => {
    // requestSubmit() without an argument hands us a null submitter, so fall back to the button
    // in the form rather than dereferencing null.
    const button = btn ?? formEl.querySelector('button[type=submit]');
    if (button) button.disabled = true;
    mount(errHost);
    // WHY +07:00 and not 'Z': this shop is in Indonesia (WIB). A <input type=time> gives a bare
    // wall clock, and appending 'Z' would claim UTC and shift every booking by 7 hours — an 08:00
    // entry would come back as 00:00 and land on the wrong grid cell. The seed data already uses
    // WIB(+07:00) for the same reason. Wall clock in, same wall clock out.
    const startTs = `${bayState.day}T${time.value}:00+07:00`;
    try {
      await api.post('/api/bays/bookings', {
        job_id: Number(jobSel.value), bay_id: Number(baySel.value),
        start_ts: startTs, duration_min: Number(dur.value),
      }, `booking ${baySel.selectedOptions[0]?.textContent ?? ''} pukul ${time.value}`);
      toast(`Slot ${time.value} di-booking`);
      await loadBays(root, bayState.day);
    } catch (err) {
      bayState.formError = err;
      bayState.formAction = `booking ${baySel.selectedOptions[0]?.textContent ?? ''} pukul ${time.value}`;
      mount(errHost, errorBlock(err, { action: bayState.formAction }));
      if (button) button.disabled = false;
    }
  };

  const formEl = h('form', {
    class: 'booking-form',
    onsubmit: (e) => { e.preventDefault(); submit(e.submitter); },
  },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Work order'), jobSel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Bay'), baySel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mulai'), time),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Durasi'), dur),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Booking'),
    errHost);
  return formEl;
}

function bayRow(bay) {
  const bookings = (bayState.bookings.get(bay.id) ?? []).slice()
    .sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
  const grid = h('div', {
    class: 'bay-grid', role: 'list',
    style: { '--cols': String(COLS) },
  });
  for (let i = 0; i < COLS; i++) {
    const label = hhmm(i);
    const slot = h('div', {
      class: 'bay-slot', role: 'listitem',
      title: bookings.length ? `${jobNumberOf(bookings[0].job_id)} di ${label}` : `${label} kosong`,
    });
    grid.append(slot);
  }
  // Bookings are painted as positioned overlays so a long booking reads as one span, not N cells.
  for (const bk of bookings) {
    const start = Math.max(0, slotIndex(bk.start_ts));
    const span = Math.max(1, Math.ceil(bk.duration_min / BLOCK_MIN));
    if (start >= COLS) continue;
    grid.append(h('div', {
      class: 'bay-booking',
      style: { '--start': String(start), '--span': String(Math.min(span, COLS - start)) },
      title: `${jobNumberOf(bk.job_id)} \u00B7 ${when(bk.start_ts)} \u00B7 ${bk.duration_min} menit`,
    },
      h('span', { class: 'bay-booking-wo' }, jobNumberOf(bk.job_id)),
      h('span', { class: 'bay-booking-time' }, hhmm(start))));
  }
  const total = bookings.reduce((s, b) => s + b.duration_min, 0);
  const pct = Math.round((total / ((CLOSE_HOUR - OPEN_HOUR) * 60)) * 1000) / 10;
  return h('div', { class: 'bay-row' },
    h('div', { class: 'bay-meta' },
      h('h4', { class: 'bay-name' }, bay.name),
      h('p', { class: 'bay-stats' },
        `${bookings.length} booking \u00B7 ${total} menit terpakai \u00B7 ${pct}%`)),
    grid);
}

export function renderBays(root) {
  if (bayState.error) {
    mount(root, errorBlock(bayState.error, { action: 'memuat jadwal bay' }));
    return;
  }
  if (bayState.loading) { mount(root, skeleton(6)); return; }

  const hours = h('div', { class: 'bay-hours', style: { '--cols': String(COLS) }, 'aria-hidden': 'true' },
    ...Array.from({ length: 6 }, (_, i) => h('span', {}, `${String(OPEN_HOUR + i * 2).padStart(2, '0')}:00`)));

  const dayInput = h('input', {
    class: 'input input-day', type: 'date', value: bayState.day,
    'aria-label': 'Pilih tanggal',
  });

  mount(root,
    h('div', { class: 'screen-head' },
      h('h2', { class: 'screen-title' }, 'Jadwal Bay'),
      h('p', { class: 'screen-sub' },
        `Blok 15 menit, buka ${String(OPEN_HOUR).padStart(2, '0')}:00\u2013${CLOSE_HOUR}:00. Slot yang bentrok ditolak database, bukan disembunyikan.`),
      h('div', { class: 'screen-actions' },
        dayInput,
        h('button', {
          type: 'button', class: 'btn btn-primary',
          onclick: () => loadBays(root, dayInput.value || SEEDED_DAY),
        }, 'Tampilkan hari ini'))),
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title' }, `Hari ${when(`${bayState.day}T00:00:00Z`, { withTime: false })}`),
        h('p', { class: 'panel-sub' }, 'Coba booking slot yang sama dua kali: server membalas 409 dan alasannya tampil di sini.')),
      h('div', { class: 'panel-body' },
        hours,
        bayState.bays.length === 0
          ? emptyState('Belum ada bay aktif.', 'Tambahkan bay lewat seed atau backend, lalu muat ulang.')
          : h('div', { class: 'bay-list' }, bayState.bays.map(bayRow)))),
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title' }, 'Booking baru'),
        h('p', { class: 'panel-sub' }, 'Bentrok = 409 dari database, tampil apa adanya di bawah form.')),
      h('div', { class: 'panel-body' }, bookingForm(root))));
}
