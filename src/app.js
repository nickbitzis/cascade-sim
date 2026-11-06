import { DEFAULTS, PRESETS, TOPOLOGIES, applyPreset, clamp, comparePresets, decodeConfig, encodeConfig, makeConfig, simulate, stateAt } from "./sim.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const SVG_NS = "http://www.w3.org/2000/svg";

let cfg = decodeConfig(location.hash);
let res = null;
let cursor = null; // the second the diagram shows; null means the middle of the fault
let svcTab = Object.keys(TOPOLOGIES[cfg.topo].services)[1];
let compareKey = "", compare = {};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const pct = (x, d = 1) => `${(x * 100).toFixed(x === 1 || x === 0 ? 0 : d)}%`;
const ms = (t) => (t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)} s` : `${Math.round(t)} ms`);
const num = (n) => Math.round(n).toLocaleString("en-US");
const topo = () => TOPOLOGIES[cfg.topo];
const label = (id) => topo().services[id].label;

// ---------------------------------------------------------------------------
// Form

function fillForm() {
  const t = topo();
  form.elements.topo.replaceChildren(...Object.entries(TOPOLOGIES).map(([id, x]) => el("option", { value: id, text: x.label })));
  form.elements.faultSvc.replaceChildren(...Object.entries(t.services).map(([id, s]) => el("option", { value: id, text: s.label })));
  for (const f of form.elements) if (f.name && f.name in cfg) f.value = cfg[f.name];
  for (const l of form.querySelectorAll("[data-kind]")) l.hidden = l.dataset.kind !== cfg.faultKind;
  if (!t.services[svcTab]) svcTab = Object.keys(t.services)[1];
  $("svc-tabs").replaceChildren(...Object.keys(t.services).map((id) => el("button", {
    type: "button", class: "tab", role: "tab", "aria-selected": String(id === svcTab), "data-svc": id, text: t.services[id].label,
  })));
  const def = t.services[svcTab];
  const calls = def.calls.map((c) => `${label(c.to)}${c.critical ? "" : " (non-critical)"}`);
  $("svc-desc").textContent = calls.length ? `Calls ${calls.join(", ")}. Timeout, retries, breaker, bulkhead, and fallback apply to these calls.` : "Calls nothing. Only the pool and the queue limit apply.";
  const pol = cfg.policies[svcTab];
  for (const f of form.querySelectorAll("[data-pol]")) {
    if (f.type === "checkbox") f.checked = !!pol[f.dataset.pol];
    else f.value = pol[f.dataset.pol];
    f.disabled = !calls.length && !["workers", "queueLimit"].includes(f.dataset.pol);
  }
  $("presets").replaceChildren(...Object.entries(PRESETS).map(([id, p]) => el("button", {
    type: "button", class: "preset", "data-preset": id, "aria-pressed": String(cfg.preset === id),
  }, [el("span", { text: p.label }), el("b", { "data-rate": id })])));
  $("preset-note").textContent = PRESETS[cfg.preset]?.note ?? "Custom settings. Pick a preset to start over from one.";
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (f.dataset.pol) {
    const v = f.type === "checkbox" ? (f.checked ? 1 : 0) : Number(f.value);
    if (f.value === "" || !Number.isFinite(v) || v < 0) return;
    cfg = clamp({ ...cfg, preset: "custom", policies: { ...cfg.policies, [svcTab]: { ...cfg.policies[svcTab], [f.dataset.pol]: v } } });
    $("preset-note").textContent = "Custom settings. Pick a preset to start over from one.";
    for (const b of $("presets").children) b.setAttribute("aria-pressed", "false");
    return schedule();
  }
  if (!f.name) return;
  if (f.name === "topo") {
    cursor = null;
    cfg = makeConfig({ ...globals(cfg), topo: f.value, faultSvc: TOPOLOGIES[f.value].defaultFault, preset: PRESETS[cfg.preset] ? cfg.preset : "none" });
    fillForm();
    return schedule();
  }
  let v = f.value;
  if (f.tagName !== "SELECT") {
    v = Number(f.value);
    if (f.value === "" || !Number.isFinite(v) || v < 0) return;
  }
  cfg = clamp({ ...cfg, [f.name]: v });
  if (f.name === "faultKind") for (const l of form.querySelectorAll("[data-kind]")) l.hidden = l.dataset.kind !== cfg.faultKind;
  schedule();
});

$("svc-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-svc]");
  if (!b) return;
  svcTab = b.dataset.svc;
  fillForm();
  paintPresetRates();
});

$("presets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-preset]");
  if (!b) return;
  cfg = applyPreset(cfg, b.dataset.preset);
  fillForm();
  update();
});

function globals(c) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = c[k];
  return out;
}

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(update, 120);
}

// ---------------------------------------------------------------------------
// Results

function update() {
  res = simulate(cfg);
  const key = JSON.stringify({ ...globals(cfg), preset: 0 });
  if (key !== compareKey) { compareKey = key; compare = comparePresets(cfg); }
  paintPresetRates();
  drawCards();
  drawCharts();
  drawDiagram();
  drawTable();
  history.replaceState(null, "", `#${encodeConfig(cfg)}`);
}

function paintPresetRates() {
  for (const b of document.querySelectorAll("[data-rate]")) {
    const r = compare[b.dataset.rate];
    if (r == null) continue;
    b.textContent = pct(r);
    b.className = r >= 0.99 ? "good" : r < 0.9 ? "bad" : "";
  }
}

function recoverySeconds() {
  const rate = res.edge.rate, end = Math.ceil(cfg.faultEndS);
  if (cfg.faultEndS <= cfg.faultStartS) return null;
  for (let k = end; k < rate.length; k++) if (rate.slice(k, k + 3).every((x) => x >= 0.99)) return k - end;
  return Infinity;
}

function card(labelText, value, sub, cls = "") {
  return el("div", { class: "card" }, [
    el("span", { class: "card-label", text: labelText }),
    el("span", { class: `card-total ${cls}`, text: value }),
    el("span", { class: "card-sub", text: sub }),
  ]);
}

function drawCards() {
  const worst = res.edges.reduce((a, e) => (e.amplification > a.amplification ? e : a), res.edges[0]);
  const rec = recoverySeconds();
  const tone = (x) => (x >= 0.99 ? "good" : x < 0.9 ? "bad" : "");
  $("cards").replaceChildren(
    card("Edge success", pct(res.successRate), `${num(res.ok)} of ${num(res.users)} users served in time`, tone(res.successRate)),
    card("During the fault", pct(res.faultSuccessRate), `${label(cfg.faultSvc)} ${cfg.faultKind === "slow" ? `${cfg.faultFactor}x slower` : `failing ${pct(cfg.faultErrorRate, 0)} of calls`}, ${cfg.faultStartS} to ${cfg.faultEndS} s`, tone(res.faultSuccessRate)),
    card("Retry amplification", `${worst.amplification.toFixed(2)}x`, `${label(worst.from)} to ${label(worst.to)}: attempts per logical call`, worst.amplification > 1.5 ? "bad" : ""),
    card("Recovery", rec == null ? "n/a" : rec === Infinity ? "Never" : `${rec} s`, rec === Infinity ? "Still failing at the end of the run" : "After the fault ends, until 3 s in a row at 99%+", rec === Infinity ? "bad" : rec === 0 ? "good" : ""),
  );
}

function drawTable() {
  $("rows").replaceChildren(...res.services.map((s) => el("tr", {}, [
    el("td", { text: s.label }),
    el("td", { class: "num", text: num(s.received) }),
    el("td", { class: `num${s.successRate < 0.99 ? " bad" : ""}`, text: pct(s.successRate) }),
    el("td", { class: "num", text: ms(s.p50) }),
    el("td", { class: "num", text: ms(s.p99) }),
    el("td", { class: "num", text: num(s.maxQueue) }),
    el("td", { class: "num", text: num(s.retriesSent) }),
    el("td", { class: "num", text: num(s.timeouts) }),
    el("td", { class: "num", text: num(s.shed + s.fastFails) }),
  ])));
  const notes = [];
  const by = Object.fromEntries(res.services.map((s) => [s.id, s]));
  const healthy = res.services.filter((s) => s.id !== cfg.faultSvc && s.successRate >= 0.99 && Math.max(...s.util) < 0.95).map((s) => s.label);
  const saturated = res.services.filter((s) => s.id !== cfg.faultSvc && Math.max(...s.util) >= 0.99).map((s) => s.label);
  if (saturated.length) notes.push(`${saturated.join(" and ")} ran out of workers while waiting on ${label(cfg.faultSvc)}, so requests queued behind them.`);
  if (saturated.length && healthy.length) notes.push(`${healthy.join(", ")} stayed healthy the whole time.`);
  const retries = res.services.reduce((a, s) => a + s.retriesSent, 0);
  if (retries) notes.push(`Retries added ${num(retries)} extra calls.`);
  const fb = res.services.reduce((a, s) => a + s.fallbacks, 0);
  if (fb) notes.push(`${num(fb)} requests got a fallback instead of a failure.`);
  if (by[cfg.faultSvc]) notes.push(`${label(cfg.faultSvc)} received ${num(by[cfg.faultSvc].received)} requests in total.`);
  $("note").textContent = notes.join(" ");
}

// ---------------------------------------------------------------------------
// Topology diagram

function health(s, k) {
  const util = s.util[k] ?? 0, ok = s.successB[k] ?? 1;
  // A full pool with a queue longer than the pool means requests are stuck waiting.
  if (ok < 0.9 || (util >= 0.99 && (s.queueB[k] ?? 0) >= s.workers)) return "bad";
  if (util >= 0.95 || ok < 0.99) return "warn";
  return "good";
}

function drawDiagram() {
  const t = topo(), d = $("diagram");
  const k = cursor ?? Math.min(res.buckets - 1, Math.floor((cfg.faultStartS + cfg.faultEndS) / 2));
  $("diag-time").textContent = `${k} to ${k + 1} s${cursor == null ? " (middle of the fault)" : ""}`;
  const cols = Math.max(...Object.values(t.layout).map((p) => p[0])) + 1;
  const rows = Math.max(...Object.values(t.layout).map((p) => p[1])) + 1;
  const W = 760, nw = 138, nh = 56, rowH = 82;
  const H = rows * rowH + 8;
  const gap = (W - cols * nw) / Math.max(1, cols - 1);
  const pos = (id) => { const [c, r] = t.layout[id]; return { x: c * (nw + gap), y: 4 + r * rowH + (rowH - nh) / 2 }; };
  d.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const byId = Object.fromEntries(res.services.map((s) => [s.id, s]));
  const nodes = [];
  const maxSent = Math.max(1, ...res.edges.flatMap((e) => e.sentB));
  for (const e of res.edges) {
    const a = pos(e.from), b = pos(e.to);
    const x1 = a.x + nw, y1 = a.y + nh / 2, x2 = b.x, y2 = b.y + nh / 2;
    const mx = (x1 + x2) / 2;
    const st = e.breakerLog ? stateAt(e.breakerLog, k * 1000 + 999) : "closed";
    const rate = e.sentB[k] ?? 0;
    nodes.push(svg("path", {
      d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
      class: `edge${e.critical ? "" : " optional"}${st !== "closed" ? ` ${st}` : ""}`,
      "stroke-width": 1.5 + 8 * Math.sqrt(rate / maxSent),
    }));
    const txt = st === "open" ? "open" : st === "half" ? "half-open" : `${num(rate)}/s`;
    nodes.push(svg("text", { x: mx, y: (y1 + y2) / 2 - 6, "text-anchor": "middle", class: `e-label${st === "open" ? " open" : ""}` }, txt));
  }
  for (const id of Object.keys(t.services)) {
    const s = byId[id], p = pos(id), h = health(s, k);
    const g = svg("g", { class: `node ${h}`, transform: `translate(${p.x},${p.y})` });
    g.append(svg("rect", { width: nw, height: nh, rx: 8 }));
    g.append(svg("text", { x: 10, y: 20, class: "n-label" }, s.label));
    g.append(svg("text", { x: 10, y: 36, class: "n-sub" }, `pool ${pct(s.util[k] ?? 0, 0)} of ${s.workers}`));
    g.append(svg("text", { x: 10, y: 50, class: "n-sub" }, (s.queueB[k] ?? 0) > 0 ? `queue ${num(s.queueB[k])}, ${num(s.recvB[k] ?? 0)}/s in` : `${pct(s.successB[k] ?? 1, 0)} ok, ${num(s.recvB[k] ?? 0)}/s in`));
    const faultNow = id === cfg.faultSvc && k >= cfg.faultStartS && k < cfg.faultEndS;
    if (faultNow) g.append(svg("text", { x: nw, y: -5, "text-anchor": "end", class: "n-fault" }, cfg.faultKind === "slow" ? `${cfg.faultFactor}x slow` : "erroring"));
    nodes.push(g);
  }
  d.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------------
// Charts: small multiples that share the time axis and the hover.

const CW = 400, PAD = { l: 104, r: 8, t: 6, b: 20 };
const xOf = (k) => PAD.l + (k / res.buckets) * (CW - PAD.l - PAD.r);

function frame(chart, h) {
  chart.setAttribute("viewBox", `0 0 ${CW} ${h}`);
  const nodes = [];
  if (cfg.faultEndS > cfg.faultStartS) {
    nodes.push(svg("rect", { x: xOf(cfg.faultStartS), y: PAD.t, width: xOf(cfg.faultEndS) - xOf(cfg.faultStartS), height: h - PAD.t - PAD.b, class: "fault" }));
  }
  const step = res.buckets > 60 ? 20 : 10;
  for (let s = 0; s <= res.buckets; s += step) {
    nodes.push(svg("text", { x: xOf(s), y: h - 6, class: "tick", "text-anchor": "middle" }, `${s}s`));
  }
  return nodes;
}

function lineChart(id, values, { max, fmt, ticks }) {
  const chart = $(id), h = 150;
  const nodes = frame(chart, h);
  const y = (v) => PAD.t + (1 - Math.min(v, max) / max) * (h - PAD.t - PAD.b);
  for (const v of ticks) {
    nodes.push(svg("line", { x1: PAD.l, x2: CW - PAD.r, y1: y(v), y2: y(v), class: "grid" }));
    nodes.push(svg("text", { x: PAD.l - 6, y: y(v) + 3, class: "tick", "text-anchor": "end" }, fmt(v)));
  }
  const pts = values.map((v, k) => `${xOf(k + 0.5).toFixed(1)},${y(v).toFixed(1)}`);
  nodes.push(svg("polyline", { points: pts.join(" "), class: "line" }));
  chart.replaceChildren(...nodes);
  chart._h = h;
}

function rowsChart(id, rows, drawRow) {
  const chart = $(id), rowH = 22;
  if (!rows.length) {
    chart.setAttribute("viewBox", `0 0 ${CW} 40`);
    chart.replaceChildren(svg("text", { x: 0, y: 20, class: "empty" }, "No breakers enabled. Turn one on per service, or pick a preset."));
    chart._h = 40;
    return;
  }
  const h = PAD.t + rows.length * rowH + PAD.b + 4;
  const nodes = frame(chart, h);
  rows.forEach((r, i) => {
    const top = PAD.t + 2 + i * rowH;
    nodes.push(svg("text", { x: 0, y: top + 14, class: "row-label" }, r.short));
    nodes.push(...drawRow(r, top, rowH - 5));
  });
  chart.replaceChildren(...nodes);
  chart._h = h;
}

const short = (id) => label(id);

function drawCharts() {
  lineChart("c-success", res.edge.rate, { max: 1, fmt: (v) => pct(v, 0), ticks: [0, 0.5, 1] });
  const maxLat = cfg.userTimeoutMs;
  lineChart("c-p99", res.edge.p99, { max: maxLat, fmt: ms, ticks: [0, maxLat / 2, maxLat] });
  rowsChart("c-util", res.services.map((s) => ({ ...s, short: short(s.id) })), (s, top, hh) => {
    const base = top + hh;
    const pts = s.util.map((u, k) => `${xOf(k).toFixed(1)},${(base - u * hh).toFixed(1)} ${xOf(k + 1).toFixed(1)},${(base - u * hh).toFixed(1)}`).join(" ");
    return [
      svg("line", { x1: PAD.l, x2: CW - PAD.r, y1: base, y2: base, class: "grid" }),
      svg("polygon", { points: `${PAD.l},${base} ${pts} ${xOf(res.buckets)},${base}`, class: "area" }),
      svg("polyline", { points: pts, class: "line", "stroke-width": 1.5 }),
    ];
  });
  const brs = res.edges.filter((e) => e.breakerLog).map((e) => ({ ...e, short: `to ${short(e.to)}` }));
  rowsChart("c-breaker", brs, (e, top, hh) => {
    const out = [svg("rect", { x: PAD.l, y: top, width: xOf(res.buckets) - PAD.l, height: hh, class: "band-closed" })];
    const end = res.buckets * 1000;
    e.breakerLog.forEach((s, i) => {
      if (s.state === "closed" || s.t >= end) return;
      const t1 = Math.min(end, e.breakerLog[i + 1]?.t ?? end);
      const x1 = xOf(s.t / 1000), x2 = xOf(t1 / 1000);
      out.push(svg("rect", { x: x1, y: top, width: Math.max(0.8, x2 - x1), height: hh, class: `band-${s.state}` }));
    });
    return out;
  });
}

// Shared hover: one crosshair across every chart, a tooltip on the hovered one,
// and the diagram follows.
function tipRows(k) {
  const rows = [
    ["Edge success", pct(res.edge.rate[k])],
    ["p99 latency", ms(res.edge.p99[k])],
    ["Users this second", num(res.edge.total[k])],
  ];
  for (const s of res.services) rows.push([`${s.label} pool`, pct(s.util[k], 0)]);
  for (const e of res.edges) if (e.breakerLog) {
    const st = stateAt(e.breakerLog, k * 1000 + 999);
    if (st !== "closed") rows.push([`Breaker to ${label(e.to)}`, st === "half" ? "half-open" : "open"]);
  }
  return rows;
}

for (const chart of document.querySelectorAll(".chart")) {
  const tip = chart.nextElementSibling;
  chart.addEventListener("pointermove", (e) => {
    if (!res) return;
    const box = chart.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * CW;
    const k = Math.floor(((sx - PAD.l) / (CW - PAD.l - PAD.r)) * res.buckets);
    if (k < 0 || k >= res.buckets) return;
    for (const c of document.querySelectorAll(".chart")) {
      c.querySelector(".crosshair")?.remove();
      c.append(svg("line", { x1: xOf(k + 0.5), x2: xOf(k + 0.5), y1: PAD.t, y2: (c._h ?? 150) - PAD.b, class: "crosshair" }));
    }
    tip.replaceChildren(el("strong", { text: `${k} to ${k + 1} s` }), ...tipRows(k).map(([a, b]) => el("div", { class: "tip-row" }, [el("span", { text: a }), el("b", { text: b })])));
    tip.hidden = false;
    const left = e.clientX - box.left;
    tip.style.left = `${left > box.width / 2 ? left - tip.offsetWidth - 12 : left + 12}px`;
    tip.style.top = `${Math.max(0, e.clientY - box.top - 20)}px`;
    if (cursor !== k) { cursor = k; drawDiagram(); }
  });
  chart.addEventListener("pointerleave", () => {
    tip.hidden = true;
    for (const c of document.querySelectorAll(".chart")) c.querySelector(".crosshair")?.remove();
  });
}

// ---------------------------------------------------------------------------

$("reset").addEventListener("click", () => {
  cfg = makeConfig();
  cursor = null;
  svcTab = Object.keys(topo().services)[1];
  fillForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

fillForm();
update();
