// ===================== ЯДРО АНАЛІТИКА =====================
// Свічка: [t, open, high, low, close, volume, trades, takerBuyBase]  (хвилинні, Binance)
// Усі ознаки причинні: значення в точці i залежить лише від свічок до i включно.

export const MIN = 60000;
export const WARM = 60;
export const D = 12;                       // кількість ознак (лише ціна: потік ордерів, час і сусідній актив перевіркою не підтверджені)
export const FEATURE_NAMES = [
  'ret1', 'ret3', 'ret5', 'ret10', 'ret15', 'ret30', 'ret60', 'rsi', 'ema20', 'ema60', 'vol5/60', 'range5',
];

const clip = (x, m = 5) => (x > m ? m : x < -m ? -m : x);

export function ema(arr, p) {
  const o = new Float64Array(arr.length), a = 2 / (p + 1);
  o[0] = arr[0];
  for (let i = 1; i < arr.length; i++) o[i] = a * arr[i] + (1 - a) * o[i - 1];
  return o;
}

// Заповнює пропущені хвилини плоскими свічками; після великої діри (>60 хв) старіші дані відкидає
export function fillGaps(cs) {
  const out = [];
  for (const c of cs) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = (c[0] - prev[0]) / MIN - 1;
      if (gap > 60) out.length = 0;
      else for (let k = 1; k <= gap; k++) out.push([prev[0] + k * MIN, prev[4], prev[4], prev[4], prev[4], 0, 0, 0]);
    }
    out.push(c);
  }
  return out;
}

export function computeSeries(cs) {
  const n = cs.length;
  const t = new Float64Array(n), c = new Float64Array(n), hi = new Float64Array(n), lo = new Float64Array(n);
  const v = new Float64Array(n), nt = new Float64Array(n), tb = new Float64Array(n), r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = cs[i];
    t[i] = x[0]; c[i] = x[4]; hi[i] = x[2]; lo[i] = x[3]; v[i] = x[5]; nt[i] = x[6]; tb[i] = x[7];
    if (i) r[i] = Math.log(c[i] / c[i - 1]);
  }
  const pre = a => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i++) p[i + 1] = p[i] + a[i]; return p; };
  const r2 = r.map(x => x * x);
  const pr = pre(r), pr2 = pre(r2), pv = pre(v), pn = pre(nt), ptb = pre(tb);
  const sig = new Float64Array(n);
  for (let i = WARM; i < n; i++) {
    const m = (pr[i + 1] - pr[i - 59]) / 60;
    sig[i] = Math.sqrt(Math.max((pr2[i + 1] - pr2[i - 59]) / 60 - m * m, 0));
  }
  const rsi = new Float64Array(n).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i < n; i++) {
    const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= 14) { ag += g / 14; al += l / 14; if (i === 14) rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return { n, t, c, hi, lo, v, nt, tb, r, pr, pr2, pv, pn, ptb, sig, ema20: ema(c, 20), ema60: ema(c, 60), rsi };
}

// Ознаки в точці i (лише на основі цін і обсягу до i включно)
export function featureAt(S, i) {
  if (i < WARM) return null;
  const sg = Math.max(S.sig[i], 1e-5), c = S.c, f = new Float64Array(D);
  const ks = [1, 3, 5, 10, 15, 30, 60];
  for (let j = 0; j < 7; j++) f[j] = clip(Math.log(c[i] / c[i - ks[j]]) / (sg * Math.sqrt(ks[j])));
  f[7] = (S.rsi[i] - 50) / 25;
  f[8] = clip(Math.log(c[i] / S.ema20[i]) / (sg * Math.sqrt(10)));
  f[9] = clip(Math.log(c[i] / S.ema60[i]) / (sg * Math.sqrt(30)));
  const v5 = (S.pv[i + 1] - S.pv[i - 4]) / 5, v60 = (S.pv[i + 1] - S.pv[i - 59]) / 60;
  f[10] = clip(Math.log((v5 + 1e-9) / (v60 + 1e-9)), 3);
  let mx = -Infinity, mn = Infinity;
  for (let k = i - 4; k <= i; k++) { if (S.hi[k] > mx) mx = S.hi[k]; if (S.lo[k] < mn) mn = S.lo[k]; }
  f[11] = clip(((mx - mn) / c[i]) / (sg * Math.sqrt(5)), 8);
  return f;
}
export const labelAt = (S, i, h) => (i + h >= S.n ? -1 : S.c[i + h] > S.c[i] ? 1 : S.c[i + h] < S.c[i] ? 0 : -1);

// Матриця ознак для всіх i (NaN, де ознак немає)
export function featureMatrix(S) {
  const X = new Float64Array(S.n * D).fill(NaN);
  for (let i = WARM; i < S.n; i++) X.set(featureAt(S, i), i * D);
  return X;
}

// ---------- модель: регуляризована логістична регресія ----------
export function fitLR(X, idx, ys, { iters = 150, lr = 0.4, l2 = 0.05, init = null } = {}) {
  const n = idx.length, d = D;
  const mu = new Float64Array(d), sd = new Float64Array(d);
  for (let k = 0; k < n; k++) { const o = idx[k] * d; for (let j = 0; j < d; j++) mu[j] += X[o + j]; }
  for (let j = 0; j < d; j++) mu[j] /= n;
  for (let k = 0; k < n; k++) { const o = idx[k] * d; for (let j = 0; j < d; j++) { const x = X[o + j] - mu[j]; sd[j] += x * x; } }
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / n) || 1;
  const Z = new Float64Array(n * d);
  for (let k = 0; k < n; k++) { const o = idx[k] * d; for (let j = 0; j < d; j++) Z[k * d + j] = (X[o + j] - mu[j]) / sd[j]; }
  const w = new Float64Array(d), g = new Float64Array(d);
  let b = 0;
  if (init) { for (let j = 0; j < d; j++) w[j] = init.w[j] * init.sd[j] / sd[j]; b = init.b; }
  for (let it = 0; it < iters; it++) {
    g.fill(0); let gb = 0;
    for (let k = 0; k < n; k++) {
      let z = b; const o = k * d;
      for (let j = 0; j < d; j++) z += w[j] * Z[o + j];
      const e = 1 / (1 + Math.exp(-z)) - ys[k];
      gb += e;
      for (let j = 0; j < d; j++) g[j] += e * Z[o + j];
    }
    b -= lr * gb / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
  }
  return { mu: Array.from(mu), sd: Array.from(sd), w: Array.from(w), b };
}
export function predictLR(m, f) {
  let z = m.b;
  for (let j = 0; j < D; j++) z += m.w[j] * (f[j] - m.mu[j]) / m.sd[j];
  return 1 / (1 + Math.exp(-z));
}

// ---------- статистика ----------
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
// Ставки не частіше, ніж раз на h хвилин: результати незалежні. Повертає індекси в масиві прогнозів.
export function thin(idx, picks, h) {
  const out = []; let prev = -1e12;
  for (const k of picks) if (idx[k] - prev >= h) { out.push(k); prev = idx[k]; }
  return out;
}

// ---------- перевірка «наперед» ----------
// Модель перевчається кожні `step` хвилин лише на тому, що було відомо на момент start (мітка i+h <= start).
export function walkForward(S, X, h, { startFrac = 0.25, step = 4320, stride = 3, fit = {} } = {}) {
  const last = S.n - 1 - h;
  const first = WARM + Math.floor((last - WARM) * startFrac);
  const ps = [], ys = [], idxOut = [];
  let prevModel = null;
  for (let start = first; start <= last; start += step) {
    const end = Math.min(start + step - 1, last);
    const tr = [], yy = [];
    for (let i = WARM; i + h <= start; i += stride) { const y = labelAt(S, i, h); if (y < 0) continue; tr.push(i); yy.push(y); }
    if (tr.length < 2000) continue;
    const m = fitLR(X, tr, yy, { ...fit, ...(prevModel ? { init: prevModel, iters: 60 } : {}) });
    prevModel = m;
    for (let i = start; i <= end; i++) {
      const y = labelAt(S, i, h); if (y < 0) continue;
      ps.push(predictLR(m, X.subarray(i * D, i * D + D))); ys.push(y); idxOut.push(i);
    }
  }
  return { ps, ys, idx: idxOut };
}

// Вибір порога впевненості τ на «валідації», фінальна перевірка на «holdout»
export const TAUS = [0, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08];
export function betsAt(wf, h, tau, lo = 0, hi = wf.ps.length) {
  const picks = [];
  for (let k = lo; k < hi; k++) if (Math.abs(wf.ps[k] - 0.5) >= tau) picks.push(k);
  const bets = thin(wf.idx, picks, h);
  let hit = 0, ups = 0;
  for (const k of bets) { if ((wf.ps[k] >= 0.5) === (wf.ys[k] === 1)) hit++; if (wf.ys[k] === 1) ups++; }
  return { n: bets.length, hit, acc: bets.length ? hit / bets.length : NaN, ups, base: bets.length ? ups / bets.length : NaN };
}
export function selectAndTest(wf, h, { valFrac = 0.6, zSel = 1.28, minBets = 60 } = {}) {
  const cut = Math.floor(wf.ps.length * valFrac);
  let best = null;
  for (const tau of TAUS) {
    const v = betsAt(wf, h, tau, 0, cut);
    if (v.n < minBets) continue;
    const lower = wilson(v.hit, v.n, zSel)[0];
    if (!best || lower > best.lower) best = { tau, lower, val: v };
  }
  if (!best) return null;
  const test = betsAt(wf, h, best.tau, cut, wf.ps.length);
  return { tau: best.tau, val: best.val, test };
}

// ===================== РУНТАЙМ: навчання, монітор 24/7, журнал, Telegram =====================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV = process.env;
const numEnv = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

export const CFG = {
  assets: [{ id: 'BTC', sym: 'BTCUSDT' }, { id: 'ETH', sym: 'ETHUSDT' }],
  horizons: [5, 15],
  historyDays: numEnv(ENV.HISTORY_DAYS, 120),     // скільки історії для навчання й перевірки
  gateLb: numEnv(ENV.GATE_LB, 0.52),              // потік вмикається, якщо нижня межа (99%) влучності на holdout вища за це
  minBets: numEnv(ENV.MIN_BETS, 200),             // мінімум незалежних ставок на holdout
  payout: numEnv(ENV.PAYOUT, 1.9),                // лише для оцінки результату у звітах, сигнали від нього не залежать
  maxPerHour: numEnv(ENV.MAX_PER_HOUR, 6),        // не більше стількох надісланих сигналів за годину
  maxMinutes: numEnv(ENV.MAX_MINUTES, 345),       // скільки хвилин працює один запуск монітора (ліміт GitHub — 360)
  notifyResults: ENV.NOTIFY_RESULTS !== '0',
  binance: ENV.BINANCE_BASE ? [ENV.BINANCE_BASE] : ['https://data-api.binance.vision', 'https://api-gcp.binance.com', 'https://api.binance.com'],
  tgBase: ENV.TELEGRAM_API_BASE || 'https://api.telegram.org',
  ghBase: ENV.GITHUB_API_BASE || 'https://api.github.com',
  dataBranch: 'data',
  dir: ENV.STATE_DIR || '.',
  tauOverride: ENV.TAU_OVERRIDE !== undefined && ENV.TAU_OVERRIDE !== '' ? numEnv(ENV.TAU_OVERRIDE, null) : null, // лише для тестів
  forceEnable: ENV.FORCE_ENABLE === '1',                                                                        // лише для тестів
};
export const STREAMS = CFG.assets.flatMap(a => CFG.horizons.map(h => ({ key: a.id + h, asset: a.id, sym: a.sym, h })));
export const GATE_Z = 2.326;      // 99% (одностороння) нижня межа
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- форматування (час за Києвом) ----------
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const money = x => '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tKyiv = ms => new Date(ms).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
const dtKyiv = ms => new Date(ms).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const label = s => `${s.asset} · ${s.h} хв`;
const streamOf = key => STREAMS.find(s => s.key === key);

// ---------- мережа ----------
export async function http(url, opts = {}, tries = 3) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 15000) });
      if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) { last = e; if (a < tries - 1) await sleep(600 * (a + 1)); }
  }
  throw last;
}
let binanceIdx = 0; // запам'ятовуємо дзеркало, яке працює
export async function klines(sym, end, limit) {
  let last;
  for (let k = 0; k < CFG.binance.length; k++) {
    const base = CFG.binance[(binanceIdx + k) % CFG.binance.length];
    try {
      const r = await http(`${base}/api/v3/klines?symbol=${sym}&interval=1m&limit=${limit}${end ? `&endTime=${end}` : ''}`, {}, 2);
      if (!r.ok) throw new Error('Binance HTTP ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error('Binance: незвичний формат');
      binanceIdx = (binanceIdx + k) % CFG.binance.length;
      return j.map(x => [x[0], +x[1], +x[2], +x[3], +x[4], +x[5], +x[8], +x[9]]);
    } catch (e) { last = e; }
  }
  throw last;
}
export async function fetchHistory(sym, days, endMs = Date.now()) {
  const PAGE = 1000, last = Math.floor(endMs / MIN) * MIN - MIN;
  const pages = Math.ceil(days * 1440 / PAGE);
  const ends = Array.from({ length: pages }, (_, k) => last - k * PAGE * MIN);
  const out = new Array(pages);
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => { while (next < pages) { const k = next++; out[k] = await klines(sym, ends[k], PAGE); } }));
  const m = new Map();
  for (const rows of out) for (const r of rows) m.set(r[0], r);
  return fillGaps([...m.values()].sort((a, b) => a[0] - b[0]));
}
// Останні закриті свічки (без поточної, ще не завершеної)
export async function fetchRecent(sym, nowMs = Date.now()) {
  const rows = await klines(sym, undefined, 200);
  return rows.filter(c => c[0] + MIN <= nowMs);
}

// ---------- сховище стану: файл локально або гілка `data` у GitHub ----------
export class Store {
  constructor(dir = CFG.dir) {
    this.dir = dir; this.sha = {}; this.branchOk = false;
    this.gh = ENV.GITHUB_TOKEN && ENV.GITHUB_REPOSITORY ? { repo: ENV.GITHUB_REPOSITORY, token: ENV.GITHUB_TOKEN } : null;
  }
  headers() { return { authorization: `Bearer ${this.gh.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'odds-bot', 'content-type': 'application/json' }; }
  async read(name) {
    if (!this.gh) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch (_) { return null; } }
    const r = await http(`${CFG.ghBase}/repos/${this.gh.repo}/contents/${name}?ref=${CFG.dataBranch}`, { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub читання ' + name + ': ' + r.status);
    const j = await r.json();
    this.sha[name] = j.sha;
    return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  }
  async ensureBranch() {
    if (this.branchOk) return;
    const base = `${CFG.ghBase}/repos/${this.gh.repo}`, h = this.headers();
    const b = await http(`${base}/branches/${CFG.dataBranch}`, { headers: h });
    if (b.ok) { this.branchOk = true; return; }
    if (b.status !== 404) throw new Error('GitHub гілка: ' + b.status);
    const info = await (await http(base, { headers: h })).json();
    const ref = await (await http(`${base}/git/ref/heads/${info.default_branch}`, { headers: h })).json();
    const c = await http(`${base}/git/refs`, { method: 'POST', headers: h, body: JSON.stringify({ ref: `refs/heads/${CFG.dataBranch}`, sha: ref.object.sha }) });
    if (!c.ok && c.status !== 422) throw new Error('GitHub створення гілки: ' + c.status);
    this.branchOk = true;
  }
  async write(name, obj, message = 'update') {
    const text = JSON.stringify(obj);
    if (!this.gh) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(path.join(this.dir, name), text); return; }
    await this.ensureBranch();
    const url = `${CFG.ghBase}/repos/${this.gh.repo}/contents/${name}`;
    for (let a = 0; a < 4; a++) {
      const body = { message, content: Buffer.from(text).toString('base64'), branch: CFG.dataBranch, ...(this.sha[name] ? { sha: this.sha[name] } : {}) };
      const r = await http(url, { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
      if (r.ok) { this.sha[name] = (await r.json()).content.sha; return; }
      if (r.status === 409 || r.status === 422) { // застарілий або відсутній sha
        const g = await http(`${url}?ref=${CFG.dataBranch}`, { headers: this.headers() });
        if (g.ok) this.sha[name] = (await g.json()).sha; else delete this.sha[name];
        continue;
      }
      throw new Error('GitHub запис ' + name + ': ' + r.status);
    }
    throw new Error('GitHub запис ' + name + ': конфлікт версій');
  }
}

// ---------- Telegram ----------
export async function sendTG(text) {
  const token = ENV.TELEGRAM_BOT_TOKEN, chat = ENV.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log('[Telegram не налаштовано]', text.replace(/\n/g, ' | ')); return false; }
  try {
    const r = await http(`${CFG.tgBase}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
    if (!r.ok) log('Telegram HTTP', r.status);
    return r.ok;
  } catch (e) { log('Telegram помилка:', e.message); return false; }
}

// ---------- навчання і перевірка ----------
export function trainStream(S, X, h, now = Date.now(), prevEnabled = false) {
  const wf = walkForward(S, X, h);
  const N = wf.ps.length;
  if (N < 20000) return { h, enabled: false, reason: 'замало історії для перевірки' };
  const all = betsAt(wf, h, 0);
  const sel = selectAndTest(wf, h);
  if (!sel) return { h, enabled: false, reason: 'не вдалося підібрати поріг впевненості' };
  const lb99 = wilson(sel.test.hit, sel.test.n, GATE_Z)[0];
  const maj = Math.max(sel.test.base, 1 - sel.test.base);
  // остаточна модель: усі розмічені дані
  const tr = [], yy = [], last = S.n - 1 - h;
  for (let i = WARM; i <= last; i += 2) { const y = labelAt(S, i, h); if (y < 0) continue; tr.push(i); yy.push(y); }
  const model = fitLR(X, tr, yy);
  let reason = '';
  if (sel.test.n < CFG.minBets) reason = `замало ставок на перевірці (${sel.test.n} < ${CFG.minBets})`;
  else if (lb99 <= (prevEnabled ? CFG.gateLb - 0.01 : CFG.gateLb)) reason = `нижня межа ${pct(lb99)} не вища за ${pct(prevEnabled ? CFG.gateLb - 0.01 : CFG.gateLb, 0)}`;
  else if (sel.test.acc <= maj + 0.01) reason = 'не краща за просте «завжди в бік тренду»';
  const ci = wilson(all.hit, all.n);
  return {
    h, model, tau: sel.tau, enabled: reason === '', reason,
    val: { n: sel.val.n, acc: sel.val.acc },
    test: { n: sel.test.n, hit: sel.test.hit, acc: sel.test.acc, base: sel.test.base, lb99 },
    oos: { n: all.n, acc: all.acc, lo: ci[0], hi: ci[1], days: Math.round(N / 1440) },
  };
}
export function trainAll(hist, now = Date.now(), prev = null) {
  const streams = {};
  for (const a of CFG.assets) {
    const S = computeSeries(hist[a.id]), X = featureMatrix(S);
    for (const h of CFG.horizons) {
      log(`навчання ${a.id} ${h} хв…`);
      streams[a.id + h] = { asset: a.id, ...trainStream(S, X, h, now, !!(prev && prev.streams && prev.streams[a.id + h] && prev.streams[a.id + h].enabled)) };
    }
  }
  const any = hist[CFG.assets[0].id];
  return { version: 1, trained: now, historyDays: CFG.historyDays, range: { from: any[0][0], to: any[any.length - 1][0] }, gate: { lb: CFG.gateLb, z: GATE_Z, minBets: CFG.minBets }, streams };
}

// ---------- повідомлення ----------
function signalText(e, sm) {
  const s = streamOf(e.key), up = e.dir === 'up';
  const minPay = 1 / sm.test.lb99;
  return [
    `🔔 СИГНАЛ · ${label(s)}`,
    `Напрямок: ${up ? '↑ ВГОРУ' : '↓ ВНИЗ'}`,
    `Ціна зараз: ${money(e.p0)} (Binance, ${tKyiv(e.t0)})`,
    `Експірація: ${tKyiv(e.t0 + e.h * MIN)} (Київ)`,
    `Впевненість моделі: ${pct(up ? e.pUp : 1 - e.pUp)}`,
    '',
    `Перевірка наперед (${sm.oos.days} днів, без підглядання): при такій впевненості влучність ${pct(sm.test.acc)}, нижня межа ${pct(sm.test.lb99)} (n=${sm.test.n}).`,
    `Має сенс, лише якщо виплата Odds ≥ ${minPay.toFixed(2)}×. Менша виплата: пропусти.`,
    '',
    'Це ймовірнісний сигнал, а не гарантія. Став лише те, що готовий втратити.',
  ].join('\n');
}
function resultText(e) {
  const s = streamOf(e.key), ic = e.status === 'win' ? '✅ вгадано' : e.status === 'loss' ? '❌ не вгадано' : '➖ без зміни';
  return `${ic} · ${label(s)} ${e.dir === 'up' ? '↑' : '↓'}\n${money(e.p0)} → ${money(e.p1)}`;
}
export function summaryText(model, live, now = Date.now()) {
  const L = [`📊 Щоденний звіт · ${dtKyiv(now)} (Київ)`, ''];
  L.push(`Моніторинг: ${live.heartbeat ? `працює, останнє оновлення ${tKyiv(live.heartbeat)}` : 'ще не запускався'}`);
  L.push(`Моделі навчені ${dtKyiv(model.trained)} на ${model.historyDays} днях. Перевірка наперед, ставки не частіше, ніж раз на горизонт:`);
  for (const s of STREAMS) {
    const m = model.streams[s.key];
    if (!m) continue;
    if (m.enabled) L.push(`• ${label(s)}: ✅ увімкнено. На перевірці ${pct(m.test.acc)} (n=${m.test.n}), нижня межа ${pct(m.test.lb99)}, поріг впевненості ${pct(m.tau, 0)}.`);
    else L.push(`• ${label(s)}: ⛔ вимкнено, ${m.reason}.`);
  }
  L.push('', 'Живий журнал (рахуються всі кандидати, навіть від вимкнених потоків):');
  let sent = 0, sentWins = 0, sentN = 0;
  for (const s of STREAMS) {
    const st = live.stats[s.key];
    if (!st || !st.n) { L.push(`• ${label(s)}: ще немає перевірених`); continue; }
    const ci = wilson(st.wins, st.n);
    L.push(`• ${label(s)}: ${st.wins} з ${st.n} (${pct(st.wins / st.n)}, інтервал ${pct(ci[0], 0)}–${pct(ci[1], 0)})`);
    sentN += st.sent; sentWins += st.sentWins;
  }
  const dayAgo = now - 24 * 3600e3;
  const day = live.journal.filter(e => e.sent && e.t0 > dayAgo);
  const dayRes = day.filter(e => e.status === 'win' || e.status === 'loss');
  const dayWins = dayRes.filter(e => e.status === 'win').length;
  L.push('', `За добу надіслано сигналів: ${day.length}${dayRes.length ? `, з перевірених ${dayRes.length} вгадано ${dayWins}` : ''}.`);
  if (sentN) L.push(`Усього надісланих і перевірених: ${sentWins} з ${sentN}. Оцінка при виплаті ${CFG.payout}×: ${((sentWins * (CFG.payout - 1) - (sentN - sentWins))).toFixed(1)} ставок (довідково).`);
  if (!STREAMS.some(s => model.streams[s.key] && model.streams[s.key].enabled)) L.push('', 'Зараз жоден потік не має доведеної переваги, тому сигналів немає. Це нормально: бот мовчить, коли переваги нема.');
  L.push('', 'Ймовірнісний аналіз, жодної гарантії результату.');
  return L.join('\n');
}
function trainText(model, prev) {
  const L = ['🧠 Моделі оновлено: змінився набір увімкнених потоків', ''];
  for (const s of STREAMS) {
    const m = model.streams[s.key], p = prev && prev.streams && prev.streams[s.key];
    if (!m) continue;
    const was = p ? (p.enabled ? 'увімкнено' : 'вимкнено') : 'новий';
    L.push(`• ${label(s)}: було ${was}, тепер ${m.enabled ? '✅ увімкнено' : '⛔ вимкнено'}${m.enabled ? ` (нижня межа ${pct(m.test.lb99)}, n=${m.test.n})` : ` (${m.reason})`}`);
  }
  return L.join('\n');
}

// ---------- рушій сигналів (той самий код працює наживо і в replay) ----------
export const newLive = () => ({ version: 1, journal: [], last: {}, stats: {}, heartbeat: 0, started: 0, lastSummaryDay: '' });
export class Engine {
  constructor(model, live, send) { this.model = model; this.live = live; this.send = send; this.dirty = false; }
  liveBlocked(key) {
    const res = this.live.journal.filter(e => e.key === key && (e.status === 'win' || e.status === 'loss')).slice(-150);
    if (res.length < 150) return false;
    const w = res.filter(e => e.status === 'win').length;
    return wilson(w, res.length)[1] < 0.52;      // живі результати вже не підтримують перевагу
  }
  sentLastHour(now) { return this.live.journal.filter(e => e.sent && e.t0 > now - 3600e3).length; }
  async resolve(S) {
    for (const e of this.live.journal) {
      if (e.status !== 'pending') continue;
      const A = S[e.asset];
      if (!A) continue;
      const nowA = A.t[A.n - 1] + MIN, expiry = e.t0 + e.h * MIN;
      if (nowA < expiry) continue;
      let j = -1;
      for (let k = A.n - 1; k >= Math.max(0, A.n - 400); k--) if (A.t[k] === expiry - MIN) { j = k; break; } // свічка, що закривається в момент експірації
      if (j < 0) { if (nowA - expiry > 3 * 3600e3) { e.status = 'void'; this.dirty = true; } continue; }
      e.p1 = A.c[j];
      e.status = e.p1 === e.p0 ? 'tie' : ((e.p1 > e.p0) === (e.dir === 'up') ? 'win' : 'loss');
      if (e.status !== 'tie') {
        const st = (this.live.stats[e.key] = this.live.stats[e.key] || { n: 0, wins: 0, sent: 0, sentWins: 0 });
        st.n++; if (e.status === 'win') st.wins++;
        if (e.sent) { st.sent++; if (e.status === 'win') st.sentWins++; }
      }
      if (e.sent && CFG.notifyResults) await this.send(resultText(e));
      this.dirty = true;
    }
  }
  // S: { BTC, ETH } — серії, остання свічка кожної щойно закрилась
  async onMinute(S) {
    await this.resolve(S);
    for (const st of STREAMS) {
      const sm = this.model.streams[st.key], A = S[st.asset];
      if (!sm || !sm.model || !A) continue;
      const i = A.n - 1, now = A.t[i] + MIN;
      const p = predictLR(sm.model, featureAt(A, i));
      const tau = CFG.tauOverride !== null ? CFG.tauOverride : sm.tau;
      if (Math.abs(p - 0.5) < tau) continue;
      if (now - (this.live.last[st.key] || 0) < st.h * MIN) continue;   // не частіше, ніж раз на горизонт: результати незалежні
      this.live.last[st.key] = now;
      const enabled = CFG.forceEnable || sm.enabled, blocked = this.liveBlocked(st.key);
      const e = { id: `${st.key}-${now}`, key: st.key, asset: st.asset, h: st.h, t0: now, p0: A.c[i], pUp: +p.toFixed(4), dir: p >= 0.5 ? 'up' : 'down', enabled, blocked, sent: false, status: 'pending' };
      if (enabled && !blocked && this.sentLastHour(now) < CFG.maxPerHour) { e.sent = true; await this.send(signalText(e, sm)); }
      this.live.journal.push(e);
      this.dirty = true;
    }
    if (this.live.journal.length > 1200) this.live.journal = this.live.journal.slice(-1200);
  }
}

// ---------- монітор 24/7 ----------
async function fetchAllRecent(expectedT) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();
    const rows = await Promise.all(CFG.assets.map(a => fetchRecent(a.sym, now)));
    if (rows.every(r => r.length > 100 && r[r.length - 1][0] === expectedT)) {
      const S = {};
      CFG.assets.forEach((a, k) => { S[a.id] = computeSeries(fillGaps(rows[k])); });
      return S;
    }
    await sleep(2000);
  }
  return null;
}
export async function monitor() {
  const store = new Store();
  let model = await store.read('model.json');
  if (!model) { log('Немає model.json. Спершу запусти навчання: node bot.mjs train'); process.exitCode = 1; return; }
  const live = (await store.read('live.json')) || newLive();
  const engine = new Engine(model, live, sendTG);
  const t0 = Date.now(), deadline = t0 + CFG.maxMinutes * MIN;
  if (!live.heartbeat) await sendTG(`✅ Моніторинг запущено. Стежу за BTC і ETH щохвилини; сигнал надішлю, коли модель матиме доведену перевагу.\nУвімкнені потоки: ${STREAMS.filter(s => model.streams[s.key] && model.streams[s.key].enabled).map(label).join(', ') || 'жодного (переваги поки немає)'}.`);
  else if (t0 - live.heartbeat > 15 * MIN) await sendTG(`⚠️ Була перерва в моніторингу ≈ ${Math.round((t0 - live.heartbeat) / MIN)} хв (перезапуск сервера). Сигнали за цей час пропущено.`);
  live.started = t0;
  let lastSave = 0, lastModel = t0, lastT = 0, failSince = 0, alerted = false;
  log(`монітор запущено на ${CFG.maxMinutes} хв`);
  while (Date.now() < deadline) {
    const next = Math.floor(Date.now() / MIN) * MIN + MIN + 2500;       // 2.5 с після початку хвилини
    await sleep(Math.max(0, Math.min(next, deadline) - Date.now()));
    if (Date.now() >= deadline) break;
    const expectedT = Math.floor(Date.now() / MIN) * MIN - MIN;          // початок хвилини, що щойно закрилась
    try {
      const S = await fetchAllRecent(expectedT);
      if (S && expectedT > lastT) { lastT = expectedT; await engine.onMinute(S); }
      if (S) { failSince = 0; if (alerted) { alerted = false; await sendTG('✅ Дані Binance знову надходять.'); } }
      else if (!failSince) failSince = Date.now();
    } catch (e) { log('помилка тіку:', e.message); if (!failSince) failSince = Date.now(); }
    if (failSince && !alerted && Date.now() - failSince > 10 * MIN) { alerted = true; await sendTG('⚠️ Понад 10 хв немає даних Binance. Сигналів поки не буде.'); }
    // щоденний звіт після 07:00 UTC
    const day = new Date().toISOString().slice(0, 10);
    if (new Date().getUTCHours() >= 7 && live.lastSummaryDay !== day) { live.lastSummaryDay = day; live.heartbeat = Date.now(); engine.dirty = true; await sendTG(summaryText(model, live)); }
    // свіжа модель (щодобове навчання)
    if (Date.now() - lastModel > 60 * MIN) {
      lastModel = Date.now();
      try { const m = await store.read('model.json'); if (m && m.trained > model.trained) { model = m; engine.model = m; log('підхопив нову модель'); } } catch (e) { log('модель не оновлено:', e.message); }
    }
    if (engine.dirty || Date.now() - lastSave > 30 * MIN) {
      live.heartbeat = Date.now();
      try { await store.write('live.json', live, 'live'); engine.dirty = false; lastSave = Date.now(); } catch (e) { log('не вдалося зберегти стан:', e.message); }
    }
  }
  live.heartbeat = Date.now();
  try { await store.write('live.json', live, 'live'); } catch (e) { log('не вдалося зберегти стан:', e.message); }
  log('монітор завершив цикл');
}

// ---------- CLI ----------
export async function trainCmd() {
  const store = new Store();
  const prev = await store.read('model.json').catch(() => null);
  const hist = {};
  for (const a of CFG.assets) { log(`завантажую ${CFG.historyDays} днів ${a.sym}…`); hist[a.id] = await fetchHistory(a.sym, CFG.historyDays); log(`${a.id}: ${hist[a.id].length} свічок`); }
  const model = trainAll(hist, Date.now(), prev);
  await store.write('model.json', model, 'model');
  for (const s of STREAMS) { const m = model.streams[s.key]; log(`${s.key}: ${m.enabled ? 'УВІМКНЕНО' : 'вимкнено'} ${m.enabled ? `τ=${m.tau} holdout ${pct(m.test.acc)} n=${m.test.n} lb99 ${pct(m.test.lb99)}` : '(' + m.reason + ')'}`); }
  const changed = !prev || STREAMS.some(s => !!(prev.streams && prev.streams[s.key] && prev.streams[s.key].enabled) !== !!model.streams[s.key].enabled);
  if (changed) await sendTG(trainText(model, prev));
}
export async function summaryCmd() {
  const store = new Store();
  const model = await store.read('model.json'), live = (await store.read('live.json')) || newLive();
  if (!model) { log('Немає model.json'); return; }
  await sendTG(summaryText(model, live));
}
// Прогін живого конвеєра по історії: навчання до `days` останніх днів, потім хвилина за хвилиною
export async function replayCmd(days = 3, dir = '.') {
  const hist = {};
  for (const a of CFG.assets) hist[a.id] = fillGaps(JSON.parse(fs.readFileSync(path.join(dir, `${a.sym}_1m.json`), 'utf8')));
  const n = Math.min(...CFG.assets.map(a => hist[a.id].length)), cut = n - days * 1440;
  const trainHist = {};
  for (const a of CFG.assets) trainHist[a.id] = hist[a.id].slice(0, cut);
  const model = trainAll(trainHist);
  const sent = [], live = newLive(), engine = new Engine(model, live, async t => { sent.push(t); });
  for (let i = cut; i < n; i++) {
    const S = {};
    for (const a of CFG.assets) S[a.id] = computeSeries(hist[a.id].slice(i - 199, i + 1));
    await engine.onMinute(S);
  }
  const res = {};
  for (const s of STREAMS) {
    const all = live.journal.filter(e => e.key === s.key && (e.status === 'win' || e.status === 'loss'));
    const w = all.filter(e => e.status === 'win').length;
    const snt = all.filter(e => e.sent), ws = snt.filter(e => e.status === 'win').length;
    res[s.key] = { enabled: model.streams[s.key].enabled, tau: model.streams[s.key].tau, candidates: all.length, wins: w, acc: all.length ? w / all.length : NaN, ci: wilson(w, all.length), sent: snt.length, sentWins: ws, sentAcc: snt.length ? ws / snt.length : NaN };
  }
  return { model, live, sent, res, days };
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const cmd = process.argv[2];
  const run = { train: trainCmd, monitor, summary: summaryCmd }[cmd];
  if (!run) { console.log('Використання: node bot.mjs train | monitor | summary'); process.exit(1); }
  run().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('Помилка:', e); process.exit(1); });
}
