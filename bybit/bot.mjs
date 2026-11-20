// ===================== BYBIT USDT-PERP: ТОРГОВИЙ БОТ =====================
// Торгує на твоєму акаунті Bybit через API-ключ тим самим кодом сигналів і ризику, що пройшов бектест (core.mjs).
//
// Захист депозиту:
//  • стоп-лосс ставиться НА БІРЖІ разом з ордером — позиція захищена, навіть якщо бот або VPS впаде;
//  • кожне опитування перевіряє, що в кожної позиції є стоп; якщо немає — ставить негайно;
//  • розмір позиції від стопа (ризик = % капіталу), плече ≤ профілю, ліквідація щонайменше вдвічі далі за стоп;
//  • денний ліміт втрат, пауза після серії збитків, kill-switch за просіданням від піку і за мінімальним капіталом;
//  • відмовляється працювати з ключем, що має право ВИВОДУ, а в live — з ключем без прив'язки до IP;
//  • за замовчуванням — демо-рахунок Bybit; реальні гроші лише з BYBIT_MODE=live і LIVE_CONFIRM=YES_REAL_MONEY.
//
//   node bybit/bot.mjs check      перевірити ключ, права, баланс, контракти (нічого не торгує)
//   node bybit/bot.mjs run        запустити бота
//   node bybit/bot.mjs status     стан і журнал угод
//   node bybit/bot.mjs flatten    АВАРІЙНО закрити всі позиції бота й зупинити торгівлю

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES, profileOf, sizeOrder, RiskGuard, toSeries, floorStep, roundTick, TF_MS } from './core.mjs';
import { isNonCrypto } from './data.mjs';
import { INDICATORS } from './indicators.mjs';

const ENV = process.env;
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const usd = x => (x < 0 ? '−' : '') + Math.abs(x).toFixed(2) + ' USDT';
const sgn = x => (x >= 0 ? '+' : '') + usd(x);
const dec = step => { const s = String(step); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length; };
const fmtStep = (x, step) => floorStep(x, step).toFixed(dec(step));
const fmtTick = (x, tick) => roundTick(x, tick).toFixed(dec(tick));
const kyivDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });
const kyivHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', hour: 'numeric', hourCycle: 'h23' });
const kyivDay = t => kyivDayFmt.format(new Date(t));
const kyivHour = t => +kyivHourFmt.format(new Date(t));

// Стратегії, доступні боту. PROVEN — ті, що пройшли перевірку на обох половинах історії (див. docs/bybit-analysis.md).
export const STRATS = {
  trend4h: () => STRATEGIES.trend({ tf: '4h', n: 30 }),
  trend: () => STRATEGIES.trend(),
  momentum: () => STRATEGIES.momentum(),
  scalp: () => STRATEGIES.scalp(),
  scalp1m: () => STRATEGIES.scalp1m(),
  spikeFade: () => STRATEGIES.spikeFade(),
  pumpRide: () => STRATEGIES.pumpRide(),
  // індикатори TradingView (docs/tradingview-indicators.md)
  ssl4h: () => INDICATORS.ssl({ tf: '4h' }),
  hull4h: () => INDICATORS.hull({ tf: '4h' }),
  supertrend4h: () => INDICATORS.supertrend({ tf: '4h' }),
  squeeze4h: () => INDICATORS.squeeze({ tf: '4h' }),
  utbot: () => INDICATORS.utbot({ tf: '1h' }),
  wavetrend: () => INDICATORS.wavetrend({ tf: '1h' }),
  lorentzian: () => INDICATORS.lorentzian({ tf: '1h' }),
};
// пройшли перевірку на BTC/ETH/SOL на обох частинах історії
export const PROVEN = new Set(['trend4h', 'ssl4h']);
const BASES = { live: 'https://api.bybit.com', demo: 'https://api-demo.bybit.com', testnet: 'https://api-testnet.bybit.com' };
const BYBIT_TF = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

export function makeConfig(env = ENV) {
  const mode = env.BYBIT_MODE || 'demo';
  if (!BASES[mode]) throw new Error('BYBIT_MODE: demo | testnet | live');
  return {
    mode,
    key: env.BYBIT_API_KEY || '',
    secret: env.BYBIT_API_SECRET || '',
    tradeBase: env.BYBIT_BASE || BASES[mode],
    // ринкові дані: для demo — основна мережа (ті самі ціни), для testnet — testnet
    dataBase: env.BYBIT_DATA_BASE || (mode === 'testnet' ? BASES.testnet : mode === 'live' && env.BYBIT_BASE ? env.BYBIT_BASE : BASES.live),
    liveConfirm: env.LIVE_CONFIRM === 'YES_REAL_MONEY',
    strategy: env.STRATEGY || 'trend4h',
    symbols: env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT',  // або TOP40 — сканер найліквідніших монет
    profile: profileOf(env.PROFILE || 'normal', {
      riskPct: env.RISK_PCT, maxLev: env.MAX_LEV, dailyLossPct: env.DAILY_LOSS_PCT, maxDdPct: env.MAX_DD_PCT, maxOpen: env.MAX_OPEN,
    }),
    maxCapital: num(env.MAX_CAPITAL_USDT, 0),   // скільки капіталу бот вважає своїм для розміру угод (0 = весь акаунт)
    minEquity: num(env.MIN_EQUITY_USDT, 0),     // абсолютна підлога: нижче — закрити все й зупинитись
    allowUnproven: env.ALLOW_UNPROVEN === '1',
    allowNoIp: env.ALLOW_NO_IP === '1',
    maxSpread: num(env.MAX_SPREAD, 0.002),
    pollSec: num(env.POLL_SEC, 20),
    barDelayMs: num(env.BAR_DELAY_SEC, 5) * 1000,
    tgToken: env.TELEGRAM_BOT_TOKEN || '',
    tgChat: env.TELEGRAM_CHAT_ID || '',
    tgBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    reportHour: num(env.REPORT_HOUR, 9),
    dir: env.STATE_DIR || 'bybit/data',
  };
}

// ---------- клієнт Bybit V5 ----------
export class BybitError extends Error {
  constructor(code, msg, where) { super(`Bybit ${where}: ${msg} (код ${code})`); this.code = code; }
}
export class Bybit {
  constructor({ key, secret, base, dataBase, recv = 5000 }) {
    Object.assign(this, { key, secret, base, dataBase: dataBase || base, recv, offset: 0 });
  }
  sign(payload) { return crypto.createHmac('sha256', this.secret).update(payload).digest('hex'); }
  async syncTime() {
    const r = await this.req('GET', '/v5/market/time', {}, { auth: false, data: true });
    const server = r.timeNano ? Math.floor(+r.timeNano / 1e6) : +r.timeSecond * 1000;
    this.offset = server - Date.now();
    return this.offset;
  }
  async req(method, p, params = {}, { auth = true, data = false } = {}) {
    const base = data ? this.dataBase : this.base;
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    for (let a = 0; a < 4; a++) {
      const ts = String(Date.now() + this.offset), recv = String(this.recv);
      let url = base + p, body, payload;
      if (method === 'GET') { const qs = new URLSearchParams(clean).toString(); if (qs) url += '?' + qs; payload = qs; }
      else { body = JSON.stringify(clean); payload = body; }
      const headers = { 'content-type': 'application/json' };
      if (auth) Object.assign(headers, {
        'X-BAPI-API-KEY': this.key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv, 'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-SIGN': this.sign(ts + this.key + recv + payload),
      });
      let r;
      try { r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) }); }
      catch (e) { if (a < 3) { await sleep(1000 * (a + 1)); continue; } throw new BybitError('NET', e.message, p); }
      if (r.status === 403) throw new BybitError(403, 'доступ заборонено: IP або країна заблоковані Bybit (запускай на VPS у ЄС)', p);
      if (r.status === 429 || r.status >= 500) { if (a < 3) { await sleep(1500 * (a + 1)); continue; } throw new BybitError(r.status, 'HTTP ' + r.status, p); }
      let j;
      try { j = await r.json(); } catch (_) { throw new BybitError(r.status, 'відповідь не JSON', p); }
      if (j.retCode === 0) return j.result;
      if (j.retCode === 10002 && a < 3) { await this.syncTime().catch(() => {}); continue; } // розсинхрон часу
      if (j.retCode === 10006 && a < 3) { await sleep(2000 * (a + 1)); continue; }          // ліміт запитів
      throw new BybitError(j.retCode, j.retMsg, p);
    }
    throw new BybitError('RETRY', 'вичерпано спроби', p);
  }
  // публічні
  async klines(symbol, tf, limit = 300) {
    const r = await this.req('GET', '/v5/market/kline', { category: 'linear', symbol, interval: BYBIT_TF[tf], limit }, { auth: false, data: true });
    return r.list.map(k => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]).reverse();
  }
  async instrument(symbol) {
    const r = await this.req('GET', '/v5/market/instruments-info', { category: 'linear', symbol }, { auth: false, data: true });
    const x = r.list && r.list[0];
    if (!x) throw new BybitError('SPEC', `контракт ${symbol} не знайдено`, 'instruments-info');
    return {
      qtyStep: +x.lotSizeFilter.qtyStep, minQty: +x.lotSizeFilter.minOrderQty, minNotional: +(x.lotSizeFilter.minNotionalValue || 5),
      tickSize: +x.priceFilter.tickSize, maxLev: +x.leverageFilter.maxLeverage, status: x.status,
    };
  }
  async tickers(symbol) { return (await this.req('GET', '/v5/market/tickers', { category: 'linear', symbol }, { auth: false, data: true })).list; }
  // приватні
  apiInfo() { return this.req('GET', '/v5/user/query-api'); }
  async balance() {
    const a = (await this.req('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' })).list[0];
    return { equity: +a.totalEquity, available: +a.totalAvailableBalance };
  }
  async positions() {
    const r = await this.req('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: 200 });
    return r.list.filter(p => +p.size > 0).map(p => ({
      sym: p.symbol, dir: p.side === 'Buy' ? 1 : -1, qty: +p.size, entry: +p.avgPrice, stop: +p.stopLoss || 0, tp: +p.takeProfit || 0,
      lev: +p.leverage, idx: +p.positionIdx, upnl: +p.unrealisedPnl, liq: +p.liqPrice || 0, mark: +p.markPrice,
    }));
  }
  async setLeverage(symbol, lev) {
    try { await this.req('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: String(lev), sellLeverage: String(lev) }); }
    catch (e) { if (e.code !== 110043) throw e; } // плече вже таке
  }
  async oneWayMode() {
    try { await this.req('POST', '/v5/position/switch-mode', { category: 'linear', coin: 'USDT', mode: 0 }); }
    catch (e) { if (e.code !== 110025) throw e; } // режим уже one-way
  }
  async order(p) {
    try { return await this.req('POST', '/v5/order/create', { category: 'linear', positionIdx: 0, ...p }); }
    catch (e) { if (e.code === 110072) return { duplicate: true }; throw e; } // той самий orderLinkId — ордер уже є
  }
  cancelAll(symbol) { return this.req('POST', '/v5/order/cancel-all', { category: 'linear', symbol }); }
  async setStop(symbol, stopLoss) {
    try { await this.req('POST', '/v5/position/trading-stop', { category: 'linear', symbol, tpslMode: 'Full', positionIdx: 0, stopLoss: String(stopLoss), slTriggerBy: 'LastPrice' }); }
    catch (e) { if (e.code !== 34040) throw e; } // не змінилось
  }
  async closedPnl(symbol, startTime) {
    const r = await this.req('GET', '/v5/position/closed-pnl', { category: 'linear', symbol, startTime, limit: 50 });
    return r.list.map(x => ({ qty: +x.qty, entry: +x.avgEntryPrice, exit: +x.avgExitPrice, pnl: +x.closedPnl, t: +x.updatedTime || +x.createdTime }));
  }
}

// ---------- Telegram ----------
export class TG {
  constructor(C) { this.C = C; this.q = []; this.busy = false; this.offset = 0; this.stopped = false; this.sent = []; }
  enabled() { return !!(this.C.tgToken && this.C.tgChat); }
  send(text) {
    log('[TG]', text.replace(/\n/g, ' | ').slice(0, 300));
    this.sent.push(text);
    if (!this.enabled()) return;
    this.q.push(text);
    this.pump();
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.q.length) {
      const text = this.q.shift();
      try {
        await fetch(`${this.C.tgBase}/bot${this.C.tgToken}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.C.tgChat, text: text.slice(0, 4000), disable_web_page_preview: true }), signal: AbortSignal.timeout(15000),
        });
      } catch (e) { log('Telegram:', e.message); }
      await sleep(1100);
    }
    this.busy = false;
  }
  async poll(handler) {
    const since = Math.floor(Date.now() / 1000) - 30;
    while (!this.stopped) {
      try {
        const r = await fetch(`${this.C.tgBase}/bot${this.C.tgToken}/getUpdates?timeout=25&offset=${this.offset}`, { signal: AbortSignal.timeout(35000) });
        const j = await r.json();
        if (!j.ok) { await sleep(10000); continue; }
        for (const u of j.result) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text || m.date < since || String(m.chat?.id) !== String(this.C.tgChat)) continue; // лише твій чат
          try { await handler(m.text.trim()); } catch (e) { this.send('Помилка команди: ' + e.message); }
        }
      } catch (e) { if (!this.stopped) await sleep(5000); }
    }
  }
}

// ---------- стан на диску (атомарний запис) ----------
export class FileStore {
  constructor(dir) { this.file = path.join(dir, 'bot_state.json'); fs.mkdirSync(dir, { recursive: true }); }
  load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return null; } }
  save(s) { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, this.file); }
}

// ===================== БОТ =====================
export class Bot {
  constructor(C, { ex, tg, store, now = () => Date.now() }) {
    Object.assign(this, { C, ex, tg, store, now });
    this.make = STRATS[C.strategy];
    if (!this.make) throw new Error(`Невідома стратегія ${C.strategy}: ${Object.keys(STRATS).join(' | ')}`);
    this.tf = this.make().tf;
    this.ms = TF_MS[this.tf];
    this.specs = {};
    this.universe = [];
    this.errors = 0;
  }

  // Перевірки перед стартом: нічого не торгує
  async preflight() {
    const C = this.C, out = [];
    if (C.mode === 'live' && !C.liveConfirm) throw new Error('Реальні гроші: постав LIVE_CONFIRM=YES_REAL_MONEY, лише після демо-періоду');
    if (!PROVEN.has(C.strategy) && !C.allowUnproven)
      throw new Error(`Стратегія ${C.strategy} НЕ пройшла бектест (у мінусі після комісій, див. docs/bybit-analysis.md). Якщо все одно хочеш її — ALLOW_UNPROVEN=1`);
    if (!C.key || !C.secret) throw new Error('Немає BYBIT_API_KEY / BYBIT_API_SECRET');
    const off = await this.ex.syncTime();
    out.push(`Режим: ${C.mode.toUpperCase()} · стратегія ${C.strategy} (${this.tf}) · профіль ${C.profile.name}: ризик ${pct(C.profile.riskPct)}/угоду, плече ≤${C.profile.maxLev}x, денний ліміт ${pct(C.profile.dailyLossPct)}, kill-switch −${pct(C.profile.maxDdPct)}`);
    if (Math.abs(off) > 3000) out.push(`⚠️ Годинник сервера розходиться з Bybit на ${(off / 1000).toFixed(1)} с (бот компенсує, але налаштуй NTP)`);
    const info = await this.ex.apiInfo();
    if (+info.readOnly === 1) throw new Error('Ключ лише для читання: потрібні права Contract → Orders + Positions');
    const perms = JSON.stringify(info.permissions || {});
    if (/withdraw/i.test(perms)) throw new Error('У ключа є право ВИВОДУ коштів. Створи новий ключ БЕЗ Withdraw — бот з таким не працюватиме');
    const ips = info.ips || [];
    if (!ips.length || ips.includes('*')) {
      if (C.mode === 'live' && !C.allowNoIp) throw new Error("Ключ не прив'язаний до IP. Прив'яжи його до IP свого VPS (або ALLOW_NO_IP=1 на власний ризик)");
      out.push("⚠️ Ключ не прив'язаний до IP");
    } else out.push(`Ключ прив'язаний до IP: ${ips.join(', ')}`);
    await this.ex.oneWayMode();
    const bal = await this.ex.balance();
    out.push(`Капітал: ${usd(bal.equity)} · вільно ${usd(bal.available)}${C.maxCapital ? ` · бот використовує до ${usd(C.maxCapital)}` : ''}`);
    this.universe = await this.loadUniverse();
    for (const s of this.universe) this.specs[s] = await this.ex.instrument(s);
    out.push(`Монети: ${this.universe.join(', ')}`);
    return out;
  }

  async loadUniverse() {
    const m = /^TOP(\d+)$/i.exec(this.C.symbols);
    if (!m) return this.C.symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const list = await this.ex.tickers();
    return list.filter(x => x.symbol.endsWith('USDT') && !isNonCrypto(x.symbol)).sort((a, b) => +b.turnover24h - +a.turnover24h).slice(0, +m[1]).map(x => x.symbol);
  }

  async init() {
    const lines = await this.preflight();
    const s = this.store.load();
    this.state = s && s.v === 1 ? s : { v: 1, guard: null, halted: null, paused: false, pos: {}, journal: [], lastBar: {}, meta: {}, startedAt: this.now() };
    const bal = await this.ex.balance();
    this.guard = new RiskGuard(this.C.profile, bal.equity);
    this.guard.restore(this.state.guard);
    if (this.state.halted) lines.push(`⛔ Бот зупинений: ${this.state.halted.reason}. Відновлення: /resume_confirm`);
    return lines;
  }

  save() { this.state.guard = this.guard.snapshot(); this.store.save(this.state); }

  // Одне опитування: синхронізація з біржею, ризик, стопи, нові свічки, сигнали
  async step() {
    const C = this.C, t = this.now();
    const [bal, list] = await Promise.all([this.ex.balance(), this.ex.positions()]);
    const onEx = new Map(list.filter(p => this.universe.includes(p.sym)).map(p => [p.sym, p]));

    // 1) позиції, що зникли з біржі: стоп/тейк спрацював, або лімітний вхід не виконався
    for (const sym of Object.keys(this.state.pos)) {
      const s = this.state.pos[sym], p = onEx.get(sym);
      if (p) { if (s.limit && !s.filled) { s.filled = true; s.entry = p.entry; s.qty = p.qty; } continue; }
      if (s.limit && !s.filled) {
        if (t >= s.limit.until) { await this.ex.cancelAll(sym).catch(() => {}); delete this.state.pos[sym]; log(`${sym}: лімітний вхід не виконався, скасовано`); }
        continue;
      }
      await this.onClosed(sym, s, t);
    }
    // 2) чужі позиції на монетах бота: не чіпаємо монету
    for (const [sym] of onEx) if (!this.state.pos[sym] && !this.state.meta['foreign:' + sym]) {
      this.state.meta['foreign:' + sym] = t;
      this.tg.send(`⚠️ На ${sym} є позиція, яку відкрив не бот. Не торгую цю монету, поки її не закриєш.`);
    }
    for (const k of Object.keys(this.state.meta)) if (k.startsWith('foreign:') && !onEx.has(k.slice(8))) delete this.state.meta[k];

    // 3) ризик: kill-switch за просіданням і за мінімальним капіталом
    const killed = this.guard.update(bal.equity, t);
    if (!this.state.halted && (killed || (C.minEquity && bal.equity <= C.minEquity)))
      await this.halt(killed ? this.guard.killed.reason : `капітал ${usd(bal.equity)} ≤ мінімуму ${usd(C.minEquity)}`, onEx);

    // 4) жодної позиції без стопа на біржі
    for (const [sym, p] of onEx) { const s = this.state.pos[sym]; if (s && !p.stop && !s.closing) await this.ensureStop(sym, p, s); }

    // 5) нові закриті свічки → супровід позицій і сигнали
    if (!this.state.halted) {
      const closed = Math.floor(t / this.ms) * this.ms - this.ms;
      const cands = [];
      if (t - (closed + this.ms) >= C.barDelayMs) {
        for (const sym of this.universe) {
          if ((this.state.lastBar[sym] || 0) >= closed) continue;
          const done = await this.onBar(sym, closed, onEx.get(sym), t, cands).catch(e => { log(`${sym}: ${e.message}`); return false; });
          if (done) this.state.lastBar[sym] = closed;
        }
      }
      cands.sort((a, b) => (b.sig.score || 0) - (a.sig.score || 0));
      for (const c of cands) {
        if (Object.keys(this.state.pos).length + [...onEx.keys()].filter(s => !this.state.pos[s]).length >= C.profile.maxOpen) { log(`${c.sym}: сигнал пропущено — ліміт ${C.profile.maxOpen} позицій`); break; }
        await this.open(c.sym, c.sig, c.S, bal, t).catch(e => this.tg.send(`❗ ${c.sym}: вхід не вдався — ${e.message}`));
      }
    }
    // 6) щоденний звіт
    const day = kyivDay(t);
    if (kyivHour(t) >= C.reportHour && this.state.meta.reportDay !== day) {
      if (this.state.meta.reportDay) this.tg.send(this.reportText('🗓 Щоденний звіт', bal));
      this.state.meta.reportDay = day;
    }
    this.save();
    return { bal, positions: onEx };
  }

  async onBar(sym, closed, p, t, cands) {
    const rows = (await this.ex.klines(sym, this.tf, 300)).filter(r => r[0] + this.ms <= t);
    if (!rows.length || rows[rows.length - 1][0] < closed) return false; // біржа ще не віддала свічку — спробуємо наступного разу
    const S = toSeries(rows), st = this.make(), i = S.n - 1;
    if (i < st.warm) return true;
    st.prepare(S);
    const s = this.state.pos[sym];
    if (p && s) {
      if (s.closing) return true;
      let bar = S.t.findIndex(x => x >= s.t0);
      if (bar < 0) bar = i;
      let ext = s.entry;
      for (let k = bar; k <= i; k++) ext = s.dir > 0 ? Math.max(ext, S.h[k]) : Math.min(ext, S.l[k]);
      const cur = p.stop || s.stop, m = st.manage(i, S, { dir: s.dir, stop: cur, ext, bar, entry: s.entry });
      if (m && m.exit) await this.close(sym, p, m.exit);
      else if (m && m.stop !== undefined && (s.dir > 0 ? m.stop > cur : m.stop < cur)) {
        const px = roundTick(m.stop, this.specs[sym].tickSize);
        if (s.dir > 0 ? px < p.mark : px > p.mark) { await this.ex.setStop(sym, px); s.stop = px; log(`${sym}: стоп підтягнуто до ${px}`); }
      }
      return true;
    }
    if (p || s || this.state.paused) return true;
    const sig = st.signal(i, S);
    if (!sig) return true;
    const why = this.guard.blocked(t);
    if (why) { log(`${sym}: сигнал заблоковано — ${why}`); return true; }
    cands.push({ sym, sig, S });
    return true;
  }

  async open(sym, sig, S, bal, t) {
    const C = this.C, spec = this.specs[sym] || (this.specs[sym] = await this.ex.instrument(sym));
    const tk = (await this.ex.tickers(sym))[0];
    const bid = +tk.bid1Price, ask = +tk.ask1Price, spread = (ask - bid) / ((ask + bid) / 2);
    if (!(spread >= 0) || spread > C.maxSpread) return log(`${sym}: спред ${pct(spread, 2)} завеликий, пропуск`);
    const px = sig.entry === 'limit' ? sig.limit : sig.dir > 0 ? ask : bid;
    if (sig.dir > 0 ? sig.stop >= px : sig.stop <= px) return log(`${sym}: ціна вже за стопом, пропуск`);
    const equity = C.maxCapital ? Math.min(bal.equity, C.maxCapital) : bal.equity;
    const z = sizeOrder({ equity, price: px, stop: sig.stop, profile: C.profile, spec, slip: 0.0005 });
    if (z.reject) return log(`${sym}: ${z.reject}`);
    const lev = Math.max(1, Math.min(z.lev, spec.maxLev || z.lev));
    if (z.notional / lev > bal.available * 0.9) return log(`${sym}: бракує вільної маржі`);
    await this.ex.setLeverage(sym, lev);
    const stop = roundTick(sig.stop, spec.tickSize), tp = sig.tp ? roundTick(sig.tp, spec.tickSize) : 0;
    const link = `ob${t.toString(36)}${sym}`.slice(0, 36);
    const o = {
      symbol: sym, side: sig.dir > 0 ? 'Buy' : 'Sell', orderType: 'Market', qty: fmtStep(z.qty, spec.qtyStep),
      stopLoss: fmtTick(stop, spec.tickSize), takeProfit: tp ? fmtTick(tp, spec.tickSize) : undefined,
      tpslMode: 'Full', slTriggerBy: 'LastPrice', tpTriggerBy: tp ? 'LastPrice' : undefined, orderLinkId: link,
    };
    if (sig.entry === 'limit') Object.assign(o, { orderType: 'Limit', price: fmtTick(sig.limit, spec.tickSize), timeInForce: 'PostOnly' });
    await this.ex.order(o);
    this.state.pos[sym] = {
      dir: sig.dir, qty: z.qty, entry: px, stop, tp, t0: S.t[S.n - 1] + this.ms, why: sig.why, link, opened: t, lev,
      limit: sig.entry === 'limit' ? { until: t + this.ms } : null, filled: sig.entry !== 'limit',
    };
    this.tg.send([
      `${sig.dir > 0 ? '🟢 LONG' : '🔴 SHORT'} ${sym} · ${C.mode.toUpperCase()}`,
      `Причина: ${sig.why}`,
      `Обсяг ${o.qty} (~${usd(z.notional)}), плече ${lev}x · вхід ~${px}`,
      `Стоп ${o.stopLoss} (−${pct(z.dist, 2)}, ризик ${pct(z.risk, 2)} капіталу ≈ ${usd(z.risk * equity)})${tp ? ` · тейк ${o.takeProfit}` : ' · далі трейлінг'}`,
    ].join('\n'));
  }

  async onClosed(sym, s, t) {
    delete this.state.pos[sym];
    let rec = [];
    try { rec = (await this.ex.closedPnl(sym, s.opened - 6e4)).filter(x => x.t >= s.opened - 6e4); } catch (e) { log(`${sym}: closed-pnl недоступний — ${e.message}`); }
    if (!rec.length) { log(`${sym}: позиції немає і закритого PnL теж — вхід не виконався`); return; }
    const pnl = rec.reduce((a, x) => a + x.pnl, 0), qty = rec.reduce((a, x) => a + x.qty, 0);
    const exit = rec.reduce((a, x) => a + x.exit * x.qty, 0) / (qty || 1);
    const near = (a, b) => b && Math.abs(a - b) / b < 0.004;
    const reason = s.closing || (near(exit, s.stop) ? 'стоп' : near(exit, s.tp) ? 'тейк' : 'закрито на біржі');
    this.guard.onClosed(pnl, t);
    this.state.journal.push({ sym, dir: s.dir, entry: s.entry, exit, qty, pnl, reason, t0: s.opened, t1: t, why: s.why });
    if (this.state.journal.length > 2000) this.state.journal.splice(0, this.state.journal.length - 2000);
    this.tg.send(`${pnl > 0 ? '✅' : '❌'} ${sym} ${s.dir > 0 ? 'LONG' : 'SHORT'} закрито: ${sgn(pnl)} · ${reason} · вихід ${+exit.toFixed(6)}${this.guard.blocked(t) ? `\n⏸ ${this.guard.blocked(t)}` : ''}`);
  }

  async close(sym, p, reason) {
    const s = this.state.pos[sym];
    if (s) s.closing = reason;
    await this.ex.cancelAll(sym).catch(() => {});
    const spec = this.specs[sym] || {};
    await this.ex.order({
      symbol: sym, side: p.dir > 0 ? 'Sell' : 'Buy', orderType: 'Market',
      qty: spec.qtyStep ? fmtStep(p.qty, spec.qtyStep) : String(p.qty), reduceOnly: true, orderLinkId: `oc${this.now().toString(36)}${sym}`.slice(0, 36),
    });
    log(`${sym}: закриття (${reason})`);
  }

  async ensureStop(sym, p, s) {
    const stop = s.stop;
    if (stop && (p.dir > 0 ? stop < p.mark : stop > p.mark)) {
      await this.ex.setStop(sym, fmtTick(stop, this.specs[sym].tickSize));
      this.tg.send(`🛡 ${sym}: на біржі не було стопа — поставив ${stop}`);
    } else {
      await this.close(sym, p, 'ціна вже за стопом');
      this.tg.send(`🛡 ${sym}: стоп зник, а ціна вже за ним — закриваю за ринком`);
    }
  }

  async halt(reason, onEx) {
    this.state.halted = { t: this.now(), reason };
    for (const [sym, s] of Object.entries(this.state.pos)) if (s.limit && !s.filled) { await this.ex.cancelAll(sym).catch(() => {}); delete this.state.pos[sym]; }
    for (const [sym, p] of onEx || []) if (this.state.pos[sym]) await this.close(sym, p, 'kill-switch').catch(e => this.tg.send(`❗ ${sym}: не вдалося закрити — ${e.message}. ЗАКРИЙ ВРУЧНУ!`));
    this.tg.send(`⛔ KILL-SWITCH: ${reason}.\nУсі позиції бота закриваю, нові угоди зупинено.\nВідновити: /resume_confirm (тільки якщо розумієш, чому так сталося).`);
    this.save();
  }

  stats() {
    const j = this.state.journal, n = j.length, w = j.filter(x => x.pnl > 0).length;
    const tot = j.reduce((a, x) => a + x.pnl, 0), gp = j.filter(x => x.pnl > 0).reduce((a, x) => a + x.pnl, 0), gl = -j.filter(x => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
    return { n, w, tot, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0 };
  }

  reportText(title, bal) {
    const s = this.stats(), open = Object.entries(this.state.pos);
    return [
      `${title} · ${this.C.mode.toUpperCase()} · ${this.C.strategy}`,
      bal ? `Капітал ${usd(bal.equity)} · пік ${usd(this.guard.peak)} · просідання ${pct(1 - bal.equity / this.guard.peak)} (kill −${pct(this.C.profile.maxDdPct)})` : null,
      `Угод ${s.n} · виграшних ${s.n ? pct(s.w / s.n, 0) : '—'} · разом ${sgn(s.tot)} · PF ${Number.isFinite(s.pf) ? s.pf.toFixed(2) : '∞'}`,
      `Відкрито: ${open.length ? open.map(([k, v]) => `${k} ${v.dir > 0 ? 'L' : 'S'} стоп ${v.stop}`).join(', ') : 'немає'}`,
      this.state.halted ? `⛔ Зупинено: ${this.state.halted.reason}` : this.state.paused ? '⏸ Нові входи на паузі' : this.guard.blocked(this.now()) ? `⏸ ${this.guard.blocked(this.now())}` : '▶️ Працює',
    ].filter(Boolean).join('\n');
  }

  async command(text) {
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    if (cmd === '/start' || cmd === '/help') return this.tg.send('/status · /pnl · /pause · /resume · /stop (закрити все й зупинитись) · /resume_confirm (після kill-switch)');
    if (cmd === '/status' || cmd === '/pnl') { const bal = await this.ex.balance(); return this.tg.send(this.reportText('📊 Стан', bal)); }
    if (cmd === '/pause') { this.state.paused = true; this.save(); return this.tg.send('⏸ Нові входи зупинено. Відкриті позиції зі стопами працюють далі.'); }
    if (cmd === '/resume') { this.state.paused = false; this.save(); return this.tg.send('▶️ Нові входи дозволено.'); }
    if (cmd === '/stop') { const list = await this.ex.positions(); return this.halt('ручна зупинка /stop', new Map(list.map(p => [p.sym, p]))); }
    if (cmd === '/resume_confirm') {
      const bal = await this.ex.balance();
      this.state.halted = null; this.guard.killed = null; this.guard.peak = bal.equity; this.guard.dayHit = false; this.save();
      return this.tg.send(`▶️ Відновлено. Новий пік для kill-switch: ${usd(bal.equity)}.`);
    }
  }
}

// ===================== ЗАПУСК =====================
async function main(cmd) {
  const C = makeConfig();
  const ex = new Bybit({ key: C.key, secret: C.secret, base: C.tradeBase, dataBase: C.dataBase });
  const tg = new TG(C), store = new FileStore(C.dir), bot = new Bot(C, { ex, tg, store });
  if (cmd === 'check') { for (const l of await bot.preflight()) console.log(l); console.log('✅ Перевірку пройдено. Угоди не відкривались.'); return; }
  if (cmd === 'status') {
    const st = store.load();
    if (!st) return console.log('Стану ще немає.');
    bot.state = st; bot.guard = new RiskGuard(C.profile, 0); bot.guard.restore(st.guard);
    console.log(bot.reportText('📊 Стан', null));
    for (const x of st.journal.slice(-20)) console.log(`${new Date(x.t1).toISOString().slice(0, 16)} ${x.sym} ${x.dir > 0 ? 'L' : 'S'} ${sgn(x.pnl)} ${x.reason}`);
    return;
  }
  if (cmd === 'flatten') {
    await bot.init();
    const list = await ex.positions();
    await bot.halt('ручна аварійна зупинка (flatten)', new Map(list.map(p => [p.sym, p])));
    await sleep(3000);
    return;
  }
  if (cmd !== 'run') { console.log('Використання: node bybit/bot.mjs check | run | status | flatten'); process.exitCode = 1; return; }
  const lines = await bot.init();
  for (const l of lines) log(l);
  tg.send(`🤖 Bybit-бот запущено\n${lines.join('\n')}\n/help — команди`);
  if (tg.enabled()) tg.poll(t => bot.command(t));
  let stop = false;
  process.once('SIGINT', () => (stop = true));
  process.once('SIGTERM', () => (stop = true));
  while (!stop) {
    try { await bot.step(); bot.errors = 0; }
    catch (e) {
      bot.errors++;
      log('Помилка кроку:', e.message);
      if (bot.errors === 5) tg.send(`❗ 5 помилок поспіль: ${e.message}. Стопи стоять на біржі, позиції захищені.`);
      if (bot.errors === 20 && !bot.state.paused) { bot.state.paused = true; bot.save(); tg.send('⏸ 20 помилок поспіль — нові входи зупинено. Перевір VPS і ключ.'); }
    }
    for (let k = 0; k < C.pollSec * 10 && !stop; k++) await sleep(100);
  }
  tg.stopped = true;
  bot.save();
  tg.send('⏹ Бот зупинено (позиції зі стопами на біржі лишаються).');
  await sleep(2500);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main(process.argv[2]).then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('⛔', e.message); process.exit(1); });
