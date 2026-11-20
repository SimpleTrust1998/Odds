// Тести трекера на синтетичному ринку: node --test pumpfun/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  Engine, makeConfig, simBuy, simSell, dexSell, paperReport, runReplay, cleanText, journalCsv, alertText, reportText, inQuiet,
} from './tracker.mjs';

const T0 = Date.UTC(2026, 10, 20, 10, 0, 0);
const cfg = (o = {}) => ({ ...makeConfig({}), ...o });

function setup(o = {}, deps = {}) {
  const events = [], subs = new Set();
  const eng = new Engine(cfg(o), {
    emit: (k, e) => events.push([k, e]), subscribe: m => subs.add(m), unsubscribe: m => subs.delete(m), ...deps,
  });
  return { eng, events, subs, of: k => events.filter(x => x[0] === k).map(x => x[1]) };
}

// Синтетична крива pump.fun: та сама constant-product математика, що й на платформі
class Market {
  constructor(eng, { mint = 'MINT1', dev = 'DEV', devSol = 1, t = T0, rec = null } = {}) {
    Object.assign(this, { eng, mint, dev, t, rec, fee: 0.0125, vSol: 30, vTok: 1073e6, bal: new Map(), sig: 0 });
    const got = this.apply(devSol);
    this.bal.set(dev, got);
    this.send({
      txType: 'create', mint, traderPublicKey: dev, initialBuy: got, solAmount: devSol, bondingCurveKey: 'CURVE_' + mint,
      vSolInBondingCurve: this.vSol, vTokensInBondingCurve: this.vTok, name: 'Test Coin', symbol: 'TST', uri: '', pool: 'pump', signature: 'c-' + mint,
    });
  }
  apply(sol) { const net = sol * (1 - this.fee), out = this.vTok - this.vSol * this.vTok / (this.vSol + net); this.vSol += net; this.vTok -= out; return out; }
  send(m) { if (this.rec) this.rec.push({ t: this.t, m }); this.eng.onMessage(m, this.t); }
  buy(who, sol, { hidden = false } = {}) {
    const out = this.apply(sol), b = (this.bal.get(who) || 0) + out;
    this.bal.set(who, b);
    if (!hidden) this.send({ txType: 'buy', mint: this.mint, traderPublicKey: who, solAmount: sol, tokenAmount: out, newTokenBalance: b, vSolInBondingCurve: this.vSol, vTokensInBondingCurve: this.vTok, pool: 'pump', signature: `s${this.mint}${++this.sig}` });
  }
  sell(who, frac = 1) {
    const have = this.bal.get(who) || 0, tok = have * frac;
    if (!(tok > 0)) return;
    const out = this.vSol - this.vSol * this.vTok / (this.vTok + tok);
    this.vSol -= out; this.vTok += tok; this.bal.set(who, have - tok);
    this.send({ txType: 'sell', mint: this.mint, traderPublicKey: who, solAmount: out * (1 - this.fee), tokenAmount: tok, newTokenBalance: have - tok, vSolInBondingCurve: this.vSol, vTokensInBondingCurve: this.vTok, pool: 'pump', signature: `s${this.mint}${++this.sig}` });
  }
  // тіки двигуна на тій самій 2-секундній сітці, що й у replay
  advance(ms) {
    const end = this.t + ms;
    for (let k = Math.floor((this.t - T0) / 2000) + 1; T0 + k * 2000 <= end; k++) this.eng.tick(T0 + k * 2000);
    this.t = end;
  }
  organic(n, { sol = 0.35, gap = 3000, prefix = 'B' } = {}) { for (let i = 0; i < n; i++) { this.advance(gap); this.buy(`${prefix}${i}`, sol); } }
  dumpAll(prefix, gap = 1000) { for (const who of [...this.bal.keys()].filter(k => k.startsWith(prefix))) { this.advance(gap); this.sell(who, 1); } }
}

test('крива: купівля + миттєвий продаж коштує ≈ дві комісії', () => {
  const fee = 0.0225, vSol = 50, vTok = 3.219e10 / 50;
  const got = simBuy(vSol, vTok, 0.06, fee);
  const nSol = vSol + 0.06 * (1 - fee), nTok = vTok - got;
  const back = simSell(nSol, nTok, got, fee);
  assert.ok(Math.abs(back / 0.06 - (1 - fee) ** 2) < 1e-9, `повернулось ${back}`);
  assert.equal(simBuy(0, 0, 1, fee), 0);
  assert.ok(dexSell({ price: 1e-7, liqBase: 1e8 }, 1e6, 0.013) < 1e6 * 1e-7);
});

test('органічна монета: один сигнал, paper-вхід із затримкою, тейк 2x і трейлінг у плюс', () => {
  const { eng, of } = setup();
  const mk = new Market(eng);
  mk.organic(60);
  const alerts = of('alert');
  assert.equal(alerts.length, 1, 'має бути рівно один сигнал');
  const a = alerts[0];
  assert.deepEqual(a.r.blockers, []);
  assert.ok(a.r.score >= 60, `скор ${a.r.score}`);
  assert.ok(a.pos && a.pos.pos, 'paper-позиція відкрита');
  const p = a.pos.pos;
  assert.equal(p.state, 'open', 'вхід виконано після затримки');
  assert.ok(p.openedAt - p.signalAt >= 8000, 'затримка виконання врахована');
  assert.ok(a.r.m.hiddenPct < 0.01, `невидимі ${a.r.m.hiddenPct}`);
  assert.match(alertText(a), /🔎 Кандидат: \$TST/);

  mk.organic(80, { prefix: 'C', sol: 0.5, gap: 2000 });
  assert.ok(p.tp1, `тейк має спрацювати, пік ${p.peak.toFixed(2)}x`);
  mk.dumpAll('C');
  mk.dumpAll('B');
  mk.advance(30000);
  const closed = of('paper_close');
  assert.equal(closed.length, 1);
  const rec = closed[0].rec;
  assert.deepEqual(rec.reasons, ['тейк 2x', 'трейлінг']);
  assert.ok(rec.pnl > 0, `pnl ${rec.pnl}`);
  assert.equal(eng.journal.length, 1);
});

test('бандл у блоці створення: «невидимі» покупки блокують сигнал', () => {
  const { eng, of } = setup();
  const mk = new Market(eng);
  for (let i = 0; i < 6; i++) mk.buy(`BUNDLE${i}`, 1.5, { hidden: true });
  mk.organic(60);
  assert.equal(of('alert').length, 0);
  const tok = eng.tokens.get('MINT1');
  assert.ok(tok.blockers.some(b => b.startsWith('невидимі')), tok.blockers.join('; '));
  assert.ok(tok.m.hiddenPct > 0.2);
});

test('dev продав до сигналу: монета заблокована', () => {
  const { eng, of } = setup();
  const mk = new Market(eng);
  mk.organic(20);
  mk.sell('DEV', 1);
  mk.organic(40, { prefix: 'C' });
  assert.equal(of('alert').length, 0);
  assert.ok(eng.tokens.get('MINT1').blockers.some(b => b.startsWith('dev продав')));
});

test('dev продав під час позиції: вихід «dev продав»', () => {
  const { eng, of } = setup();
  const mk = new Market(eng);
  mk.organic(60);
  assert.equal(of('alert').length, 1);
  mk.sell('DEV', 1);
  mk.advance(12000);
  mk.buy('LATE', 0.1);
  const rec = of('paper_close')[0]?.rec;
  assert.ok(rec, 'позицію закрито');
  assert.equal(rec.reason, 'dev продав');
  assert.equal(of('dev_dump').length, 1);
});

test('раг: стоп-лосс закриває в мінус з урахуванням затримки', () => {
  const { eng, of } = setup();
  const mk = new Market(eng);
  for (let i = 0; i < 100 && !of('alert').length; i++) mk.organic(1, { prefix: `B${i}_` });
  assert.equal(of('alert').length, 1);
  mk.advance(9000);
  assert.equal(eng.positions[0].state, 'open');
  mk.dumpAll('B', 500);
  mk.advance(20000);
  const rec = of('paper_close')[0]?.rec;
  assert.ok(rec);
  assert.equal(rec.reason, 'стоп-лосс');
  assert.ok(rec.pnlPct < -0.35, `pnl ${rec.pnlPct}`);
});

test('тайм-стоп: без нового піку 20 хв позиція закривається', () => {
  const { eng, of } = setup();
  const mk = new Market(eng);
  mk.organic(60);
  mk.advance(21 * 60000);
  assert.equal(of('paper_close')[0]?.rec.reason, 'тайм-стоп');
});

test('ліміт відкритих позицій і денний ліміт втрат', () => {
  const { eng, of } = setup({ maxOpen: 1, dailyLossSol: 0.01 });
  const a = new Market(eng, { mint: 'MA' });
  a.organic(60);
  const b = new Market(eng, { mint: 'MB', t: a.t });
  b.organic(60);
  const al = of('alert');
  assert.equal(al.length, 2);
  assert.ok(al[0].pos.pos);
  assert.match(al[1].pos.skip, /відкриті позиції/);
  a.dumpAll('B', 500);
  a.advance(20000);
  assert.ok(of('limit').some(x => x.kind === 'daily'));
  const c = new Market(eng, { mint: 'MC', t: a.t });
  c.organic(60);
  assert.equal(of('alert').at(-1).pos.skip, 'денний ліміт втрат');
});

test('міграція без DEX-даних: вихід за ціною кривої одразу', () => {
  const { eng, of } = setup();
  const mk = new Market(eng);
  mk.organic(60);
  mk.send({ txType: 'migrate', mint: 'MINT1', signature: 'mig' });
  assert.equal(of('paper_close')[0]?.rec.reason, 'міграція');
  assert.equal(of('migration').length, 1);
});

test('міграція в DEX-режимі: продаж за ціною DexScreener або запасний вихід', () => {
  const { eng, of } = setup({}, { dex: true });
  const mk = new Market(eng);
  mk.organic(60);
  mk.send({ txType: 'migrate', mint: 'MINT1', signature: 'mig' });
  const p = eng.positions[0];
  assert.ok(p.dex);
  eng.onDexPrice('MINT1', { price: p.ref * 3, liqBase: 2e8 }, mk.t + 1000);
  assert.ok(p.tp1, 'тейк за ціною DEX');
  eng.onDexPrice('MINT1', { price: p.ref * 3, liqBase: 2e8 }, mk.t + 10000);
  assert.ok(p.left < p.tokens && !p.closed, 'продано половину, решта тримається');
  mk.advance(6 * 60000);
  assert.ok(!p.closed, 'з живими DEX-цінами запасний вихід не спрацьовує');
  eng.onDexPrice('MINT1', { price: p.ref * 1.8, liqBase: 2e8 }, mk.t + 1000);
  eng.onDexPrice('MINT1', { price: p.ref * 1.7, liqBase: 2e8 }, mk.t + 10000);
  const rec = of('paper_close')[0]?.rec;
  assert.ok(rec, 'позицію закрито');
  assert.deepEqual(rec.reasons, ['тейк 2x', 'трейлінг']);
  assert.ok(rec.pnl > 0);

  const s2 = setup({}, { dex: true });
  const mk2 = new Market(s2.eng);
  mk2.organic(60);
  mk2.send({ txType: 'migrate', mint: 'MINT1', signature: 'mig' });
  mk2.advance(6 * 60000);
  assert.equal(s2.of('paper_close')[0]?.rec.reason, 'міграція (без даних DEX)');
});

test('дублікати подій не рахуються двічі, чужі пули ігноруються', () => {
  const { eng } = setup();
  const mk = new Market(eng);
  mk.buy('X', 0.5);
  const m = { ...mk.rec?.at(-1)?.m };
  const tok = eng.tokens.get('MINT1');
  const before = tok.trades;
  eng.onMessage({ txType: 'buy', mint: 'MINT1', traderPublicKey: 'X', solAmount: 0.5, tokenAmount: 1, newTokenBalance: 1, vSolInBondingCurve: 40, vTokensInBondingCurve: 8e8, pool: 'pump', signature: 'dup' }, mk.t);
  eng.onMessage({ txType: 'buy', mint: 'MINT1', traderPublicKey: 'X', solAmount: 0.5, tokenAmount: 1, newTokenBalance: 1, vSolInBondingCurve: 40, vTokensInBondingCurve: 8e8, pool: 'pump', signature: 'dup' }, mk.t);
  assert.equal(tok.trades, before + 1);
  eng.onMessage({ txType: 'create', mint: 'BONK1', traderPublicKey: 'D', vSolInBondingCurve: 30, vTokensInBondingCurve: 1e9, pool: 'bonk', signature: 'b' }, mk.t);
  assert.equal(eng.tokens.has('BONK1'), false);
  assert.ok(m);
});

test('мертві монети відписуються, щоб не перевантажувати стрім', () => {
  const { eng, subs } = setup();
  const mk = new Market(eng, { mint: 'DEAD' });
  assert.ok(subs.has('DEAD'));
  mk.buy('A', 0.1);
  mk.advance(200000);
  assert.equal(eng.tokens.has('DEAD'), false);
  assert.equal(subs.has('DEAD'), false);
});

test('серійний деплоєр блокується', () => {
  const { eng, of } = setup({ serialN: 3 });
  let t = T0;
  for (const mint of ['S1', 'S2']) { new Market(eng, { mint, dev: 'SERIAL', t }); t += 1000; }
  const mk = new Market(eng, { mint: 'S3', dev: 'SERIAL', t });
  mk.organic(60);
  assert.equal(of('alert').length, 0);
  assert.ok(eng.tokens.get('S3').blockers.some(b => b.startsWith('серійний')));
});

test('збереження й відновлення стану після рестарту', () => {
  const { eng } = setup();
  const mk = new Market(eng);
  mk.organic(60);
  eng.wallets.set('WALLET1', 'кит');
  eng.addWatch('WATCH1', mk.t);
  const snap = JSON.parse(JSON.stringify(eng.snapshot()));
  const s2 = setup();
  s2.eng.restore(snap, mk.t + 1000);
  assert.equal(s2.eng.positions.length, 1);
  assert.ok(s2.eng.positions[0].restored);
  assert.ok(s2.subs.has('MINT1') && s2.subs.has('WATCH1'));
  assert.equal(s2.eng.wallets.get('WALLET1'), 'кит');
  s2.eng.tick(mk.t + 62 * 60000);
  assert.equal(s2.of('paper_close')[0]?.rec.reason, 'немає ціни після рестарту');
});

test('звіт: контрольна точка №1 і просідання', () => {
  const C = cfg({ bankSol: 0.36 });
  const mk = (pnlPct, i) => ({ id: String(i), symbol: 'X', mint: 'M', signalAt: T0, openedAt: T0, closedAt: T0 + 6e5, size: 0.06, out: 0.06 * (1 + pnlPct), pnl: 0.06 * pnlPct, pnlPct, peak: 1, reason: pnlPct > 0 ? 'трейлінг' : 'стоп-лосс', reasons: [], score: 70, flags: [] });
  const good = Array.from({ length: 120 }, (_, i) => mk(i % 2 ? 0.3 : -0.1, i));
  const r = paperReport(good, C);
  assert.equal(r.n, 120);
  assert.ok(Math.abs(r.mean - 0.1) < 1e-9);
  assert.ok(r.gate.pass, JSON.stringify(r.gate));
  const bad = Array.from({ length: 10 }, (_, i) => mk(-1, i));
  const rb = paperReport(bad, C);
  assert.equal(rb.stopAt, 6);
  assert.equal(rb.gate.pass, false);
  assert.match(reportText(rb, C), /зупинився б на угоді №6/);
  assert.equal(journalCsv(good).trim().split('\n').length, 121);
});

test('бектест із записаного файлу дає той самий результат, що й наживо', async () => {
  const rec = [];
  const { eng, of } = setup();
  const mk = new Market(eng, { rec });
  mk.organic(60);
  mk.organic(80, { prefix: 'C', sol: 0.5, gap: 2000 });
  mk.dumpAll('C');
  mk.advance(30000);
  mk.buy('END', 0.01);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-')), 'events.jsonl.gz');
  fs.writeFileSync(file, zlib.gzipSync(rec.map(e => JSON.stringify(e)).join('\n') + '\n'));
  const r = await runReplay(file, cfg());
  assert.equal(r.n, rec.length);
  assert.equal(r.eng.stats.signals, 1);
  assert.equal(r.rep.n, 1);
  assert.ok(Math.abs(r.eng.journal[0].pnl - of('paper_close')[0].rec.pnl) < 1e-6);
});

test('захист від фішингу в назвах монет і тихі години', () => {
  const s = cleanText('Claim at scam-site.com now https://evil.xyz/drain\nfree');
  assert.ok(!/scam-site\.com|https|evil/.test(s), s);
  assert.equal(inQuiet(Date.UTC(2026, 10, 20, 22, 0), '23-8'), true); // 00:00 за Києвом
  assert.equal(inQuiet(Date.UTC(2026, 10, 20, 10, 0), '23-8'), false);
  assert.equal(inQuiet(Date.UTC(2026, 10, 20, 10, 0), '0-0'), false);
});
