// Історичні свічки з кешем: Binance (для бектесту з будь-якого сервера) або Bybit linear (на VPS).
import fs from 'node:fs';
import path from 'node:path';
import { TF_MS } from './core.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, tries = 4) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return await r.json();
    } catch (e) { last = e; await sleep(800 * (a + 1)); }
  }
  throw last;
}

const BYBIT_TF = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

// rows: [t, o, h, l, c, v], від старих до нових, лише закриті свічки
export async function fetchCandles({ symbol, tf, days, source = 'binance', base, cacheDir = 'bybit/data/cache', now = Date.now() }) {
  const ms = TF_MS[tf], end = Math.floor(now / ms) * ms, start = end - days * 864e5;
  const file = path.join(cacheDir, `${source}-${symbol}-${tf}-${days}d.json`);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.end >= end - 6 * 36e5) return c.rows; // кеш свіжіший за 6 год — використовуємо
  } catch (_) { /* кешу немає */ }
  const rows = new Map();
  if (source === 'binance') {
    const b = base || 'https://data-api.binance.vision';
    for (let s = start; s < end;) {
      const j = await getJson(`${b}/api/v3/klines?symbol=${symbol}&interval=${tf}&startTime=${s}&limit=1000`);
      if (!Array.isArray(j) || !j.length) break;
      for (const k of j) if (k[0] + ms <= end) rows.set(k[0], [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
      const next = j[j.length - 1][0] + ms;
      if (next <= s) break;
      s = next;
    }
  } else {
    const b = base || 'https://api.bybit.com';
    for (let e = end; e > start;) {
      const j = await getJson(`${b}/v5/market/kline?category=linear&symbol=${symbol}&interval=${BYBIT_TF[tf]}&end=${e - 1}&limit=1000`);
      if (j.retCode !== 0) throw new Error(`Bybit kline: ${j.retMsg}`);
      const list = j.result.list || [];
      if (!list.length) break;
      for (const k of list) { const t = +k[0]; if (t >= start && t + ms <= end) rows.set(t, [t, +k[1], +k[2], +k[3], +k[4], +k[5]]); }
      const oldest = +list[list.length - 1][0];
      if (oldest >= e) break;
      e = oldest;
    }
  }
  const out = [...rows.values()].sort((a, b) => a[0] - b[0]);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ end, rows: out }));
  return out;
}

// Найліквідніші USDT-пари (без стейблкоїнів і левереджених токенів)
const STABLE = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|USD1|RLUSD|USDE|PYUSD|XUSD|AEUR|EURI|BFUSD|USDS)USDT$/;
const STOCKS = new Set('SOXL NVDA GOOGL GOOG QQQ MSTR INTC CRCL SPCX ANT TSLA AAPL AMZN META MSFT COIN HOOD SPY NFLX AMD PLTR BABA ORCL AVGO IBIT MU'.split(' '));
export function isNonCrypto(sym) {
  const base = sym.replace(/USDT$/, '');
  return ['XAUT', 'PAXG', 'WBTC', 'BTCB', 'RWUSD', 'U', 'XAU', 'XAG'].includes(base) || (base.endsWith('B') && STOCKS.has(base.slice(0, -1)));
}
export async function fetchUniverse({ n = 40, source = 'binance', base } = {}) {
  if (source === 'binance') {
    const j = await getJson(`${base || 'https://data-api.binance.vision'}/api/v3/ticker/24hr`);
    return j.filter(x => x.symbol.endsWith('USDT') && !STABLE.test(x.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol) && !isNonCrypto(x.symbol) && +x.count > 0)
      .sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, n).map(x => ({ sym: x.symbol, vol24: +x.quoteVolume, price: +x.lastPrice }));
  }
  const j = await getJson(`${base || 'https://api.bybit.com'}/v5/market/tickers?category=linear`);
  if (j.retCode !== 0) throw new Error('Bybit tickers: ' + j.retMsg);
  return j.result.list.filter(x => x.symbol.endsWith('USDT') && !STABLE.test(x.symbol) && !isNonCrypto(x.symbol))
    .sort((a, b) => +b.turnover24h - +a.turnover24h).slice(0, n).map(x => ({ sym: x.symbol, vol24: +x.turnover24h, price: +x.lastPrice }));
}

// Паралельне завантаження з обмеженням одночасних запитів
export async function fetchMany(jobs, conc = 4) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (next < jobs.length) { const k = next++; try { out[k] = await jobs[k](); } catch (e) { out[k] = { error: e.message }; } } }));
  return out;
}
