// WHY demo-auth and no passwords: this repo is a solo showcase backend whose interesting
// claims are about SQL invariants, not identity. A real password store would be a security
// claim I cannot back with tests, so the honest thing is a header that cannot be mistaken
// for security, plus a stated ceiling. Anything that ships to customers must replace this
// file with real sessions; `x-role` is trusted input and is only as trustworthy as the proxy
// in front of it.
//
// ponytail: no sessions, no password hashing, no token expiry. Upgrade path: verify a signed
// session cookie here and keep the same `role` output, so callers do not change.
export const ROLES = ['owner', 'advisor', 'mechanic', 'parts_counter'];

// Spec role vocabulary maps onto four names; `parts_counter` is the spec's parts role.
export const ROLE_ALIASES = { parts: 'parts_counter' };

export function roleFromHeaders(headers) {
  const raw = headers['x-role'];
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'owner'; // demo default
  const v = String(raw).trim().toLowerCase();
  const normalised = ROLE_ALIASES[v] ?? v;
  if (!ROLES.includes(normalised)) {
    const err = new Error(`unknown role '${v}'; allowed: ${ROLES.join(', ')}`);
    err.status = 401;
    throw err;
  }
  return normalised;
}

export function actorFromHeaders(headers) {
  const raw = headers['x-staff'];
  const name = raw === undefined || raw === null ? null : String(raw).trim().slice(0, 100);
  return { role: roleFromHeaders(headers), staffName: name === '' ? null : name };
}
