// WHY the drawer shows every edge, not just the legal ones: the role rules ARE the product here.
// An advisor who cannot see why "Setujui estimate" is dead for them has learned nothing; showing the
// button greyed out with the server's own guard wording teaches the workflow. The server stays the
// authority — every button here still POSTs and any refusal is rendered verbatim.

import { api, rp, when, num, getSession } from './api.mjs';
import {
  h, mount, frag, errorBlock, skeleton, stateBadge, toast, emptyState, confirmDestructive, iconBtn,
} from './dom.mjs';
import {
  STATE_LABEL, STATE_GLYPH, edgesFor, guardHint, isTerminal, edgeLabel,
} from './fsm.mjs';

const ROLE_IDS = { 'Budi Santoso': 'M1', 'Andi Prasetyo': 'M2', 'Rita Kumala': 'M3' };
const staffName = (id) => (id === 1 ? 'Budi Santoso (owner)' : id === 2 ? 'Andi Prasetyo (mekanik)' : id === 3 ? 'Rita Kumala (parts)' : '—');

export const drawerState = {
  jobId: null,
  detail: null,
  loading: false,
  error: null,
  /** Per-section error, so one failed write never blanks the whole drawer. */
  actionError: null,
  lastAction: null,
};

let drawerEl = null;
let lastFocus = null;
let ctx = {}; // { bays, jobs, onChanged, openInvoice }

/**
 * plate/customer live on the JOB LIST, not on /api/jobs/:id (that row is the bare jobs table), so
 * the drawer looks the header values up from the list it already has instead of refetching.
 */
function identityOf(detail) {
  const row = (ctx.jobs ?? []).find((j) => j.id === detail?.job?.id);
  return { plate: row?.plate ?? '—', customer: row?.customer ?? '' };
}

export function setDrawerContext(next) { ctx = { ...ctx, ...next }; }

export async function openJob(jobId, { bays = [] } = {}) {
  lastFocus = document.activeElement;
  drawerState.jobId = jobId;
  drawerState.loading = true;
  drawerState.error = null;
  drawerState.actionError = null;
  renderDrawer();
  try {
    drawerState.detail = await api.get(`/api/jobs/${jobId}`, 'memuat detail work order');
    drawerState.loading = false;
  } catch (err) {
    drawerState.error = err;
    drawerState.loading = false;
  }
  renderDrawer();
  // Focus moves into the drawer so a keyboard user is not left behind on the board.
  queueMicrotask(() => drawerEl?.querySelector('.drawer-close')?.focus());
}

export function closeDrawer() {
  drawerState.jobId = null;
  drawerState.detail = null;
  drawerEl?.remove();
  drawerEl = null;
  if (lastFocus?.isConnected) lastFocus.focus();
}

export async function refreshDrawer() {
  if (drawerState.jobId === null) return;
  drawerState.loading = true;
  renderDrawer();
  try {
    drawerState.detail = await api.get(`/api/jobs/${drawerState.jobId}`, 'memuat ulang detail work order');
    drawerState.error = null;
  } catch (err) {
    drawerState.error = err;
  }
  drawerState.loading = false;
  renderDrawer();
}

// ---------------------------------------------------------------- sections

function section(title, subtitle, ...body) {
  return h('section', { class: 'panel' },
    h('header', { class: 'panel-head' },
      h('h3', { class: 'panel-title' }, title),
      subtitle ? h('p', { class: 'panel-sub' }, subtitle) : null),
    h('div', { class: 'panel-body' }, ...body));
}

function actionBar(detail, role) {
  const edges = edgesFor(detail.job.state);
  if (isTerminal(detail.job.state)) {
    return h('div', { class: 'actions actions-terminal' },
      h('p', { class: 'terminal-note' },
        `WO ini sudah final di status ${STATE_LABEL[detail.job.state]} — tidak ada transisi keluar.`));
  }
  const items = edges.map((edge) => {
    const allowed = edge.roles.includes(role);
    const hint = guardHint(detail, edge.to);
    const blockedByRole = !allowed;
    const blockedByGuard = hint.block;
    const disabled = blockedByRole || blockedByGuard;
    const reason = blockedByRole
      ? `role '${role}' tidak boleh \u2014 hanya ${edge.roles.join(' / ')}`
      // An enabled button must not read like a refusal: show the requirement as a precondition.
      : blockedByGuard
        ? `Belum bisa: ${hint.text}`
        : `Syarat: ${hint.text || edge.why}`;
    return h('div', { class: 'action-slot' },
      h('button', {
        type: 'button',
        class: 'btn btn-action',
        disabled,
        'aria-disabled': disabled ? 'true' : null,
        title: reason,
        dataset: { to: edge.to, allowed: String(allowed), blocked: String(blockedByGuard) },
        onclick: () => runTransition(edge, hint),
      },
        h('span', { class: 'action-glyph', 'aria-hidden': 'true' }, STATE_GLYPH[edge.to] ?? '\u2192'),
        h('span', { class: 'action-label' }, edgeLabel(edge.to)),
        h('span', { class: 'action-to' }, STATE_LABEL[edge.to])),
      h('p', { class: `action-reason ${disabled ? 'is-blocked' : 'is-open'}` },
        disabled ? h('span', { class: 'reason-mark', 'aria-hidden': 'true' }, '\u2715') : null,
        reason));
  });
  return h('div', { class: 'actions' },
    h('p', { class: 'actions-note' },
      'Actif = legally next step untuk role ',
      h('strong', {}, ` ${role}`),
      ' dan prasyaratnya sudah terpenuhi. Mati = alasannya ditulis, bukan disembunyikan.'),
    ...items);
}

async function runTransition(edge, hint) {
  const { role } = getSession();
  const label = edgeLabel(edge.to);
  if (edge.to === 'cancelled' || (edge.to === 'in_progress' && detailState() === 'qc')) {
    const why = edge.to === 'cancelled'
      ? `Batalkan ${detailNumber()}? Reservasi dan slot bay dilepas.`
      : `Kembalikan ${detailNumber()} ke dikerjakan? Job ini dihitung rework.`;
    if (!confirmDestructive(why)) return;
  }
  const body = { to: edge.to };
  // Two edges need one more field from the counter, and asking inline beats inventing a default.
  if (edge.to === 'cancelled') {
    const reason = window.prompt('Alasan pembatalan (wajib, tersimpan di WO):', 'pelanggan batal datang');
    if (reason === null) return;
    if (reason.trim() === '') {
      drawerState.actionError = new Error('Alasan pembatalan wajib diisi.');
      drawerState.lastAction = label;
      renderDrawer();
      return;
    }
    body.cancel_reason = reason.trim();
  }
  if (edge.to === 'awaiting_parts' && detailState() === 'approved') {
    const eta = window.prompt('ETA part (YYYY-MM-DD):', '2026-03-12');
    if (eta === null) return;
    body.eta_date = eta.trim();
  }
  drawerState.actionError = null;
  drawerState.lastAction = label;
  try {
    const res = await api.post(`/api/jobs/${drawerState.jobId}/transition`, body, label);
    const moved = res.job?.state ?? edge.to;
    toast(`${detailNumber()} → ${STATE_LABEL[moved] ?? moved}`);
    await refreshDrawer();
    ctx.onChanged?.();
  } catch (err) {
    drawerState.actionError = err;
    drawerState.lastAction = label;
    renderDrawer();
  }
}

const detailState = () => drawerState.detail?.job?.state;
const detailNumber = () => drawerState.detail?.job?.number ?? `#${drawerState.jobId}`;

function estimatesBlock(detail) {
  if (!detail.estimates?.length) {
    return emptyState('Belum ada estimate.',
      'Estimate asli dibuat teknisi di tahap diagnosis, lalu dikirim untuk persetujuan pelanggan.',
      h('code', { class: 'inline-code' }, 'POST /api/jobs/:id/estimates'));
  }
  return detail.estimates.map((est) => h('div', { class: 'est' },
    h('header', { class: 'est-head' },
      h('h4', {}, est.kind === 'variation' ? 'Variation' : 'Estimate asli'),
      h('span', { class: 'est-status', dataset: { status: est.status } }, est.status),
      est.reason ? h('p', { class: 'est-reason' }, est.reason) : null),
    h('table', { class: 'tbl tbl-est' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, 'Item'),
        h('th', { scope: 'col', class: 'num' }, 'Qty'),
        h('th', { scope: 'col', class: 'num' }, 'Jam'),
        h('th', { scope: 'col', class: 'num' }, 'Harga'),
        h('th', { scope: 'col', class: 'num' }, 'Jumlah'))),
      h('tbody', {}, est.lines.length === 0
        ? h('tr', {}, h('td', { colspan: '5', class: 'tbl-empty' }, 'Estimate ini belum punya baris.'))
        : est.lines.map((l) => h('tr', { class: l.core_returnable ? 'is-core' : null },
            h('td', {},
              h('span', { class: 'line-kind' }, l.kind === 'labour' ? 'Tenaga' : 'Part'),
              h('span', { class: 'line-desc' }, l.description),
              l.core_returnable ? h('span', { class: 'badge badge-core' }, 'core') : null),
            h('td', { class: 'num' }, String(l.qty)),
            h('td', { class: 'num' }, l.unit_hours === null ? '—' : String(l.unit_hours)),
            h('td', { class: 'num' }, rp(l.unit_rate)),
            h('td', { class: 'num strong' }, rp(l.amount)))))),
    h('p', { class: 'est-total' },
      h('span', {}, 'Total estimate'),
      h('span', { class: 'num strong' }, rp(est.total)))));
}

function stockBlock(detail, jobId) {
  const resv = detail.reservations ?? [];
  const orders = detail.order_parts ?? [];
  const consumed = detail.consumptions ?? [];
  const cores = detail.core_returns ?? [];
  const anyResv = resv.length > 0 || orders.length > 0;
  const resvBody = resv.length === 0
    ? h('p', { class: 'empty-next' }, 'Belum ada reservasi. Reservasi dibuat otomatis saat owner menyetujui estimate.')
    : h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Item'),
          h('th', { scope: 'col', class: 'num' }, 'Qty'),
          h('th', { scope: 'col' }, 'Status'),
          h('th', { scope: 'col' }, ''))),
        h('tbody', {}, resv.map((r) => h('tr', {},
          h('td', {}, `Item #${r.stock_item_id}`),
          h('td', { class: 'num' }, String(r.qty)),
          h('td', {}, r.status),
          h('td', { class: 'num' }, consumeButton(jobId, r))))));
  const ordersBody = orders.length === 0
    ? h('p', { class: 'empty-next' }, 'Tidak ada order part terbuka. Kalau stok kurang saat approval, order dibuat otomatis.')
    : h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Part'),
          h('th', { scope: 'col', class: 'num' }, 'Dipesan'),
          h('th', { scope: 'col', class: 'num' }, 'Datang'),
          h('th', { scope: 'col' }, 'ETA'))),
        h('tbody', {}, orders.map((o) => h('tr', {},
          h('td', {}, `${o.sku} \u00B7 ${o.name ?? ''}`),
          h('td', { class: 'num' }, String(o.qty_ordered ?? '—')),
          h('td', { class: 'num' }, String(o.qty_received ?? 0)),
          h('td', {}, o.eta_date ? when(o.eta_date, { withTime: false }) : '—')))));
  const extras = [];
  if (consumed.length) {
    extras.push(h('p', { class: 'panel-note' },
      `${consumed.length} baris part sudah dipakai: `,
      consumed.map((c) => `${c.qty}× item #${c.stock_item_id}`).join(', ')));
  }
  if (cores.length) {
    extras.push(h('p', { class: 'panel-note' },
      'Core return: ',
      cores.map((c) => `${c.condition} (${rp(c.credit)})`).join(', ')));
  }
  return frag(
    h('h4', { class: 'sub-head' }, 'Reservasi part'),
    resvBody,
    h('h4', { class: 'sub-head' }, 'Order part'),
    ordersBody,
    ...extras);
}

function consumeButton(jobId, reservation) {
  if (reservation.status !== 'active') return h('span', { class: 'muted' }, '\u2014');
  const qty = h('input', {
    class: 'input input-num input-mini', type: 'number', min: '1', max: String(reservation.qty),
    value: '1', 'aria-label': `Qty untuk item #${reservation.stock_item_id}`, style: { width: '64px' },
  });
  return h('div', { class: 'row-inline' }, qty,
    h('button', {
      type: 'button', class: 'btn btn-mini',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await api.post(`/api/jobs/${jobId}/consume`, {
            estimate_line_id: reservation.estimate_line_id,
            stock_item_id: reservation.stock_item_id,
            qty: Number(qty.value),
          }, `memakai part item #${reservation.stock_item_id}`);
          toast(`Part dipakai: ${qty.value}× item #${reservation.stock_item_id}`);
          await refreshDrawer();
          ctx.onChanged?.();
        } catch (err) {
          drawerState.actionError = err;
          drawerState.lastAction = `memakai part item #${reservation.stock_item_id}`;
          btn.disabled = false;
          renderDrawer();
        }
      },
    }, 'Pakai'));
}

function bayBlock(detail, jobId, bays) {
  const bookings = (detail.bay_bookings ?? []).filter((b) => b.status !== 'cancelled');
  const bayName = (id) => bays.find((b) => b.id === Number(id))?.name ?? `Bay #${id}`;
  const list = bookings.length === 0
    ? h('p', { class: 'empty-next' }, 'Belum ada slot lift. Mekanik tidak bisa mulai kerja tanpa booking bay — booking di layar "Bay".')
    : h('ul', { class: 'plain-list' }, bookings.map((b) => h('li', { class: 'booking-row' },
        h('span', { class: 'booking-bay' }, bayName(b.bay_id)),
        h('span', { class: 'booking-time' }, `${when(b.start_ts)} \u00B7 ${b.duration_min} menit`),
        h('span', { class: 'booking-status', dataset: { status: b.status } }, b.status))));

  const baySel = h('select', { class: 'input', 'aria-label': 'Pilih bay' },
    ...bays.map((b) => h('option', { value: b.id }, b.name)));
  const timeInput = h('input', { class: 'input', type: 'datetime-local', value: '2026-03-10T08:00' });
  const durInput = h('input', { class: 'input input-num', type: 'number', min: '15', step: '15', value: '120' });
  const form = h('div', { class: 'form-grid form-grid-booking' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Bay'), baySel),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mulai'), timeInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Menit'), durInput),
    h('button', {
      type: 'button', class: 'btn btn-primary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await api.post('/api/bays/bookings', {
            job_id: jobId,
            bay_id: Number(baySel.value),
            // WHY +07:00 appended by hand: datetime-local yields 'YYYY-MM-DDTHH:MM' with no zone, and
        // new Date(that).toISOString() would resolve it in the VIEWER's timezone — an 08:00 booking
        // would land on a different grid cell for a recruiter than for the owner. The shop is WIB.
        start_ts: `${timeInput.value}:00+07:00`,
            duration_min: Number(durInput.value),
          }, `booking bay ${bayName(baySel.value)}`);
          toast(`Slot ${bayName(baySel.value)} di-booking`);
          await refreshDrawer();
          ctx.onChanged?.();
        } catch (err) {
          // The 409 IS the feature: the DB refused a double-booked 15-min block. Show it verbatim.
          drawerState.actionError = err;
          drawerState.lastAction = `booking bay ${bayName(baySel.value)}`;
          btn.disabled = false;
          renderDrawer();
        }
      },
    }, 'Booking'));
  return frag(list, h('h4', { class: 'sub-head' }, 'Tambah slot'), form);
}

function qcBlock(detail, jobId) {
  const checks = detail.qc_checks ?? [];
  const last = checks[checks.length - 1];
  const history = checks.length === 0
    ? h('p', { class: 'empty-next' }, 'Belum ada pemeriksaan QC. QC wajib diisi sebelum stage "Siap Diserah" bisa dibuka.')
    : h('ul', { class: 'plain-list' }, checks.map((c) => h('li', { class: 'qc-row' },
        h('span', { class: 'qc-verdict', dataset: { pass: c.passed ? '1' : '0' } },
          c.passed ? 'LULUS' : 'GAGAL'),
        h('span', { class: 'qc-when' }, when(c.at)),
        h('span', { class: 'qc-reason' }, c.reason ?? '\u2014'),
        h('span', { class: 'qc-by' }, staffName(c.checked_by)))));

  const reason = h('input', { class: 'input', type: 'text', placeholder: 'alasan bila GAGAL', 'aria-label': 'Alasan QC gagal' });
  const submit = async (passed, btn) => {
    btn.disabled = true;
    try {
      await api.post(`/api/jobs/${jobId}/qc`, { passed, reason: passed ? null : reason.value },
        `QC ${passed ? 'lulus' : 'gagal'}`);
      toast(`QC dicatat: ${passed ? 'lulus' : 'gagal'}`);
      await refreshDrawer();
      ctx.onChanged?.();
    } catch (err) {
      drawerState.actionError = err;
      drawerState.lastAction = `QC ${passed ? 'lulus' : 'gagal'}`;
      btn.disabled = false;
      renderDrawer();
    }
  };
  const controls = h('div', { class: 'qc-controls' },
    h('label', { class: 'field field-grow' }, h('span', { class: 'field-label' }, 'Catatan QC'), reason),
    h('div', { class: 'row-inline' },
      h('button', { type: 'button', class: 'btn btn-ok', onclick: (e) => submit(true, e.currentTarget) }, 'QC lulus'),
      h('button', { type: 'button', class: 'btn btn-danger', onclick: (e) => submit(false, e.currentTarget) }, 'QC gagal')));

  const hoursInput = h('input', {
    class: 'input input-num', type: 'number', step: '0.25', min: '0.25',
    value: detail.job.actual_hours ?? '', 'aria-label': 'Jam kerja aktual',
  });
  return frag(
    h('div', { class: 'hours-row' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, 'Jam kerja aktual'),
        hoursInput),
      h('button', {
        type: 'button', class: 'btn',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api.post(`/api/jobs/${jobId}/hours`, { actual_hours: Number(hoursInput.value) },
              'mencatat jam kerja aktual');
            toast(`Jam aktual dicatat: ${hoursInput.value}`);
            await refreshDrawer();
            ctx.onChanged?.();
          } catch (err) {
            drawerState.actionError = err;
            drawerState.lastAction = 'mencatat jam kerja aktual';
            btn.disabled = false;
            renderDrawer();
          }
        },
      }, 'Catat jam'),
      h('span', { class: 'muted' },
        detail.job.rework_count > 0 ? `rework ${detail.job.rework_count}\u00D7` : 'belum ada rework')),
    history, controls);
}

function closeBlock(detail, jobId) {
  const discount = h('input', { class: 'input input-num', type: 'number', min: '0', step: '1000', value: '0', 'aria-label': 'Diskon rupiah' });
  const reason = h('input', { class: 'input', type: 'text', placeholder: 'mis. pelanggan lama', 'aria-label': 'Alasan diskon' });
  return h('div', { class: 'form-grid form-grid-close' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Diskon (Rp)'), discount),
    h('label', { class: 'field field-grow' }, h('span', { class: 'field-label' }, 'Alasan diskon'), reason),
    h('button', {
      type: 'button', class: 'btn btn-primary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await api.post(`/api/jobs/${jobId}/close`, {
            discount: Number(discount.value) || 0,
            discount_reason: reason.value || null,
          }, 'menutup WO dengan invoice');
          toast('Invoice terbit, WO selesai');
          await refreshDrawer();
          ctx.onChanged?.();
        } catch (err) {
          drawerState.actionError = err;
          drawerState.lastAction = 'menutup WO dengan invoice';
          btn.disabled = false;
          renderDrawer();
        }
      },
    }, 'Tutup + terbitkan invoice'),
    h('p', { class: 'panel-note' },
      'Satu aksi: invoice terbit DAN stage ready \u2192 selesai. Kalau gagal, tidak ada invoice yatim.'));
}

function invoiceBlock(detail) {
  const inv = detail.invoice;
  if (!inv) {
    return emptyState('Belum ada invoice.',
      'Invoice terbit saat WO ditutup dari stage "Siap Diserah" — tombol "Tutup + terbitkan invoice" di bawah.');
  }
  const net = inv.subtotal + inv.tax - inv.discount - inv.core_credit;
  return frag(
    h('p', { class: 'invoice-line' },
      h('span', {}, 'No. invoice'), h('span', { class: 'num strong' }, inv.number),
      h('span', { class: 'muted' }, when(inv.issued_at))),
    h('p', { class: 'invoice-line' },
      h('span', {}, 'Subtotal'), h('span', { class: 'num' }, rp(inv.subtotal)),
      h('span', {}, 'Pajak'), h('span', { class: 'num' }, rp(inv.tax)),
      h('span', {}, 'Diskon'), h('span', { class: 'num' }, `(${rp(inv.discount)})`),
      h('span', {}, 'Core credit'), h('span', { class: 'num' }, `(${rp(inv.core_credit)})`)),
    h('p', { class: 'invoice-total' },
      h('span', {}, `Total tagihan${net !== inv.total ? ' (hitungan ulang)' : ''}`),
      h('span', { class: 'num' }, rp(inv.total))),
    h('button', {
      type: 'button', class: 'btn', onclick: () => ctx.openInvoice?.(inv.number),
    }, 'Buka invoice printable'));
}

function timeline(detail) {
  const log = detail.state_log ?? [];
  if (log.length === 0) return h('p', { class: 'empty-next' }, 'Riwayat status masih kosong.');
  return h('ol', { class: 'timeline' }, log.map((e) => h('li', { class: 'timeline-item' },
    h('span', { class: 'timeline-glyph', 'aria-hidden': 'true', dataset: { state: e.to_state } }, STATE_GLYPH[e.to_state] ?? '\u2022'),
    h('div', { class: 'timeline-body' },
      h('p', { class: 'timeline-what' },
        e.from_state ? h('span', { class: 'muted' }, `${STATE_LABEL[e.from_state]} \u2192 `) : null,
        h('strong', {}, STATE_LABEL[e.to_state] ?? e.to_state)),
      h('p', { class: 'timeline-meta' },
        when(e.at), ' \u00B7 ', e.actor_role ?? 'sistem',
        e.actor_id ? ` \u00B7 ${staffName(e.actor_id)}` : '')))));
}

// ---------------------------------------------------------------- shell

export function renderDrawer() {
  if (drawerState.jobId === null) return;
  if (!drawerEl) {
    drawerEl = h('aside', {
      class: 'drawer', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Detail work order',
    });
    document.body.append(drawerEl);
  }
  const { role } = getSession();
  const detail = drawerState.detail;
  const id = identityOf(detail);

  const head = h('header', { class: 'drawer-head' },
    h('div', {},
      h('p', { class: 'drawer-wo' }, detail?.job?.number ?? `WO #${drawerState.jobId}`),
      h('h2', { class: 'drawer-title' },
        id.plate,
        h('span', { class: 'drawer-cust' }, id.customer))),
    iconBtn('\u2715', 'Tutup detail work order', { class: 'drawer-close', onclick: closeDrawer }));

  let body;
  if (drawerState.error) {
    body = errorBlock(drawerState.error, { action: 'memuat detail work order' });
  } else if (drawerState.loading || !detail) {
    body = skeleton(8);
  } else {
    const job = detail.job;
    const badge = stateBadge(job.state, STATE_LABEL[job.state]);
    const meta = h('dl', { class: 'kv' },
      h('div', {}, h('dt', {}, 'Keluhan'), h('dd', {}, job.complaint)),
      h('div', {}, h('dt', {}, 'Advisor'), h('dd', {}, staffName(job.advisor_id))),
      h('div', {}, h('dt', {}, 'Mekanik'), h('dd', {}, staffName(job.mechanic_id))),
      h('div', {}, h('dt', {}, 'Masuk'), h('dd', {}, when(job.intake_at))),
      h('div', {}, h('dt', {}, 'Disetujui'), h('dd', {}, job.approved_at ? when(job.approved_at) : '—')),
      h('div', {}, h('dt', {}, 'Selesai'), h('dd', {}, job.completed_at ? when(job.completed_at) : '—')),
      job.cancel_reason ? h('div', {}, h('dt', {}, 'Alasan batal'), h('dd', {}, job.cancel_reason)) : null,
      h('div', {}, h('dt', {}, 'Rework'), h('dd', {}, `${job.rework_count}\u00D7`)),
      h('div', {}, h('dt', {}, 'Jam aktual'), h('dd', {}, job.actual_hours === null ? '—' : `${job.actual_hours} jam`)));

    const errStrip = drawerState.actionError
      ? errorBlock(drawerState.actionError, { action: drawerState.lastAction ?? 'aksi di drawer' })
      : null;

    body = frag(
      h('div', { class: 'drawer-scroll' },
        h('div', { class: 'drawer-status' }, badge,
          h('span', { class: 'muted' }, `role aktif: ${role}`)),
        meta,
        errStrip,
        section('Tindakan status', `Role '${role}' \u2014 edge yang tampil legal dari status ini; yang mati alasannya ditulis.`,
          actionBar(detail, role)),
        section('Estimate', 'Baris tenaga + part, core return ditandai.',
          estimatesBlock(detail)),
        section('Part & order', 'Reservasi, order part, pemakaian, core return.', stockBlock(detail, drawerState.jobId)),
        section('Bay', 'Slot lift untuk WO ini.', bayBlock(detail, drawerState.jobId, ctx.bays ?? [])),
        section('Jam kerja & QC', 'Jam aktual dicatat teknisi; QC diisi sebelum serah terima.', qcBlock(detail, drawerState.jobId)),
        section('Invoice', 'Detail invoice + tautan ke versi printable.', invoiceBlock(detail)),
        job.state === 'ready'
          ? section('Tutup WO', 'Terbit invoice dan selesaikan dalam satu transaksi.', closeBlock(detail, drawerState.jobId))
          : null,
        section('Riwayat status', `Jejak audit ${detail.state_log?.length ?? 0} entri.`, timeline(detail))));
  }
  mount(drawerEl, head, body);
}
