// WHY one fetch wrapper: every failure in this app is a 4xx/5xx carrying a message the backend
// wrote to be read by a human ("role 'mechanic' may not move a job intake -> diagnosis"). If that
// message reaches the operator intact, with the action that failed, then no screen needs its own
// error plumbing. One function owns headers, JSON, the error shape, and the global handler.

export const ROLES = ['owner', 'advisor', 'mechanic', 'parts_counter'];
export const ROLE_LABEL = {
  owner: 'Owner',
  advisor: 'Advisor',
  mechanic: 'Mekanik',
  parts_counter: 'Parts Counter',
};

/** Staff names the backend knows (seeded); the header carries a name, not an id. */
export const STAFF = [
  { name: 'Budi Santoso', role: 'owner' },
  { name: 'Andi Prasetyo', role: 'mechanic' },
  { name: 'Rita Kumala', role: 'parts_counter' },
];

const session = { role: 'owner', staff: 'Budi Santoso' };

export function getSession() { return { ...session }; }

/**
 * Role + staff are one decision, not two: the staff list is filtered to the chosen role, so the
 * pair on screen is always a pair the backend seeded.
 */
export function setRole(role) {
  session.role = role;
  const match = STAFF.find((s) => s.role === role);
  session.staff = match ? match.name : '';
  try {
    localStorage.setItem('bk.role', role);
  } catch { /* private mode: the switcher still works for this session */ }
  return getSession();
}

export function initSession() {
  let saved = null;
  try { saved = localStorage.getItem('bk.role'); } catch { /* ignore */ }
  return setRole(ROLES.includes(saved) ? saved : 'owner');
}

/** An ApiError is what the UI knows how to render; nothing else is thrown to a screen. */
export class ApiError extends Error {
  constructor(message, { status = 0, detail = null, action = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.action = action;
  }

  /** 403/409 need different framing than a 404, so the drawer says who was refused and why. */
  get forbidden() { return this.status === 403; }
  get conflict() { return this.status === 409; }
}

async function request(method, path, { body, action } = {}) {
  const headers = { 'x-role': session.role };
  if (session.staff) headers['x-staff'] = session.staff;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(`Tidak bisa menghubungi server: ${cause.message}`, { action, status: 0 });
  }
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
  }
  if (!res.ok) {
    // The backend's own wording is the message. Never replace it with our own summary.
    throw new ApiError(payload?.error ?? `HTTP ${res.status}`, {
      status: res.status,
      detail: payload?.detail ?? null,
      action,
    });
  }
  return payload;
}

export const api = {
  get: (path, action) => request('GET', path, { action }),
  post: (path, body, action) => request('POST', path, { body: body ?? {}, action }),
  patch: (path, body, action) => request('PATCH', path, { body: body ?? {}, action }),
};

export const money = new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0,
});
/** Money is integer rupiah everywhere: formatted, never multiplied by a float here. */
export const rp = (n) => (typeof n === 'number' && Number.isFinite(n) ? money.format(n) : '—');

export const num = new Intl.NumberFormat('id-ID');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// WHY a fixed offset instead of the browser's own zone: every timestamp here is a workshop wall
// clock in WIB. Using local browser time would render the same row differently for a recruiter in
// Berlin than for the owner in Jakarta, and the README screenshots would not match the live app.
// One shop, one zone, stated in one place. Share SHOP_OFFSET_MIN with bays.mjs when you need both.
const SHOP_OFFSET_MIN = 7 * 60; // WIB (UTC+7)

/** ISO instant -> "10 Mar 14:00" in the SHOP's timezone, not the viewer's. */
export function when(iso, { withTime = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const shifted = new Date(d.getTime() + SHOP_OFFSET_MIN * 60000);
  const day = `${String(shifted.getUTCDate()).padStart(2, '0')} ${MONTHS[shifted.getUTCMonth()]}`;
  if (!withTime) return day;
  return `${day} ${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
