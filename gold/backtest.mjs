// Перевірка логіки золотого скальпера з відео: «позиція + зустрічний стоп-ордер + трейлінг» (stop-and-reverse).
//   node gold/backtest.mjs fetch [днів]   завантажити посекундну історію PAXG/USDT (токенізоване золото, 1 токен = 1 унція)
//   node gold/backtest.mjs run [звіт.md]  перебір параметрів, перевірка на нових даних, звіт
//
// Модель брокера: ціна = PAXG (рух золота), спред і сліпедж — як у брокера XAUUSD (параметри),
// торгові години XAUUSD (без вихідних і щоденної перерви). Гроші — на 1 унцію = 0,01 лота.
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'gold/data', SYM = 'PAXGUSDT';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, tries = 5) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status === 418 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; await sleep(1500 * (a + 1)); }
  }
  throw last;
}

// ---------- дані: посекундні свічки, лише секунди з угодами ----------
export async function fetchSeconds(days, now = Date.now()) {
  const end = Math.floor(now / 1000) * 1000, start = end - days * 864e5;
  const pages = [];
  for (let s = start; s < end; s += 1e6) pages.push(s);
  const out = new Array(pages.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < pages.length) {
      const k = next++, s = pages[k];
      const j = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${SYM}&interval=1s&startTime=${s}&endTime=${Math.min(end, s + 1e6) - 1}&limit=1000`);
      out[k] = j.filter(x => +x[5] > 0).map(x => [x[0], +x[1], +x[2], +x[3], +x[4]]);
      if (++done % 250 === 0) console.log(`  ${done}/${pages.length}`);
    }
  }));
  const rows = out.flat().sort((a, b) => a[0] - b[0]);
  const buf = new Float64Array(rows.length * 5);
  rows.forEach((r, i) => buf.set(r, i * 5));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${SYM}-1s.bin`), Buffer.from(buf.buffer));
  fs.writeFileSync(path.join(DIR, `${SYM}-1s.json`), JSON.stringify({ start, end, n: rows.length, days }));
  return rows.length;
}
export function loadSeconds() {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, `${SYM}-1s.json`), 'utf8'));
  const b = fs.readFileSync(path.join(DIR, `${SYM}-1s.bin`));
  const f = new Float64Array(b.buffer, b.byteOffset, b.length / 8), n = f.length / 5;
  const D = { n, meta, t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n) };
  for (let i = 0; i < n; i++) { D.t[i] = f[i * 5]; D.o[i] = f[i * 5 + 1]; D.h[i] = f[i * 5 + 2]; D.l[i] = f[i * 5 + 3]; D.c[i] = f[i * 5 + 4]; }
  return D;
}

// ---------- торгові години XAUUSD (UTC, консервативно) ----------
export function tradable(t, session) {
  const d = new Date(t), wd = d.getUTCDay(), h = d.getUTCHours();
  if (wd === 6 || (wd === 0 && h < 23) || (wd === 5 && h >= 21)) return false;  // вихідні
  if (h >= 21 && h < 23) return false;                                        // щоденна перерва й рідкий ринок
  if (session === 'active' && !(h >= 7 && h < 20)) return false;              // лише Лондон + Нью-Йорк
  return true;
}

// ---------- симуляція ----------
// P: { g — відстань стоп-ордера/трейлінгу ($), mode: 'reverse' (одразу переворот, як на відео) | 'rearm' (після виходу нова «вилка»),
//      tp — тейк у $ (0 = без), spread, slip — $ на унцію, session: 'all' | 'active' }
export function simulate(D, P, fromT = -Infinity, toT = Infinity) {
  const { g, mode = 'reverse', tp = 0, spread = 0.2, slip = 0.02, session = 'all' } = P;
  const half = spread / 2;
  let st = 0, entry = 0, ext = 0, hi = NaN, lo = NaN, pnl = 0, peak = 0, maxDd = 0, n = 0, wins = 0, gp = 0, gl = 0;
  const daily = new Map();
  const book = (x, t) => {
    pnl += x; n++;
    if (x > 0) { wins++; gp += x; } else gl -= x;
    if (pnl > peak) peak = pnl;
    maxDd = Math.max(maxDd, peak - pnl);
    const d = Math.floor(t / 864e5);
    daily.set(d, (daily.get(d) || 0) + x);
  };
  const open = (dir, lvl) => { st = dir; entry = lvl; ext = lvl; };
  const close = (lvl, t, limit = false) => {
    const cost = half * 2 + (limit ? 0 : slip) + slip; // спред туди-назад + сліпедж на вході й (для стопів) на виході
    book(st * (lvl - entry) - cost, t);
    st = 0;
  };
  const flat = lvl => { st = 0; hi = lvl; lo = lvl; };
  let wasOn = false, last = NaN;
  for (let i = 0; i < D.n; i++) {
    const t = D.t[i];
    if (t < fromT || t >= toT) continue;
    const on = tradable(t, session);
    if (!on) { if (st) close(D.o[i], t); wasOn = false; last = NaN; continue; }
    if (!wasOn) { flat(D.o[i]); wasOn = true; last = D.o[i]; }
    const O = D.o[i], H = D.h[i], L = D.l[i], C = D.c[i];
    // відрізок від попередньої ціни до відкриття теж перевіряється (рідкі угоди PAXG = безперервний рух золота між ними)
    const path = C >= O ? [last, O, L, H, C] : [last, O, H, L, C];
    let a = path[0];
    for (let s = 1; s < path.length; s++) {
      const b = path[s];
      if (b === a) continue;
      const up = b > a;
      for (let guard = 0; guard < 50; guard++) {
        let lvl = NaN, ev = 0;
        if (st === 0) {
          if (up) { hi = Math.max(hi, a); if (b >= lo + g) { lvl = Math.max(a, lo + g); ev = 1; } }
          else { lo = Math.min(lo, a); if (b <= hi - g) { lvl = Math.min(a, hi - g); ev = -1; } }
        } else if (st === 1) {
          if (up) { if (tp && b >= entry + tp) { lvl = Math.max(a, entry + tp); ev = 2; } }
          else { ext = Math.max(ext, a); if (b <= ext - g) { lvl = Math.min(a, ext - g); ev = 3; } }
        } else {
          if (!up) { if (tp && b <= entry - tp) { lvl = Math.min(a, entry - tp); ev = 2; } }
          else { ext = Math.min(ext, a); if (b >= ext + g) { lvl = Math.max(a, ext + g); ev = 3; } }
        }
        if (!ev) break;
        if (ev === 1 || ev === -1) open(ev, lvl);
        else if (ev === 2) { close(lvl, t, true); flat(lvl); }
        else { const was = st; close(lvl, t); if (mode === 'reverse') open(-was, lvl); else flat(lvl); }
        a = lvl;
      }
      if (st === 1) ext = Math.max(ext, b); else if (st === -1) ext = Math.min(ext, b);
      else { hi = Math.max(hi, b); lo = Math.min(lo, b); }
      a = b;
    }
    last = C;
  }
  const days = [...daily.values()];
  return { n, pnl, wins, winRate: n ? wins / n : 0, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0, maxDd, perTrade: n ? pnl / n : 0, days: days.length, posDays: days.filter(x => x > 0).length };
}

// ---------- реалістичне виконання: рішення за ціною закриття секунди, угода за першою ціною наступної ----------
// (затримка ~1 с, як у робота MT5 на VPS або телефоні; жодних ідеальних заповнень усередині секунди)
export function simulateLagged(D, P, fromT = -Infinity, toT = Infinity) {
  const { g, mode = 'reverse', tp = 0, spread = 0.2, slip = 0.02, session = 'all' } = P;
  let st = 0, entry = 0, ext = 0, hi = NaN, lo = NaN, pnl = 0, peak = 0, maxDd = 0, n = 0, wins = 0, gp = 0, gl = 0, pend = null, wasOn = false;
  const daily = new Map();
  const book = (x, t) => { pnl += x; n++; if (x > 0) { wins++; gp += x; } else gl -= x; if (pnl > peak) peak = pnl; maxDd = Math.max(maxDd, peak - pnl); const d = Math.floor(t / 864e5); daily.set(d, (daily.get(d) || 0) + x); };
  const cost = spread + 2 * slip;
  for (let i = 0; i < D.n; i++) {
    const t = D.t[i];
    if (t < fromT || t >= toT) continue;
    const on = tradable(t, session), O = D.o[i], C = D.c[i];
    if (!on) { if (st) { book(st * (O - entry) - cost, t); st = 0; } pend = null; wasOn = false; continue; }
    if (!wasOn) { wasOn = true; st = 0; hi = lo = O; }
    if (pend) { // виконання рішення попередньої секунди за поточним відкриттям
      if (pend.close && st) { book(st * (O - entry) - cost, t); st = 0; }
      if (pend.open) { st = pend.open; entry = O; ext = O; } else { hi = lo = O; }
      pend = null;
    }
    if (st === 0) {
      hi = Math.max(hi, C); lo = Math.min(lo, C);
      if (C >= lo + g) pend = { open: 1 }; else if (C <= hi - g) pend = { open: -1 };
    } else {
      ext = st > 0 ? Math.max(ext, C) : Math.min(ext, C);
      const hitTp = tp && (st > 0 ? C >= entry + tp : C <= entry - tp);
      const hitStop = st > 0 ? C <= ext - g : C >= ext + g;
      if (hitTp) pend = { close: true };
      else if (hitStop) pend = { close: true, open: mode === 'reverse' ? -st : 0 };
    }
  }
  const days = [...daily.values()];
  return { n, pnl, wins, winRate: n ? wins / n : 0, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0, maxDd, perTrade: n ? pnl / n : 0, days: days.length, posDays: days.filter(x => x > 0).length };
}

// ---------- перебір і звіт ----------
async function run(outFile) {
  const D = loadSeconds();
  const t0 = D.t[0], t1 = D.t[D.n - 1], cut = t0 + (t1 - t0) * 0.6;
  const lines = [], log = s => { console.log(s); lines.push(s); };
  const combos = [];
  for (const g of [0.3, 0.5, 0.8, 1.2, 2, 3, 5, 8]) for (const mode of ['reverse', 'rearm']) for (const tpm of [0, 1, 2]) for (const session of ['all', 'active'])
    combos.push({ g, mode, tp: tpm * g, session });
  const res = combos.map(P => ({ P, ideal: simulate(D, P), full: simulateLagged(D, P), is: simulateLagged(D, P, -Infinity, cut), oos: simulateLagged(D, P, cut) }));
  const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
  const usd = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(0) + ' $';
  const name = P => `${P.mode === 'reverse' ? 'переворот' : 'нова вилка'}, крок ${P.g} $${P.tp ? `, тейк ${P.tp} $` : ''}, ${P.session === 'all' ? 'весь день' : 'Лондон+НЙ'}`;
  const dd = s => new Date(s).toISOString().slice(0, 10);
  log(`# Перевірка золотого скальпера з відео (stop-and-reverse)\n`);
  log(`Дані: посекундні ціни золота (PAXG/USDT, Binance), ${dd(t0)} — ${dd(t1)}, лише торгові години XAUUSD. Витрати: спред брокера 0,20 $ на унцію + сліпедж 0,02 $. Результат на **1 унцію = 0,01 лота**; на відео 0,1 лота — множ на 10.\n`);
  log('Два режими виконання:\n- **ідеальне** — угода точно за ціною спрацювання всередині секунди (так рахують рекламні бектести; на практиці недосяжно);\n- **реалістичне** — рішення за ціною кінця секунди, угода за першою ціною наступної (затримка ~1 с, як у робота MT5).\n');
  const video = res.find(r => r.P.g === 0.3 && r.P.mode === 'reverse' && !r.P.tp && r.P.session === 'all');
  const best = [...res].sort((a, b) => b.is.pnl - a.is.pnl)[0];
  const row = (title, r) => log(`| ${title} | ${name(r.P)} | ${usd(r.ideal.pnl)} | ${r.full.n} | ${(r.full.winRate * 100).toFixed(0)}% | ${f(r.full.pf)} | **${usd(r.full.pnl)}** | ${usd(-r.full.maxDd)} | ${usd(r.is.pnl)} | ${usd(r.oos.pnl)} |`);
  log('| | Налаштування | Ідеальне виконання | Угод (реал.) | Win | PF | **Реалістично, 30 днів** | Макс. просідання | Перші 60% | Останні 40% |');
  log('|---|---|---|---|---|---|---|---|---|---|');
  row('Як на відео', video);
  row('Найкраща (вибір на перших 60%)', best);
  log('\n## Усі 96 комбінацій, реалістичне виконання (сортування за останніми 40%)\n');
  log('| Налаштування | Ідеальне | Угод | Win | PF | Реалістично | Просідання | Перші 60% | Останні 40% |');
  log('|---|---|---|---|---|---|---|---|---|');
  for (const r of [...res].sort((a, b) => b.oos.pnl - a.oos.pnl))
    log(`| ${name(r.P)} | ${usd(r.ideal.pnl)} | ${r.full.n} | ${(r.full.winRate * 100).toFixed(0)}% | ${f(r.full.pf)} | ${usd(r.full.pnl)} | ${usd(-r.full.maxDd)} | ${usd(r.is.pnl)} | ${usd(r.oos.pnl)} |`);
  log('\n## Чутливість до спреду брокера (реалістичне виконання)\n');
  log('| Спред, $ на унцію | Як на відео | Найкраща |');
  log('|---|---|---|');
  for (const sp of [0, 0.1, 0.2, 0.3]) log(`| ${sp.toFixed(2)} | ${usd(simulateLagged(D, { ...video.P, spread: sp }).pnl)} | ${usd(simulateLagged(D, { ...best.P, spread: sp }).pnl)} |`);
  const positive = res.filter(r => r.is.pnl > 0 && r.oos.pnl > 0 && r.full.pf > 1.1);
  log(`\nКомбінацій у плюсі на обох частинах історії з PF > 1,1 (реалістично): **${positive.length} з ${res.length}**.`);
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(res));
  if (outFile) fs.writeFileSync(outFile, lines.join('\n') + '\n');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'fetch') fetchSeconds(+(arg || 30)).then(n => console.log('секунд з угодами:', n)).catch(e => { console.error(e); process.exit(1); });
else if (cmd === 'run') run(arg).catch(e => { console.error(e); process.exit(1); });
else if (cmd) { console.log('node gold/backtest.mjs fetch [днів] | run [звіт.md]'); process.exit(1); }
