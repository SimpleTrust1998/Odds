// Перевірка популярних індикаторів TradingView на реальній історії: node bybit/analyze-indicators.mjs [звіт.md]
// Чиста перевага: ризик 1% на угоду, без kill-switch і лімітів (щоб не обрізати вибірку), комісії Bybit, сліпедж, фандинг.
import fs from 'node:fs';
import { backtest, profileOf, specOf, toSeries, STRATEGIES } from './core.mjs';
import { INDICATORS, INDICATOR_TITLES } from './indicators.mjs';
import { fetchCandles } from './data.mjs';

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TFS = [['15m', 365], ['1h', 1095], ['4h', 1095]];
const PROF = { ...profileOf('normal'), maxDdPct: 1, dailyLossPct: 1, maxLossStreak: 1e9 };
const list = Object.keys(INDICATORS).map(k => ({ id: k, title: INDICATOR_TITLES[k], make: tf => INDICATORS[k]({ tf }) }));
list.push({ id: 'donchian', title: 'Пробій Дончіана (наш тренд)', make: tf => STRATEGIES.trend({ tf, n: tf === '4h' ? 30 : 48 }) });
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
const sp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%';
const lines = [], log = s => { console.log(s); lines.push(s); };

const data = {};
for (const [tf, days] of TFS) for (const s of SYMS) data[s + tf] = toSeries(await fetchCandles({ symbol: s, tf, days }));

const rows = [];
for (const ind of list) {
  for (const [tf] of TFS) for (const sym of SYMS) {
    const S = data[sym + tf], cut = Math.floor(S.n * 0.6), o = { profile: PROF, spec: specOf(sym) };
    const r = backtest(S, ind.make(tf), o), a = backtest(S, ind.make(tf), { ...o, to: cut }), b = backtest(S, ind.make(tf), { ...o, from: cut });
    rows.push({ ind, tf, sym, r, a, b, works: r.n >= 30 && r.pf > 1.1 && a.avgR > 0 && b.avgR > 0 });
  }
}
const score = ind => rows.filter(x => x.ind === ind && x.works).length;
const medPf = ind => { const v = rows.filter(x => x.ind === ind && x.r.n >= 30).map(x => x.r.pf).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : 0; };
const ranked = [...list].sort((p, q) => score(q) - score(p) || medPf(q) - medPf(p));

log('# Популярні індикатори TradingView: перевірка на реальних даних\n');
log('BTC/ETH/SOL, таймфрейми 15m (1 рік), 1h і 4h (3 роки). Ризик 1% капіталу на угоду, комісії Bybit (taker 0,055%), сліпедж 0,03%, фандинг 0,01%/8 год проти позиції. Сигнал на закритті свічки, вхід на наступній. «Працює» = ≥30 угод, PF > 1,1 і плюс на обох частинах історії (перші 60% і останні 40%).\n');
log('## Рейтинг\n');
log('| # | Індикатор | Працює (з 9 комбінацій) | Медіанний PF | Середній R на угоду | Найкраща комбінація |');
log('|---|---|---|---|---|---|');
ranked.forEach((ind, k) => {
  const rs = rows.filter(x => x.ind === ind), avgR = rs.reduce((s, x) => s + x.r.avgR, 0) / rs.length;
  const best = rs.filter(x => x.r.n >= 30).sort((p, q) => q.r.pf - p.r.pf)[0];
  log(`| ${k + 1} | ${ind.title} | **${score(ind)}** | ${f(medPf(ind))} | ${avgR >= 0 ? '+' : ''}${f(avgR, 3)}R | ${best ? `${best.sym.replace('USDT', '')} ${best.tf}: PF ${f(best.r.pf)}, ${sp(best.r.net)}` : '—'} |`);
});
log('\n## Деталі\n');
log('| Індикатор | ТФ | Монета | Угод | Угод/міс | Win | PF | R/угоду | Разом (1% ризику) | Перші 60% (R) | Останні 40% (R) | Працює |');
log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const ind of ranked) for (const x of rows.filter(y => y.ind === ind))
  log(`| ${ind.title} | ${x.tf} | ${x.sym.replace('USDT', '')} | ${x.r.n} | ${(x.r.tradesPerDay * 30).toFixed(0)} | ${(x.r.winRate * 100).toFixed(0)}% | ${f(x.r.pf)} | ${x.r.avgR >= 0 ? '+' : ''}${f(x.r.avgR, 3)} | ${sp(x.r.net)} | ${f(x.a.avgR, 3)} | ${f(x.b.avgR, 3)} | ${x.works ? '✅' : '❌'} |`);
fs.mkdirSync('bybit/data', { recursive: true });
fs.writeFileSync('bybit/data/indicators.json', JSON.stringify(rows.map(x => ({ id: x.ind.id, tf: x.tf, sym: x.sym, n: x.r.n, pf: x.r.pf, avgR: x.r.avgR, net: x.r.net, isR: x.a.avgR, oosR: x.b.avgR, works: x.works, R: x.r.trades.map(t => +t.R.toFixed(4)) }))));
if (process.argv[2]) fs.writeFileSync(process.argv[2], lines.join('\n') + '\n');
