// A discrete-event simulation of a microservice call graph. Each service has a
// fixed worker pool, a queue, a lognormal latency, and synchronous calls to its
// downstream services. A worker stays busy while it waits on those calls, which
// is how one slow dependency drains the pool of everything above it.
// Times are in milliseconds. No DOM code.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lognormal sample with the given median, from a uniform RNG (Box-Muller). */
export function lognormal(rand, medianMs, sigma) {
  const u = 1 - rand(), v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return medianMs * Math.exp(sigma * z);
}

/** Min-heap of events ordered by time, then by insertion order for ties. */
export class EventQueue {
  constructor() { this.heap = []; this.seq = 0; }
  get size() { return this.heap.length; }
  push(t, fn) {
    const h = this.heap, e = { t, s: this.seq++, fn };
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (before(h[p], e)) break;
      h[i] = h[p]; i = p;
    }
    h[i] = e;
  }
  pop() {
    const h = this.heap, top = h[0], last = h.pop();
    if (h.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, best = last;
        if (l < h.length && before(h[l], best)) { m = l; best = h[l]; }
        if (r < h.length && before(h[r], best)) { m = r; best = h[r]; }
        if (m === i) break;
        h[i] = h[m]; i = m;
      }
      h[i] = last;
    }
    return top;
  }
}
const before = (a, b) => a.t < b.t || (a.t === b.t && a.s < b.s);

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

// ---------------------------------------------------------------------------
// Topologies. `timeoutMs` is the tight outbound timeout the presets use.

export const TOPOLOGIES = {
  checkout: {
    label: "E-commerce checkout",
    edge: "gateway",
    defaultFault: "recommendations",
    services: {
      gateway: { label: "Gateway", latencyMs: 2, sigma: 0.4, workers: 400, timeoutMs: 1000, calls: [{ to: "checkout", critical: true }] },
      checkout: {
        label: "Checkout", latencyMs: 5, sigma: 0.4, workers: 40, timeoutMs: 250,
        calls: [{ to: "inventory", critical: true }, { to: "payments", critical: true }, { to: "recommendations", critical: false }],
      },
      inventory: { label: "Inventory", latencyMs: 8, sigma: 0.4, workers: 30, timeoutMs: 150, calls: [{ to: "db", critical: true }] },
      payments: { label: "Payments", latencyMs: 30, sigma: 0.4, workers: 40, calls: [] },
      recommendations: { label: "Recommendations", latencyMs: 20, sigma: 0.4, workers: 20, calls: [] },
      db: { label: "Inventory DB", latencyMs: 4, sigma: 0.4, workers: 20, calls: [] },
    },
    layout: { gateway: [0, 1], checkout: [1, 1], inventory: [2, 0], payments: [2, 1], recommendations: [2, 2], db: [3, 0] },
  },
  chain: {
    label: "Simple chain",
    edge: "web",
    defaultFault: "db",
    services: {
      web: { label: "Web", latencyMs: 2, sigma: 0.4, workers: 400, timeoutMs: 1000, calls: [{ to: "api", critical: true }] },
      api: { label: "API", latencyMs: 5, sigma: 0.4, workers: 40, timeoutMs: 400, calls: [{ to: "orders", critical: true }] },
      orders: { label: "Orders", latencyMs: 10, sigma: 0.4, workers: 30, timeoutMs: 150, calls: [{ to: "db", critical: true }] },
      db: { label: "Orders DB", latencyMs: 8, sigma: 0.4, workers: 10, calls: [] },
    },
    layout: { web: [0, 0], api: [1, 0], orders: [2, 0], db: [3, 0] },
  },
};

/** Edges of a topology as [from, to, critical]. */
export function edgesOf(topo) {
  const out = [];
  for (const [id, s] of Object.entries(topo.services)) for (const c of s.calls) out.push({ from: id, to: c.to, critical: c.critical, key: `${id}>${c.to}` });
  return out;
}

// ---------------------------------------------------------------------------
// Policies and presets. Each service's policy applies to its outbound calls,
// except `queueLimit` (load shedding) which guards its own inbound queue.

export const POLICY_KEYS = ["workers", "timeoutMs", "retries", "backoff", "breaker", "bulkhead", "queueLimit", "fallback"];

export const PRESETS = {
  none: { label: "No protection", note: "No timeouts, no retries, unbounded queues." },
  retries: { label: "Retries only", note: "3 immediate retries on every call, triggered by a 1 s library default timeout." },
  breaker: { label: "Timeouts + breaker", note: "Tight timeouts, a circuit breaker on every call, and a fallback for non-critical calls." },
  full: { label: "Full resilience", note: "Adds retries with backoff and jitter below the edge, bulkheads, and queue limits." },
};

export function presetPolicies(topoId, preset) {
  const topo = TOPOLOGIES[topoId];
  const out = {};
  for (const [id, s] of Object.entries(topo.services)) {
    const hasCalls = s.calls.length > 0;
    const p = { workers: s.workers, timeoutMs: 0, retries: 0, backoff: 0, breaker: 0, bulkhead: 0, queueLimit: 0, fallback: 0 };
    if (preset === "retries" && hasCalls) Object.assign(p, { timeoutMs: 1000, retries: 3 });
    if ((preset === "breaker" || preset === "full") && hasCalls) Object.assign(p, { timeoutMs: s.timeoutMs, breaker: 1, fallback: 1 });
    if (preset === "full") {
      if (hasCalls && id !== topo.edge) Object.assign(p, { retries: 2, backoff: 1 });
      if (hasCalls) p.bulkhead = Math.max(5, Math.round(s.workers / 2));
      p.queueLimit = s.workers * 2;
    }
    out[id] = p;
  }
  return out;
}

export const DEFAULTS = {
  topo: "checkout",
  preset: "none",
  rps: 100,
  durationS: 60,
  seed: 7,
  userTimeoutMs: 2000,
  faultSvc: "recommendations",
  faultKind: "slow", // "slow" or "error"
  faultStartS: 15,
  faultEndS: 35,
  faultFactor: 20,
  faultErrorRate: 0.5,
  breakerThreshold: 0.5, // error rate that opens the breaker
  breakerWindow: 50, // last N calls considered
  breakerCooldownMs: 3000,
  breakerProbes: 5,
  backoffMs: 50,
};

/** A full config: globals plus a policy per service. */
export function makeConfig(over = {}) {
  const base = { ...DEFAULTS, ...over };
  if (!TOPOLOGIES[base.topo]) base.topo = DEFAULTS.topo;
  const topo = TOPOLOGIES[base.topo];
  if (!topo.services[base.faultSvc]) base.faultSvc = topo.defaultFault;
  const policies = presetPolicies(base.topo, PRESETS[base.preset] ? base.preset : "none");
  for (const id of Object.keys(policies)) Object.assign(policies[id], over.policies?.[id] ?? {});
  return { ...base, policies };
}

export function applyPreset(cfg, preset) {
  return makeConfig({ ...cfg, preset, policies: {} });
}

// ---------------------------------------------------------------------------
// Breaker: count-based window of the last N calls, open on error rate, then a
// cooldown, then half-open with a few trial calls.

export class Breaker {
  constructor({ threshold, window, cooldownMs, probes }) {
    Object.assign(this, { threshold, window, cooldownMs, probes });
    this.state = "closed";
    this.results = [];
    this.openedAt = 0;
    this.trials = 0; // trial calls in flight or done while half-open
    this.trialOk = 0;
    this.trialBad = 0;
    this.log = [{ t: 0, state: "closed" }];
  }
  set(t, state) {
    this.state = state;
    this.log.push({ t, state });
  }
  /** Returns "closed", "probe", or null when the call must fail fast. */
  allow(t) {
    if (this.state === "open" && t - this.openedAt >= this.cooldownMs) {
      this.set(t, "half");
      this.trials = 0; this.trialOk = 0; this.trialBad = 0;
    }
    if (this.state === "closed") return "closed";
    if (this.state === "half" && this.trials < this.probes) { this.trials++; return "probe"; }
    return null;
  }
  record(t, token, ok) {
    if (token === "probe" && this.state === "half") {
      ok ? this.trialOk++ : this.trialBad++;
      // Reopen as soon as the trial calls reach the error threshold, close once enough succeed.
      if (this.trialBad / this.probes >= this.threshold) { this.openedAt = t; this.set(t, "open"); }
      else if (this.trialOk + this.trialBad >= this.probes) { this.results = []; this.set(t, "closed"); }
      return;
    }
    if (token !== "closed" || this.state !== "closed") return;
    this.results.push(ok);
    if (this.results.length > this.window) this.results.shift();
    if (this.results.length >= Math.min(this.window, 20)) {
      const bad = this.results.filter((r) => !r).length;
      if (bad / this.results.length >= this.threshold) { this.openedAt = t; this.set(t, "open"); }
    }
  }
}

// ---------------------------------------------------------------------------
// The simulation.

export function simulate(cfg) {
  const topo = TOPOLOGIES[cfg.topo];
  const ids = Object.keys(topo.services);
  const durationMs = cfg.durationS * 1000;
  const endMs = durationMs + cfg.userTimeoutMs;
  const nb = Math.ceil(cfg.durationS);
  const bucket = (t) => Math.min(nb - 1, Math.floor(t / 1000));
  const q = new EventQueue();
  const randArr = mulberry32(cfg.seed);
  const rand = mulberry32(cfg.seed * 7919 + 1);
  let now = 0;
  const at = (t, fn) => q.push(t, fn);
  const fault = { svc: cfg.faultSvc, kind: cfg.faultKind, from: cfg.faultStartS * 1000, to: cfg.faultEndS * 1000 };
  const faulty = (id, t) => id === fault.svc && t >= fault.from && t < fault.to;

  const svc = {};
  for (const id of ids) {
    const def = topo.services[id], pol = cfg.policies[id];
    svc[id] = {
      id, def, pol, busy: 0, queue: [], qHead: 0, lastT: 0,
      received: 0, ok: 0, failed: 0, shed: 0, retriesSent: 0, timeouts: 0, fastFails: 0, fallbacks: 0, maxQueue: 0,
      latencies: [], busyArea: new Array(nb).fill(0), recvB: new Array(nb).fill(0), okB: new Array(nb).fill(0), queueB: new Array(nb).fill(0),
    };
  }
  const edges = {};
  for (const e of edgesOf(topo)) {
    const pol = cfg.policies[e.from];
    edges[e.key] = {
      ...e, calls: 0, attempts: 0, inflight: 0, sentB: new Array(nb).fill(0),
      breaker: pol.breaker ? new Breaker({ threshold: cfg.breakerThreshold, window: cfg.breakerWindow, cooldownMs: cfg.breakerCooldownMs, probes: cfg.breakerProbes }) : null,
    };
  }

  // Time-weighted pool usage per second.
  function account(s) {
    let t0 = s.lastT;
    while (t0 < now) {
      const k = Math.floor(t0 / 1000);
      if (k >= nb) break;
      const t1 = Math.min(now, (k + 1) * 1000);
      s.busyArea[k] += s.busy * (t1 - t0);
      t0 = t1;
    }
    s.lastT = now;
  }
  const setBusy = (s, d) => { account(s); s.busy += d; };
  const qLen = (s) => s.queue.length - s.qHead;

  /** A request arrives at service `id`. `reply(ok)` is called once it answers. */
  function receive(id, reply) {
    const s = svc[id];
    s.received++;
    if (now < durationMs) s.recvB[bucket(now)]++;
    const req = { arrive: now, reply };
    if (s.busy < s.pol.workers) return start(s, req);
    if (s.pol.queueLimit > 0 && qLen(s) >= s.pol.queueLimit) {
      s.shed++;
      at(now, () => finish(s, req, false, false));
      return;
    }
    s.queue.push(req);
    const len = qLen(s);
    if (len > s.maxQueue) s.maxQueue = len;
    if (now < durationMs) { const k = bucket(now); if (len > s.queueB[k]) s.queueB[k] = len; }
  }

  function start(s, req) {
    setBusy(s, 1);
    const slow = faulty(s.id, now) && fault.kind === "slow" ? cfg.faultFactor : 1;
    at(now + lognormal(rand, s.def.latencyMs, s.def.sigma) * slow, () => {
      if (faulty(s.id, now) && fault.kind === "error" && rand() < cfg.faultErrorRate) return finish(s, req, false, true);
      runCalls(s, req, 0);
    });
  }

  function runCalls(s, req, i) {
    if (i >= s.def.calls.length) return finish(s, req, true, true);
    const c = s.def.calls[i];
    call(s, edges[`${s.id}>${c.to}`], (ok) => {
      if (ok) return runCalls(s, req, i + 1);
      if (!c.critical && s.pol.fallback) { s.fallbacks++; return runCalls(s, req, i + 1); }
      finish(s, req, false, true);
    });
  }

  function finish(s, req, ok, held) {
    if (held) setBusy(s, -1);
    ok ? s.ok++ : s.failed++;
    if (ok && now < durationMs + 1000) s.okB[bucket(req.arrive)]++;
    s.latencies.push(now - req.arrive);
    req.reply(ok);
    if (held) {
      while (s.busy < s.pol.workers && qLen(s) > 0) {
        const next = s.queue[s.qHead++];
        if (s.qHead > 1024 && s.qHead * 2 > s.queue.length) { s.queue = s.queue.slice(s.qHead); s.qHead = 0; }
        start(s, next);
      }
    }
  }

  /** One logical call from service `s` over edge `e`, with timeouts, retries, breaker, and bulkhead. */
  function call(s, e, done) {
    e.calls++;
    const pol = s.pol;
    const attempt = (k) => {
      const token = e.breaker ? e.breaker.allow(now) : "closed";
      if (!token) { s.fastFails++; return done(false); }
      if (pol.bulkhead > 0 && e.inflight >= pol.bulkhead) {
        s.fastFails++;
        if (token === "probe") e.breaker.trials--;
        return done(false);
      }
      e.inflight++; e.attempts++;
      if (now < durationMs) e.sentB[bucket(now)]++;
      if (k > 0) s.retriesSent++;
      let settled = false;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        e.inflight--;
        if (e.breaker) e.breaker.record(now, token, ok);
        if (ok) return done(true);
        if (k < pol.retries) {
          const delay = pol.backoff ? rand() * cfg.backoffMs * 2 ** k : 0;
          at(now + delay, () => attempt(k + 1));
        } else done(false);
      };
      receive(e.to, settle);
      if (pol.timeoutMs > 0 && !settled) at(now + pol.timeoutMs, () => { if (!settled) { s.timeouts++; settle(false); } });
    };
    attempt(0);
  }

  // User traffic: Poisson arrivals at the edge. Users give up after userTimeoutMs.
  const users = [];
  for (let t = 0; ;) {
    t += (-Math.log(1 - randArr()) / cfg.rps) * 1000;
    if (t >= durationMs) break;
    const u = { t, doneAt: null, ok: false };
    users.push(u);
    at(t, () => receive(topo.edge, (ok) => { u.doneAt = now; u.ok = ok; }));
  }

  let events = 0;
  while (q.size) {
    const ev = q.pop();
    if (ev.t > endMs) break;
    now = ev.t;
    ev.fn();
    events++;
  }
  now = Math.min(now, durationMs);
  for (const s of Object.values(svc)) account(s);

  return summarize(cfg, topo, users, svc, edges, events, nb);
}

function summarize(cfg, topo, users, svc, edges, events, nb) {
  const limit = cfg.userTimeoutMs;
  const edge = { total: new Array(nb).fill(0), ok: new Array(nb).fill(0), p99: new Array(nb).fill(0), p50: new Array(nb).fill(0) };
  const lat = Array.from({ length: nb }, () => []);
  let ok = 0, inFault = 0, okInFault = 0;
  const from = cfg.faultStartS * 1000, to = cfg.faultEndS * 1000;
  for (const u of users) {
    const k = Math.min(nb - 1, Math.floor(u.t / 1000));
    const good = u.ok && u.doneAt != null && u.doneAt - u.t <= limit;
    const seen = u.doneAt == null ? limit : Math.min(limit, u.doneAt - u.t);
    edge.total[k]++;
    lat[k].push(seen);
    if (good) { ok++; edge.ok[k]++; }
    if (u.t >= from && u.t < to) { inFault++; if (good) okInFault++; }
  }
  for (let k = 0; k < nb; k++) {
    lat[k].sort((a, b) => a - b);
    edge.p99[k] = quantile(lat[k], 0.99);
    edge.p50[k] = quantile(lat[k], 0.5);
  }
  edge.rate = edge.total.map((n, k) => (n ? edge.ok[k] / n : 1));

  const services = Object.values(svc).map((s) => {
    const sorted = s.latencies.slice().sort((a, b) => a - b);
    return {
      id: s.id, label: s.def.label, workers: s.pol.workers,
      received: s.received, ok: s.ok, failed: s.failed, shed: s.shed,
      successRate: s.received ? s.ok / s.received : 1,
      p50: quantile(sorted, 0.5), p99: quantile(sorted, 0.99),
      maxQueue: s.maxQueue, retriesSent: s.retriesSent, timeouts: s.timeouts, fastFails: s.fastFails, fallbacks: s.fallbacks,
      util: s.busyArea.map((a) => Math.min(1, a / (1000 * s.pol.workers))),
      recvB: s.recvB, queueB: s.queueB,
      successB: s.recvB.map((n, k) => (n ? Math.min(1, s.okB[k] / n) : 1)),
    };
  });
  const edgeList = Object.values(edges).map((e) => ({
    key: e.key, from: e.from, to: e.to, critical: e.critical, calls: e.calls, attempts: e.attempts,
    amplification: e.calls ? e.attempts / e.calls : 1, sentB: e.sentB,
    breakerLog: e.breaker ? e.breaker.log : null,
  }));
  const calls = edgeList.reduce((a, e) => a + e.calls, 0), attempts = edgeList.reduce((a, e) => a + e.attempts, 0);
  return {
    cfg, topo, events, buckets: nb,
    users: users.length, ok, successRate: users.length ? ok / users.length : 1,
    faultSuccessRate: inFault ? okInFault / inFault : 1,
    amplification: calls ? attempts / calls : 1,
    edge, services, edges: edgeList,
  };
}

/** Edge success rate for each preset, same traffic and fault. */
export function comparePresets(cfg) {
  const out = {};
  for (const p of Object.keys(PRESETS)) out[p] = simulate(applyPreset(cfg, p)).successRate;
  return out;
}

/** Breaker state at time t from a transition log. */
export function stateAt(log, t) {
  let s = "closed";
  for (const e of log) { if (e.t > t) break; s = e.state; }
  return s;
}

// ---------------------------------------------------------------------------
// URL hash: globals as plain keys, policies as `service.key`.

const GLOBAL_NUM = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "number");

export function encodeConfig(cfg) {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEFAULTS)) p.set(k, String(cfg[k]));
  for (const [id, pol] of Object.entries(cfg.policies)) for (const k of POLICY_KEYS) p.set(`${id}.${k}`, String(pol[k]));
  return p.toString();
}

export function decodeConfig(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ""));
  const over = {};
  for (const k of ["topo", "preset", "faultSvc", "faultKind"]) if (p.has(k)) over[k] = p.get(k);
  for (const k of GLOBAL_NUM) {
    const n = Number(p.get(k));
    if (p.has(k) && Number.isFinite(n) && n >= 0) over[k] = n;
  }
  const topoId = TOPOLOGIES[over.topo] ? over.topo : DEFAULTS.topo;
  over.policies = {};
  for (const id of Object.keys(TOPOLOGIES[topoId].services)) {
    over.policies[id] = {};
    for (const k of POLICY_KEYS) {
      const n = Number(p.get(`${id}.${k}`));
      if (p.has(`${id}.${k}`) && Number.isFinite(n) && n >= 0) over.policies[id][k] = n;
    }
  }
  return clamp(makeConfig(over));
}

export function clamp(cfg) {
  const c = { ...cfg };
  if (c.faultKind !== "error") c.faultKind = "slow";
  c.rps = Math.min(400, Math.max(1, c.rps));
  c.durationS = Math.round(Math.min(120, Math.max(10, c.durationS)));
  c.seed = Math.round(c.seed);
  c.userTimeoutMs = Math.max(100, c.userTimeoutMs);
  c.faultStartS = Math.min(c.durationS, c.faultStartS);
  c.faultEndS = Math.min(c.durationS, Math.max(c.faultStartS, c.faultEndS));
  c.faultFactor = Math.max(1, c.faultFactor);
  c.faultErrorRate = Math.min(1, c.faultErrorRate);
  c.breakerThreshold = Math.min(1, Math.max(0.05, c.breakerThreshold));
  c.breakerWindow = Math.max(1, Math.round(c.breakerWindow));
  c.breakerProbes = Math.max(1, Math.round(c.breakerProbes));
  c.policies = Object.fromEntries(Object.entries(c.policies).map(([id, pol]) => [id, {
    ...pol,
    workers: Math.max(1, Math.round(pol.workers)),
    retries: Math.min(10, Math.round(pol.retries)),
    bulkhead: Math.round(pol.bulkhead),
    queueLimit: Math.round(pol.queueLimit),
    backoff: pol.backoff ? 1 : 0, breaker: pol.breaker ? 1 : 0, fallback: pol.fallback ? 1 : 0,
  }]));
  return c;
}
