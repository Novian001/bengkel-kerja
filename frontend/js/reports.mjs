// WHY reports are plain rows and bars, not a hero-metric strip: the counter asks "are the lifts
// full, is rework eating the day, did money come in" — three questions with three numbers each.
// Utilisation is a bar because it is a ratio against a known capacity (40 blocks); revenue and
// cycle time are text because there is no denominator to draw them against.

import { api, rp, when, num, todayISO } from './api.mjs';
import { h, mount, errorBlock, skeleton, emptyState, loadingNote } from './dom.mjs';
import { STATE_LABEL, STATE_GLYPH, STATES, CLOSED_STATES } from './fsm.mjs';

export const reportState = {
  day: '2026-03-10', daily: null, eva: null, invoices: [],
  loading: true, error: null, errorAction: null,
};

export async function loadReports(root, day = reportState.day) {
  reportState.day = day;
  reportState.loading = true;
  reportState.error = null;
  renderReports(root);
  try {
    const [daily, eva, inv] = await Promise.all([
      api.get(`/api/reports/daily?day=${day}`, `memuat laporan harian ${day}`),
      api.get('/api/reports/estimate-vs-actual', 'memuat laporan estimasi vs aktual'),
      api.get('/api/invoices', 'memuat daftar invoice'),
    ]);
    reportState.daily = daily;
    reportState.eva = eva.rows;
    reportState.invoices = inv.invoices;
    reportState.loading = false;
  } catch (err) {
    reportState.error = err;
    reportState.loading = false;
  }
  renderReports(root);
}

function utilisationBars(rows) {
  const max = Math.max(100, ...rows.map((r) => r.utilisation_pct));
  return rows.map((r) => h('div', { class: 'util-row' },
    h('span', { class: 'util-name' }, r.name),
    h('div', { class: 'util-track' },
      h('div', {
        class: 'util-fill',
        style: { width: `${(r.utilisation_pct / max) * 100}%` },
        role: 'img',
        'aria-label': `${r.name}: ${r.utilisation_pct} persen terpakai, ${r.bookings} booking, ${r.booked_blocks} dari ${r.capacity_blocks} blok`,
      }),
      h('span', { class: 'util-pct num' }, `${num.format(r.utilisation_pct)}%`)),
    h('span', { class: 'util-meta num' },
      `${r.bookings} booking \u00B7 ${r.booked_blocks}/${r.capacity_blocks} blok`)));
}

function stateBars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.jobs));
  return rows.slice().sort((a, b) => b.jobs - a.jobs).map((r) => h('div', {
    class: 'util-row', dataset: { state: r.state },
  },
    h('span', { class: 'util-name' },
      h('span', { class: 'group-glyph', 'aria-hidden': 'true', dataset: { state: r.state } }, STATE_GLYPH[r.state] ?? '\u2022'),
      STATE_LABEL[r.state] ?? r.state),
    h('div', { class: 'util-track' },
      h('div', { class: 'util-fill', style: { width: `${(r.jobs / max) * 100}%` } }),
      h('span', { class: 'util-pct num' }, num.format(r.jobs))),
    h('span', { class: 'util-meta' },
      CLOSED_STATES.includes(r.state) ? 'tutup' : 'terbuka')));
}

/** A fact row: label left, value right, no card, no icon. Dense and scannable. */
function fact(label, value, note = null) {
  return h('div', { class: 'fact' },
    h('span', { class: 'fact-label' }, label),
    h('span', { class: 'fact-value num' }, value),
    note ? h('span', { class: 'fact-note' }, note) : null);
}

export function renderReports(root, { openInvoice } = {}) {
  if (reportState.error) {
    mount(root, errorBlock(reportState.error, { action: reportState.errorAction ?? 'memuat laporan' }));
    return;
  }
  if (reportState.loading || !reportState.daily) { mount(root, skeleton(8)); return; }

  const d = reportState.daily;
  const dayInput = h('input', {
    class: 'input input-day', type: 'date', value: reportState.day, 'aria-label': 'Pilih tanggal laporan',
  });

  const rework = d.rework ?? { qc_checks: 0, qc_failed: 0, rework_rate_pct: 0, rework_count_sum: 0 };
  const invoiceRows = (d.revenue_by_invoice ?? []).length === 0
    ? emptyState('Belum ada invoice terbit di hari ini.',
        'Invoice terbit saat WO ditutup di stage "Siap Diserah". Buka papan kerja, pilih WO yang "Siap Diserah", lalu tutup dengan invoice.',
        h('code', { class: 'inline-code' }, 'POST /api/jobs/:id/close'))
    : h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Invoice'),
          h('th', { scope: 'col', class: 'num' }, 'Pekerjaan + part'),
          h('th', { scope: 'col', class: 'num' }, 'Variation'),
          h('th', { scope: 'col', class: 'num' }, 'Consumable'),
          h('th', { scope: 'col', class: 'num' }, 'Total'))),
        h('tbody', {}, d.revenue_by_invoice.map((r) => h('tr', {},
          h('th', { scope: 'row' },
            h('button', {
              type: 'button', class: 'link-btn', onclick: () => openInvoice?.(r.number),
            }, r.number)),
          h('td', { class: 'num' }, rp(r.labour_and_parts)),
          h('td', { class: 'num' }, rp(r.variation)),
          h('td', { class: 'num' }, rp(r.consumables)),
          h('td', { class: 'num strong' }, rp(r.total))))));

  const evaRows = (reportState.eva ?? []).length === 0
    ? h('p', { class: 'empty-next' }, 'Belum ada WO dengan jam aktual tercatat.')
    : h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'WO'),
          h('th', { scope: 'col', class: 'num' }, 'Jam aktual'),
          h('th', { scope: 'col', class: 'num' }, 'Tenaga offers'),
          h('th', { scope: 'col', class: 'num' }, 'Nilai part dipakai'),
          h('th', { scope: 'col', class: 'num' }, 'Selisih part'),
          h('th', { scope: 'col', class: 'num' }, 'Rework'))),
        h('tbody', {}, reportState.eva.map((r) => {
          const diff = r.consumed_value - r.quoted_labour;
          return h('tr', {},
            h('th', { scope: 'row' }, r.number),
            h('td', { class: 'num' }, r.actual_hours === null ? '—' : String(r.actual_hours)),
            h('td', { class: 'num' }, rp(r.quoted_labour)),
            h('td', { class: 'num' }, rp(r.consumed_value)),
            h('td', { class: 'num', dataset: { sign: diff > 0 ? 'over' : diff < 0 ? 'under' : 'even' } },
              `${diff > 0 ? '+' : ''}${rp(diff)}`),
            h('td', { class: 'num' }, r.rework_count > 0 ? `${r.rework_count}\u00D7` : '0'));
        })));

  mount(root,
    h('div', { class: 'screen-head' },
      h('h2', { class: 'screen-title' }, 'Laporan Harian'),
      h('p', { class: 'screen-sub' },
        'Angka dihitung ulang dari ledger, bukan dari cache di browser.'),
      h('div', { class: 'screen-actions' },
        dayInput,
        h('button', {
          type: 'button', class: 'btn', onclick: () => loadReports(root, dayInput.value || todayISO()),
        }, 'Tampilkan'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => loadReports(root, todayISO()) }, 'Hari ini'))),

    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title' }, `Ringkasan ${when(`${d.day}T00:00:00Z`, { withTime: false })}`)),
      h('div', { class: 'facts' },
        fact('WO terbuka', num.format(d.open_jobs), `${num.format((d.jobs_by_state ?? []).reduce((s, r) => s + r.jobs, 0))} total WO masuk s/d hari ini`),
        fact('Selesai hari ini', num.format(d.completed_today),
          d.average_cycle_hours === null ? 'belum ada WO selesai hari ini' : `siklus rata-rata ${num.format(d.average_cycle_hours)} jam`),
        fact('Tingkat rework', `${num.format(rework.rework_rate_pct)}%`,
          `${rework.qc_failed} gagal dari ${rework.qc_checks} QC \u00B7 total rework ${rework.rework_count_sum}\u00D7`),
        fact('Omzet hari ini', rp(d.revenue_total), `variation ${rp(d.variation_revenue)}`),
        fact('Pemanasan lift', `${num.format(d.bay_utilisation_pct)}%`, 'rata-rata seluruh bay'))),

    h('div', { class: 'report-cols' },
      h('section', { class: 'panel' },
        h('header', { class: 'panel-head' },
          h('h3', { class: 'panel-title' }, 'Pemanasan bay'),
          h('p', { class: 'panel-sub' }, 'Blok 15 menit terpakai vs 40 blok buka.')),
        h('div', { class: 'panel-body' }, utilisationBars(d.bay_utilisation ?? []))),
      h('section', { class: 'panel' },
        h('header', { class: 'panel-head' },
          h('h3', { class: 'panel-title' }, 'WO per tahap'),
          h('p', { class: 'panel-sub' }, 'Termasuk WO yang sudah tutup, untuk lihat antrean menumpuk.')),
        h('div', { class: 'panel-body' }, stateBars(d.jobs_by_state ?? [])))),

    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title' }, 'Pendapatan per invoice'),
        h('p', { class: 'panel-sub' }, 'Klik nomor invoice untuk buka versi printable.')),
      h('div', { class: 'panel-body' }, invoiceRows)),

    // WHY a separate invoice list: revenue_by_invoice is scoped to the selected DAY, and the
    // seeded invoice is stamped with the server's own clock. Without this list the invoice screen
    // would be unreachable on any day that had no money come in.
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title' }, 'Invoice terbit'),
        h('p', { class: 'panel-sub' }, 'Semua invoice di toko, kapan pun diterbitkan.')),
      h('div', { class: 'panel-body' }, (reportState.invoices ?? []).length === 0
        ? emptyState('Belum ada invoice.',
          'Invoice terbit saat WO ditutup dari stage "Siap Diserah" — buka papan, pilih WO "Siap Diserah", lalu tutup dengan invoice.')
        : h('table', { class: 'tbl' },
            h('thead', {}, h('tr', {},
              h('th', { scope: 'col' }, 'Invoice'),
              h('th', { scope: 'col', class: 'num' }, 'WO'),
              h('th', { scope: 'col', class: 'num' }, 'Subtotal'),
              h('th', { scope: 'col', class: 'num' }, 'Pajak'),
              h('th', { scope: 'col', class: 'num' }, 'Diskon'),
              h('th', { scope: 'col', class: 'num' }, 'Core'),
              h('th', { scope: 'col', class: 'num' }, 'Total'),
              h('th', { scope: 'col' }, 'Terbit'))),
            h('tbody', {}, reportState.invoices.map((i) => h('tr', {},
              h('th', { scope: 'row' },
                h('button', { type: 'button', class: 'link-btn', onclick: () => openInvoice?.(i.number) }, i.number)),
              h('td', { class: 'num' }, `#${i.job_id}`),
              h('td', { class: 'num' }, rp(i.subtotal)),
              h('td', { class: 'num' }, rp(i.tax)),
              h('td', { class: 'num' }, rp(i.discount)),
              h('td', { class: 'num' }, rp(i.core_credit)),
              h('td', { class: 'num strong' }, rp(i.total)),
              h('td', {}, when(i.issued_at)))))))),

    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title' }, 'Estimasi vs aktual'),
        h('p', { class: 'panel-sub' }, 'Selisih positif = nilai part dipakai melebihi tenaga+kuris offer; hijau di bawah, merah di atas.')),
      h('div', { class: 'panel-body' }, evaRows)));
}
