// WHY this table is data and not if-statements spread through handlers: the spec's value is
// in WHICH edge is legal for WHOM, and a reviewer must be able to read that in one place.
// Preconditions are named guard ids; the actual DB checks live in repo/jobs.js so this file
// stays free of SQL and can be unit-tested without a database.
import { bad, conflict } from './db.js';

// `guard: null` means the edge is legal on role alone.
export const TRANSITIONS = {
  intake: [
    { to: 'diagnosis', roles: ['mechanic', 'owner'], guard: 'intake_checklist_done' },
  ],
  diagnosis: [
    { to: 'awaiting_approval', roles: ['mechanic', 'owner'], guard: 'estimate_has_lines' },
  ],
  awaiting_approval: [
    { to: 'approved', roles: ['owner'], guard: 'estimate_approved_with_provenance' },
    { to: 'cancelled', roles: ['owner'], guard: 'nothing_reserved' },
    // only reachable by DECIDING the open variation that paused an in-progress job
    { to: 'in_progress', roles: ['owner'], guard: 'variation_approved' },
    // an approved variation whose part is out of stock has to wait for the part like any other
    { to: 'awaiting_parts', roles: ['owner'], guard: 'variation_approved' },
    { to: 'in_progress', roles: ['owner'], guard: 'variation_declined' },
  ],
  approved: [
    { to: 'awaiting_parts', roles: ['parts_counter', 'owner'], guard: 'shortage_creates_orders' },
    { to: 'in_progress', roles: ['mechanic'], guard: 'bay_booked_and_parts_ready' },
    { to: 'cancelled', roles: ['owner'], guard: 'no_invoice' },
  ],
  awaiting_parts: [
    { to: 'in_progress', roles: ['mechanic'], guard: 'no_open_order_parts' },
    { to: 'cancelled', roles: ['owner'], guard: 'no_invoice' },
  ],
  in_progress: [
    { to: 'qc', roles: ['mechanic'], guard: 'actuals_recorded' },
    { to: 'awaiting_approval', roles: ['mechanic', 'owner'], guard: 'variation_pending' },
    { to: 'cancelled', roles: ['owner'], guard: 'no_invoice' },
  ],
  qc: [
    { to: 'ready', roles: ['owner'], guard: 'qc_passed' },
    { to: 'in_progress', roles: ['owner'], guard: 'qc_failed_counts_rework' },
    { to: 'cancelled', roles: ['owner'], guard: 'no_invoice' },
  ],
  ready: [
    { to: 'completed', roles: ['owner'], guard: 'invoice_issued' },
    { to: 'in_progress', roles: ['owner'], guard: 'handover_rejected' },
  ],
  completed: [],
  cancelled: [],
};

export const STATES = Object.keys(TRANSITIONS);
export const TERMINAL = STATES.filter((s) => TRANSITIONS[s].length === 0);

export function isTerminal(state) { return TERMINAL.includes(state); }

export function edge(from, to) {
  return (TRANSITIONS[from] ?? []).find((t) => t.to === to) ?? null;
}

// Two distinct failures, because they mean different things to the counter:
//   409 unknown_edge  = the shop tried to do something the workflow does not model
//   403 role_forbidden = the right step, done by the wrong person
export function assertTransition(from, to, role) {
  if (isTerminal(from)) {
    throw conflict(`job is terminal in state '${from}' and accepts no further transitions`, { from, to });
  }
  if (!STATES.includes(to)) {
    throw bad(`unknown target state '${to}'`, { to, known: STATES });
  }
  const e = edge(from, to);
  if (!e) {
    throw conflict(`illegal transition ${from} -> ${to}`, { from, to, allowed: TRANSITIONS[from].map((t) => t.to) });
  }
  if (!e.roles.includes(role)) {
    const err = conflict(`role '${role}' may not move a job ${from} -> ${to}`, { from, to, role, allowedRoles: e.roles });
    err.status = 403;
    throw err;
  }
  return e;
}

export function canTransition(from, to, role) {
  try { assertTransition(from, to, role); return true; } catch { return false; }
}
