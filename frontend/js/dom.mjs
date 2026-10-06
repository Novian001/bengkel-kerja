// WHY hand-rolled DOM helpers instead of a framework: the app has six screens of server-rendered
// data and no build step, and a virtual DOM is a dependency the project owner explicitly forbade.
// `h` builds an element, `frag` batches them, and every screen owns its own re-render. Text is
// set through textContent, so seeded data can never become markup.

/** h('div', {class:'x', onclick:fn}, child, ...) -> HTMLElement. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only ever called with literal markup authored here
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Replace a container's children in one shot. */
export function mount(container, ...children) {
  container.replaceChildren(...(children.flat(4).filter(Boolean)));
  return container;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Icon-only controls must carry an accessible name; this is the one place that is enforced. */
export function iconBtn(glyph, label, props = {}) {
  return h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': label, title: label, ...props,
  }, h('span', { 'aria-hidden': 'true', class: 'glyph' }, glyph));
}

export function field(label, control, { hint = null, id = null } = {}) {
  return h('label', { class: 'field', for: id ?? null },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select(options, value, onchange, props = {}) {
  const el = h('select', { class: 'input', onchange, ...props });
  for (const o of options) {
    el.append(h('option', { value: o.value, selected: o.value === value }, o.label));
  }
  el.value = value;
  return el;
}

/** A number input that reports an INTEGER (rupiah, qty, hours are all integers server-side). */
export function intInput(value, oninput, props = {}) {
  const el = h('input', {
    class: 'input input-num', type: 'number', inputmode: 'numeric', step: '1',
    value: value ?? '', oninput, ...props,
  });
  return el;
}

/**
 * A state badge: glyph + word, never colour alone. The colour comes from the --st-<state> token
 * as a ring and a dot; the word carries the meaning for colour-blind and monochrome use.
 */
export function stateBadge(state, label) {
  return h('span', { class: 'state-badge', dataset: { state } },
    h('span', { class: 'state-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'state-word' }, label),
  );
}

/**
 * Error block for a failed action. Says WHICH action failed and shows the server's own sentence,
 * plus the detail fields when the backend sent them (allowed roles, open order parts, ...).
 */
export function errorBlock(err, { action = null, compact = false } = {}) {
  const kind = err?.status === 403 ? 'Ditolak hak akses'
    : err?.status === 409 ? 'Ditolak aturan kerja'
    : err?.status === 404 ? 'Tidak ditemukan'
    : err?.status === 401 ? 'Role tidak dikenal'
    : 'Gagal';
  const rows = [];
  if (err?.detail && typeof err.detail === 'object') {
    for (const [k, v] of Object.entries(err.detail)) {
      if (v === null || v === undefined) continue;
      rows.push(h('div', { class: 'err-detail' },
        h('span', { class: 'err-key' }, k),
        h('span', { class: 'err-val' }, Array.isArray(v) ? v.join(', ') : String(v))));
    }
  }
  return h('div', { class: `err ${compact ? 'err-compact' : ''}`, role: 'alert', dataset: { status: err?.status ?? 0 } },
    h('div', { class: 'err-head' },
      h('span', { class: 'err-kind' }, kind),
      err?.status ? h('span', { class: 'err-code' }, `HTTP ${err.status}`) : null),
    action ? h('p', { class: 'err-action' }, `Aksi gagal: ${action}`) : null,
    h('p', { class: 'err-msg' }, err?.message ?? 'Kesalahan tidak diketahui'),
    rows.length ? h('div', { class: 'err-details' }, rows) : null);
}

/** Loading placeholder that occupies the space the real content will take (no layout jump). */
export function skeleton(rows = 3) {
  return h('div', { class: 'skeleton', 'aria-hidden': 'true' },
    ...Array.from({ length: rows }, () => h('div', { class: 'skeleton-row' })));
}

export function loadingNote(text = 'Memuat…') {
  return h('p', { class: 'loading-note', role: 'status' }, text);
}

/**
 * Empty state that says what to DO next. The action hint is the difference between "no data" and
 * a dead end, so it is a required argument here rather than something each screen remembers.
 */
export function emptyState(title, next, actionEl = null) {
  return h('div', { class: 'empty' },
    h('p', { class: 'empty-title' }, title),
    h('p', { class: 'empty-next' }, next),
    actionEl);
}

/** A toast strip for a successful write; errors stay in place next to the control that failed. */
let toastHost = null;
export function toast(message, { tone = 'ok' } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast-${tone}` },
    h('span', { class: 'toast-glyph', 'aria-hidden': 'true' }, tone === 'ok' ? '\u2713' : '!'),
    h('span', {}, message));
  toastHost.append(el);
  setTimeout(() => el.remove(), 4200);
}

/** Confirmation for the irreversible edges (cancel, rework back to in_progress). */
export function confirmDestructive(message) {
  return window.confirm(message);
}
