// WHY the role switcher is in the top bar and not behind a login: the backend's demo auth is a
// header, and the whole teaching value of this app is watching the same WO refuse one role and
// allow another. Switching role re-renders the current screen so disabled buttons change reason
// ("role 'mechanic' tidak boleh — hanya owner") without a page reload.

import { api, rp, when, num, ROLES, ROLE_LABEL, STAFF, getSession, setRole, initSession } from './api.mjs';
import { h, mount, $, errorBlock, skeleton, emptyState, toast } from './dom.mjs';
import { loadBoard, renderBoard, boardState } from './board.mjs';
import { openJob, renderDrawer, setDrawerContext, refreshDrawer } from './drawer.mjs';
import { loadStock, renderStock, stockState } from './stock.mjs';
import { loadBays, renderBays, bayState } from './bays.mjs';
import { loadReports, renderReports, reportState } from './reports.mjs';

const TABS = [
  { id: 'board', label: 'Papan WO' },
  { id: 'stock', label: 'Stok' },
  { id: 'bays', label: 'Bay' },
  { id: 'reports', label: 'Laporan' },
];

export const app = {
  tab: 'board',
  bays: [],
  invoiceNumber: null,
  loaded: new Set(),
};

/* ------------------------------------------------------------ invoice view */

const invoiceState = { data: null, loading: false, error: null, action: null };

async function openInvoice(number) {
  app.invoiceNumber = number;
  invoiceState.loading = true;
  invoiceState.error = null;
  renderInvoice();
  try {
    invoiceState.data = await api.get(`/api/invoices/${encodeURIComponent(number)}`, `memuat invoice ${number}`);
  } catch (err) {
    invoiceState.error = err;
  }
  invoiceState.loading = false;
  renderInvoice();
}

function closeInvoice() {
  app.invoiceNumber = null;
  invoiceState.data = null;
  renderInvoice();
}

function renderInvoice() {
  const host = $('#invoice-host');
  if (!host) return;
  if (app.invoiceNumber === null) { host.hidden = true; host.replaceChildren(); return; }
  host.hidden = false;

  const head = h('header', { class: 'invoice-bar' },
    h('div', {},
      h('h2', { class: 'screen-title' }, `Invoice ${app.invoiceNumber}`),
      h('p', { class: 'screen-sub' }, 'Tampilan siap cetak — Ctrl/Cmd+P menghasilkan struk yang sama.')),
    h('div', { class: 'screen-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, 'Cetak'),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeInvoice }, 'Tutup')));

  let body;
  if (invoiceState.error) {
    body = errorBlock(invoiceState.error, { action: invoiceState.action ?? `memuat invoice ${app.invoiceNumber}` });
  } else if (invoiceState.loading || !invoiceState.data) {
    body = skeleton(7);
  } else {
    const inv = invoiceState.data;
    const job = bayState.jobs.find((j) => j.id === inv.job_id);
    const recomputed = inv.subtotal + inv.tax - inv.discount - inv.core_credit;
    const mismatch = recomputed !== inv.total;
    const sourceLabel = { estimate: 'Estimate', variation: 'Variation', consumable: 'Consumable' };
    body = h('article', { class: 'invoice', id: 'print-area' },
      h('header', { class: 'invoice-head' },
        h('div', {},
          h('p', { class: 'invoice-shop' }, 'BengkelKerja'),
          h('p', { class: 'invoice-address' }, 'Jl. Raya Motor No. 8, Jakarta \u00B7 Telp 021-5550-1234')),
        h('div', { class: 'invoice-meta' },
          h('p', { class: 'invoice-no' }, inv.number),
          h('p', {}, 'Terbit ', when(inv.issued_at)),
          h('p', {}, 'WO ', job ? `${job.number} \u00B7 ${job.plate}` : `#${inv.job_id}`),
          job ? h('p', {}, job.customer) : null)),
      h('table', { class: 'tbl tbl-invoice' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Keterangan'),
          h('th', { scope: 'col' }, 'Sumber'),
          h('th', { scope: 'col', class: 'num' }, 'Qty'),
          h('th', { scope: 'col', class: 'num' }, 'Harga'),
          h('th', { scope: 'col', class: 'num' }, 'Jumlah'))),
        h('tbody', {}, (inv.lines ?? []).map((l) => h('tr', {},
          h('th', { scope: 'row' }, l.description),
          h('td', {}, sourceLabel[l.source] ?? l.source),
          h('td', { class: 'num' }, String(l.qty)),
          h('td', { class: 'num' }, rp(l.unit_price)),
          h('td', { class: 'num strong' }, rp(l.amount)))))),
      h('dl', { class: 'invoice-totals' },
        h('div', {}, h('dt', {}, 'Subtotal'), h('dd', { class: 'num' }, rp(inv.subtotal))),
        h('div', {}, h('dt', {}, `Pajak${inv.discount_reason ? ` \u00B7 diskon: ${inv.discount_reason}` : ''}`), h('dd', { class: 'num' }, rp(inv.tax))),
        h('div', {}, h('dt', {}, 'Diskon'), h('dd', { class: 'num' }, `(${rp(inv.discount)})`)),
        h('div', {}, h('dt', {}, 'Core credit'), h('dd', { class: 'num' }, `(${rp(inv.core_credit)})`)),
        h('div', { class: 'is-total' }, h('dt', {}, 'Total'), h('dd', { class: 'num' }, rp(inv.total)))),
      mismatch
        ? h('p', { class: 'invoice-warn' },
            `Catatan: subtotal + pajak \u2212 diskon \u2212 core credit = ${rp(recomputed)},server mengirim ${rp(inv.total)}. Angka server yang dipakai untuk tagihan.`)
        : null,
      h('p', { class: 'invoice-foot' },
        'Terima kasih sudah mempercayakan kendaraan Anda. Garansi pekerjaan mengikuti ketentuan bengkel.'));
  }
  mount(host, head, body);
}

/* ------------------------------------------------------------ chrome */

function roleSwitcher(onChange) {
  const { role, staff } = getSession();
  const group = h('div', { class: 'role-group', role: 'radiogroup', 'aria-label': 'Role aktif (header x-role)' });
  for (const r of ROLES) {
    const id = `role-${r}`;
    const input = h('input', {
      type: 'radio', name: 'role', id, value: r, class: 'role-input',
      checked: r === role,
      onchange: () => { setRole(r); onChange(); },
    });
    group.append(h('label', { class: `role-opt ${r === role ? 'is-on' : ''}`, for: id },
      input,
      h('span', { class: 'role-name' }, ROLE_LABEL[r]),
      h('span', { class: 'role-key' }, r)));
  }
  const staffList = STAFF.filter((s) => s.role === role);
  return h('div', { class: 'role-switcher' },
    group,
    h('p', { class: 'role-who' },
      staffList.length
        ? h('span', {}, 'Bertikap sebagai ', h('strong', {}, staffList[0].name))
        : h('span', {}, 'Tanpa nama staf \u2014 header x-staff kosong')));
}

function showTab(id) {
  app.tab = id;
  const panel = $('#panel');
  const boardRoot = $('#board-root');
  const stockRoot = $('#stock-root');
  const baysRoot = $('#bays-root');
  const reportsRoot = $('#reports-root');
  for (const [tabId, root] of [['board', boardRoot], ['stock', stockRoot], ['bays', baysRoot], ['reports', reportsRoot]]) {
    if (root) root.hidden = tabId !== id;
  }
  panel.dataset.tab = id;
  renderTabs();
  renderScreen();
  // A tab must load its own data on first open: the previous version only loaded the initial tab,
  // so Stok/Bay/Laporan sat on their skeleton forever.
  ensureLoaded(id).then(renderScreen);
  location.hash = id;
}

/** One loader per tab, re-run only when the tab is opened again or a write changed its data. */
async function ensureLoaded(id, force = false) {
  if (app.loaded.has(id) && !force) return;
  app.loaded.add(id);
  switch (id) {
    case 'board': await loadBoard($('#board-root'), { onOpenJob: openJobWithCtx }); break;
    case 'stock':
      stockState.root = $('#stock-root');
      stockState.errorHost = $('#global-error');
      await loadStock();
      break;
    case 'bays': await loadBays($('#bays-root')); break;
    case 'reports': await loadReports($('#reports-root'), reportState.day); break;
    default: break;
  }
}

function renderTabs() {
  mount($('#tabs'), ...TABS.map((t) => h('button', {
    type: 'button',
    class: `tab ${app.tab === t.id ? 'is-on' : ''}`,
    'aria-current': app.tab === t.id ? 'page' : null,
    onclick: () => showTab(t.id),
  }, t.label)));
}

function renderScreen() {
  switch (app.tab) {
    case 'board': renderBoard($('#board-root'), { onOpenJob: openJobWithCtx }); break;
    case 'stock': renderStock(); break;
    case 'bays': renderBays($('#bays-root')); break;
    case 'reports': renderReports($('#reports-root'), { openInvoice }); break;
    default: break;
  }
}

async function openJobWithCtx(jobId) {
  // plate/customer come from the job LIST, which the board already loaded.
  setDrawerContext({ jobs: boardState.jobs });
  await openJob(jobId, { bays: app.bays });
}

/** Reload whatever the current screen shows, plus stock/bays because writes there move numbers. */
async function refreshAll() {
  const id = app.tab;
  await ensureLoaded(id, true);
  renderScreen();
}

/* ------------------------------------------------------------ boot */

function showGlobalError(err, action) {
  mount($('#global-error'), errorBlock(err, { action }));
}

/** Re-render chrome and the open drawer after the role changed: disabled buttons change reason. */
async function onRoleChange() {
  const { role, staff } = getSession();
  mount($('#role-switcher'), roleSwitcher(onRoleChange));
  toast(`Role: ${ROLE_LABEL[role]}${staff ? ` \u00B7 ${staff}` : ' \u00B7 tanpa nama staf'}`);
  if (drawerOpen()) await refreshDrawer();
  renderScreen();
}

async function boot() {
  initSession();
  mount($('#role-switcher'), roleSwitcher(onRoleChange));
  mount($('#tabs'), ...[]); // placeholder replaced by renderTabs on first showTab

  setDrawerContext({ bays: [], onChanged: refreshAll, openInvoice });

  try {
    const { bays } = await api.get('/api/bays', 'memuat daftar bay');
    app.bays = bays.bays;
  } catch (err) {
    showGlobalError(err, 'memuat daftar bay untuk drawer');
  }

  const initial = TABS.some((t) => t.id === location.hash.slice(1)) ? location.hash.slice(1) : 'board';
  showTab(initial);
  await ensureLoaded(initial);
  renderScreen();
}

const drawerOpen = () => Boolean(document.querySelector('.drawer'));

/* A global handler so no rejection can die silently: the requirement is that a console error and
   an unhandled rejection both surface in the UI, and the toast strip is the cheapest place. */
window.addEventListener('unhandledrejection', (e) => {
  toast(`Unhandled: ${e.reason?.message ?? e.reason}`, { tone: 'err' });
  e.preventDefault();
});
window.addEventListener('error', (e) => {
  toast(`Error: ${e.message}`, { tone: 'err' });
});

/* Keyboard: Escape closes the drawer, arrows walk the lanes' job cards. Neither traps focus. */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen()) {
    e.preventDefault();
    document.querySelector('.drawer-close')?.click();
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (document.activeElement?.classList.contains('job-card')) {
      const cards = [...document.querySelectorAll('.job-card')];
      const i = cards.indexOf(document.activeElement);
      const next = cards[i + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
    }
  }
});

boot().catch((err) => showGlobalError(err, 'memuat aplikasi'));
