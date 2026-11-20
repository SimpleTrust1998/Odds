// Популярні індикатори TradingView як стратегії для бектесту й бота.
// Формули — як в оригінальних Pine-скриптах. Лише закриті свічки: жодного перемальовування й заглядання вперед.
import { ema, sma, stdev, atr, rsi } from './core.mjs';

const N = n => new Float64Array(n).fill(NaN);
const ok = x => Number.isFinite(x);

// ---------- допоміжні функції як у Pine ----------
export function rma(a, p) { // ta.rma
  const o = N(a.length);
  let s = 0, n = 0, prev = NaN;
  for (let i = 0; i < a.length; i++) {
    if (!ok(a[i])) continue;
    if (n < p) { s += a[i]; n++; if (n === p) o[i] = prev = s / p; }
    else o[i] = prev = (prev * (p - 1) + a[i]) / p;
  }
  return o;
}
export function wma(a, p) {
  const o = N(a.length), d = (p * (p + 1)) / 2;
  for (let i = p - 1; i < a.length; i++) {
    let s = 0, bad = false;
    for (let k = 0; k < p; k++) { const v = a[i - k]; if (!ok(v)) { bad = true; break; } s += v * (p - k); }
    if (!bad) o[i] = s / d;
  }
  return o;
}
export function hma(a, p) {
  const w1 = wma(a, Math.max(1, Math.floor(p / 2))), w2 = wma(a, p), d = N(a.length);
  for (let i = 0; i < a.length; i++) if (ok(w1[i]) && ok(w2[i])) d[i] = 2 * w1[i] - w2[i];
  return wma(d, Math.max(1, Math.floor(Math.sqrt(p))));
}
export function linreg(a, p) { // ta.linreg(src, p, 0): значення лінії регресії на поточній свічці
  const o = N(a.length), sx = (p * (p - 1)) / 2, sxx = ((p - 1) * p * (2 * p - 1)) / 6;
  for (let i = p - 1; i < a.length; i++) {
    let sy = 0, sxy = 0, bad = false;
    for (let x = 0; x < p; x++) { const y = a[i - p + 1 + x]; if (!ok(y)) { bad = true; break; } sy += y; sxy += x * y; }
    if (bad) continue;
    const slope = (p * sxy - sx * sy) / (p * sxx - sx * sx), icpt = (sy - slope * sx) / p;
    o[i] = icpt + slope * (p - 1);
  }
  return o;
}
export function hiIncl(a, p) { const o = N(a.length); for (let i = p - 1; i < a.length; i++) { let m = -Infinity; for (let j = i - p + 1; j <= i; j++) if (a[j] > m) m = a[j]; o[i] = m; } return o; }
export function loIncl(a, p) { const o = N(a.length); for (let i = p - 1; i < a.length; i++) { let m = Infinity; for (let j = i - p + 1; j <= i; j++) if (a[j] < m) m = a[j]; o[i] = m; } return o; }
export function cci(src, p) {
  const m = sma(src, p), o = N(src.length);
  for (let i = p - 1; i < src.length; i++) {
    let md = 0;
    for (let j = i - p + 1; j <= i; j++) md += Math.abs(src[j] - m[i]);
    md /= p;
    o[i] = md > 0 ? (src[i] - m[i]) / (0.015 * md) : 0;
  }
  return o;
}
export function adx(H, L, C, p) {
  const n = C.length, tr = N(n), pdm = N(n), mdm = N(n);
  for (let i = 1; i < n; i++) {
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  }
  const trr = rma(tr, p), pr = rma(pdm, p), mr = rma(mdm, p), dx = N(n);
  for (let i = 0; i < n; i++) {
    if (!ok(trr[i]) || trr[i] === 0) continue;
    const plus = (100 * pr[i]) / trr[i], minus = (100 * mr[i]) / trr[i], s = plus + minus;
    dx[i] = (100 * Math.abs(plus - minus)) / (s || 1);
  }
  return rma(dx, p);
}
export function waveTrend(S, n1, n2) {
  const n = S.n, ap = new Float64Array(n);
  for (let i = 0; i < n; i++) ap[i] = (S.h[i] + S.l[i] + S.c[i]) / 3;
  const esa = ema(ap, n1), dev = new Float64Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(ap[i] - esa[i]);
  const d = ema(dev, n1), ci = new Float64Array(n);
  for (let i = 0; i < n; i++) ci[i] = d[i] > 0 ? (ap[i] - esa[i]) / (0.015 * d[i]) : 0;
  const wt1 = ema(ci, n2), wt2 = sma(wt1, 4);
  return { wt1, wt2 };
}
const crossUp = (a, b, i) => a[i] > b[i] && a[i - 1] <= b[i - 1];
const crossDn = (a, b, i) => a[i] < b[i] && a[i - 1] >= b[i - 1];

// Обгортка: однаковий інтерфейс зі стратегіями core.mjs
function make(name, P, warm, prepare, signal, manage) {
  return { name, P, tf: P.tf, warm, prepare, signal, manage: manage || (() => null) };
}

export const INDICATORS = {
  // SuperTrend (KivancOzbilgic): ATR 10 × 3. Вхід на розвороті, стоп = лінія SuperTrend (трейлінг), вихід на зворотному розвороті.
  supertrend: (p = {}) => {
    const P = { tf: '1h', atrP: 10, mult: 3, ...p };
    let up, dn, tr;
    return make('supertrend', P, P.atrP + 3, S => {
      const a = atr(S.h, S.l, S.c, P.atrP), n = S.n;
      up = N(n); dn = N(n); tr = new Int8Array(n).fill(1);
      for (let i = 0; i < n; i++) {
        if (!ok(a[i])) continue;
        const src = (S.h[i] + S.l[i]) / 2;
        let u = src - P.mult * a[i], d = src + P.mult * a[i];
        if (ok(up[i - 1])) { u = S.c[i - 1] > up[i - 1] ? Math.max(u, up[i - 1]) : u; d = S.c[i - 1] < dn[i - 1] ? Math.min(d, dn[i - 1]) : d; }
        up[i] = u; dn[i] = d;
        if (i > 0) tr[i] = tr[i - 1] === -1 && ok(dn[i - 1]) && S.c[i] > dn[i - 1] ? 1 : tr[i - 1] === 1 && ok(up[i - 1]) && S.c[i] < up[i - 1] ? -1 : tr[i - 1];
      }
    }, i => {
      if (tr[i] === 1 && tr[i - 1] === -1) return { dir: 1, stop: up[i], entry: 'market', why: 'SuperTrend розвернувся вгору' };
      if (tr[i] === -1 && tr[i - 1] === 1) return { dir: -1, stop: dn[i], entry: 'market', why: 'SuperTrend розвернувся вниз' };
      return null;
    }, (i, S, pos) => {
      if (tr[i] !== pos.dir) return { exit: 'розворот SuperTrend' };
      const line = pos.dir > 0 ? up[i] : dn[i];
      return (pos.dir > 0 ? line > pos.stop : line < pos.stop) ? { stop: line } : null;
    });
  },

  // UT Bot Alerts (QuantNomad): ATR-трейлінг із ключем 1, ATR 10. Вхід на перетині ціни й трейлінг-стопа.
  utbot: (p = {}) => {
    const P = { tf: '1h', key: 1, atrP: 10, ...p };
    let ts;
    return make('utbot', P, P.atrP + 3, S => {
      const a = atr(S.h, S.l, S.c, P.atrP), n = S.n, c = S.c;
      ts = N(n);
      for (let i = 1; i < n; i++) {
        if (!ok(a[i])) continue;
        const loss = P.key * a[i], prev = ok(ts[i - 1]) ? ts[i - 1] : 0;
        ts[i] = c[i] > prev && c[i - 1] > prev ? Math.max(prev, c[i] - loss)
          : c[i] < prev && c[i - 1] < prev ? Math.min(prev, c[i] + loss)
          : c[i] > prev ? c[i] - loss : c[i] + loss;
      }
    }, (i, S) => {
      const c = S.c;
      if (!ok(ts[i - 1])) return null;
      if (c[i] > ts[i] && c[i - 1] <= ts[i - 1]) return { dir: 1, stop: ts[i], entry: 'market', why: 'UT Bot: Buy' };
      if (c[i] < ts[i] && c[i - 1] >= ts[i - 1]) return { dir: -1, stop: ts[i], entry: 'market', why: 'UT Bot: Sell' };
      return null;
    }, (i, S, pos) => {
      const c = S.c;
      if (pos.dir > 0 ? c[i] < ts[i] : c[i] > ts[i]) return { exit: 'UT Bot: зворотний сигнал' };
      return (pos.dir > 0 ? ts[i] > pos.stop : ts[i] < pos.stop) ? { stop: ts[i] } : null;
    });
  },

  // Squeeze Momentum (LazyBear): вихід зі «стиску» (Боллінджер усередині Кельтнера) у бік імпульсу.
  // Як в оригіналі: відхилення Боллінджера множиться на multKC (1,5) — відома особливість скрипта.
  squeeze: (p = {}) => {
    const P = { tf: '1h', len: 20, multKC: 1.5, atrP: 14, stopAtr: 2, ...p };
    let on, val, a;
    return make('squeeze', P, P.len * 2 + 3, S => {
      const n = S.n, c = S.c, basis = sma(c, P.len), sd = stdev(c, P.len), tr = new Float64Array(n);
      for (let i = 0; i < n; i++) tr[i] = i ? Math.max(S.h[i] - S.l[i], Math.abs(S.h[i] - c[i - 1]), Math.abs(S.l[i] - c[i - 1])) : S.h[i] - S.l[i];
      const rng = sma(tr, P.len), hh = hiIncl(S.h, P.len), ll = loIncl(S.l, P.len), x = N(n);
      on = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        const dev = P.multKC * sd[i], ub = basis[i] + dev, lb = basis[i] - dev, uk = basis[i] + rng[i] * P.multKC, lk = basis[i] - rng[i] * P.multKC;
        on[i] = lb > lk && ub < uk ? 1 : 0;
        if (ok(hh[i]) && ok(basis[i])) x[i] = c[i] - ((hh[i] + ll[i]) / 2 + basis[i]) / 2;
      }
      val = linreg(x, P.len);
      a = atr(S.h, S.l, S.c, P.atrP);
    }, (i, S) => {
      if (!(on[i - 1] && !on[i]) || !ok(val[i - 1])) return null;
      const c = S.c[i];
      if (val[i] > 0 && val[i] > val[i - 1]) return { dir: 1, stop: c - P.stopAtr * a[i], entry: 'market', why: 'вихід зі стиску вгору' };
      if (val[i] < 0 && val[i] < val[i - 1]) return { dir: -1, stop: c + P.stopAtr * a[i], entry: 'market', why: 'вихід зі стиску вниз' };
      return null;
    }, (i, S, pos) => {
      const fading = pos.dir > 0 ? val[i] < val[i - 1] && val[i - 1] < val[i - 2] : val[i] > val[i - 1] && val[i - 1] > val[i - 2];
      return fading ? { exit: 'імпульс слабшає' } : null;
    });
  },

  // WaveTrend (LazyBear; основа VuManChu Cipher B): перетин ліній у зонах перекупленості/перепроданості.
  wavetrend: (p = {}) => {
    const P = { tf: '1h', n1: 10, n2: 21, ob: 53, os: -53, atrP: 14, stopAtr: 2, ...p };
    let w, a;
    return make('wavetrend', P, P.n1 + P.n2 + 10, S => { w = waveTrend(S, P.n1, P.n2); a = atr(S.h, S.l, S.c, P.atrP); }, (i, S) => {
      const c = S.c[i];
      if (crossUp(w.wt1, w.wt2, i) && w.wt1[i] < P.os) return { dir: 1, stop: c - P.stopAtr * a[i], entry: 'market', why: 'WaveTrend: розворот із перепроданості' };
      if (crossDn(w.wt1, w.wt2, i) && w.wt1[i] > P.ob) return { dir: -1, stop: c + P.stopAtr * a[i], entry: 'market', why: 'WaveTrend: розворот із перекупленості' };
      return null;
    }, (i, S, pos) => ((pos.dir > 0 ? crossDn(w.wt1, w.wt2, i) : crossUp(w.wt1, w.wt2, i)) ? { exit: 'WaveTrend: зворотний перетин' } : null));
  },

  // MACD + EMA200 (класика YouTube): перетин MACD нижче нуля в бік тренду, стоп 1,5 ATR, тейк 1,5R.
  macd: (p = {}) => {
    const P = { tf: '1h', fast: 12, slow: 26, sig: 9, emaP: 200, atrP: 14, stopAtr: 1.5, rr: 1.5, ...p };
    let m, s, e, a;
    return make('macd', P, P.emaP + 3, S => {
      const f = ema(S.c, P.fast), sl = ema(S.c, P.slow);
      m = new Float64Array(S.n); for (let i = 0; i < S.n; i++) m[i] = f[i] - sl[i];
      s = ema(m, P.sig); e = ema(S.c, P.emaP); a = atr(S.h, S.l, S.c, P.atrP);
    }, (i, S) => {
      const c = S.c[i], d = P.stopAtr * a[i];
      if (crossUp(m, s, i) && m[i] < 0 && c > e[i]) return { dir: 1, stop: c - d, tp: c + P.rr * d, entry: 'market', why: 'MACD перетин угору над EMA200' };
      if (crossDn(m, s, i) && m[i] > 0 && c < e[i]) return { dir: -1, stop: c + d, tp: c - P.rr * d, entry: 'market', why: 'MACD перетин униз під EMA200' };
      return null;
    });
  },

  // RSI 30/70: вихід RSI з перепроданості / перекупленості.
  rsi: (p = {}) => {
    const P = { tf: '1h', len: 14, lo: 30, hi: 70, atrP: 14, stopAtr: 1.5, tpAtr: 2, ...p };
    let r, a;
    return make('rsi', P, P.len + 3, S => { r = rsi(S.c, P.len); a = atr(S.h, S.l, S.c, P.atrP); }, (i, S) => {
      const c = S.c[i];
      if (r[i] > P.lo && r[i - 1] <= P.lo) return { dir: 1, stop: c - P.stopAtr * a[i], tp: c + P.tpAtr * a[i], entry: 'market', why: 'RSI вийшов вище 30' };
      if (r[i] < P.hi && r[i - 1] >= P.hi) return { dir: -1, stop: c + P.stopAtr * a[i], tp: c - P.tpAtr * a[i], entry: 'market', why: 'RSI вийшов нижче 70' };
      return null;
    });
  },

  // EMA 9/21: перетин швидкої й повільної, вихід на зворотному перетині.
  emaCross: (p = {}) => {
    const P = { tf: '1h', fast: 9, slow: 21, atrP: 14, stopAtr: 2, ...p };
    let f, s, a;
    return make('emaCross', P, P.slow + 3, S => { f = ema(S.c, P.fast); s = ema(S.c, P.slow); a = atr(S.h, S.l, S.c, P.atrP); }, (i, S) => {
      const c = S.c[i];
      if (crossUp(f, s, i)) return { dir: 1, stop: c - P.stopAtr * a[i], entry: 'market', why: 'EMA9 перетнула EMA21 угору' };
      if (crossDn(f, s, i)) return { dir: -1, stop: c + P.stopAtr * a[i], entry: 'market', why: 'EMA9 перетнула EMA21 униз' };
      return null;
    }, (i, S, pos) => ((pos.dir > 0 ? crossDn(f, s, i) : crossUp(f, s, i)) ? { exit: 'зворотний перетин EMA' } : null));
  },

  // Hull Suite (InSilico): розворот HMA 55 (порівняння з HMA 2 свічки тому).
  hull: (p = {}) => {
    const P = { tf: '1h', len: 55, atrP: 14, stopAtr: 2, ...p };
    let h, a;
    const up = i => h[i] > h[i - 2];
    return make('hull', P, P.len + 12, S => { h = hma(S.c, P.len); a = atr(S.h, S.l, S.c, P.atrP); }, (i, S) => {
      if (!ok(h[i - 3])) return null;
      const c = S.c[i];
      if (up(i) && !up(i - 1)) return { dir: 1, stop: c - P.stopAtr * a[i], entry: 'market', why: 'Hull розвернувся вгору' };
      if (!up(i) && up(i - 1)) return { dir: -1, stop: c + P.stopAtr * a[i], entry: 'market', why: 'Hull розвернувся вниз' };
      return null;
    }, (i, S, pos) => (up(i) !== pos.dir > 0 ? { exit: 'розворот Hull' } : null));
  },

  // SSL Channel (ErwinBeckers): SMA максимумів/мінімумів 10, перемикання напряму.
  ssl: (p = {}) => {
    const P = { tf: '1h', len: 10, atrP: 14, stopAtr: 2, ...p };
    let hlv, a;
    return make('ssl', P, P.len + 3, S => {
      const sh = sma(S.h, P.len), sl = sma(S.l, P.len);
      hlv = new Int8Array(S.n); a = atr(S.h, S.l, S.c, P.atrP);
      for (let i = 1; i < S.n; i++) hlv[i] = S.c[i] > sh[i] ? 1 : S.c[i] < sl[i] ? -1 : hlv[i - 1];
    }, (i, S) => {
      const c = S.c[i];
      if (hlv[i] === 1 && hlv[i - 1] === -1) return { dir: 1, stop: c - P.stopAtr * a[i], entry: 'market', why: 'SSL перемкнувся вгору' };
      if (hlv[i] === -1 && hlv[i - 1] === 1) return { dir: -1, stop: c + P.stopAtr * a[i], entry: 'market', why: 'SSL перемкнувся вниз' };
      return null;
    }, (i, S, pos) => (hlv[i] === -pos.dir ? { exit: 'SSL: зворотне перемикання' } : null));
  },
};

// Lorentzian Classification (jdehorty) — НАБЛИЖЕНА реалізація ядра: kNN із лоренцевою відстанню на 5 ознаках
// (RSI14, WaveTrend 10/11, CCI20, ADX20, RSI9), k = 8, вікно 2000 свічок із кроком 4, прогноз напряму на 4 свічки,
// фільтр волатильності, утримання 4 свічки. Kernel-фільтр оригіналу не відтворено. Навчання лише на минулих даних.
function runNorm(a) {
  const o = new Float64Array(a.length).fill(0.5);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    if (a[i] < mn) mn = a[i];
    if (a[i] > mx) mx = a[i];
    o[i] = mx > mn ? (a[i] - mn) / (mx - mn) : 0.5;
  }
  return o;
}
INDICATORS.lorentzian = (p = {}) => {
  const P = { tf: '1h', k: 8, maxBack: 2000, hold: 4, atrP: 14, stopAtr: 2, ...p };
  let sig, a;
  return make('lorentzian', P, 300, S => {
    const n = S.n, c = S.c;
    const r14 = rsi(c, 14), r9 = rsi(c, 9), w = waveTrend(S, 10, 11), wd = new Float64Array(n);
    for (let i = 0; i < n; i++) wd[i] = w.wt1[i] - w.wt2[i];
    const ad = adx(S.h, S.l, c, 20);
    const F = [r14.map(x => x / 100), runNorm(wd), runNorm(cci(c, 20)), ad.map(x => (Number.isFinite(x) ? x / 100 : 0.5)), r9.map(x => x / 100)];
    const label = new Int8Array(n);
    for (let j = 0; j + 4 < n; j++) label[j] = c[j + 4] > c[j] ? 1 : c[j + 4] < c[j] ? -1 : 0;
    const tr = new Float64Array(n);
    for (let i = 1; i < n; i++) tr[i] = Math.max(S.h[i] - S.l[i], Math.abs(S.h[i] - c[i - 1]), Math.abs(S.l[i] - c[i - 1]));
    const a10 = atr(S.h, S.l, c, 10);
    a = atr(S.h, S.l, c, P.atrP);
    sig = new Int8Array(n);
    for (let i = 60; i < n; i++) {
      let last = -1, sum = 0;
      const dist = [], pr = [];
      for (let j = Math.max(0, i - P.maxBack); j <= i - 5; j += 4) { // мітка j відома лише після свічки j+4 ≤ i−1
        let d = 0;
        for (let f = 0; f < 5; f++) d += Math.log(1 + Math.abs(F[f][i] - F[f][j]));
        if (d >= last) {
          last = d; dist.push(d); pr.push(label[j]);
          if (pr.length > P.k) { last = dist[Math.round((P.k * 3) / 4)]; dist.shift(); pr.shift(); }
        }
      }
      for (const v of pr) sum += v;
      const volOk = tr[i] > a10[i];
      sig[i] = sum > 0 && volOk ? 1 : sum < 0 && volOk ? -1 : sig[i - 1];
    }
  }, (i, S) => {
    if (sig[i] === sig[i - 1] || !sig[i]) return null;
    const c = S.c[i];
    return sig[i] > 0 ? { dir: 1, stop: c - P.stopAtr * a[i], entry: 'market', why: 'ML-прогноз: угору' } : { dir: -1, stop: c + P.stopAtr * a[i], entry: 'market', why: 'ML-прогноз: униз' };
  }, (i, S, pos) => (i - pos.bar >= P.hold ? { exit: 'утримання 4 свічки' } : null));
};

export const INDICATOR_TITLES = {
  supertrend: 'SuperTrend (10, 3)', utbot: 'UT Bot Alerts (1, 10)', squeeze: 'Squeeze Momentum [LazyBear]', wavetrend: 'WaveTrend [LazyBear] / VuManChu',
  macd: 'MACD + EMA200 (1,5R)', rsi: 'RSI 30/70', emaCross: 'EMA 9/21', hull: 'Hull Suite (55)', ssl: 'SSL Channel (10)', lorentzian: 'Lorentzian Classification (ML)',
};
