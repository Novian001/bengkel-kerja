// WHY stock computes available = on_hand - reserved in the browser instead of asking the server:
// /api/stock already returns both numbers, and the server's low-stock list uses its own
// comparison — showing BOTH and letting the numbers disagree visibly is more honest than hiding
// one. The LOW badge uses the same rule the backend does (available <= reorder_point), and the
// receive action is the one place a parts counter changes on_hand.

import { api, rp, when, num } from './api.mjs';
import { h, mount, errorBlock, skeleton, emptyState, toast } from './dom.mjs';

export const stockState = { items: [], orders: [], low: [], loading: true, error: null, onlyLow: false };

export async function loadStock() {
  stockState.loading = true;
  stockState.error = null;
  renderStock();
  try {
    const [items, orders, low] = await Promise.all([
      api.get('/api/stock', 'memuat daftar stok'),
      api.get('/api/order-parts', 'memuat order part terbuka'),
      api.get('/api/stock?low=1', 'memuat daftar stok menipis'),
    ]);
    stockState.items = items.items;
    stockState.orders = orders.open;
    stockState.low = low.low_stock;
    stockState.loading = false;
  } catch (err) {
    stockState.error = err;
    stockState.loading = false;
  }
  renderStock();
}

const available = (it) => it.on_hand - it.reserved;

async function adjust(item, delta, reason) {
  try {
    await api.post(`/api/stock/${item.id}/adjust`, { delta, reason }, `koreksi stok ${item.sku}`);
    toast(`${item.sku} ${delta > 0 ? '+' : ''}${delta} \u00B7 ${reason}`);
    await loadStock();
  } catch (err) {
    mount(stockState.errorHost, errorBlock(err, { action: `koreksi stok ${item.sku}` }));
  }
}

function adjustControl(item) {
  const delta = h('input', {
    class: 'input input-num input-mini', type: 'number', step: '1', value: '1',
    'aria-label': `Jumlah koreksi untuk ${item.sku}`,
  });
  const reason = h('input', {
    class: 'input input-mini input-reason', type: 'text', placeholder: 'alasan (wajib)',
    'aria-label': `Alasan koreksi stok ${item.sku}`,
  });
  const submit = (sign, btn) => {
    const n = Number(delta.value);
    btn.disabled = true;
    adjust(item, sign * n, reason.value).finally(() => { btn.disabled = false; });
  };
  return h('div', { class: 'adjust' },
    h('div', { class: 'row-inline' },
      h('button', {
        type: 'button', class: 'btn btn-mini', 'aria-label': `Kurangi stok ${item.sku}`,
        onclick: (e) => submit(-1, e.currentTarget),
      }, '\u2212'),
      h('button', {
        type: 'button', class: 'btn btn-mini', 'aria-label': `Tambah stok ${item.sku}`,
        onclick: (e) => submit(1, e.currentTarget),
      }, '+'),
      delta),
    reason);
}

export function renderStock() {
  const root = stockState.errorHost;
  if (!root) return;
  const host = stockState.root;
  if (!host) return;

  if (stockState.error) {
    mount(host, errorBlock(stockState.error, { action: 'memuat data stok' }));
    return;
  }
  if (stockState.loading) { mount(host, skeleton(8)); return; }

  const items = stockState.onlyLow
    ? stockState.items.filter((it) => available(it) <= it.reorder_point)
    : stockState.items;
  const lowIds = new Set(stockState.low.map((i) => i.id));

  const rows = items.map((it) => {
    const avail = available(it);
    const low = avail <= it.reorder_point;
    return h('tr', { class: low ? 'is-low' : null },
      h('th', { scope: 'row' },
        h('span', { class: 'sku' }, it.sku),
        h('span', { class: 'item-name' }, it.name)),
      h('td', { class: 'num' }, String(it.on_hand)),
      h('td', { class: 'num muted' }, String(it.reserved)),
      h('td', { class: 'num strong' }, String(avail)),
      h('td', { class: 'num' }, String(it.reorder_point)),
      h('td', {}, low
        ? h('span', { class: 'badge badge-low' },
            h('span', { 'aria-hidden': 'true' }, '\u25B2'), 'MENIPIS')
        : (lowIds.has(it.id)
            ? h('span', { class: 'muted' }, 'ok')
            : h('span', { class: 'muted' }, 'ok'))),
      h('td', { class: 'num' }, rp(it.unit_cost)),
      h('td', { class: 'num' }, it.core_credit ? rp(it.core_credit) : '—'),
      h('td', {}, adjustControl(it)));
  });

  const table = h('table', { class: 'tbl tbl-stock' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Item'),
      h('th', { scope: 'col', class: 'num' }, 'On hand'),
      h('th', { scope: 'col', class: 'num' }, 'Reserved'),
      h('th', { scope: 'col', class: 'num' }, 'Tersedia'),
      h('th', { scope: 'col', class: 'num' }, 'Reorder'),
      h('th', { scope: 'col' }, 'Status'),
      h('th', { scope: 'col', class: 'num' }, 'Harga modal'),
      h('th', { scope: 'col', class: 'num' }, 'Core credit'),
      h('th', { scope: 'col' }, 'Koreksi'))),
    h('tbody', {}, rows.length === 0
      ? h('tr', {}, h('td', { colspan: '9' },
          emptyState('Tidak ada item cocok.',
            stockState.onlyLow
              ? 'Semua item di atas reorder point. Matikan filter MENIPIS untuk melihat seluruh daftar.'
              : 'Tambah item lewat backend atau seed ulang database.',
            h('button', {
              type: 'button', class: 'btn', onclick: () => { stockState.onlyLow = false; renderStock(); },
            }, 'Tampilkan semua item'))))
      : rows));

  const orderRows = stockState.orders.length === 0
    ? h('p', { class: 'empty-next' },
        'Tidak ada order part terbuka. Order dibuat otomatis saat owner menyetujui estimate dengan part kurang.')
    : h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, 'Part'),
          h('th', { scope: 'col' }, 'Supplier'),
          h('th', { scope: 'col', class: 'num' }, 'Dipesan'),
          h('th', { scope: 'col', class: 'num' }, 'Diterima'),
          h('th', { scope: 'col' }, 'ETA'),
          h('th', { scope: 'col' }, ''))),
        h('tbody', {}, stockState.orders.map((o) => {
          const qty = h('input', {
            class: 'input input-num input-mini', type: 'number', min: '1', max: '100', value: '1',
            'aria-label': `Qty terima untuk ${o.sku}`,
          });
          return h('tr', {},
            h('td', {}, h('span', { class: 'sku' }, o.sku), h('span', { class: 'item-name' }, o.name)),
            h('td', {}, o.supplier),
            h('td', { class: 'num' }, String(o.qty_ordered)),
            h('td', { class: 'num' }, String(o.qty_received)),
            h('td', {}, o.eta_date ? when(o.eta_date, { withTime: false }) : '—'),
            h('td', {}, h('div', { class: 'row-inline' }, qty,
              h('button', {
                type: 'button', class: 'btn btn-mini btn-primary',
                onclick: async (e) => {
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  try {
                    await api.post(`/api/order-parts/${o.id}/receive`, { qty: Number(qty.value) },
                      `terima part ${o.sku}`);
                    toast(`${o.sku} diterima: ${qty.value}`);
                    await loadStock();
                  } catch (err) {
                    mount(root, errorBlock(err, { action: `terima part ${o.sku}` }));
                    btn.disabled = false;
                  }
                },
              }, 'Terima'))));
        })));

  mount(host,
    h('div', { class: 'screen-head' },
      h('h2', { class: 'screen-title' }, 'Stok & Order Part'),
      h('p', { class: 'screen-sub' },
        'Tersedia = on hand \u2212 reserved. Badge MENIPIS aktif saat tersedia \u2264 reorder point.'),
      h('div', { class: 'screen-actions' },
        h('label', { class: 'toggle' },
          h('input', {
            type: 'checkbox', checked: stockState.onlyLow,
            onchange: (e) => { stockState.onlyLow = e.target.checked; renderStock(); },
          }),
          h('span', {}, `Hanya menipis (${stockState.low.length})`)),
        h('button', { type: 'button', class: 'btn', onclick: () => loadStock() }, 'Muat ulang'))),
    h('div', { class: 'panel' }, table),
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title' }, 'Order part terbuka'),
        h('p', { class: 'panel-sub' }, 'Terima barang di rak: on_hand naik, reservasi WO dilepas.')),
      h('div', { class: 'panel-body' }, orderRows)));
}
