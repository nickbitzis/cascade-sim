import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Breaker, DEFAULTS, EventQueue, PRESETS, TOPOLOGIES, applyPreset, comparePresets, decodeConfig, edgesOf, encodeConfig,
  lognormal, makeConfig, mulberry32, presetPolicies, quantile, simulate, stateAt,
} from "../src/sim.js";

// A two-service test topology: "a" calls "b". Registered once for every test.
TOPOLOGIES.pair = {
  label: "Test pair",
  edge: "a",
  defaultFault: "b",
  services: {
    a: { label: "A", latencyMs: 1, sigma: 0, workers: 1000, timeoutMs: 50, calls: [{ to: "b", critical: true }] },
    b: { label: "B", latencyMs: 10, sigma: 0, workers: 2, calls: [] },
  },
  layout: { a: [0, 0], b: [1, 0] },
};
// "a" calls a critical and a non-critical service.
TOPOLOGIES.fan = {
  label: "Test fan",
  edge: "a",
  defaultFault: "slow",
  services: {
    a: { label: "A", latencyMs: 1, sigma: 0, workers: 20, timeoutMs: 50, calls: [{ to: "fast", critical: true }, { to: "slow", critical: false }] },
    fast: { label: "Fast", latencyMs: 5, sigma: 0, workers: 50, calls: [] },
    slow: { label: "Slow", latencyMs: 5, sigma: 0, workers: 50, calls: [] },
  },
  layout: { a: [0, 0], fast: [1, 0], slow: [1, 1] },
};

const noFault = { faultStartS: 0, faultEndS: 0 };
const pair = (over = {}, pol = {}) => makeConfig({ topo: "pair", rps: 50, durationS: 10, userTimeoutMs: 5000, ...noFault, ...over, policies: pol });
const svc = (r, id) => r.services.find((s) => s.id === id);
const edge = (r, key) => r.edges.find((e) => e.key === key);

test("mulberry32 is deterministic and seed dependent", () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const xs = Array.from({ length: 5 }, a), ys = Array.from({ length: 5 }, b), zs = Array.from({ length: 5 }, c);
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, zs);
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test("lognormal has the requested median", () => {
  const rand = mulberry32(1);
  const xs = Array.from({ length: 20000 }, () => lognormal(rand, 30, 0.5)).sort((a, b) => a - b);
  const med = quantile(xs, 0.5);
  assert.ok(med > 28.5 && med < 31.5, `median ${med}`);
  assert.ok(quantile(xs, 0.99) > 2.5 * med); // a real tail
});

test("event queue pops in time order and keeps insertion order for ties", () => {
  const q = new EventQueue(), out = [];
  for (const [t, tag] of [[5, "a"], [1, "b"], [5, "c"], [3, "d"], [1, "e"], [0, "f"]]) q.push(t, tag);
  while (q.size) out.push(q.pop().fn);
  assert.deepEqual(out, ["f", "b", "e", "d", "a", "c"]);
});

test("event queue stays ordered under random load", () => {
  const rand = mulberry32(9), q = new EventQueue();
  for (let i = 0; i < 2000; i++) q.push(Math.floor(rand() * 100), i);
  let last = { t: -1, s: -1 };
  while (q.size) {
    const e = q.pop();
    assert.ok(e.t > last.t || (e.t === last.t && e.s > last.s));
    last = e;
  }
});

test("simulation is reproducible from the seed", () => {
  const a = simulate(makeConfig({ durationS: 20 })), b = simulate(makeConfig({ durationS: 20 }));
  assert.equal(a.ok, b.ok);
  assert.deepEqual(a.edge.p99, b.edge.p99);
  const c = simulate(makeConfig({ durationS: 20, seed: 8 }));
  assert.notDeepEqual(a.edge.p99, c.edge.p99);
});

test("a saturated pool queues requests instead of dropping them", () => {
  // B has 2 workers and 10 ms of work: 200 req/s capacity. Send 400 req/s.
  const r = simulate(pair({ rps: 400, durationS: 5 }));
  const b = svc(r, "b");
  assert.ok(b.maxQueue > 100, `max queue ${b.maxQueue}`);
  assert.equal(b.shed, 0);
  assert.ok(Math.max(...b.util) > 0.99);
});

test("a queue limit sheds load instead of queueing", () => {
  const r = simulate(pair({ rps: 400, durationS: 5 }, { b: { queueLimit: 5 } }));
  const b = svc(r, "b");
  assert.ok(b.maxQueue <= 5);
  assert.ok(b.shed > 500);
  assert.ok(b.p99 < 50, `p99 ${b.p99}`); // what is accepted is served fast
});

test("a client timeout fires before a slow response", () => {
  const r = simulate(pair({ faultStartS: 0, faultEndS: 99, faultFactor: 20 }, { a: { timeoutMs: 50 } }));
  const a = svc(r, "a");
  assert.ok(a.timeouts > 0);
  assert.equal(a.ok, 0); // B takes 200 ms, every call times out at 50 ms
  assert.ok(a.p99 < 60, `p99 ${a.p99}`);
});

test("without a timeout the caller waits for the slow response", () => {
  const r = simulate(pair({ rps: 5, faultStartS: 0, faultEndS: 99, faultFactor: 20 }));
  const a = svc(r, "a");
  assert.equal(a.timeouts, 0);
  assert.equal(a.failed, 0);
  assert.ok(a.p50 >= 200);
});

test("retries amplify load by exactly retries + 1 when every call fails", () => {
  const r = simulate(pair({ faultKind: "error", faultErrorRate: 1, faultStartS: 0, faultEndS: 99 }, { a: { retries: 3 } }));
  const e = edge(r, "a>b");
  assert.equal(e.attempts, e.calls * 4);
  assert.equal(svc(r, "b").received, e.calls * 4);
  assert.equal(svc(r, "a").retriesSent, e.calls * 3);
});

test("retries on a partial error rate amplify by 1 + p + p^2 + p^3", () => {
  const p = 0.5;
  const r = simulate(pair({ rps: 60, durationS: 30, faultKind: "error", faultErrorRate: p, faultStartS: 0, faultEndS: 99 }, { a: { retries: 3 } }));
  const expected = 1 + p + p ** 2 + p ** 3;
  assert.ok(Math.abs(edge(r, "a>b").amplification - expected) < 0.07, `${edge(r, "a>b").amplification}`);
  assert.ok(Math.abs(svc(r, "a").successRate - (1 - p ** 4)) < 0.02);
});

test("backoff with jitter spreads retries out in time", () => {
  const base = { faultKind: "error", faultErrorRate: 1, faultStartS: 0, faultEndS: 99 };
  const flat = simulate(pair(base, { a: { retries: 3 } }));
  const spread = simulate(pair({ ...base, backoffMs: 100 }, { a: { retries: 3, backoff: 1 } }));
  // Same number of attempts, but each failed request takes longer to give up.
  assert.equal(edge(spread, "a>b").attempts, edge(flat, "a>b").attempts);
  assert.ok(svc(spread, "a").p50 > svc(flat, "a").p50 + 50);
});

test("breaker opens on error rate, half-opens after cooldown, and closes on good trials", () => {
  const br = new Breaker({ threshold: 0.5, window: 20, cooldownMs: 1000, probes: 3 });
  for (let i = 0; i < 20; i++) br.record(i, br.allow(i), i % 2 === 0); // 50% errors
  assert.equal(br.state, "open");
  assert.equal(br.allow(500), null); // fails fast during cooldown
  const t = br.openedAt + 1000;
  assert.equal(br.allow(t), "probe");
  assert.equal(br.state, "half");
  assert.equal(br.allow(t), "probe");
  assert.equal(br.allow(t), "probe");
  assert.equal(br.allow(t), null); // only 3 trials
  for (let i = 0; i < 3; i++) br.record(t + 10, "probe", true);
  assert.equal(br.state, "closed");
  assert.deepEqual(br.log.map((e) => e.state), ["closed", "open", "half", "closed"]);
});

test("breaker reopens when trial calls fail", () => {
  const br = new Breaker({ threshold: 0.5, window: 20, cooldownMs: 1000, probes: 2 });
  for (let i = 0; i < 20; i++) br.record(i, br.allow(i), false);
  const t = br.openedAt + 1000;
  const tok = br.allow(t);
  br.record(t + 5, tok, false);
  assert.equal(br.state, "open");
  assert.equal(br.openedAt, t + 5);
  assert.equal(stateAt(br.log, t + 1), "half");
  assert.equal(stateAt(br.log, t + 6), "open");
});

test("breaker stays closed below the threshold", () => {
  const br = new Breaker({ threshold: 0.5, window: 20, cooldownMs: 1000, probes: 2 });
  for (let i = 0; i < 200; i++) br.record(i, br.allow(i), i % 5 !== 0); // 20% errors
  assert.equal(br.state, "closed");
});

test("an open breaker fails fast and stops load on the sick service", () => {
  const cfg = pair({ faultStartS: 0, faultEndS: 99, faultFactor: 20, breakerCooldownMs: 3000 }, { a: { timeoutMs: 50, breaker: 1 } });
  const r = simulate(cfg);
  assert.ok(svc(r, "a").fastFails > 300);
  assert.ok(svc(r, "b").received < 0.2 * r.users);
  const states = edge(r, "a>b").breakerLog.map((e) => e.state);
  assert.ok(states.includes("open") && states.includes("half"));
});

test("bulkhead caps concurrent calls to one dependency", () => {
  const over = { rps: 200, durationS: 10, faultStartS: 0, faultEndS: 99, faultFactor: 50 };
  const without = simulate(makeConfig({ topo: "fan", ...over, userTimeoutMs: 2000 }));
  const withBh = simulate(makeConfig({ topo: "fan", ...over, userTimeoutMs: 2000, policies: { a: { bulkhead: 5, fallback: 1 } } }));
  // Without isolation, the slow call holds all 20 workers. With it, at most 5.
  assert.ok(Math.max(...svc(without, "a").util) > 0.99);
  assert.ok(Math.max(...svc(withBh, "a").util) < 0.4);
  assert.ok(withBh.successRate > 0.99);
  assert.ok(without.successRate < 0.5);
});

test("fallback turns a failed non-critical call into a degraded success", () => {
  const over = { topo: "fan", rps: 50, durationS: 10, faultKind: "error", faultErrorRate: 1, faultStartS: 0, faultEndS: 99 };
  const noFb = simulate(makeConfig(over));
  const fb = simulate(makeConfig({ ...over, policies: { a: { fallback: 1 } } }));
  assert.equal(noFb.ok, 0);
  assert.equal(fb.ok, fb.users);
  assert.equal(svc(fb, "a").fallbacks, fb.users);
});

test("fallback does not hide a failed critical call", () => {
  const over = { topo: "fan", rps: 50, durationS: 10, faultSvc: "fast", faultKind: "error", faultErrorRate: 1, faultStartS: 0, faultEndS: 99 };
  const r = simulate(makeConfig({ ...over, policies: { a: { fallback: 1 } } }));
  assert.equal(r.ok, 0);
});

test("presets order edge success: retries < none < timeouts + breaker <= full", () => {
  const s = comparePresets(makeConfig());
  assert.ok(s.retries < s.none, JSON.stringify(s));
  assert.ok(s.none < s.breaker);
  assert.ok(s.full >= s.breaker - 0.002);
  assert.ok(s.breaker > 0.99 && s.full > 0.99);
});

test("default story: checkout collapses while payments and inventory stay healthy", () => {
  const r = simulate(makeConfig());
  assert.ok(r.faultSuccessRate < 0.15, `${r.faultSuccessRate}`);
  assert.ok(svc(r, "payments").successRate > 0.99);
  assert.ok(svc(r, "inventory").successRate > 0.99);
  const ck = svc(r, "checkout");
  assert.ok(Math.max(...ck.util) > 0.99);
  assert.ok(ck.maxQueue > 200);
});

test("retries only creates a retry storm that outlasts the fault", () => {
  const r = simulate(applyPreset(makeConfig(), "retries"));
  const gw = edge(r, "gateway>checkout");
  assert.ok(gw.amplification > 2.5, `${gw.amplification}`);
  const after = r.edge.rate.slice(DEFAULTS.faultEndS + 10);
  assert.ok(after.every((x) => x < 0.2)); // still down 10 s after recommendations recovered
});

test("presets set the expected policies", () => {
  const p = presetPolicies("checkout", "full");
  assert.equal(p.gateway.retries, 0); // retry at one layer only
  assert.equal(p.checkout.retries, 2);
  assert.equal(p.checkout.backoff, 1);
  assert.ok(p.checkout.bulkhead > 0 && p.checkout.breaker && p.checkout.fallback);
  assert.ok(p.payments.queueLimit > 0);
  assert.equal(presetPolicies("checkout", "none").checkout.timeoutMs, 0);
  assert.deepEqual(Object.keys(PRESETS), ["none", "retries", "breaker", "full"]);
});

test("every topology has a valid edge, layout, and acyclic call graph", () => {
  for (const [id, t] of Object.entries(TOPOLOGIES)) {
    assert.ok(t.services[t.edge], id);
    for (const e of edgesOf(t)) assert.ok(t.services[e.to], `${id}: ${e.key}`);
    for (const s of Object.keys(t.services)) assert.ok(t.layout[s], `${id}: ${s}`);
  }
});

test("config round-trips through the URL hash and clamps bad input", () => {
  const cfg = makeConfig({ topo: "checkout", rps: 120, faultKind: "error", policies: { checkout: { retries: 2, breaker: 1 } } });
  const back = decodeConfig(`#${encodeConfig(cfg)}`);
  assert.deepEqual(back, cfg);
  const bad = decodeConfig("#rps=-5&durationS=9999&topo=nope&faultSvc=zzz&checkout.retries=99");
  assert.equal(bad.topo, "checkout");
  assert.equal(bad.rps, DEFAULTS.rps);
  assert.equal(bad.durationS, 120);
  assert.equal(bad.faultSvc, "recommendations");
  assert.equal(bad.policies.checkout.retries, 10);
});

test("chain topology runs and a slow database shows up at the edge", () => {
  const r = simulate(makeConfig({ topo: "chain", durationS: 30, faultStartS: 10, faultEndS: 20 }));
  assert.equal(r.services.length, 4);
  assert.ok(r.faultSuccessRate < r.successRate);
});
