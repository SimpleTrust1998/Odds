// ===================== PUMP.FUN ТРЕКЕР =====================
// Стежить за новими монетами pump.fun у реальному часі (PumpPortal WebSocket), рахує метрики
// імпульсу й ризику (холдери, топ-10, dev, снайпери, «невидимі» бандл-покупки), шле алерти в Telegram
// і веде paper-trading: віртуальні угоди з реалістичними комісіями, сліпеджем і затримкою виконання.
//
// Бот лише ЧИТАЄ публічні дані. Приватний ключ гаманця йому не потрібен і ніколи не буде потрібен.
//
//   node pumpfun/tracker.mjs live              стрім + алерти + paper-trading (+ запис подій, якщо задано RECORD_FILE)
//   node pumpfun/tracker.mjs record [файл]     лише збір даних для бектесту, без алертів
//   node pumpfun/tracker.mjs replay <файл>     бектест: прогнати записані події через ту саму логіку
//   node pumpfun/tracker.mjs report [--csv]    звіт paper-журналу (контрольна точка №1 плану)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ENV = process.env;
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MINUTE = 6e4;
const JOURNAL_MAX = 1500; // файл стану має лишатися < 1 МБ (ліміт GitHub Contents API)

// ---------- налаштування (усе можна змінити змінними середовища) ----------
export function makeConfig(env = ENV) {
  return {
    wsUrl: env.PUMPPORTAL_WS || 'wss://pumpportal.fun/api/data',
    pools: (env.POOLS || 'pump').split(',').map(s => s.trim()).filter(Boolean),
    // крива pump.fun: 1 млрд токенів, ~793,1 млн продаються на кривій (перевір, якщо платформа змінить параметри)
    supply: num(env.SUPPLY, 1e9),
    curveTok: num(env.CURVE_TOKENS, 793.1e6),
    initVTok: num(env.INIT_VTOKENS, 1073e6),
    // відстеження
    trackMin: num(env.TRACK_MIN, 15),            // скільки хвилин стежити за звичайною новою монетою
    trackMaxMin: num(env.TRACK_MAX_MIN, 180),    // максимум для «гарячих» монет
    maxTracked: num(env.MAX_TRACKED, 800),       // скільки монет одночасно в пам'яті
    deadSec: num(env.DEAD_SEC, 180),             // якщо за стільки секунд після створення трейдів мало —
    deadTrades: num(env.DEAD_TRADES, 10),        // …монета вважається мертвою і відписується
    windowSec: num(env.WINDOW_SEC, 300),         // вікно імпульсу (5 хв)
    earlySec: num(env.EARLY_SEC, 3),             // покупці перших N секунд = снайпери
    enrichWaitSec: num(env.ENRICH_WAIT_SEC, 8),  // скільки чекати перевірку соцмереж/RPC перед алертом
    // фільтри: будь-який спрацював — сигналу немає
    minAgeSec: num(env.MIN_AGE_SEC, 90),
    minHolders: num(env.MIN_HOLDERS, 40),
    minBuyers5: num(env.MIN_BUYERS_5M, 15),
    minProgress: num(env.MIN_PROGRESS, 0.15),
    maxProgress: num(env.MAX_PROGRESS, 0.97),
    maxTop10: num(env.MAX_TOP10, 0.30),
    maxHidden: num(env.MAX_HIDDEN, 0.20),
    maxDevSold: num(env.MAX_DEV_SOLD, 0.5),
    maxAthDrop: num(env.MAX_ATH_DROP, 0.5),
    serialN: num(env.SERIAL_N, 5),
    alertScore: num(env.ALERT_SCORE, 60),
    // paper-trading (правила з розділу 6 плану)
    paper: env.PAPER !== '0',
    paperSol: num(env.PAPER_SOL, 0.16),          // ≈ 10 € при SOL ≈ 62 € (листопад 2026) — розмір однієї віртуальної угоди
    maxOpen: num(env.MAX_OPEN, 3),
    dailyLossSol: num(env.DAILY_LOSS_SOL, 0.16), // ≈ 10 € — денний ліміт втрат
    bankSol: num(env.BANK_SOL, 0.96),            // ≈ 60 € — банк лабораторії (перерахуй під поточний курс SOL)
    curveFee: num(env.CURVE_FEE, 0.0125),        // комісія кривої pump.fun (протокол + творець)
    terminalFee: num(env.TERMINAL_FEE, 0.01),    // комісія терміналу / Telegram-бота
    postFee: num(env.POST_FEE, 0.013),           // після міграції: AMM + термінал
    prioritySol: num(env.PRIORITY_SOL, 0.001),   // priority fee + Jito tip за транзакцію
    fillDelaySec: num(env.FILL_DELAY_SEC, 8),    // реакція людини: угода виконується через N секунд після рішення
    stopLoss: num(env.STOP_LOSS, 0.35),
    tp1: num(env.TP1, 2.0),
    tp1Frac: num(env.TP1_FRACTION, 0.5),
    trailArm: num(env.TRAIL_ARM, 1.3),
    trail: num(env.TRAIL, 0.30),
    timeStopMin: num(env.TIME_STOP_MIN, 20),
    maxHoldMin: num(env.MAX_HOLD_MIN, 180),
    dexWaitMin: num(env.DEX_WAIT_MIN, 5),
    // контрольна точка №1
    gateN: num(env.GATE_N, 100),
    gateEv: num(env.GATE_EV, 0.05),
    gateDd: num(env.GATE_DD, 0.30),
    // сповіщення
    tgToken: env.TELEGRAM_BOT_TOKEN || '',
    tgChat: env.TELEGRAM_CHAT_ID || '',
    tgBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    tgCommands: env.TG_COMMANDS !== '0',
    paperNotify: env.PAPER_NOTIFY !== '0',
    maxAlertsPerHour: num(env.MAX_ALERTS_PER_HOUR, 6),
    quiet: env.QUIET_HOURS || '0-0',             // «23-8» = тихі години за Києвом; «0-0» = вимкнено
    reportHour: num(env.REPORT_HOUR, 9),
    watchMove: num(env.WATCH_MOVE, 0.2),
    walletMinSol: num(env.WALLET_MIN_SOL, 0.3),
    // зовнішні дані
    rpcUrl: env.RPC_URL || '',
    fetchMeta: env.FETCH_META !== '0',
    ipfsGateway: env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/',
    dexBase: env.DEXSCREENER_BASE || 'https://api.dexscreener.com',
    binanceBase: env.BINANCE_BASE || 'https://data-api.binance.vision',
    // запуск і стан
    maxMinutes: num(env.MAX_MINUTES, 0),         // 0 = працювати безкінечно (VPS); на GitHub Actions ≤ 345
    dir: env.STATE_DIR || 'pumpfun/data',
    stateFile: 'pumpfun_state.json',
    recordFile: env.RECORD_FILE || '',
  };
}
export const CFG = makeConfig();

// ---------- математика кривої: constant product на віртуальних резервах ----------
export function simBuy(vSol, vTok, solIn, fee) {
  const net = solIn * (1 - fee);
  return net > 0 && vSol > 0 && vTok > 0 ? vTok - (vSol * vTok) / (vSol + net) : 0;
}
export function simSell(vSol, vTok, tokIn, fee) {
  if (!(tokIn > 0 && vSol > 0 && vTok > 0)) return 0;
  return (vSol - (vSol * vTok) / (vTok + tokIn)) * (1 - fee);
}
// Продаж після міграції за даними DexScreener (ціна в SOL + резерв базового токена в пулі)
export function dexSell(info, tokIn, fee) {
  if (!(tokIn > 0 && info && info.price > 0)) return 0;
  const gross = info.liqBase > 0 ? tokIn * info.price * info.liqBase / (info.liqBase + tokIn) : tokIn * info.price * 0.99;
  return gross * (1 - fee);
}

// ---------- час (Київ) ----------
const kyivDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });
const kyivHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', hour: 'numeric', hourCycle: 'h23' });
export const kyivDay = ms => kyivDayFmt.format(new Date(ms));
export const kyivHour = ms => +kyivHourFmt.format(new Date(ms));
export function inQuiet(ms, spec) {
  const [a, b] = String(spec).split('-').map(Number);
  if (!(a >= 0 && a < 24 && b >= 0 && b < 24) || a === b) return false;
  const h = kyivHour(ms);
  return a < b ? h >= a && h < b : h >= a || h < b;
}

export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

// Назви монет пишуть скамери: прибираємо посилання й домени, щоб у Telegram не було клікабельного фішингу
export function cleanText(s, max = 40) {
  return String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[посилання]')
    .replace(/\b[\w-]+(\.[\w-]+)*\.(com|io|xyz|fun|app|net|org|gg|me|co|ai|so|to|site|online|live|pro|vip|top|info|link|click)\b/gi, '[посилання]')
    .trim().slice(0, max);
}

// ===================== ЯДРО: стан монет, сигнали, paper-trading =====================
// Чиста логіка без мережі: час передається явно, тож однаково працює наживо, у бектесті й у тестах.
export class Engine {
  constructor(C, deps = {}) {
    this.C = C;
    this.d = { emit() {}, subscribe() {}, unsubscribe() {}, enrich: null, dex: false, ...deps };
    this.tokens = new Map();     // mint → стан монети
    this.positions = [];         // відкриті paper-позиції
    this.journal = [];           // закриті paper-угоди
    this.watch = new Map();      // mint → { mint, addedAt, ref }
    this.wallets = new Map();    // адреса → мітка
    this.creators = new Map();   // деплоєр → [час створення монет за 24 год]
    this.seen = new Map();       // дедуплікація подій
    this.day = { key: '', pnl: 0, hit: false };
    this.cumPnl = 0;
    this.closedCount = 0;
    this.bankHit = null;
    this.meta = {};
    this.stats = { created: 0, trades: 0, signals: 0, migrations: 0, since: 0 };
  }

  // ----- події PumpPortal -----
  onMessage(m, t) {
    if (!m || typeof m !== 'object' || typeof m.mint !== 'string') return;
    if (!this.stats.since) this.stats.since = t;
    const tx = String(m.txType || '');
    if (tx.startsWith('migrat')) return this.onMigrate(m, t);
    if (m.pool && !this.C.pools.includes(m.pool)) {
      if (String(m.pool).includes('amm') && this.tokens.has(m.mint)) this.onMigrate(m, t);
      return;
    }
    if (m.signature) {
      const key = `${m.signature}|${m.mint}|${m.traderPublicKey}|${tx}|${m.tokenAmount}`;
      if (this.seen.has(key)) return;
      this.seen.set(key, 1);
      if (this.seen.size > 50000) { const it = this.seen.keys(); for (let i = 0; i < 10000; i++) this.seen.delete(it.next().value); }
    }
    if (tx === 'create') return this.onCreate(m, t);
    if (tx === 'buy' || tx === 'sell') return this.onTrade(m, t);
  }

  newToken(mint, t, o = {}) {
    const vSol = o.vSol || 0, vTok = o.vTok || 0, p = vSol > 0 && vTok > 0 ? vSol / vTok : 0;
    return {
      mint, name: o.name || '', symbol: o.symbol || '', uri: o.uri || '', creator: o.creator || '', curveKey: o.curveKey || '',
      createdAt: t, seenCreate: !!o.seenCreate, initVTok: o.initVTok || this.C.initVTok,
      vSol, vTok, price: p, ath: p, athAt: t, lastTradeAt: t,
      trades: 0, buys: 0, sells: 0, buySol: 0, sellSol: 0,
      holders: new Map(), early: new Set(), devMax: o.devInit || 0, creatorCount: 1,
      win: [], dirty: true, migrated: false, migratedAt: 0, alerted: false, notified: false, devDumped: false,
      keepUntil: t + this.C.trackMin * MINUTE, score: 0, blockers: [], flags: [], m: null,
      enrich: null, enrichAt: 0, info: null,
    };
  }

  onCreate(m, t) {
    if (this.tokens.has(m.mint)) return;
    const vSol = +m.vSolInBondingCurve, vTok = +m.vTokensInBondingCurve;
    if (!(vSol > 0 && vTok > 0)) return; // монети з іншою котирувальною валютою (напр. USDC) поки не підтримуються
    this.stats.created++;
    const dev = String(m.traderPublicKey || ''), init = Math.max(0, +m.initialBuy || 0);
    const tok = this.newToken(m.mint, t, {
      name: cleanText(m.name), symbol: cleanText(m.symbol, 16), uri: m.uri, creator: dev, curveKey: m.bondingCurveKey,
      vSol, vTok, seenCreate: true, devInit: init, initVTok: vTok + init, // калібрування: резерв до покупки dev
    });
    if (init >= 1) tok.holders.set(dev, init);
    const arr = (this.creators.get(dev) || []).filter(x => t - x < 864e5);
    arr.push(t);
    this.creators.delete(dev);
    this.creators.set(dev, arr);
    if (this.creators.size > 100000) { const it = this.creators.keys(); for (let i = 0; i < 20000; i++) this.creators.delete(it.next().value); }
    tok.creatorCount = arr.length;
    this.tokens.set(m.mint, tok);
    this.d.subscribe(m.mint);
    if (this.tokens.size > this.C.maxTracked) this.evictOne();
  }

  hasPos(mint) { return this.positions.some(p => p.mint === mint && !p.closed); }
  keep(tok) { return this.watch.has(tok.mint) || this.hasPos(tok.mint); }

  onTrade(m, t) {
    let tok = this.tokens.get(m.mint);
    const trader = String(m.traderPublicKey || ''), side = m.txType, sol = Math.max(0, +m.solAmount || 0);
    if (!tok && (this.watch.has(m.mint) || this.hasPos(m.mint))) { tok = this.newToken(m.mint, t); this.tokens.set(m.mint, tok); }
    if (this.wallets.has(trader) && sol >= this.C.walletMinSol)
      this.d.emit('wallet', { wallet: trader, label: this.wallets.get(trader), side, sol, mint: m.mint, symbol: tok?.symbol || '', t });
    if (!tok) return;
    this.stats.trades++;
    const vSol = +m.vSolInBondingCurve, vTok = +m.vTokensInBondingCurve;
    if (vSol > 0 && vTok > 0) {
      tok.vSol = vSol; tok.vTok = vTok; tok.price = vSol / vTok;
      if (tok.price > tok.ath) { tok.ath = tok.price; tok.athAt = t; }
    }
    const prev = tok.holders.get(trader) || 0, bal = +m.newTokenBalance;
    const nb = Number.isFinite(bal) && m.newTokenBalance !== null && m.newTokenBalance !== '' ? bal
      : Math.max(0, prev + (side === 'buy' ? 1 : -1) * (+m.tokenAmount || 0));
    if (nb >= 1) tok.holders.set(trader, nb); else tok.holders.delete(trader);
    if (side === 'buy') {
      tok.buys++; tok.buySol += sol;
      if (trader !== tok.creator && tok.seenCreate && t - tok.createdAt <= this.C.earlySec * 1000) tok.early.add(trader);
    } else { tok.sells++; tok.sellSol += sol; }
    if (trader === tok.creator) tok.devMax = Math.max(tok.devMax, nb);
    tok.trades++; tok.lastTradeAt = t; tok.dirty = true;
    tok.win.push({ t, buy: side === 'buy', sol, trader, price: tok.price });
    if (tok.win.length > 4000) this.pruneWin(tok, t);
    if (trader === tok.creator && side === 'sell' && tok.devMax > 0 && !tok.devDumped && 1 - nb / tok.devMax >= this.C.maxDevSold) {
      tok.devDumped = true;
      if (tok.alerted || this.keep(tok)) this.d.emit('dev_dump', { tok, t, soldFrac: 1 - nb / tok.devMax });
    }
    if (tok.price > 0) this.onPrice(tok, t, tok.price, 'curve');
  }

  onMigrate(m, t) {
    this.stats.migrations++;
    const tok = this.tokens.get(m.mint);
    if (!tok || tok.migrated) return;
    tok.migrated = true; tok.migratedAt = t; tok.dirty = true;
    if (tok.alerted || this.keep(tok)) this.d.emit('migration', { tok, t });
    for (const p of this.positions) {
      if (p.mint !== tok.mint || p.closed) continue;
      p.migratedAt = t;
      if (p.state === 'pending') { p.closed = true; p.cancelled = 'міграція до входу'; continue; }
      if (this.d.dex) p.dex = true;
      else { p.exit = p.exit || { at: t, frac: 1, reason: 'міграція' }; this.fillExit(p, tok, t); }
    }
  }

  // Ціна після міграції (DexScreener), або ціна монет зі списку /watch
  onDexPrice(mint, info, t) {
    const tok = this.tokens.get(mint);
    if (!tok || !(info && info.price > 0)) return;
    if (!tok.symbol && info.symbol) tok.symbol = cleanText(info.symbol, 16);
    if (!tok.name && info.name) tok.name = cleanText(info.name);
    for (const p of this.positions) {
      if (p.mint !== mint || p.closed) continue;
      if (p.restored && !(tok.vSol > 0)) p.dex = true; // після рестарту монета могла мігрувати, поки бот спав
      if (p.dex) { p.dexInfo = info; p.dexSeen = true; }
    }
    this.onPrice(tok, t, info.price, 'dex');
  }

  onPrice(tok, t, price, src) {
    for (const p of this.positions) if (p.mint === tok.mint && !p.closed && (src === 'dex') === !!p.dex) this.stepPos(p, tok, t, price);
    const w = this.watch.get(tok.mint);
    if (w && price > 0) {
      if (!w.ref) w.ref = price;
      else if (Math.abs(price / w.ref - 1) >= this.C.watchMove) {
        this.d.emit('watch_move', { w, tok, t, price, ch: price / w.ref - 1 });
        w.ref = price;
      }
    }
  }

  // ----- метрики й оцінка -----
  pruneWin(tok, t) {
    const lim = t - this.C.windowSec * 1000;
    let i = 0;
    while (i < tok.win.length && tok.win[i].t < lim) i++;
    if (i) tok.win.splice(0, i);
  }

  metrics(tok, t) {
    const C = this.C, S = C.supply;
    this.pruneWin(tok, t);
    const bals = [...tok.holders.values()];
    let seen = 0;
    for (const b of bals) seen += b;
    bals.sort((a, b) => b - a);
    let top10 = 0;
    for (let i = 0; i < Math.min(10, bals.length); i++) top10 += bals[i];
    const devBal = tok.holders.get(tok.creator) || 0;
    let earlyBal = 0;
    for (const a of tok.early) earlyBal += tok.holders.get(a) || 0;
    const sold = Math.max(0, tok.initVTok - tok.vTok); // скільки токенів вийшло з кривої
    const buyers = new Set(), traders = new Set();
    let bSol = 0, sSol = 0;
    for (const x of tok.win) {
      traders.add(x.trader);
      if (x.buy) { buyers.add(x.trader); bSol += x.sol; } else sSol += x.sol;
    }
    const p0 = tok.win.length ? tok.win[0].price : tok.price;
    return {
      age: (t - tok.createdAt) / 1000,
      progress: clamp((tok.initVTok - tok.vTok) / C.curveTok, 0, 1),
      mcapSol: tok.price * S,
      holders: bals.length,
      top10: top10 / S,
      devPct: devBal / S,
      devSold: tok.devMax > 0 ? Math.max(0, 1 - devBal / tok.devMax) : 0,
      earlyPct: earlyBal / S,
      // токени, що вийшли з кривої, але чиїх покупок ми не бачили: покупки в блоці створення (бандл/снайпери)
      hiddenPct: tok.seenCreate ? Math.max(0, sold - seen) / S : null,
      buyers5: buyers.size,
      trades5: tok.win.length,
      buySol5: bSol, sellSol5: sSol, net5: bSol - sSol,
      bs: bSol / Math.max(sSol, 0.01),
      diversity: tok.win.length ? traders.size / tok.win.length : 0,
      ch5: p0 > 0 ? tok.price / p0 - 1 : 0,
      athDrop: tok.ath > 0 ? 1 - tok.price / tok.ath : 0,
    };
  }

  assess(tok, t) {
    const C = this.C, m = this.metrics(tok, t), B = [], F = [], info = tok.info;
    if (!tok.seenCreate) B.push('немає даних із моменту створення');
    if (tok.migrated) B.push('вже мігрувала');
    if (m.age < C.minAgeSec) B.push(`вік < ${C.minAgeSec} с`);
    if (m.holders < C.minHolders) B.push(`холдерів < ${C.minHolders}`);
    if (m.buyers5 < C.minBuyers5) B.push(`покупців за 5 хв < ${C.minBuyers5}`);
    if (m.progress < C.minProgress) B.push(`крива < ${pct(C.minProgress)}`);
    if (m.progress > C.maxProgress) B.push('крива майже заповнена');
    if (m.top10 > C.maxTop10) B.push(`топ-10 ${pct(m.top10)}`);
    if (m.hiddenPct !== null && m.hiddenPct > C.maxHidden) B.push(`невидимі покупки ${pct(m.hiddenPct)} (бандл?)`);
    if (m.devSold >= C.maxDevSold) B.push(`dev продав ${pct(m.devSold)}`);
    if (m.athDrop > C.maxAthDrop) B.push(`−${pct(m.athDrop)} від піку`);
    if (tok.creatorCount >= C.serialN) B.push(`серійний деплоєр (${tok.creatorCount} за 24 год)`);
    if (info && info.rpcTop10 != null && info.rpcTop10 > C.maxTop10) B.push(`RPC: топ-10 ${pct(info.rpcTop10)}`);

    let s = 25 * Math.min(1, m.buyers5 / 30)
      + 20 * clamp(m.net5 / 8, 0, 1)
      + 15 * Math.min(1, m.progress / 0.6)
      + 10 * Math.min(1, m.holders / 120)
      + 15 * (1 - clamp((m.top10 - 0.10) / 0.25, 0, 1))
      + 5 * clamp((m.diversity - 0.3) / 0.4, 0, 1);
    const soc = info && info.socials;
    if (!soc) s += 5; // не перевірялось — нейтрально
    else {
      const k = (soc.twitter ? 1 : 0) + (soc.telegram ? 1 : 0) + (soc.website ? 1 : 0);
      s += [0, 6, 9, 10][k];
      if (!k) F.push('немає соцмереж');
    }
    if (m.hiddenPct > 0.10) { s -= 10; F.push(`невидимі покупки ${pct(m.hiddenPct)}`); }
    if (m.earlyPct > 0.20) { s -= 10; F.push(`снайпери тримають ${pct(m.earlyPct)}`); }
    if (m.devPct > 0.05) { s -= 5; F.push(`dev тримає ${pct(m.devPct)}`); }
    if (m.devSold > 0.2 && m.devSold < C.maxDevSold) F.push(`dev продав ${pct(m.devSold)}`);
    if (m.athDrop > 0.4) { s -= 15; F.push(`−${pct(m.athDrop)} від піку`); }
    if (m.diversity < 0.3 && m.trades5 > 30) F.push('мало унікальних трейдерів (wash?)');
    if (tok.creatorCount >= 3 && tok.creatorCount < C.serialN) { s -= 10; F.push(`деплоєр: ${tok.creatorCount} монет за 24 год`); }
    return { score: Math.round(clamp(s, 0, 100)), blockers: B, flags: F, m };
  }

  startEnrich(tok, t) {
    tok.enrich = 'pending'; tok.enrichAt = t;
    Promise.resolve()
      .then(() => this.d.enrich(tok))
      .then(info => { tok.info = info || {}; }, () => { tok.info = {}; })
      .finally(() => { tok.enrich = 'done'; tok.dirty = true; });
  }

  signal(tok, r, t) {
    tok.alerted = true;
    tok.keepUntil = t + this.C.trackMaxMin * MINUTE;
    this.stats.signals++;
    if (tok.enrich === 'pending') r.flags.push('соцмережі/RPC не встигли перевірити');
    const pos = this.C.paper ? this.openPos(tok, r, t) : null;
    this.d.emit('alert', { tok, r, t, pos });
  }

  tick(t) {
    const C = this.C;
    for (const tok of this.tokens.values()) {
      if (!tok.dirty) continue;
      tok.dirty = false;
      const r = this.assess(tok, t);
      tok.score = r.score; tok.blockers = r.blockers; tok.flags = r.flags; tok.m = r.m;
      if (tok.alerted || r.blockers.length) continue;
      if (r.score >= 40) tok.keepUntil = Math.max(tok.keepUntil, Math.min(t + 10 * MINUTE, tok.createdAt + C.trackMaxMin * MINUTE));
      if (r.score < C.alertScore - 10) continue;
      if (this.d.enrich && !tok.enrich) this.startEnrich(tok, t);
      if (r.score < C.alertScore) continue;
      if (tok.enrich === 'pending' && t - tok.enrichAt < C.enrichWaitSec * 1000) { tok.dirty = true; continue; }
      this.signal(tok, r, t);
    }
    for (const tok of [...this.tokens.values()]) {
      if (this.keep(tok)) continue;
      const dead = tok.seenCreate && !tok.alerted && t - tok.createdAt > C.deadSec * 1000 && tok.trades < C.deadTrades;
      if (dead || t > tok.keepUntil || (tok.migrated && t - tok.migratedAt > MINUTE)) this.drop(tok);
    }
    for (const p of this.positions) if (!p.closed) this.tickPos(p, t);
    this.positions = this.positions.filter(p => !p.closed);
  }

  drop(tok) { this.tokens.delete(tok.mint); this.d.unsubscribe(tok.mint); }
  evictOne() {
    let worst = null;
    for (const tok of this.tokens.values()) {
      if (this.keep(tok) || tok.alerted) continue;
      if (!worst || tok.lastTradeAt < worst.lastTradeAt) worst = tok;
    }
    if (worst) this.drop(worst);
  }
  top(n = 5) {
    return [...this.tokens.values()].filter(x => x.seenCreate && !x.migrated && x.m).sort((a, b) => b.score - a.score).slice(0, n);
  }

  // ----- paper-trading -----
  rollDay(t) {
    const k = kyivDay(t);
    if (this.day.key !== k) this.day = { key: k, pnl: 0, hit: false };
  }

  openPos(tok, r, t) {
    const C = this.C;
    this.rollDay(t);
    if (this.day.hit) return { skip: 'денний ліміт втрат' };
    if (this.positions.filter(p => !p.closed).length >= C.maxOpen) return { skip: `уже ${C.maxOpen} відкриті позиції` };
    const p = {
      id: `${t}-${tok.mint.slice(0, 6)}`, mint: tok.mint, symbol: tok.symbol, name: tok.name,
      signalAt: t, fillAt: t + C.fillDelaySec * 1000, openedAt: 0, state: 'pending', size: C.paperSol,
      tokens: 0, left: 0, realized: 0, ref: 0, peak: 1, peakAt: t, tp1: false, exit: null,
      score: r.score, flags: r.flags.slice(0, 4), dex: false, migratedAt: 0, closed: false,
      entryMcap: 0, lastPrice: tok.price, reasons: [],
    };
    this.positions.push(p);
    return { pos: p };
  }

  stepPos(p, tok, t, price) {
    p.lastPrice = price;
    if (p.state === 'pending') { if (t >= p.fillAt) this.fillEntry(p, tok, t); return; }
    if (!p.exit) this.rules(p, tok, t, price);
    if (p.exit && t >= p.exit.at) this.fillExit(p, tok, t);
  }

  tickPos(p, t) {
    const C = this.C, tok = this.tokens.get(p.mint);
    if (!tok) { p.closed = true; return; }
    if (p.state === 'pending') {
      if (t < p.fillAt) return;
      if (tok.migrated || !(tok.vSol > 0)) { p.closed = true; p.cancelled = 'немає ціни для входу'; return; }
      return this.fillEntry(p, tok, t);
    }
    if (p.dex && !p.dexSeen && p.migratedAt && t - p.migratedAt > C.dexWaitMin * MINUTE) {
      // DEX-ціни немає: виходимо за останньою ціною кривої (момент міграції)
      p.dex = false;
      p.exit = { at: t, frac: 1, reason: 'міграція (без даних DEX)' };
      return this.fillExit(p, tok, t);
    }
    const priced = p.dex ? !!p.dexInfo : tok.vSol > 0;
    if (!priced) {
      // після рестарту ціни немає ні на кривій, ні на DEX: консервативно вважаємо позицію втраченою
      if (p.restored && t - (p.restoredAt || t) > 60 * MINUTE) { p.left = 0; this.closePos(p, t, 'немає ціни після рестарту'); }
      return;
    }
    if (p.exit) { if (t >= p.exit.at) this.fillExit(p, tok, t); return; }
    if (t - p.peakAt > C.timeStopMin * MINUTE) this.decideExit(p, t, 1, 'тайм-стоп');
    else if (t - p.openedAt > C.maxHoldMin * MINUTE) this.decideExit(p, t, 1, 'макс. утримання');
    if (p.exit && t >= p.exit.at) this.fillExit(p, tok, t);
  }

  fillEntry(p, tok, t) {
    const C = this.C;
    const got = simBuy(tok.vSol, tok.vTok, p.size - C.prioritySol, C.curveFee + C.terminalFee);
    if (!(got > 0)) { p.closed = true; p.cancelled = 'вхід неможливий'; return; }
    Object.assign(p, { tokens: got, left: got, ref: tok.price, state: 'open', openedAt: t, peak: 1, peakAt: t, entryMcap: tok.price * C.supply, lastPrice: tok.price });
  }

  rules(p, tok, t, price) {
    const C = this.C, mult = price / p.ref;
    if (mult > p.peak) { p.peak = mult; p.peakAt = t; }
    if (tok.devDumped) this.decideExit(p, t, 1, 'dev продав');
    else if (mult <= 1 - C.stopLoss) this.decideExit(p, t, 1, 'стоп-лосс');
    else if (!p.tp1 && mult >= C.tp1) { p.tp1 = true; this.decideExit(p, t, C.tp1Frac, `тейк ${C.tp1}x`); }
    else if (p.peak >= C.trailArm && mult <= p.peak * (1 - C.trail)) this.decideExit(p, t, 1, 'трейлінг');
  }

  decideExit(p, t, frac, reason) {
    if (!p.exit) p.exit = { at: t + this.C.fillDelaySec * 1000, frac, reason };
  }

  fillExit(p, tok, t) {
    const C = this.C, e = p.exit;
    if (!e) return;
    p.exit = null;
    const tokIn = e.frac >= 1 ? p.left : p.left * e.frac;
    let out = p.dex && p.dexInfo ? dexSell(p.dexInfo, tokIn, C.postFee) : simSell(tok.vSol, tok.vTok, tokIn, C.curveFee + C.terminalFee);
    out = Math.max(0, out - C.prioritySol);
    p.realized += out; p.left -= tokIn; p.reasons.push(e.reason);
    if (e.frac >= 1 || p.left <= p.tokens * 1e-9) this.closePos(p, t, e.reason);
  }

  closePos(p, t, reason) {
    p.closed = true;
    const C = this.C, pnl = p.realized - p.size;
    const rec = {
      id: p.id, mint: p.mint, symbol: p.symbol, signalAt: p.signalAt, openedAt: p.openedAt, closedAt: t,
      size: p.size, out: +p.realized.toFixed(6), pnl: +pnl.toFixed(6), pnlPct: +(pnl / p.size).toFixed(4),
      peak: +p.peak.toFixed(3), reason, reasons: p.reasons.slice(), score: p.score, flags: p.flags,
      entryMcap: Math.round(p.entryMcap), migrated: !!p.migratedAt,
    };
    this.journal.push(rec);
    if (this.journal.length > JOURNAL_MAX) this.journal.splice(0, this.journal.length - JOURNAL_MAX);
    this.closedCount++;
    this.cumPnl += pnl;
    this.rollDay(t);
    this.day.pnl += pnl;
    if (!this.day.hit && this.day.pnl <= -C.dailyLossSol) { this.day.hit = true; this.d.emit('limit', { kind: 'daily', t, pnl: this.day.pnl }); }
    if (!this.bankHit && this.cumPnl <= -C.bankSol) { this.bankHit = { t, n: this.closedCount }; this.d.emit('limit', { kind: 'bank', t }); }
    this.d.emit('paper_close', { p, rec, t });
  }

  closeAll(t, reason) {
    for (const p of this.positions) {
      if (p.closed) continue;
      const tok = this.tokens.get(p.mint);
      if (p.state === 'pending' || !tok) { p.closed = true; continue; }
      p.exit = { at: t, frac: 1, reason };
      this.fillExit(p, tok, t);
    }
    this.positions = this.positions.filter(p => !p.closed);
  }

  // ----- списки стеження -----
  addWatch(mint, t) {
    if (this.watch.has(mint)) return false;
    this.watch.set(mint, { mint, addedAt: t, ref: 0 });
    if (!this.tokens.has(mint)) this.tokens.set(mint, this.newToken(mint, t));
    this.d.subscribe(mint);
    return true;
  }
  delWatch(mint) { return this.watch.delete(mint); }

  // ----- збереження -----
  snapshot() {
    return {
      v: 1, savedAt: Date.now(), journal: this.journal, cumPnl: this.cumPnl, closedCount: this.closedCount,
      bankHit: this.bankHit, day: this.day, meta: this.meta,
      positions: this.positions.filter(p => !p.closed && p.state === 'open').map(p => ({ ...p, dexInfo: undefined, exit: null })),
      watch: [...this.watch.values()], wallets: [...this.wallets.entries()],
    };
  }
  restore(s, t) {
    if (!s || s.v !== 1) return;
    this.journal = s.journal || [];
    this.cumPnl = s.cumPnl || 0;
    this.closedCount = s.closedCount || this.journal.length;
    this.bankHit = s.bankHit || null;
    this.day = s.day || this.day;
    this.meta = s.meta || {};
    for (const [a, l] of s.wallets || []) this.wallets.set(a, l);
    for (const w of s.watch || []) {
      this.addWatch(w.mint, t);
      this.watch.get(w.mint).ref = w.ref || 0;
    }
    for (const p of s.positions || []) {
      this.positions.push({ ...p, restored: true, restoredAt: t });
      if (!this.tokens.has(p.mint)) this.tokens.set(p.mint, this.newToken(p.mint, t, { symbol: p.symbol, name: p.name }));
      this.d.subscribe(p.mint);
    }
  }
}

// ---------- звіт paper-журналу ----------
export function paperReport(journal, C) {
  const n = journal.length;
  const pnls = journal.map(x => x.pnlPct);
  const wins = journal.filter(x => x.pnl > 0).length;
  let tot = 0, gp = 0, gl = 0;
  for (const x of journal) { tot += x.pnl; if (x.pnl > 0) gp += x.pnl; else gl -= x.pnl; }
  const mean = n ? pnls.reduce((a, b) => a + b, 0) / n : 0;
  const sorted = [...pnls].sort((a, b) => a - b);
  const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;
  let eq = C.bankSol, peak = eq, dd = 0, stopAt = null;
  journal.forEach((x, i) => {
    eq += x.pnl;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak > 0 ? (peak - eq) / peak : 0);
    if (stopAt === null && eq <= 0) stopAt = i + 1;
  });
  const reasons = {};
  for (const x of journal) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
  const hold = n ? journal.reduce((s, x) => s + (x.closedAt - x.openedAt) / MINUTE, 0) / n : 0;
  const gate = { n: n >= C.gateN, ev: mean >= C.gateEv, dd: dd < C.gateDd };
  gate.pass = gate.n && gate.ev && gate.dd;
  return {
    n, wins, winRate: n ? wins / n : 0, ci: wilson(wins, n), mean, median, tot,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0, dd, stopAt,
    best: n ? sorted[n - 1] : 0, worst: n ? sorted[0] : 0, reasons, hold, gate,
  };
}

export function journalCsv(journal) {
  const cols = ['id', 'symbol', 'mint', 'signalAt', 'openedAt', 'closedAt', 'size', 'out', 'pnl', 'pnlPct', 'peak', 'reason', 'score', 'entryMcap', 'migrated'];
  const esc = v => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const iso = v => (v ? new Date(v).toISOString() : '');
  return [cols.join(','), ...journal.map(x => cols.map(c => esc(c.endsWith('At') ? iso(x[c]) : x[c])).join(','))].join('\n') + '\n';
}

// ===================== ТЕКСТИ ДЛЯ TELEGRAM =====================
export const fx = { solUsd: 0, solEur: 0 };
const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
const sgnPct = (x, d = 0) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d) + '%';
const fmtSol = x => { const a = Math.abs(x); return (x < 0 ? '−' : '') + (a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a.toFixed(3)) + ' SOL'; };
const sgnSol = x => (x >= 0 ? '+' : '') + fmtSol(x);
const kfmt = x => (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x.toFixed(0));
const eurOf = s => (fx.solEur ? ` (~${(s * fx.solEur).toFixed(Math.abs(s * fx.solEur) >= 10 ? 0 : 2)} €)` : '');
const usdOf = s => (fx.solUsd ? ` ≈ $${kfmt(s * fx.solUsd)}` : '');
const short = a => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '?');
const tag = tok => `$${tok.symbol || short(tok.mint)}${tok.name ? ' · ' + tok.name : ''}`;
export const links = mint => [
  `https://pump.fun/coin/${mint}`,
  `https://dexscreener.com/solana/${mint}`,
  `https://app.bubblemaps.io/sol/token/${mint}`,
  `https://gmgn.ai/sol/token/${mint}`,
];

export function alertText({ tok, r, pos }, C = CFG) {
  const m = r.m, s = tok.info && tok.info.socials;
  const soc = s ? `X ${s.twitter ? '✓' : '✗'} · TG ${s.telegram ? '✓' : '✗'} · сайт ${s.website ? '✓' : '✗'}` : 'не перевірено';
  const L = [
    `🔎 Кандидат: ${tag(tok)}`,
    `Скор ${r.score}/100 · крива ${pct(m.progress)} · mcap ${fmtSol(m.mcapSol)}${usdOf(m.mcapSol)} · вік ${m.age < 120 ? Math.round(m.age) + ' с' : Math.round(m.age / 60) + ' хв'}`,
    `5 хв: ${m.buyers5} покупців · потік ${sgnSol(m.net5)} · ${m.sellSol5 > 0 ? `купівлі/продажі ${Math.min(m.bs, 99).toFixed(1)}×` : 'лише купівлі'}`,
    `Холдери ${m.holders} · топ-10 ${pct(m.top10)} · dev ${pct(m.devPct, 1)} · снайпери ${pct(m.earlyPct)} · невидимі ${m.hiddenPct == null ? '?' : pct(m.hiddenPct)}`,
    `Соцмережі: ${soc}${tok.info && tok.info.rpcTop10 != null ? ` · RPC топ-10 ${pct(tok.info.rpcTop10)}` : ''}`,
  ];
  if (r.flags.length) L.push('⚠️ ' + r.flags.join('; '));
  if (pos && pos.pos) L.push(`📝 Paper-вхід ${fmtSol(pos.pos.size)}${eurOf(pos.pos.size)} через ${C.fillDelaySec} с (симуляція, не угода)`);
  else if (pos && pos.skip) L.push(`📝 Paper: пропуск, ${pos.skip}`);
  L.push('', ...links(tok.mint), '', 'Не порада. Перевір сам: Bubblemaps, соцмережі, dev.');
  return L.join('\n');
}

export function closeText({ p, rec }) {
  return `${rec.pnl > 0 ? '✅' : '❌'} Paper: $${p.symbol || short(p.mint)} закрито ${sgnPct(rec.pnlPct)} (${sgnSol(rec.pnl)}${eurOf(rec.pnl)})`
    + ` · ${rec.reasons.join(' → ')} · ${Math.round((rec.closedAt - rec.openedAt) / MINUTE)} хв · пік ${rec.peak.toFixed(2)}x`;
}

export function reportText(rep, C = CFG, title = '📊 Paper-журнал') {
  if (!rep.n) return `${title}: угод ще немає. Потрібно ${C.gateN}+ для контрольної точки №1.`;
  const g = rep.gate, ok = b => (b ? '✓' : '✗');
  const reasons = Object.entries(rep.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    `${title}: ${rep.n} угод`,
    `Win-rate ${pct(rep.winRate)} (95% ДІ ${pct(rep.ci[0])}–${pct(rep.ci[1])})`,
    `Середня угода ${sgnPct(rep.mean, 1)} · медіана ${sgnPct(rep.median, 1)}`,
    `Разом ${sgnSol(rep.tot)}${eurOf(rep.tot)} · profit factor ${Number.isFinite(rep.pf) ? rep.pf.toFixed(2) : '∞'}`,
    `Макс. просідання ${pct(rep.dd)} від банку ${fmtSol(C.bankSol)} · утримання ~${rep.hold.toFixed(0)} хв`,
    `Найкраща ${sgnPct(rep.best)} · найгірша ${sgnPct(rep.worst)}`,
    `Виходи: ${reasons}`,
    rep.stopAt ? `⛔ За правилами плану реальний трейдинг зупинився б на угоді №${rep.stopAt} (банк вичерпано).` : null,
    `Контрольна точка №1: ${g.pass ? '✅ пройдено' : '❌ не пройдено'} · угод ${rep.n}/${C.gateN} ${ok(g.n)} · EV ${sgnPct(rep.mean, 1)} ≥ ${sgnPct(C.gateEv)} ${ok(g.ev)} · просідання < ${pct(C.gateDd)} ${ok(g.dd)}`,
  ].filter(Boolean).join('\n');
}

function topText(eng) {
  const top = eng.top(5);
  if (!top.length) return 'Поки немає оцінених монет.';
  return ['🏁 Топ-5 зараз:', ...top.map((x, i) =>
    `${i + 1}. ${tag(x)} · скор ${x.score} · крива ${pct(x.m.progress)} · ${x.m.buyers5} покупців/5 хв${x.blockers.length ? ' · ⛔ ' + x.blockers[0] : ''}\n   pump.fun/coin/${x.mint}`)].join('\n');
}

const HELP = [
  '🤖 pump.fun трекер (тільки читає дані, ключі гаманця не потрібні)',
  '/status: стан бота й відкриті paper-позиції',
  '/top: 5 найсильніших монет зараз',
  '/report: звіт paper-журналу й контрольна точка №1',
  '/watch <mint>: стежити за монетою (рухи ±20%, міграція, dev)',
  '/unwatch <mint>',
  '/wallet <адреса> [мітка]: сповіщати про угоди гаманця',
  '/unwallet <адреса>',
  '/pause · /resume: вимкнути або ввімкнути алерти (paper працює далі)',
].join('\n');

// ===================== МЕРЕЖА =====================
export async function http(url, opts = {}, tries = 3) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 15000) });
      if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) { last = e; if (a < tries - 1) await sleep(700 * (a + 1)); }
  }
  throw last;
}

async function refreshFx(C) {
  try {
    const [usd, eur] = await Promise.all(['SOLUSDT', 'SOLEUR'].map(s => http(`${C.binanceBase}/api/v3/ticker/price?symbol=${s}`, {}, 2).then(r => r.json())));
    if (+usd.price > 0) fx.solUsd = +usd.price;
    if (+eur.price > 0) fx.solEur = +eur.price;
  } catch (e) { log('курс SOL недоступний:', e.message); }
}

function ipfsUrl(uri, gw) {
  const s = String(uri || '');
  const m = s.match(/\/ipfs\/(.+)$/) || s.match(/^ipfs:\/\/(.+)$/);
  return m ? gw.replace(/\/?$/, '/') + m[1] : s;
}

async function rpc(url, method, params) {
  const r = await http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), timeout: 8000 }, 2);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

// Точний топ-10 через RPC: ловить бандли з блоку створення, яких не видно в стрімі
async function rpcTop10(C, tok) {
  if (!tok.curveKey) return null;
  const largest = (await rpc(C.rpcUrl, 'getTokenLargestAccounts', [tok.mint, { commitment: 'confirmed' }]))?.value || [];
  if (!largest.length) return null;
  const accs = (await rpc(C.rpcUrl, 'getMultipleAccounts', [largest.map(x => x.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value || [];
  let sum = 0, k = 0;
  largest.forEach((x, i) => {
    const owner = accs[i]?.data?.parsed?.info?.owner;
    if (!owner || owner === tok.curveKey || k >= 10) return;
    sum += +(x.uiAmountString ?? x.uiAmount ?? 0);
    k++;
  });
  return sum / C.supply;
}

async function enrich(C, tok) {
  const info = { socials: null, rpcTop10: null };
  if (C.fetchMeta && tok.uri) {
    try {
      const r = await http(ipfsUrl(tok.uri, C.ipfsGateway), { timeout: 5000 }, 1);
      if (r.ok) {
        const j = await r.json();
        info.socials = { twitter: String(j.twitter || ''), telegram: String(j.telegram || ''), website: String(j.website || '') };
      }
    } catch (_) { /* метадані не завантажились — лишаємо «не перевірено» */ }
  }
  if (C.rpcUrl) { try { info.rpcTop10 = await rpcTop10(C, tok); } catch (e) { log('RPC:', e.message); } }
  return info;
}

async function dexFetch(C, mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const part = mints.slice(i, i + 30);
    try {
      const r = await http(`${C.dexBase}/tokens/v1/solana/${part.join(',')}`, {}, 2);
      if (!r.ok) continue;
      const j = await r.json();
      for (const p of Array.isArray(j) ? j : j.pairs || []) {
        const mint = p?.baseToken?.address;
        if (!part.includes(mint)) continue;
        const best = out.get(mint);
        if (!best || (+p.liquidity?.usd || 0) > (+best.liquidity?.usd || 0)) out.set(mint, p);
      }
    } catch (e) { log('DexScreener:', e.message); }
  }
  return out;
}
function dexInfo(p) {
  const quoteIsSol = p.quoteToken?.address === SOL_MINT;
  const price = quoteIsSol ? +p.priceNative : fx.solUsd ? +p.priceUsd / fx.solUsd : 0;
  return { price, priceUsd: +p.priceUsd || 0, liqBase: +p.liquidity?.base || 0, symbol: p.baseToken?.symbol || '', name: p.baseToken?.name || '', dexId: p.dexId || '' };
}

// ---------- сховище: файл локально або гілка `data` у GitHub (як у bot_mjs.js) ----------
export class Store {
  constructor(C, env = ENV) {
    this.dir = C.dir; this.sha = {}; this.branchOk = false;
    this.base = env.GITHUB_API_BASE || 'https://api.github.com';
    this.branch = env.DATA_BRANCH || 'data';
    this.gh = env.GITHUB_TOKEN && env.GITHUB_REPOSITORY && env.STORE !== 'local' ? { repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN } : null;
  }
  headers() { return { authorization: `Bearer ${this.gh.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'odds-pumpfun', 'content-type': 'application/json' }; }
  async read(name) {
    if (!this.gh) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch (_) { return null; } }
    const r = await http(`${this.base}/repos/${this.gh.repo}/contents/${name}?ref=${this.branch}`, { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub читання ' + name + ': ' + r.status);
    const j = await r.json();
    this.sha[name] = j.sha;
    const raw = j.content ? Buffer.from(j.content, 'base64').toString('utf8') : await (await http(j.download_url, { headers: this.headers() })).text();
    return JSON.parse(raw);
  }
  async ensureBranch() {
    if (this.branchOk) return;
    const base = `${this.base}/repos/${this.gh.repo}`, h = this.headers();
    const b = await http(`${base}/branches/${this.branch}`, { headers: h });
    if (b.ok) { this.branchOk = true; return; }
    if (b.status !== 404) throw new Error('GitHub гілка: ' + b.status);
    const info = await (await http(base, { headers: h })).json();
    const ref = await (await http(`${base}/git/ref/heads/${info.default_branch}`, { headers: h })).json();
    const c = await http(`${base}/git/refs`, { method: 'POST', headers: h, body: JSON.stringify({ ref: `refs/heads/${this.branch}`, sha: ref.object.sha }) });
    if (!c.ok && c.status !== 422) throw new Error('GitHub створення гілки: ' + c.status);
    this.branchOk = true;
  }
  async write(name, obj, message = 'pumpfun state') {
    const text = JSON.stringify(obj);
    if (!this.gh) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(path.join(this.dir, name), text); return; }
    await this.ensureBranch();
    const url = `${this.base}/repos/${this.gh.repo}/contents/${name}`;
    for (let a = 0; a < 4; a++) {
      const body = { message, content: Buffer.from(text).toString('base64'), branch: this.branch, ...(this.sha[name] ? { sha: this.sha[name] } : {}) };
      const r = await http(url, { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
      if (r.ok) { this.sha[name] = (await r.json()).content.sha; return; }
      if (r.status === 409 || r.status === 422) {
        const g = await http(`${url}?ref=${this.branch}`, { headers: this.headers() });
        if (g.ok) this.sha[name] = (await g.json()).sha; else delete this.sha[name];
        continue;
      }
      throw new Error('GitHub запис ' + name + ': ' + r.status);
    }
    throw new Error('GitHub запис ' + name + ': конфлікт версій');
  }
}

// ---------- Telegram: черга відправки + команди ----------
class TG {
  constructor(C) { this.C = C; this.q = []; this.busy = false; this.offset = 0; this.stopped = false; }
  enabled() { return !!(this.C.tgToken && this.C.tgChat); }
  send(text) {
    if (!this.enabled()) { log('[Telegram не налаштовано]', text.replace(/\n/g, ' | ').slice(0, 400)); return; }
    this.q.push(text);
    this.pump();
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.q.length) {
      const text = this.q.shift();
      try {
        const r = await http(`${this.C.tgBase}/bot${this.C.tgToken}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.C.tgChat, text: text.slice(0, 4000), disable_web_page_preview: true }),
        });
        if (!r.ok) log('Telegram HTTP', r.status);
      } catch (e) { log('Telegram помилка:', e.message); }
      await sleep(1100);
    }
    this.busy = false;
  }
  async drain(ms = 15000) { const end = Date.now() + ms; while ((this.q.length || this.busy) && Date.now() < end) await sleep(200); }
  async poll(handler) {
    const startSec = Math.floor(Date.now() / 1000) - 30;
    while (!this.stopped) {
      try {
        const r = await http(`${this.C.tgBase}/bot${this.C.tgToken}/getUpdates?timeout=25&offset=${this.offset}&allowed_updates=%5B%22message%22%5D`, { timeout: 35000 }, 1);
        const j = await r.json();
        if (!j.ok) { log('Telegram getUpdates:', j.description || r.status); await sleep(10000); continue; }
        for (const u of j.result) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg || !msg.text || msg.date < startSec) continue;
          if (String(msg.chat?.id) !== String(this.C.tgChat)) continue; // команди лише з твого чату
          try { await handler(msg.text); } catch (e) { log('команда:', e.message); }
        }
      } catch (e) { if (!this.stopped) { log('Telegram опитування:', e.message); await sleep(5000); } }
    }
  }
}

// ---------- PumpPortal WebSocket із перепідключенням і керуванням підписками ----------
class Feed {
  constructor(C, onMsg) {
    this.C = C; this.onMsg = onMsg; this.ws = null; this.connected = false; this.stopped = false; this.retry = 0;
    this.mints = new Set(); this.wallets = new Set(); this.qSub = new Set(); this.qUnsub = new Set();
    this.lastMsg = Date.now(); this.msgs = 0;
  }
  start() {
    this.connect();
    this.flushT = setInterval(() => this.flush(), 1000);
    this.dogT = setInterval(() => {
      if (this.connected && Date.now() - this.lastMsg > 90000) { log('PumpPortal: тиша 90 с, перепідключаюсь'); try { this.ws.close(); } catch (_) {} }
    }, 15000);
  }
  connect() {
    let ws;
    try { ws = new WebSocket(this.C.wsUrl); } catch (e) { log('PumpPortal:', e.message); return this.reconnect(); }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true; this.retry = 0; this.lastMsg = Date.now();
      log('PumpPortal: підключено');
      this.raw({ method: 'subscribeNewToken' });
      this.raw({ method: 'subscribeMigration' });
      this.qUnsub.clear();
      this.qSub = new Set(this.mints);
      if (this.wallets.size) this.raw({ method: 'subscribeAccountTrade', keys: [...this.wallets] });
      this.flush();
    };
    ws.onmessage = ev => {
      this.lastMsg = Date.now(); this.msgs++;
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch (_) { return; }
      if (m && m.errors) { log('PumpPortal помилка:', JSON.stringify(m.errors).slice(0, 200)); return; }
      try { this.onMsg(m, this.lastMsg); } catch (e) { log('обробка події:', e.message); }
    };
    ws.onerror = () => {};
    ws.onclose = () => { const was = this.connected; this.connected = false; if (!this.stopped) { if (was) log("PumpPortal: з'єднання закрито"); this.reconnect(); } };
  }
  reconnect() {
    if (this.stopped) return;
    const d = Math.min(30000, 1000 * 2 ** this.retry++);
    setTimeout(() => this.connect(), d);
  }
  raw(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  sub(mint) {
    if (this.mints.has(mint)) return;
    this.mints.add(mint); this.qUnsub.delete(mint);
    if (this.connected) this.raw({ method: 'subscribeTokenTrade', keys: [mint] }); // одразу: кожна мілісекунда — менше «невидимих» покупок
    else this.qSub.add(mint);
  }
  unsub(mint) { if (!this.mints.delete(mint)) return; this.qSub.delete(mint); this.qUnsub.add(mint); }
  flush() {
    if (!this.connected) return;
    const send = (set, method) => { const a = [...set]; set.clear(); for (let i = 0; i < a.length; i += 100) this.raw({ method, keys: a.slice(i, i + 100) }); };
    if (this.qSub.size) send(this.qSub, 'subscribeTokenTrade');
    if (this.qUnsub.size) send(this.qUnsub, 'unsubscribeTokenTrade');
  }
  subWallet(a) { this.wallets.add(a); this.raw({ method: 'subscribeAccountTrade', keys: [a] }); }
  unsubWallet(a) { this.wallets.delete(a); this.raw({ method: 'unsubscribeAccountTrade', keys: [a] }); }
  stop() { this.stopped = true; clearInterval(this.flushT); clearInterval(this.dogT); try { this.ws && this.ws.close(); } catch (_) {} }
}

// ---------- запис і читання сирих подій (для бектесту) ----------
function openRecorder(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const out = fs.createWriteStream(file, { flags: 'a' });
  if (!file.endsWith('.gz')) return { write: s => out.write(s), close: () => new Promise(r => out.end(r)) };
  const gz = zlib.createGzip();
  gz.pipe(out);
  return { write: s => gz.write(s), close: () => new Promise(r => { out.on('finish', r); gz.end(); }) };
}

export async function* readEvents(file) {
  let input = fs.createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && e.m && Number.isFinite(e.t)) yield e; } catch (_) { /* битий рядок пропускаємо */ }
  }
}

// Бектест: та сама логіка Engine на записаних подіях, з «віртуальним» часом
export async function runReplay(file, C = CFG) {
  const counts = {};
  const eng = new Engine({ ...C, paper: true }, { emit: k => { counts[k] = (counts[k] || 0) + 1; }, dex: false });
  let next = 0, first = 0, last = 0, n = 0;
  for await (const { t, m } of readEvents(file)) {
    if (!first) { first = t; next = t; }
    while (t >= next) { eng.tick(next); next += 2000; }
    eng.onMessage(m, t);
    last = t; n++;
  }
  if (n) { eng.tick(last + 1); eng.closeAll(last, 'кінець даних'); }
  return { eng, counts, n, first, last, rep: paperReport(eng.journal, C) };
}

// ===================== КОМАНДИ =====================
export async function liveCmd({ record = false } = {}) {
  if (typeof WebSocket !== 'function') throw new Error('Потрібен Node.js 22+ (вбудований WebSocket)');
  const C = CFG, t0 = Date.now(), store = new Store(C), tg = new TG(C);
  const notify = !record;
  const rec = C.recordFile ? openRecorder(C.recordFile) : null;
  let paused = false, alertTimes = [], feed = null;

  const canAlert = t => {
    alertTimes = alertTimes.filter(x => t - x < 36e5);
    return !paused && !inQuiet(t, C.quiet) && alertTimes.length < C.maxAlertsPerHour;
  };
  const eng = new Engine({ ...C, paper: C.paper && !record }, {
    subscribe: m => feed && feed.sub(m),
    unsubscribe: m => feed && feed.unsub(m),
    enrich: !record && (C.fetchMeta || C.rpcUrl) ? tok => enrich(C, tok) : null,
    dex: true,
    emit: (kind, e) => {
      if (kind === 'alert') {
        log(`СИГНАЛ ${e.tok.symbol} скор ${e.r.score} крива ${pct(e.r.m.progress)} ${e.tok.mint}`);
        if (notify && canAlert(e.t)) {
          alertTimes.push(e.t); e.tok.notified = true;
          if (e.pos && e.pos.pos) e.pos.pos.notified = true;
          tg.send(alertText(e, C));
        }
      } else if (kind === 'paper_close') {
        log(`PAPER ${e.p.symbol} ${sgnPct(e.rec.pnlPct)} ${e.rec.reasons.join('→')}`);
        if (notify && C.paperNotify && e.p.notified) tg.send(closeText(e));
      } else if (!notify) {
        return;
      } else if (kind === 'migration') {
        if (e.tok.notified || eng.watch.has(e.tok.mint)) tg.send(`🎓 ${tag(e.tok)} мігрувала на PumpSwap (graduation)\n${links(e.tok.mint).slice(0, 2).join('\n')}`);
      } else if (kind === 'dev_dump') {
        if (e.tok.notified || eng.watch.has(e.tok.mint)) tg.send(`🚨 Dev ${tag(e.tok)} продав ${pct(e.soldFrac)} своїх токенів\nhttps://pump.fun/coin/${e.tok.mint}`);
      } else if (kind === 'wallet') {
        tg.send(`👛 ${e.label || short(e.wallet)} ${e.side === 'buy' ? 'купив' : 'продав'} $${e.symbol || short(e.mint)} на ${fmtSol(e.sol)}${eurOf(e.sol)}\nhttps://pump.fun/coin/${e.mint}`);
      } else if (kind === 'watch_move') {
        tg.send(`👀 ${tag(e.tok)} ${sgnPct(e.ch)} від останнього сповіщення · mcap ${fmtSol(e.price * C.supply)}${usdOf(e.price * C.supply)}\nhttps://dexscreener.com/solana/${e.tok.mint}`);
      } else if (kind === 'limit') {
        tg.send(e.kind === 'daily'
          ? `⛔ Paper: денний ліміт втрат (${fmtSol(e.pnl)}). Нових входів до завтра немає. Те саме правило діє для реальних грошей.`
          : `⛔ Paper: банк лабораторії (${fmtSol(C.bankSol)}) вичерпано. За планом реальний трейдинг зупинився б тут.`);
      }
    },
  });

  let state = null;
  try { state = await store.read(C.stateFile); } catch (e) { log('стан не прочитано:', e.message); }
  feed = new Feed(C, (m, t) => { if (rec) rec.write(JSON.stringify({ t, m }) + '\n'); eng.onMessage(m, t); });
  eng.restore(state, Date.now());
  for (const [a] of eng.wallets) feed.wallets.add(a);
  feed.start();
  await refreshFx(C);

  const save = async () => { try { await store.write(C.stateFile, eng.snapshot()); } catch (e) { log('стан не збережено:', e.message); } };
  const timers = [
    setInterval(() => { try { eng.tick(Date.now()); } catch (e) { log('tick:', e.stack || e.message); } }, 2000),
    setInterval(save, 5 * MINUTE),
    setInterval(() => refreshFx(C), 5 * MINUTE),
    setInterval(() => log(`монет ${eng.stats.created} · трейдів ${eng.stats.trades} · у пам'яті ${eng.tokens.size} · сигналів ${eng.stats.signals} · paper відкр. ${eng.positions.length} · закр. ${eng.closedCount} · повідомлень WS ${feed.msgs}`), 5 * MINUTE),
    setInterval(async () => {
      const mints = [...new Set([...eng.positions.filter(p => !p.closed && (p.dex || p.restored)).map(p => p.mint), ...eng.watch.keys()])];
      if (!mints.length) return;
      const res = await dexFetch(C, mints);
      for (const [mint, p] of res) eng.onDexPrice(mint, dexInfo(p), Date.now());
    }, 20000),
    setInterval(() => {
      const now = Date.now(), day = kyivDay(now);
      if (!notify || kyivHour(now) !== C.reportHour || eng.meta.reportDay === day) return;
      eng.meta.reportDay = day;
      tg.send(reportText(paperReport(eng.journal, C), C, '🗓 Щоденний звіт paper-журналу'));
    }, MINUTE),
  ];

  const onCommand = async text => {
    const [c0, a1, ...rest] = text.trim().split(/\s+/);
    const cmd = c0.toLowerCase().replace(/@.*$/, ''), isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
    const now = Date.now();
    if (cmd === '/start' || cmd === '/help') return tg.send(HELP);
    if (cmd === '/status') {
      const open = eng.positions.filter(p => !p.closed);
      return tg.send([
        `🟢 Трекер працює ${Math.round((now - t0) / MINUTE)} хв · PumpPortal ${feed.connected ? 'онлайн' : 'офлайн'}`,
        `Нових монет: ${eng.stats.created} · трейдів: ${eng.stats.trades} · сигналів: ${eng.stats.signals} · міграцій: ${eng.stats.migrations}`,
        `У пам'яті: ${eng.tokens.size} · watchlist: ${eng.watch.size} · гаманці: ${eng.wallets.size}`,
        `Paper: відкрито ${open.length}${open.length ? ': ' + open.map(p => `$${p.symbol || short(p.mint)} ${p.state === 'pending' ? 'очікує' : (p.lastPrice / p.ref).toFixed(2) + 'x'}`).join(', ') : ''} · закрито ${eng.closedCount} · разом ${sgnSol(eng.cumPnl)}${eurOf(eng.cumPnl)}`,
        paused ? '⏸ Алерти на паузі (/resume)' : null,
      ].filter(Boolean).join('\n'));
    }
    if (cmd === '/top') return tg.send(topText(eng));
    if (cmd === '/report') return tg.send(reportText(paperReport(eng.journal, C), C));
    if (cmd === '/watch') {
      if (!isAddr(a1)) return tg.send('Формат: /watch <адреса монети>');
      return tg.send(eng.addWatch(a1, now) ? `👀 Стежу за ${short(a1)}: рухи ±${pct(C.watchMove)}, міграція, dev.` : 'Вже у списку.');
    }
    if (cmd === '/unwatch') return tg.send(eng.delWatch(a1) ? 'Прибрав зі списку.' : 'Такої монети в списку немає.');
    if (cmd === '/wallet') {
      if (!isAddr(a1)) return tg.send('Формат: /wallet <адреса гаманця> [мітка]');
      eng.wallets.set(a1, cleanText(rest.join(' '), 24)); feed.subWallet(a1);
      return tg.send(`👛 Стежу за гаманцем ${short(a1)} (угоди від ${fmtSol(C.walletMinSol)}).`);
    }
    if (cmd === '/unwallet') { const ok = eng.wallets.delete(a1); if (ok) feed.unsubWallet(a1); return tg.send(ok ? 'Гаманець прибрано.' : 'Такого гаманця немає.'); }
    if (cmd === '/pause') { paused = true; return tg.send('⏸ Алерти на паузі. Paper-журнал працює далі.'); }
    if (cmd === '/resume') { paused = false; return tg.send('▶️ Алерти ввімкнено.'); }
  };
  if (notify && C.tgCommands && tg.enabled()) tg.poll(onCommand);
  if (notify) tg.send(`🟢 pump.fun трекер запущено${C.maxMinutes ? ` на ${C.maxMinutes} хв` : ''}. Paper-журнал: ${eng.closedCount} угод. /help`);
  log(`Запущено${record ? ' (лише запис)' : ''}. Стан: ${store.gh ? 'гілка data у GitHub' : C.dir}${rec ? ` · запис у ${C.recordFile}` : ''}`);

  await new Promise(res => {
    process.once('SIGINT', res);
    process.once('SIGTERM', res);
    if (C.maxMinutes > 0) setTimeout(res, C.maxMinutes * MINUTE);
  });

  log('Зупинка…');
  timers.forEach(clearInterval);
  tg.stopped = true;
  feed.stop();
  await save();
  if (rec) await rec.close();
  if (notify) {
    const mins = Math.round((Date.now() - t0) / MINUTE);
    tg.send(`⏹ Сесія завершена (${mins} хв): монет ${eng.stats.created}, сигналів ${eng.stats.signals}, міграцій ${eng.stats.migrations}.\n\n${reportText(paperReport(eng.journal, C), C)}`);
    await tg.drain();
  }
}

async function reportCmd(args) {
  const C = CFG, state = await new Store(C).read(C.stateFile);
  const journal = state?.journal || [];
  if (args.includes('--csv')) { process.stdout.write(journalCsv(journal)); return; }
  console.log(reportText(paperReport(journal, C), C));
}

async function replayCmd(file) {
  if (!file || !fs.existsSync(file)) throw new Error('Вкажи файл: node pumpfun/tracker.mjs replay events.jsonl.gz');
  const C = CFG, r = await runReplay(file, C);
  console.log(`Подій: ${r.n} · період ${((r.last - r.first) / 36e5).toFixed(1)} год · нових монет ${r.eng.stats.created} · сигналів ${r.eng.stats.signals} · міграцій ${r.eng.stats.migrations}`);
  console.log(reportText(r.rep, C, '📊 Бектест'));
  if (ENV.REPLAY_CSV) { fs.writeFileSync(ENV.REPLAY_CSV, journalCsv(r.eng.journal)); console.log('Журнал угод:', ENV.REPLAY_CSV); }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = {
    live: () => liveCmd(),
    record: () => {
      if (!CFG.recordFile) CFG.recordFile = args[0] || `pumpfun/data/events-${kyivDay(Date.now())}.jsonl.gz`;
      return liveCmd({ record: true });
    },
    replay: () => replayCmd(args[0]),
    report: () => reportCmd(args),
  }[cmd];
  if (!run) { console.log('Використання: node pumpfun/tracker.mjs live | record [файл] | replay <файл> | report [--csv]'); process.exit(1); }
  run().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('Помилка:', e); process.exit(1); });
}
