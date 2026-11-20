// ===================== BYBIT USDT-PERP: ЯДРО =====================
// Індикатори, стратегії, ризик-менеджер і бектестер. Чиста логіка без мережі:
// однаково працює в бектесті, у тестах і в живому боті (той самий код сигналів і ризику).
//
// Принципи, щоб не злити депозит:
//  • розмір позиції рахується від стопа: збиток по стопу = заданий % капіталу (з комісіями й сліпеджем);
//  • плече обмежене профілем і жорсткою межею HARD; ліквідація завжди щонайменше вдвічі далі за стоп;
//  • денний ліміт втрат, пауза після серії збитків, kill-switch за просіданням від піку;
//  • сигнал на закритті свічки, виконання на відкритті наступної (жодного заглядання в майбутнє).

export const FEES = { taker: 0.00055, maker: 0.0002 }; // Bybit VIP 0, USDT-perp
export const MMR = 0.005;                              // підтримувальна маржа (BTC/ETH/SOL ≈ 0,5% на малих позиціях)
export const MIN_STOP = 0.001;                         // стоп ближче 0,1% — це шум, не торгуємо

// Профілі ризику. HARD — межі, які не можна перевищити жодними налаштуваннями.
export const PROFILES = {
  safe:       { riskPct: 0.005, maxLev: 2, dailyLossPct: 0.02, maxDdPct: 0.10, maxOpen: 1, maxLossStreak: 3, pauseHours: 24, gridLossPct: 0.04 },
  normal:     { riskPct: 0.01,  maxLev: 3, dailyLossPct: 0.03, maxDdPct: 0.15, maxOpen: 2, maxLossStreak: 4, pauseHours: 12, gridLossPct: 0.07 },
  aggressive: { riskPct: 0.02,  maxLev: 5, dailyLossPct: 0.06, maxDdPct: 0.25, maxOpen: 3, maxLossStreak: 5, pauseHours: 6,  gridLossPct: 0.12 },
};
export const HARD = { maxLev: 10, riskPct: 0.03, maxDdPct: 0.35, dailyLossPct: 0.10, gridLossPct: 0.20 };

export function profileOf(name = 'normal', over = {}) {
  const base = PROFILES[name];
  if (!base) throw new Error(`Невідомий профіль ${name}: safe | normal | aggressive`);
  const p = { name, ...base };
  for (const [k, v] of Object.entries(over)) if (v !== undefined && v !== null && v !== '' && Number.isFinite(+v)) p[k] = +v;
  p.maxLev = Math.max(1, Math.min(p.maxLev, HARD.maxLev));
  p.riskPct = Math.min(p.riskPct, HARD.riskPct);
  p.maxDdPct = Math.min(p.maxDdPct, HARD.maxDdPct);
  p.dailyLossPct = Math.min(p.dailyLossPct, HARD.dailyLossPct);
  p.gridLossPct = Math.min(p.gridLossPct, HARD.gridLossPct);
  return p;
}

// Специфікації контрактів Bybit (живий бот бере актуальні з API instruments-info)
export const SPECS = {
  BTCUSDT: { qtyStep: 0.001, minQty: 0.001, minNotional: 5, tickSize: 0.1 },
  ETHUSDT: { qtyStep: 0.01, minQty: 0.01, minNotional: 5, tickSize: 0.01 },
  SOLUSDT: { qtyStep: 0.1, minQty: 0.1, minNotional: 5, tickSize: 0.01 },
};
export const specOf = sym => SPECS[sym] || { qtyStep: 0.001, minQty: 0.001, minNotional: 5, tickSize: 0.0001 };

export const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
const H8 = 8 * 36e5;
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const dec = step => { const s = String(step); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length; };
export const floorStep = (x, step) => +(Math.floor(x / step + 1e-9) * step).toFixed(dec(step));
export const roundTick = (x, tick) => +(Math.round(x / tick) * tick).toFixed(dec(tick));

// ---------- свічки й індикатори ----------
// rows: [t, o, h, l, c, v]
export function toSeries(rows) {
  const n = rows.length, f = () => new Float64Array(n);
  const S = { n, t: f(), o: f(), h: f(), l: f(), c: f(), v: f() };
  rows.forEach((r, i) => { S.t[i] = r[0]; S.o[i] = r[1]; S.h[i] = r[2]; S.l[i] = r[3]; S.c[i] = r[4]; S.v[i] = r[5]; });
  return S;
}
export function slice(S, from, to) {
  const out = { n: to - from };
  for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) out[k] = S[k].subarray(from, to);
  return out;
}
export function ema(a, p) {
  const o = new Float64Array(a.length), k = 2 / (p + 1);
  o[0] = a[0];
  for (let i = 1; i < a.length; i++) o[i] = k * a[i] + (1 - k) * o[i - 1];
  return o;
}
export function sma(a, p) {
  const o = new Float64Array(a.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p; }
  return o;
}
export function stdev(a, p) {
  const o = new Float64Array(a.length).fill(NaN);
  let s = 0, q = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i]; q += a[i] * a[i];
    if (i >= p) { s -= a[i - p]; q -= a[i - p] * a[i - p]; }
    if (i >= p - 1) { const m = s / p; o[i] = Math.sqrt(Math.max(0, q / p - m * m)); }
  }
  return o;
}
export function atr(H, L, C, p) {
  const n = C.length, o = new Float64Array(n).fill(NaN);
  let a = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    if (i <= p) { a += tr / p; if (i === p) o[i] = a; } else { a = (a * (p - 1) + tr) / p; o[i] = a; }
  }
  return o;
}
export function rsi(C, p) {
  const n = C.length, o = new Float64Array(n).fill(50);
  let g = 0, l = 0;
  for (let i = 1; i < n; i++) {
    const d = C[i] - C[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= p) { g += up / p; l += dn / p; if (i === p) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return o;
}
// максимум / мінімум попередніх p свічок (поточна НЕ входить — без заглядання вперед)
export function highest(a, p) {
  const o = new Float64Array(a.length).fill(NaN);
  for (let i = p; i < a.length; i++) { let m = -Infinity; for (let j = i - p; j < i; j++) if (a[j] > m) m = a[j]; o[i] = m; }
  return o;
}
export function lowest(a, p) {
  const o = new Float64Array(a.length).fill(NaN);
  for (let i = p; i < a.length; i++) { let m = Infinity; for (let j = i - p; j < i; j++) if (a[j] < m) m = a[j]; o[i] = m; }
  return o;
}

// ---------- стратегії ----------
// signal(i) викликається на ЗАКРИТТІ свічки i → { dir: 1|-1, stop, tp?, entry: 'market'|'limit', limit?, why }
// manage(i, pos) → { stop } (лише підтягування) | { exit: причина } | null
export const STRATEGIES = {
  // Тренд: пробій 2-денного діапазону в бік EMA200, стоп 2,5 ATR, трейлінг 3 ATR (Chandelier). Шорт теж — ринок зараз ведмежий.
  trend: (p = {}) => {
    const P = { tf: '1h', n: 48, emaP: 200, atrP: 14, stopAtr: 2.5, trailAtr: 3, ...p };
    let hh, ll, e, a;
    return {
      name: 'trend', P, tf: P.tf, warm: Math.max(P.n, P.emaP, P.atrP) + 2,
      prepare(S) { hh = highest(S.h, P.n); ll = lowest(S.l, P.n); e = ema(S.c, P.emaP); a = atr(S.h, S.l, S.c, P.atrP); },
      signal(i, S) {
        const c = S.c[i];
        if (c > hh[i] && c > e[i]) return { dir: 1, stop: c - P.stopAtr * a[i], entry: 'market', why: `пробій ${P.n}-свічкового максимуму` };
        if (c < ll[i] && c < e[i]) return { dir: -1, stop: c + P.stopAtr * a[i], entry: 'market', why: `пробій ${P.n}-свічкового мінімуму` };
        return null;
      },
      manage(i, S, pos) {
        const tr = pos.dir > 0 ? pos.ext - P.trailAtr * a[i] : pos.ext + P.trailAtr * a[i];
        return (pos.dir > 0 ? tr > pos.stop : tr < pos.stop) ? { stop: tr } : null;
      },
    };
  },
  // Імпульс: пробій 20 свічок з об'ємом ×1,5, стоп 1,5 ATR, тейк 3 ATR, тайм-стоп 8 год.
  momentum: (p = {}) => {
    const P = { tf: '15m', n: 20, volP: 20, volMult: 1.5, emaP: 100, atrP: 14, stopAtr: 1.5, tpAtr: 3, maxBars: 32, ...p };
    let hh, ll, e, a, vs;
    return {
      name: 'momentum', P, tf: P.tf, warm: Math.max(P.n, P.emaP, P.atrP, P.volP) + 2,
      prepare(S) { hh = highest(S.h, P.n); ll = lowest(S.l, P.n); e = ema(S.c, P.emaP); a = atr(S.h, S.l, S.c, P.atrP); vs = sma(S.v, P.volP); },
      signal(i, S) {
        const c = S.c[i];
        if (!(S.v[i] > P.volMult * vs[i])) return null;
        if (c > hh[i] && c > e[i]) return { dir: 1, stop: c - P.stopAtr * a[i], tp: c + P.tpAtr * a[i], entry: 'market', why: 'пробій з об\'ємом' };
        if (c < ll[i] && c < e[i]) return { dir: -1, stop: c + P.stopAtr * a[i], tp: c - P.tpAtr * a[i], entry: 'market', why: 'пробій вниз з об\'ємом' };
        return null;
      },
      manage(i, S, pos) { return i - pos.bar >= P.maxBars ? { exit: 'тайм-стоп' } : null; },
    };
  },
  // Скальп 5m: повернення до середньої після виходу за смугу Боллінджера при екстремальному RSI, лише в бік EMA200.
  scalp: (p = {}) => {
    const P = { tf: '5m', bbP: 20, bbK: 2.2, rsiP: 7, lo: 20, hi: 80, emaP: 200, atrP: 14, stopAtr: 1.2, maxBars: 12, minEdge: 0.002, ...p };
    let m, sd, r, e, a;
    return {
      name: 'scalp', P, tf: P.tf, warm: Math.max(P.bbP, P.emaP, P.atrP) + 2,
      prepare(S) { m = sma(S.c, P.bbP); sd = stdev(S.c, P.bbP); r = rsi(S.c, P.rsiP); e = ema(S.c, P.emaP); a = atr(S.h, S.l, S.c, P.atrP); },
      signal(i, S) {
        const c = S.c[i];
        if (c < m[i] - P.bbK * sd[i] && r[i] < P.lo && c > e[i] && (m[i] - c) / c > P.minEdge)
          return { dir: 1, stop: c - P.stopAtr * a[i], tp: m[i], entry: 'limit', limit: c, why: 'відкат нижче смуги' };
        if (c > m[i] + P.bbK * sd[i] && r[i] > P.hi && c < e[i] && (c - m[i]) / c > P.minEdge)
          return { dir: -1, stop: c + P.stopAtr * a[i], tp: m[i], entry: 'limit', limit: c, why: 'відскок вище смуги' };
        return null;
      },
      manage(i, S, pos) { return i - pos.bar >= P.maxBars ? { exit: 'тайм-стоп' } : null; },
    };
  },
  // Мікроскальп 1m: пробій 15 хвилин з об'ємом ×2, стоп 0,15%, тейк 0,3%. Показує, як комісії з'їдають часту торгівлю.
  scalp1m: (p = {}) => {
    const P = { tf: '1m', n: 15, volP: 30, volMult: 2, stopPct: 0.0015, tpPct: 0.003, maxBars: 15, ...p };
    let hh, ll, vs;
    return {
      name: 'scalp1m', P, tf: P.tf, warm: Math.max(P.n, P.volP) + 2,
      prepare(S) { hh = highest(S.h, P.n); ll = lowest(S.l, P.n); vs = sma(S.v, P.volP); },
      signal(i, S) {
        const c = S.c[i];
        if (!(S.v[i] > P.volMult * vs[i])) return null;
        if (c > hh[i]) return { dir: 1, stop: c * (1 - P.stopPct), tp: c * (1 + P.tpPct), entry: 'market', why: 'мікропробій' };
        if (c < ll[i]) return { dir: -1, stop: c * (1 + P.stopPct), tp: c * (1 - P.tpPct), entry: 'market', why: 'мікропробій вниз' };
        return null;
      },
      manage(i, S, pos) { return i - pos.bar >= P.maxBars ? { exit: 'тайм-стоп' } : null; },
    };
  },
};

// Стратегії для сканера по багатьох монетах (волатильні альти)
Object.assign(STRATEGIES, {
  // Проти сплеску: свічка 5m з рухом > 3 ATR і об'ємом ×3 → вхід проти руху, тейк на 50% відкату, стоп за екстремумом.
  spikeFade: (p = {}) => {
    const P = { tf: '5m', atrP: 20, k: 3, volP: 48, volMult: 3, retrace: 0.5, stopBuf: 0.3, maxBars: 12, ...p };
    let a, vs;
    return {
      name: 'spikeFade', P, tf: P.tf, warm: Math.max(P.atrP, P.volP) + 2,
      prepare(S) { a = atr(S.h, S.l, S.c, P.atrP); vs = sma(S.v, P.volP); },
      signal(i, S) {
        const c = S.c[i], prev = S.c[i - 1], mv = c - prev, A = a[i - 1];
        if (!(Math.abs(mv) > P.k * A && S.v[i] > P.volMult * vs[i - 1])) return null;
        const score = Math.abs(mv) / A;
        if (mv > 0) return { dir: -1, stop: S.h[i] + P.stopBuf * A, tp: c - P.retrace * mv, entry: 'market', why: 'сплеск угору', score };
        return { dir: 1, stop: S.l[i] - P.stopBuf * A, tp: c - P.retrace * mv, entry: 'market', why: 'сплеск униз', score };
      },
      manage(i, S, pos) { return i - pos.bar >= P.maxBars ? { exit: 'тайм-стоп' } : null; },
    };
  },
  // За пампом: +4% за годину і пробій 12 свічок з об'ємом ×3 → вхід за рухом, стоп 2 ATR, трейлінг 2,5 ATR.
  pumpRide: (p = {}) => {
    const P = { tf: '5m', look: 12, minMove: 0.04, volP: 48, volMult: 3, atrP: 20, stopAtr: 2, trailAtr: 2.5, maxBars: 36, ...p };
    let hh, ll, a, vs;
    return {
      name: 'pumpRide', P, tf: P.tf, warm: Math.max(P.look, P.volP, P.atrP) + 2,
      prepare(S) { hh = highest(S.h, P.look); ll = lowest(S.l, P.look); a = atr(S.h, S.l, S.c, P.atrP); vs = sma(S.v, P.volP); },
      signal(i, S) {
        const c = S.c[i], ch = c / S.c[i - P.look] - 1;
        if (!(S.v[i] > P.volMult * vs[i - 1])) return null;
        if (ch > P.minMove && c > hh[i]) return { dir: 1, stop: c - P.stopAtr * a[i], entry: 'market', why: `памп +${(ch * 100).toFixed(1)}% за год`, score: ch };
        if (ch < -P.minMove && c < ll[i]) return { dir: -1, stop: c + P.stopAtr * a[i], entry: 'market', why: `дамп ${(ch * 100).toFixed(1)}% за год`, score: -ch };
        return null;
      },
      manage(i, S, pos) {
        if (i - pos.bar >= P.maxBars) return { exit: 'тайм-стоп' };
        const tr = pos.dir > 0 ? pos.ext - P.trailAtr * a[i] : pos.ext + P.trailAtr * a[i];
        return (pos.dir > 0 ? tr > pos.stop : tr < pos.stop) ? { stop: tr } : null;
      },
    };
  },
});

// Специфікація для довільної монети, якщо реальної немає (бектест): крок лота ≈ до $1, мін. 5 USDT
export function genericSpec(price) {
  const step = 10 ** Math.floor(Math.log10(1 / price));
  return { qtyStep: step, minQty: step, minNotional: 5, tickSize: 10 ** Math.floor(Math.log10(price / 1e4)) };
}

// ---------- ризик-менеджер ----------
// Розмір позиції від стопа: збиток по стопу (з комісіями й сліпеджем) = profile.riskPct від капіталу.
export function sizeOrder({ equity, price, stop, profile, spec, fees = FEES, slip = 0.0003 }) {
  const dist = Math.abs(price - stop) / price;
  if (!(dist >= MIN_STOP)) return { reject: `стоп ближче за ${pct(MIN_STOP)}` };
  const levByStop = Math.floor(1 / (2 * dist + MMR));   // ліквідація щонайменше вдвічі далі за стоп
  if (levByStop < 1) return { reject: 'стоп задалеко: ліквідація була б ближче' };
  const lev = Math.min(profile.maxLev, levByStop);
  const cost = 2 * fees.taker + 2 * slip;
  let notional = Math.min(equity * profile.riskPct / (dist + cost), equity * lev * 0.95);
  const qty = floorStep(notional / price, spec.qtyStep);
  if (qty < spec.minQty || qty * price < spec.minNotional) return { reject: 'депозит замалий для мінімального лота' };
  notional = qty * price;
  const risk = notional * (dist + cost) / equity;
  if (risk > profile.riskPct * 1.5) return { reject: `мінімальний лот дає ризик ${pct(risk)} > ліміту ${pct(profile.riskPct)}` };
  return { qty, notional, lev: Math.max(1, Math.min(lev, Math.ceil(notional / (equity * 0.95)) || 1)), risk, dist, liqDist: 1 / lev - MMR };
}

export const utcDay = t => Math.floor(t / 864e5);

export class RiskGuard {
  constructor(profile, equity0) {
    this.P = profile; this.peak = equity0; this.day = null; this.dayStart = equity0; this.dayHit = false;
    this.streak = 0; this.pausedUntil = 0; this.killed = null;
  }
  // mark-to-market капітал → чи треба все закрити
  update(equity, t) {
    const d = utcDay(t);
    if (d !== this.day) { this.day = d; this.dayStart = equity; this.dayHit = false; }
    if (equity > this.peak) this.peak = equity;
    if (!this.killed && equity <= this.peak * (1 - this.P.maxDdPct))
      this.killed = { t, equity, reason: `просідання ${pct(1 - equity / this.peak)} від піку ${this.peak.toFixed(2)}` };
    if (!this.dayHit && equity <= this.dayStart * (1 - this.P.dailyLossPct)) this.dayHit = true;
    return !!this.killed;
  }
  onClosed(pnl, t) {
    this.streak = pnl < 0 ? this.streak + 1 : 0;
    if (this.streak >= this.P.maxLossStreak) { this.pausedUntil = t + this.P.pauseHours * 36e5; this.streak = 0; }
  }
  blocked(t) {
    if (this.killed) return 'kill-switch: ' + this.killed.reason;
    if (this.dayHit) return `денний ліміт втрат ${pct(this.P.dailyLossPct)}`;
    if (t < this.pausedUntil) return `пауза після ${this.P.maxLossStreak} збитків поспіль`;
    return null;
  }
  snapshot() { const { P, ...s } = this; return s; }
  restore(s) { if (s) Object.assign(this, s, { P: this.P }); }
}

// ---------- бектест сигнальних стратегій ----------
// Комісії Bybit, сліпедж, фандинг (консервативно: завжди проти нас), мінімальні лоти, ризик-гард.
export function backtest(S, strat, o = {}) {
  const fees = o.fees || FEES, slip = o.slip ?? 0.0003, fund = o.funding8h ?? 0.0001;
  const profile = o.profile || profileOf('normal'), spec = o.spec || specOf('BTCUSDT');
  const eq0 = o.equity0 ?? 219, from = Math.max(strat.warm, o.from ?? 0), to = o.to ?? S.n;
  strat.prepare(S);
  const guard = new RiskGuard(profile, eq0);
  let eq = eq0, pos = null, pending = null, feesPaid = 0, fundPaid = 0, rejects = {}, maxDd = 0, peak = eq0;
  const trades = [], daily = [];
  const reject = r => { rejects[r] = (rejects[r] || 0) + 1; };

  const exit = (i, price, why, maker = false) => {
    const fee = pos.qty * price * (maker ? fees.maker : fees.taker);
    const gross = pos.dir * pos.qty * (price - pos.entry);
    eq += gross - fee; feesPaid += fee;
    const pnl = gross - fee - pos.feeIn - pos.fund;
    trades.push({ t0: S.t[pos.bar], t1: S.t[i], dir: pos.dir, entry: pos.entry, exit: price, qty: pos.qty, pnl, ret: pnl / pos.eqIn, R: pnl / (pos.eqIn * (pos.risk || 0.01)), why, bars: i - pos.bar, lev: pos.lev });
    guard.onClosed(pnl, S.t[i]);
    pos = null;
  };

  for (let i = from; i < to; i++) {
    const O = S.o[i], Hh = S.h[i], Ll = S.l[i], C = S.c[i], t = S.t[i];
    if (pos && t % H8 === 0) { const f = pos.qty * O * Math.abs(fund); eq -= f; pos.fund += f; fundPaid += f; }
    // 1) вхід за сигналом попередньої свічки
    if (pending && !pos) {
      const s = pending; pending = null;
      let fill = null, maker = false;
      if (s.entry === 'market') fill = O * (1 + s.dir * slip);
      else if (s.dir > 0 ? Ll < s.limit : Hh > s.limit) { fill = s.dir > 0 ? Math.min(O, s.limit) : Math.max(O, s.limit); maker = true; }
      if (fill !== null && (s.dir > 0 ? fill > s.stop : fill < s.stop)) {
        const fee = s.qty * fill * (maker ? fees.maker : fees.taker);
        eq -= fee; feesPaid += fee;
        pos = { dir: s.dir, entry: fill, qty: s.qty, stop: s.stop, tp: s.tp, bar: i, ext: fill, feeIn: fee, fund: 0, eqIn: s.eqIn, lev: s.lev, risk: s.risk, exitNext: null };
      }
    }
    // 2) вихід, ухвалений на закритті попередньої свічки
    if (pos && pos.exitNext) { exit(i, O * (1 - pos.dir * slip), pos.exitNext); }
    // 3) стоп / тейк усередині свічки (шлях: бичача o→l→h→c, ведмежа o→h→l→c)
    if (pos) {
      const bull = C >= O, stopFirst = pos.dir > 0 ? bull : !bull;
      const hitStop = pos.dir > 0 ? Ll <= pos.stop : Hh >= pos.stop;
      const hitTp = pos.tp !== undefined && (pos.dir > 0 ? Hh >= pos.tp : Ll <= pos.tp);
      const stopPx = () => (pos.dir > 0 ? Math.min(O, pos.stop) : Math.max(O, pos.stop)) * (1 - pos.dir * slip);
      if (hitStop && (!hitTp || stopFirst)) exit(i, stopPx(), 'стоп');
      else if (hitTp) exit(i, pos.tp, 'тейк', true);
    }
    if (pos) pos.ext = pos.dir > 0 ? Math.max(pos.ext, Hh) : Math.min(pos.ext, Ll);
    // 4) ризик на закритті
    const mark = eq + (pos ? pos.dir * pos.qty * (C - pos.entry) : 0);
    if (mark > peak) peak = mark;
    maxDd = Math.max(maxDd, 1 - mark / peak);
    if (guard.update(mark, t) && pos && !pos.exitNext) pos.exitNext = 'kill-switch';
    if (i === to - 1 || utcDay(S.t[i + 1]) !== utcDay(t)) daily.push([t, mark]);
    if (guard.killed && !pos) break;
    // 5) супровід позиції
    if (pos && !pos.exitNext) {
      const m = strat.manage(i, S, pos);
      if (m && m.exit) pos.exitNext = m.exit;
      else if (m && m.stop !== undefined) pos.stop = m.stop;
    }
    // 6) новий сигнал
    if (!pos && !pending && i < to - 1) {
      const s = strat.signal(i, S);
      if (s) {
        const why = guard.blocked(t);
        if (why) reject(why.split(':')[0]);
        else {
          const z = sizeOrder({ equity: eq, price: s.entry === 'limit' ? s.limit : C, stop: s.stop, profile, spec, fees, slip });
          if (z.reject) reject(z.reject);
          else pending = { ...s, qty: z.qty, lev: z.lev, eqIn: eq, risk: z.risk };
        }
      }
    }
  }
  if (pos) exit(to - 1, S.c[to - 1], 'кінець даних');
  return finish({ trades, daily, eq0, eq, feesPaid, fundPaid, maxDd, guard, rejects, S, from, to });
}

function finish({ trades, daily, eq0, eq, feesPaid, fundPaid, maxDd, guard, rejects, S, from, to }) {
  const n = trades.length, wins = trades.filter(x => x.pnl > 0);
  const gp = wins.reduce((s, x) => s + x.pnl, 0), gl = -trades.filter(x => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
  let streak = 0, worstStreak = 0;
  for (const x of trades) { streak = x.pnl < 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak); }
  const rets = [];
  for (let k = 1; k < daily.length; k++) rets.push(daily[k][1] / daily[k - 1][1] - 1);
  const mu = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1)) : 0;
  const days = (S.t[Math.min(to, S.n) - 1] - S.t[from]) / 864e5;
  return {
    trades, daily, n, winRate: n ? wins.length / n : 0, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgRet: n ? trades.reduce((s, x) => s + x.ret, 0) / n : 0,
    avgR: n ? trades.reduce((s, x) => s + (x.R ?? x.ret / 0.01), 0) / n : 0,
    net: eq / eq0 - 1, final: eq, maxDd, feesPaid, fundPaid, worstStreak, days,
    perMonth: days > 0 ? (eq / eq0) ** (30 / days) - 1 : 0,
    sharpe: sd > 0 ? (mu / sd) * Math.sqrt(365) : 0,
    killed: guard.killed, rejects,
    tradesPerDay: days > 0 ? n / days : 0,
  };
}

// ---------- бектест сітки (grid) ----------
// Сітка в один бік (у one-way режимі Bybit): лонг-сітка купує відкати й продає на рівень вище,
// шорт-сітка навпаки. Напрям — за EMA. Розмір рівня такий, щоб повний стоп сітки коштував ≤ gridLossPct капіталу.
export function gridPlan({ price, dir, equity, P, profile, spec, fees = FEES }) {
  const step = P.rangePct / P.levels;
  const lv = [];
  for (let k = 1; k <= P.levels; k++) lv.push({ k, entry: price * (1 - dir * k * step), tp: price * (1 - dir * (k - 1) * step), held: 0 });
  const stopPx = price * (1 - dir * (P.rangePct + P.stopPct));
  const sumDist = lv.reduce((s, x) => s + Math.abs(x.entry - stopPx), 0);
  const sumPx = lv.reduce((s, x) => s + x.entry, 0);
  const q1 = profile.gridLossPct * equity / (sumDist + sumPx * (fees.maker + fees.taker));
  const q2 = equity * profile.maxLev * 0.9 / sumPx;
  const qty = floorStep(Math.min(q1, q2), spec.qtyStep);
  if (qty < spec.minQty || qty * lv[lv.length - 1].entry < spec.minNotional)
    return { reject: 'депозит замалий для сітки з таким числом рівнів' };
  return { dir, center: price, step, lv, stopPx, qty, worstLoss: qty * (sumDist + sumPx * (fees.maker + fees.taker)), notional: qty * sumPx };
}

export function backtestGrid(S, params = {}, o = {}) {
  const P = { tf: '5m', levels: 10, rangePct: 0.05, stopPct: 0.01, emaP: 288, mode: 'auto', cooldown: 288, ...params };
  const fees = o.fees || FEES, slip = o.slip ?? 0.0003, fund = o.funding8h ?? 0.0001;
  const profile = o.profile || profileOf('normal'), spec = o.spec || specOf('BTCUSDT');
  const eq0 = o.equity0 ?? 219, from = Math.max(P.emaP + 2, o.from ?? 0), to = o.to ?? S.n;
  const e = ema(S.c, P.emaP), guard = new RiskGuard(profile, eq0);
  let eq = eq0, g = null, wait = 0, feesPaid = 0, fundPaid = 0, maxDd = 0, peak = eq0, rounds = 0;
  const trades = [], daily = [], rejects = {};
  const held = () => (g ? g.lv.filter(x => x.held) : []);
  const close = (i, px, why) => {
    let pnl = 0;
    for (const x of held()) { const fee = g.qty * px * fees.taker; const p = g.dir * g.qty * (px - x.entry) - fee; eq += p; feesPaid += fee; pnl += p - x.feeIn; x.held = 0; }
    if (pnl !== 0) { trades.push({ t0: g.t0, t1: S.t[i], dir: g.dir, pnl, ret: pnl / g.eqIn, why, bars: 0 }); guard.onClosed(pnl, S.t[i]); }
    g = null;
  };
  const build = i => {
    const why = guard.blocked(S.t[i]);
    if (why) { rejects[why.split(':')[0]] = (rejects[why.split(':')[0]] || 0) + 1; return; }
    const dir = P.mode === 'long' ? 1 : P.mode === 'short' ? -1 : S.c[i] >= e[i] ? 1 : -1;
    const plan = gridPlan({ price: S.c[i], dir, equity: eq, P, profile, spec, fees });
    if (plan.reject) { rejects[plan.reject] = (rejects[plan.reject] || 0) + 1; return; }
    g = { ...plan, t0: S.t[i], eqIn: eq };
  };
  for (let i = from; i < to; i++) {
    const O = S.o[i], C = S.c[i], t = S.t[i];
    if (g && t % H8 === 0) { const f = held().length * g.qty * O * Math.abs(fund); eq -= f; fundPaid += f; }
    if (!g && i >= wait) build(i);
    if (g) {
      const path = C >= O ? [O, S.l[i], S.h[i], C] : [O, S.h[i], S.l[i], C];
      for (let s = 1; s < path.length && g; s++) {
        const a = path[s - 1], b = path[s], down = b < a;
        const adverse = g.dir > 0 ? down : !down;
        if (adverse) {
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (const x of g.lv) if (!x.held && x.entry >= lo && x.entry <= hi && (g.dir > 0 ? x.entry < a : x.entry > a)) {
            const fee = g.qty * x.entry * fees.maker; eq -= fee; feesPaid += fee; x.held = 1; x.feeIn = fee;
          }
          if (g.dir > 0 ? b <= g.stopPx : b >= g.stopPx) { close(i, g.stopPx * (1 - g.dir * slip), 'стоп сітки'); wait = i + P.cooldown; }
        } else {
          for (const x of g.lv) if (x.held && (g.dir > 0 ? x.tp > a && x.tp <= b : x.tp < a && x.tp >= b)) {
            const fee = g.qty * x.tp * fees.maker, p = g.dir * g.qty * (x.tp - x.entry) - fee;
            eq += p; feesPaid += fee; x.held = 0; rounds++;
            trades.push({ t0: t, t1: t, dir: g.dir, pnl: p - x.feeIn, ret: (p - x.feeIn) / g.eqIn, why: 'рівень', bars: 0 });
            guard.onClosed(p - x.feeIn, t);
          }
        }
      }
    }
    // трейлінг сітки: якщо все продано і ціна пішла в наш бік на крок — перебудувати вище/нижче
    if (g && !held().length && (g.dir > 0 ? C > g.center * (1 + g.step) : C < g.center * (1 - g.step))) { g = null; build(i); }
    const mark = eq + held().reduce((s, x) => s + g.dir * g.qty * (C - x.entry), 0);
    if (mark > peak) peak = mark;
    maxDd = Math.max(maxDd, 1 - mark / peak);
    if (guard.update(mark, t) && g) close(i, C * (1 - g.dir * slip), 'kill-switch');
    if (i === to - 1 || utcDay(S.t[i + 1]) !== utcDay(t)) daily.push([t, mark]);
    if (guard.killed) break;
  }
  if (g) close(to - 1, S.c[to - 1], 'кінець даних');
  const r = finish({ trades, daily, eq0, eq, feesPaid, fundPaid, maxDd, guard, rejects, S, from, to });
  r.rounds = rounds;
  return r;
}

// ---------- Монте-Карло: шанс подвоїти до kill-switch ----------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function monteCarlo(rets, { paths = 3000, horizon = 200, target = 2, maxDd = 0.15, seed = 7 } = {}) {
  if (!rets.length) return null;
  const r = rng(seed), finals = [];
  let hit = 0, killed = 0;
  for (let p = 0; p < paths; p++) {
    let eq = 1, peak = 1, done = false;
    for (let k = 0; k < horizon && !done; k++) {
      eq *= 1 + rets[Math.floor(r() * rets.length)];
      if (eq > peak) peak = eq;
      if (eq >= target) { hit++; done = true; }
      else if (eq <= peak * (1 - maxDd)) { killed++; done = true; }
    }
    finals.push(eq);
  }
  finals.sort((a, b) => a - b);
  return { pTarget: hit / paths, pKill: killed / paths, median: finals[Math.floor(paths / 2)], p5: finals[Math.floor(paths * 0.05)], p95: finals[Math.floor(paths * 0.95)] };
}

// ---------- портфельний бектест: багато монет, спільний капітал і ризик ----------
// list: [{ sym, S, spec?, slip? }]. Та сама семантика, що й backtest(): сигнал на закритті, виконання на наступній свічці.
export function backtestPortfolio(list, makeStrat, o = {}) {
  const fees = o.fees || FEES, fund = o.funding8h ?? 0.0001;
  const profile = o.profile || profileOf('normal'), eq0 = o.equity0 ?? 219;
  const tFrom = o.tFrom ?? -Infinity, tTo = o.tTo ?? Infinity;
  const items = list.map(x => { const st = makeStrat(); st.prepare(x.S); return { sym: x.sym, S: x.S, st, slip: x.slip ?? o.slip ?? 0.0003, spec: x.spec || specOf(x.sym), i: 0, pos: null, pending: null, last: NaN }; });
  const all = new Set();
  for (const it of items) for (let i = 0; i < it.S.n; i++) { const t = it.S.t[i]; if (t >= tFrom && t < tTo) all.add(t); }
  const T = Float64Array.from(all).sort();
  const guard = new RiskGuard(profile, eq0);
  let eq = eq0, peak = eq0, maxDd = 0, feesPaid = 0, fundPaid = 0;
  const trades = [], daily = [], rejects = {};
  const reject = r => { rejects[r] = (rejects[r] || 0) + 1; };
  const busy = () => items.reduce((s, x) => s + (x.pos || x.pending ? 1 : 0), 0);
  const margin = () => items.reduce((s, x) => s + (x.pos ? x.pos.qty * x.pos.entry / x.pos.lev : x.pending ? x.pending.qty * x.pending.px / x.pending.lev : 0), 0);
  const exit = (it, i, price, why, maker = false) => {
    const pos = it.pos, fee = pos.qty * price * (maker ? fees.maker : fees.taker), gross = pos.dir * pos.qty * (price - pos.entry);
    eq += gross - fee; feesPaid += fee;
    const pnl = gross - fee - pos.feeIn - pos.fund;
    trades.push({ sym: it.sym, t0: it.S.t[pos.bar], t1: it.S.t[i], dir: pos.dir, entry: pos.entry, exit: price, qty: pos.qty, pnl, ret: pnl / pos.eqIn, R: pnl / (pos.eqIn * (pos.risk || 0.01)), why, bars: i - pos.bar, lev: pos.lev });
    guard.onClosed(pnl, it.S.t[i]);
    it.pos = null;
  };
  let first = -1, lastK = -1;
  for (let k = 0; k < T.length; k++) {
    const t = T[k], active = [];
    for (const it of items) {
      const S = it.S;
      while (it.i < S.n && S.t[it.i] < t) it.i++;
      if (it.i >= S.n || S.t[it.i] !== t) continue;
      const i = it.i, O = S.o[i], Hh = S.h[i], Ll = S.l[i], C = S.c[i];
      it.last = C;
      if (i < it.st.warm) continue;
      active.push(it);
      if (it.pos && t % H8 === 0) { const f = it.pos.qty * O * Math.abs(fund); eq -= f; it.pos.fund += f; fundPaid += f; }
      if (it.pending && !it.pos) {
        const s = it.pending; it.pending = null;
        let fill = null, maker = false;
        if (s.entry === 'market') fill = O * (1 + s.dir * it.slip);
        else if (s.dir > 0 ? Ll < s.limit : Hh > s.limit) { fill = s.dir > 0 ? Math.min(O, s.limit) : Math.max(O, s.limit); maker = true; }
        if (fill !== null && (s.dir > 0 ? fill > s.stop : fill < s.stop)) {
          const fee = s.qty * fill * (maker ? fees.maker : fees.taker);
          eq -= fee; feesPaid += fee;
          it.pos = { dir: s.dir, entry: fill, qty: s.qty, stop: s.stop, tp: s.tp, bar: i, ext: fill, feeIn: fee, fund: 0, eqIn: s.eqIn, lev: s.lev, risk: s.risk, exitNext: null };
        }
      }
      if (it.pos && it.pos.exitNext) exit(it, i, O * (1 - it.pos.dir * it.slip), it.pos.exitNext);
      const pos = it.pos;
      if (pos) {
        const bull = C >= O, stopFirst = pos.dir > 0 ? bull : !bull;
        const hitStop = pos.dir > 0 ? Ll <= pos.stop : Hh >= pos.stop;
        const hitTp = pos.tp !== undefined && (pos.dir > 0 ? Hh >= pos.tp : Ll <= pos.tp);
        if (hitStop && (!hitTp || stopFirst)) exit(it, i, (pos.dir > 0 ? Math.min(O, pos.stop) : Math.max(O, pos.stop)) * (1 - pos.dir * it.slip), 'стоп');
        else if (hitTp) exit(it, i, pos.tp, 'тейк', true);
      }
      if (it.pos) it.pos.ext = it.pos.dir > 0 ? Math.max(it.pos.ext, Hh) : Math.min(it.pos.ext, Ll);
    }
    if (!active.length) continue;
    if (first < 0) first = k;
    lastK = k;
    let mark = eq;
    for (const it of items) if (it.pos) mark += it.pos.dir * it.pos.qty * (it.last - it.pos.entry);
    if (mark > peak) peak = mark;
    maxDd = Math.max(maxDd, 1 - mark / peak);
    if (guard.update(mark, t)) for (const it of items) { it.pending = null; if (it.pos && !it.pos.exitNext) it.pos.exitNext = 'kill-switch'; }
    if (k === T.length - 1 || utcDay(T[k + 1]) !== utcDay(t)) daily.push([t, mark]);
    if (guard.killed && !items.some(x => x.pos)) break;
    for (const it of active) {
      if (!it.pos || it.pos.exitNext) continue;
      const m = it.st.manage(it.i, it.S, it.pos);
      if (m && m.exit) it.pos.exitNext = m.exit;
      else if (m && m.stop !== undefined) it.pos.stop = m.stop;
    }
    const cands = [];
    for (const it of active) if (!it.pos && !it.pending && it.i < it.S.n - 1) { const s = it.st.signal(it.i, it.S); if (s) cands.push([it, s]); }
    if (!cands.length) continue;
    const why = guard.blocked(t);
    if (why) { for (let c = 0; c < cands.length; c++) reject(why.split(':')[0]); continue; }
    cands.sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
    for (const [it, s] of cands) {
      if (busy() >= profile.maxOpen) { reject('ліміт одночасних позицій'); continue; }
      const px = s.entry === 'limit' ? s.limit : it.S.c[it.i];
      const z = sizeOrder({ equity: eq, price: px, stop: s.stop, profile, spec: it.spec, fees, slip: it.slip });
      if (z.reject) { reject(z.reject); continue; }
      if (margin() + z.notional / z.lev > eq * 0.95) { reject('бракує маржі'); continue; }
      it.pending = { ...s, qty: z.qty, lev: z.lev, eqIn: eq, px, risk: z.risk };
    }
  }
  for (const it of items) if (it.pos) exit(it, it.i, it.last, 'кінець даних');
  const r = finish({ trades, daily, eq0, eq, feesPaid, fundPaid, maxDd, guard, rejects, S: { t: T, n: T.length }, from: Math.max(0, first), to: lastK + 1 });
  r.bySym = {};
  for (const x of trades) { const b = (r.bySym[x.sym] ||= { n: 0, pnl: 0 }); b.n++; b.pnl += x.pnl; }
  return r;
}
