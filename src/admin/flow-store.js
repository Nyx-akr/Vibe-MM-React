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
  const change = typeof patch === 'function' ? patch(doc) : patch;
  // A write that changes nothing (the map re-saving its positions after an
  // undo) is not an edit: it must not become an undo step or clear redo.
  if (!Object.keys(change || {}).some((k) => JSON.stringify(change[k]) !== JSON.stringify(doc[k]))) return;
  const next = { ...doc, ...change, updatedAt: Date.now() };
  remember(doc);
  commit(next);
}

function commit(next) {
  state.docs[next.id] = next;
  if (next.id !== DEFAULT_FLOW) {
    write(LS_DOC(next.id), next);
    pushToServer(next);
  }
  emit();
}

/* ------------------------------------------------------- undo / redo -- */

/*
 * The last UNDO_STEPS versions of each flow, so Ctrl+Z steps back one edit
 * and Ctrl+Y steps forward again. Edits closer together than COALESCE_MS
 * (typing a number, one drag) count as one step.
 */
const UNDO_STEPS = 10;
const COALESCE_MS = 600;
const history = new Map(); // flow id -> { past: [doc], future: [doc], at }
let historyVersion = 0;
const historyOf = (id) => {
  if (!history.has(id)) history.set(id, { past: [], future: [], at: 0 });
  return history.get(id);
};
function remember(doc) {
  const h = historyOf(doc.id);
  const now = Date.now();
  if (now - h.at > COALESCE_MS) {
    h.past.push(doc);
    if (h.past.length > UNDO_STEPS) h.past.shift();
  }
  h.at = now;
  h.future = [];
}
/** Bumped by undo and redo, so the map knows to reload the flow. */
export const flowHistoryVersion = () => historyVersion;
export const canUndo = () => historyOf(activeFlowId()).past.length > 0;
export const canRedo = () => historyOf(activeFlowId()).future.length > 0;

/** Back one edit. Returns false when there is nothing to undo. */
export function undoFlow() {
  const h = historyOf(activeFlowId());
  if (!h.past.length) return false;
  const cur = activeFlow();
  h.future.push(cur);
  h.at = 0;
  historyVersion += 1;
  commit({ ...h.past.pop(), updatedAt: Date.now() });
  return true;
}

/** Forward one undone edit. */
export function redoFlow() {
  const h = historyOf(activeFlowId());
  if (!h.future.length) return false;
  h.past.push(activeFlow());
  h.at = 0;
  historyVersion += 1;
  commit({ ...h.future.pop(), updatedAt: Date.now() });
  return true;
}

// The keys the map used before flows existed: its settings and its groups
// now live in the active flow, so the old copies are cleared.
try { ['vs.admin.boxsettings.v1', 'vs.admin.engines.v1'].forEach((k) => window.localStorage.removeItem(k)); } catch (e) { /* private window */ }

// Another tab changed a flow (the admin map, while the frontend is open): take
// its copy, so the score in this tab uses the same parameters on its next poll.
try {
  window.addEventListener('storage', (e) => {
    if (!e.key) return;
    if (e.key === LS_ACTIVE) state.active = read(LS_ACTIVE, DEFAULT_FLOW);
    else if (e.key === LS_USERS) state.users = read(LS_USERS, []);
    else if (e.key.indexOf(LS_DOC('')) === 0) delete state.docs[e.key.slice(LS_DOC('').length)];
    else return;
    emit();
  });
} catch (err) { /* not a browser */ }

pullUsers();
if (activeFlowId() !== DEFAULT_FLOW) pullDoc(activeFlowId());
