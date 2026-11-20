// Повний аналіз стратегій на реальній історії: node bybit/analyze.mjs [звіт.md]
// Комісії Bybit, сліпедж, фандинг проти нас, мінімальні лоти Bybit, депозит ≈ 200 € (219 USDT).
import fs from 'node:fs';
import { STRATEGIES, backtest, backtestGrid, profileOf, specOf, toSeries, slice, monteCarlo } from './core.mjs';
import { fetchCandles } from './data.mjs';

const EQ0 = +(process.env.EQUITY0 || 219);
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const SUITE = [
  { id: 'scalp1m', title: 'Мікроскальп 1m', tf: '1m', days: 60, make: () => STRATEGIES.scalp1m() },
  { id: 'scalp', title: 'Скальп 5m (Боллінджер)', tf: '5m', days: 180, make: () => STRATEGIES.scalp() },
  { id: 'grid', title: 'Grid 5m (авто-напрям)', tf: '5m', days: 180, grid: { levels: 10, rangePct: 0.05, stopPct: 0.01 } },
  { id: 'momentum', title: 'Імпульс 15m', tf: '15m', days: 365, make: () => STRATEGIES.momentum() },
  { id: 'trend', title: 'Тренд 1h', tf: '1h', days: 1095, make: () => STRATEGIES.trend() },
  { id: 'trend4h', title: 'Тренд 4h', tf: '4h', days: 1095, make: () => STRATEGIES.trend({ tf: '4h', n: 30 }) },
];
const PROFILE_NAMES = ['safe', 'normal', 'aggressive'];

const p = (x, d = 1) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%' : '—');
const p0 = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—');
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : '∞');

function run(item, S, profile, sym, from, to) {
  const o = { profile, spec: specOf(sym), equity0: EQ0, from, to };
  return item.grid ? backtestGrid(S, { tf: item.tf, ...item.grid }, o) : backtest(S, item.make(), o);
}

const lines = [], log = s => { console.log(s); lines.push(s); };
const results = [];
log(`# Аналіз стратегій Bybit USDT-perp\n`);
log(`Згенеровано ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Депозит ${EQ0} USDT (≈200 €). Комісії: taker 0,055%, maker 0,02%. Сліпедж 0,03%. Фандинг 0,01%/8 год, завжди проти позиції. Мінімальні лоти Bybit. Дані: Binance (ціни ф'ючерсів Bybit рухаються майже синхронно).\n`);

for (const item of SUITE) {
  log(`## ${item.title} (${item.tf}, ${item.days} днів)\n`);
  log('| Монета | Профіль | Угод | Угод/день | Win | PF | Разом | На місяць | Макс. просідання | Комісії | Kill-switch | Перші 60% | Останні 40% |');
  log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const sym of SYMBOLS) {
    let rows;
    try { rows = await fetchCandles({ symbol: sym, tf: item.tf, days: item.days }); }
    catch (e) { log(`| ${sym} | дані недоступні: ${e.message} |`); continue; }
    const S = toSeries(rows), cut = Math.floor(S.n * 0.6);
    for (const pn of PROFILE_NAMES) {
      const profile = profileOf(pn);
      const r = run(item, S, profile, sym, 0, S.n);
      const a = run(item, S, profile, sym, 0, cut), b = run(item, S, profile, sym, cut, S.n);
      results.push({ item, sym, pn, r, a, b });
      log(`| ${sym} | ${pn} | ${r.n} | ${r.tradesPerDay.toFixed(1)} | ${p0(r.winRate, 0)} | ${f2(r.pf)} | **${p(r.net)}** | ${p(r.perMonth)} | ${p0(r.maxDd)} | ${p0(r.feesPaid / EQ0, 0)} | ${r.killed ? '⛔ так' : 'ні'} | ${p(a.net)} | ${p(b.net)} |`);
    }
  }
  log('');
}

log(`## Монте-Карло: шанс подвоїти депозит до спрацювання kill-switch\n`);
log('Угоди з бектесту перемішуються 3000 разів; горизонт — кількість угод за ~90 днів цієї стратегії.\n');
log('| Стратегія | Монета | Профіль | Угод за 90 днів | Шанс ×2 | Шанс kill-switch | Медіана результату | Гірші 5% | Кращі 5% |');
log('|---|---|---|---|---|---|---|---|---|');
for (const x of results) {
  if (x.pn === 'safe' || x.r.n < 20) continue;
  const horizon = Math.max(10, Math.round(x.r.tradesPerDay * 90));
  const mc = monteCarlo(x.r.trades.map(t => t.ret), { horizon, maxDd: profileOf(x.pn).maxDdPct });
  if (!mc) continue;
  x.mc = mc;
  log(`| ${x.item.title} | ${x.sym} | ${x.pn} | ${horizon} | ${p0(mc.pTarget)} | ${p0(mc.pKill)} | ${p(mc.median - 1)} | ${p(mc.p5 - 1)} | ${p(mc.p95 - 1)} |`);
}
log('');

// підсумок: що стабільно в плюсі на обох половинах історії
const robust = results.filter(x => x.pn === 'normal' && x.r.n >= 20 && x.a.net > 0 && x.b.net > 0 && x.r.pf > 1.1);
log(`## Підсумок\n`);
log(robust.length
  ? 'Стабільно в плюсі на обох половинах історії (профіль normal, ≥20 угод, PF > 1,1):\n\n' + robust.map(x => `- ${x.item.title} · ${x.sym}: ${p(x.r.net)} разом, ${p(x.r.perMonth)}/міс, просідання ${p0(x.r.maxDd)}, PF ${f2(x.r.pf)}`).join('\n')
  : 'Жодна комбінація не була стабільно прибутковою на обох половинах історії з профілем normal.');
const json = results.map(x => ({ id: x.item.id, sym: x.sym, profile: x.pn, n: x.r.n, net: x.r.net, perMonth: x.r.perMonth, maxDd: x.r.maxDd, pf: x.r.pf, winRate: x.r.winRate, fees: x.r.feesPaid, isNet: x.a.net, oosNet: x.b.net, killed: !!x.r.killed, mc: x.mc || null, rejects: x.r.rejects }));
fs.mkdirSync('bybit/data', { recursive: true });
fs.writeFileSync('bybit/data/analysis.json', JSON.stringify(json, null, 1));
if (process.argv[2]) fs.writeFileSync(process.argv[2], lines.join('\n') + '\n');
