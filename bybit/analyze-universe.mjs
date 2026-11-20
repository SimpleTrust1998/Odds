// Сканер по багатьох монетах: node bybit/analyze-universe.mjs [звіт.md]
// Спільний капітал і ризик, ліміт одночасних позицій, сліпедж росте для менш ліквідних монет.
import fs from 'node:fs';
import { STRATEGIES, backtestPortfolio, profileOf, specOf, SPECS, genericSpec, toSeries, monteCarlo } from './core.mjs';
import { fetchCandles, fetchUniverse, fetchMany } from './data.mjs';

const EQ0 = +(process.env.EQUITY0 || 219), N = +(process.env.UNIVERSE || 40);
const SUITE = [
  { title: 'Памп-райдер 5m', tf: '5m', days: 90, make: () => STRATEGIES.pumpRide() },
  { title: 'Проти сплеску 5m', tf: '5m', days: 90, make: () => STRATEGIES.spikeFade() },
  { title: 'Скальп 5m (Боллінджер)', tf: '5m', days: 90, make: () => STRATEGIES.scalp() },
  { title: 'Імпульс 15m', tf: '15m', days: 180, make: () => STRATEGIES.momentum() },
  { title: 'Тренд 4h', tf: '4h', days: 1095, make: () => STRATEGIES.trend({ tf: '4h', n: 30 }) },
];
const slipOf = rank => (rank < 5 ? 0.0003 : rank < 15 ? 0.0005 : rank < 30 ? 0.0008 : 0.0012);
const p = (x, d = 1) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%' : '—');
const p0 = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—');
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : '∞');
const lines = [], log = s => { console.log(s); lines.push(s); };

const uni = await fetchUniverse({ n: N });
log(`# Сканер по ${uni.length} монетах (Bybit USDT-perp, депозит ${EQ0} USDT)\n`);
log(`Монети (за 24-год обсягом): ${uni.map(x => x.sym.replace('USDT', '')).join(', ')}.\n`);
log('Сліпедж: топ-5 0,03%, 6–15 0,05%, 16–30 0,08%, далі 0,12%. Комісії Bybit, фандинг проти нас, спільний ризик-гард. ⚠️ Список монет — сьогоднішній (ефект «виживших»: монети, що померли за період, сюди не потрапили — реальність гірша).\n');
log('| Стратегія | Профіль | Монет із даними | Угод | Угод/день | Win | PF | Разом | На місяць | Макс. просідання | Комісії | Kill-switch | Перші 60% | Останні 40% | Шанс ×2 за 90 днів | Шанс kill за 90 днів |');
log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
const summary = [];
for (const item of SUITE) {
  const data = await fetchMany(uni.map((u, rank) => async () => ({ sym: u.sym, rank, rows: await fetchCandles({ symbol: u.sym, tf: item.tf, days: item.days }) })), 4);
  const list = data.filter(d => d && d.rows && d.rows.length > 300).map(d => {
    const S = toSeries(d.rows);
    return { sym: d.sym, S, slip: slipOf(d.rank), spec: SPECS[d.sym] || genericSpec(S.c[S.n - 1]) };
  });
  const t0 = Math.min(...list.map(x => x.S.t[0])), t1 = Math.max(...list.map(x => x.S.t[x.S.n - 1]));
  const tCut = t0 + (t1 - t0) * 0.6;
  for (const pn of ['normal', 'aggressive']) {
    const profile = profileOf(pn);
    const r = backtestPortfolio(list, item.make, { profile, equity0: EQ0 });
    const a = backtestPortfolio(list, item.make, { profile, equity0: EQ0, tTo: tCut });
    const b = backtestPortfolio(list, item.make, { profile, equity0: EQ0, tFrom: tCut });
    const mc = r.n >= 20 ? monteCarlo(r.trades.map(t => t.ret), { horizon: Math.max(10, Math.round(r.tradesPerDay * 90)), maxDd: profile.maxDdPct }) : null;
    summary.push({ item, pn, r, a, b, mc });
    log(`| ${item.title} | ${pn} | ${list.length} | ${r.n} | ${r.tradesPerDay.toFixed(1)} | ${p0(r.winRate, 0)} | ${f2(r.pf)} | **${p(r.net)}** | ${p(r.perMonth)} | ${p0(r.maxDd)} | ${p0(r.feesPaid / EQ0, 0)} | ${r.killed ? '⛔ так' : 'ні'} | ${p(a.net)} | ${p(b.net)} | ${mc ? p0(mc.pTarget) : '—'} | ${mc ? p0(mc.pKill) : '—'} |`);
  }
}
log('');
for (const x of summary.filter(s => s.pn === 'normal')) {
  const by = Object.entries(x.r.bySym).sort((a, b) => b[1].pnl - a[1].pnl);
  if (!by.length) continue;
  const top = by.slice(0, 4).map(([s, v]) => `${s.replace('USDT', '')} ${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(1)}$ (${v.n})`).join(', ');
  const bot = by.slice(-4).reverse().map(([s, v]) => `${s.replace('USDT', '')} ${v.pnl.toFixed(1)}$ (${v.n})`).join(', ');
  const rej = Object.entries(x.r.rejects).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join('; ');
  log(`- **${x.item.title}** · найкращі: ${top} · найгірші: ${bot}${rej ? ` · відхилено сигналів — ${rej}` : ''}`);
}
fs.mkdirSync('bybit/data', { recursive: true });
fs.writeFileSync('bybit/data/universe.json', JSON.stringify(summary.map(x => ({ title: x.item.title, profile: x.pn, n: x.r.n, net: x.r.net, perMonth: x.r.perMonth, maxDd: x.r.maxDd, pf: x.r.pf, isNet: x.a.net, oosNet: x.b.net, mc: x.mc })), null, 1));
if (process.argv[2]) fs.writeFileSync(process.argv[2], lines.join('\n') + '\n');
