/**
 * FLOWS - the arrangement of the DATA FLOW map, one document per user.
 *
 * A flow document holds everything about the map that is NOT a formula:
 *   arrangement  every box, the group it sits in, the groups, the wires
 *   cfg          the user's layer - their groups, moves, renames, sketch wires
 *   settings     every value changed on a box (parameters, weights, filters)
 *   positions    boxes dragged by hand
 * What each box COMPUTES stays in the box library (pipeline.js), keyed by
 * box id; a flow says how those boxes are arranged and tuned.
 *
 * DEFAULT is the flow we build together in code. It is never saved: a change
 * made while on DEFAULT is a preview that is gone on reload. A USER flow is
 * saved on every change - to this browser at once, and to the server's app
 * store (data/app/flows/<id>.json, local writes only) a moment later - so it
 * stays for good and is the same in every browser on this machine.
 */

import { storeOrigin } from '../services/storage/raw-store';

export const DEFAULT_FLOW = 'default';
const LS_ACTIVE = 'vs.admin.flow.active';
const LS_USERS = 'vs.admin.flow.users';
const LS_DOC = (id) => 'vs.admin.flow.doc.' + id;

const emptyCfg = () => ({ engines: {}, assign: {}, renamed: {}, removed: {}, sketch: [] });
const blank = (id, name) => ({
  id, name, version: 1, createdAt: Date.now(), updatedAt: Date.now(),
  arrangement: null, cfg: emptyCfg(), settings: {}, positions: {},
});

const read = (key, fallback) => {
  try { const s = window.localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
};
const write = (key, value) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private window */ }
};

const state = {
  active: read(LS_ACTIVE, DEFAULT_FLOW),
  users: read(LS_USERS, []),
  docs: { [DEFAULT_FLOW]: blank(DEFAULT_FLOW, 'DEFAULT') },
  server: 'unknown', // 'ok' | 'offline' | 'refused'
};
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export const subscribeFlows = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const flowUsers = () => state.users.slice();
export const activeFlowId = () => (state.active === DEFAULT_FLOW || state.users.some((u) => u.id === state.active) ? state.active : DEFAULT_FLOW);
export const serverState = () => state.server;

function docOf(id) {
  if (!state.docs[id]) {
    const u = state.users.find((x) => x.id === id);
    state.docs[id] = { ...blank(id, u ? u.name : id), ...(read(LS_DOC(id), null) || {}) };
  }
  return state.docs[id];
}

/** The flow the map is showing. */
export const activeFlow = () => docOf(activeFlowId());
export const isDefaultActive = () => activeFlowId() === DEFAULT_FLOW;

/* ------------------------------------------------------------ server -- */

const origin = () => { try { return storeOrigin(); } catch (e) { return null; } };
const pending = new Map();

function pushToServer(doc) {
  clearTimeout(pending.get(doc.id));
  pending.set(doc.id, setTimeout(async () => {
    const o = origin();
    if (!o) return;
    try {
      const res = await fetch(o + '/app/flows/' + doc.id + '.json', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
      });
      state.server = res.status === 403 ? 'refused' : res.ok ? 'ok' : 'offline';
    } catch (e) {
      state.server = 'offline';
    }
    emit();
  }, 700));
}

/** Pull the user list and a flow's file from the server, when it answers. */
async function pullUsers() {
  const o = origin();
  if (!o) return;
  try {
    const res = await fetch(o + '/app/flows/index.json');
    if (!res.ok) { state.server = 'offline'; emit(); return; }
    const out = await res.json();
    state.server = 'ok';
    const known = new Map(state.users.map((u) => [u.id, u]));
    (out.flows || []).forEach((f) => { if (!known.has(f.id)) known.set(f.id, { id: f.id, name: f.name }); });
    state.users = Array.from(known.values());
    write(LS_USERS, state.users);
    emit();
  } catch (e) {
    state.server = 'offline';
    emit();
  }
}

async function pullDoc(id) {
  const o = origin();
  if (!o || id === DEFAULT_FLOW) return;
  try {
    const res = await fetch(o + '/app/flows/' + id + '.json');
    if (!res.ok) return;
    const remote = await res.json();
    const local = docOf(id);
    // The newer copy wins: the server's after another browser edited it, the
    // local one when this browser edited while the server was off.
    if (remote && (remote.updatedAt || 0) > (local.updatedAt || 0)) {
      state.docs[id] = { ...blank(id, remote.name || id), ...remote };
      write(LS_DOC(id), state.docs[id]);
      emit();
    } else if ((local.updatedAt || 0) > (remote.updatedAt || 0)) {
      pushToServer(local);
    }
  } catch (e) { /* offline: the local copy stands */ }
}

/* ----------------------------------------------------------- changes -- */

/** Switch the map to another flow. */
export function setActiveFlow(id) {
  state.active = id;
  write(LS_ACTIVE, id);
  pullDoc(id);
  emit();
}

/** Register a new user flow, named, starting from the default arrangement. */
export function addUser(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  let id = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'user';
  while (id === DEFAULT_FLOW || state.users.some((u) => u.id === id)) id += '-2';
  state.users = state.users.concat([{ id, name: clean }]);
  write(LS_USERS, state.users);
  const doc = blank(id, clean);
  state.docs[id] = doc;
  write(LS_DOC(id), doc);
  pushToServer(doc);
  setActiveFlow(id);
  return id;
}

/**
 * Change the active flow. On DEFAULT the change lives in memory only - a
 * preview; on a user flow it is saved, locally now and to the server soon.
 */
export function updateFlow(patch) {
  const doc = activeFlow();
  const next = { ...doc, ...(typeof patch === 'function' ? patch(doc) : patch), updatedAt: Date.now() };
  state.docs[doc.id] = next;
  if (doc.id !== DEFAULT_FLOW) {
    write(LS_DOC(doc.id), next);
    pushToServer(next);
  }
  emit();
}

// The keys the map used before flows existed: its settings and its groups
// now live in the active flow, so the old copies are cleared.
try { ['vs.admin.boxsettings.v1', 'vs.admin.engines.v1'].forEach((k) => window.localStorage.removeItem(k)); } catch (e) { /* private window */ }

pullUsers();
if (activeFlowId() !== DEFAULT_FLOW) pullDoc(activeFlowId());
