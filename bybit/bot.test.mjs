// Тести ядра й бота проти фейкової біржі Bybit (перевіряє підпис кожного приватного запиту): node --test bybit/
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot, Bybit, TG, FileStore, makeConfig } from './bot.mjs';
import { sizeOrder, profileOf, specOf, RiskGuard, backtest, backtestPortfolio, STRATEGIES, toSeries, monteCarlo, floorStep } from './core.mjs';

const KEY = 'test-key', SECRET = 'test-secret', H4 = 4 * 36e5;

// ---------- фейкова біржа ----------
function mockBybit(clock) {
  const M = { cash: 219, price: {}, candles: {}, pos: {}, lev: {}, orders: [], closed: [], calls: [], perms: { ContractTrade: ['Order', 'Position'] }, ips: ['1.2.3.4'], readOnly: 0, badSign: 0 };
  const upnl = () => Object.entries(M.pos).reduce((s, [k, p]) => s + p.dir * p.qty * (M.price[k] - p.entry), 0);
  const closePos = (sym, px) => {
    const p = M.pos[sym], fee = p.qty * px * 0.00055, pnl = p.dir * p.qty * (px - p.entry) - fee;
    M.cash += pnl;
    M.closed.push({ symbol: sym, qty: String(p.qty), avgEntryPrice: String(p.entry), avgExitPrice: String(px), closedPnl: String(pnl), updatedTime: String(clock()) });
    delete M.pos[sym];
  };
  M.setPrice = (sym, px) => {
    M.price[sym] = px;
    const p = M.pos[sym];
    if (p && p.stop && (p.dir > 0 ? px <= p.stop : px >= p.stop)) closePos(sym, p.stop); // стоп на біржі
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams);
      const P = req.method === 'POST' ? JSON.parse(body || '{}') : q;
      const send = (result, code = 0, msg = 'OK') => res.end(JSON.stringify({ retCode: code, retMsg: msg, result }));
      if (!u.pathname.startsWith('/v5/market/')) {
        const h = req.headers, payload = req.method === 'POST' ? body : (req.url.split('?')[1] || '');
        const exp = crypto.createHmac('sha256', SECRET).update(h['x-bapi-timestamp'] + h['x-bapi-api-key'] + h['x-bapi-recv-window'] + payload).digest('hex');
        if (h['x-bapi-api-key'] !== KEY || h['x-bapi-sign'] !== exp) { M.badSign++; return send({}, 10004, 'error sign!'); }
        M.calls.push({ path: u.pathname, P });
      }
      switch (u.pathname) {
        case '/v5/market/time': return send({ timeSecond: String(Math.floor(clock() / 1000)), timeNano: String(clock() * 1e6) });
        case '/v5/market/kline': return send({ list: (M.candles[q.symbol] || []).filter(c => c[0] <= clock()).slice(-(+q.limit || 200)).reverse().map(c => c.map(String)) });
        case '/v5/market/instruments-info': return send({ list: [{ symbol: q.symbol, status: 'Trading', lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', minNotionalValue: '5' }, priceFilter: { tickSize: '0.10' }, leverageFilter: { maxLeverage: '100' } }] });
        case '/v5/market/tickers': { const px = M.price[q.symbol]; return send({ list: [{ symbol: q.symbol, bid1Price: String(px - 0.5), ask1Price: String(px + 0.5), lastPrice: String(px), turnover24h: '1' }] }); }
        case '/v5/user/query-api': return send({ readOnly: M.readOnly, permissions: M.perms, ips: M.ips });
        case '/v5/account/wallet-balance': { const eq = M.cash + upnl(); return send({ list: [{ totalEquity: String(eq), totalAvailableBalance: String(eq * 0.9) }] }); }
        case '/v5/position/list': return send({ list: Object.entries(M.pos).map(([s, p]) => ({ symbol: s, side: p.dir > 0 ? 'Buy' : 'Sell', size: String(p.qty), avgPrice: String(p.entry), stopLoss: p.stop ? String(p.stop) : '', takeProfit: '', leverage: String(p.lev), positionIdx: 0, unrealisedPnl: '0', liqPrice: '', markPrice: String(M.price[s]) })) });
        case '/v5/position/set-leverage': M.lev[P.symbol] = +P.buyLeverage; return send({});
        case '/v5/position/switch-mode': return send({}, 110025, 'Position mode is not modified');
        case '/v5/order/create': {
          M.orders.push(P);
          const px = M.price[P.symbol], fill = P.side === 'Buy' ? px + 0.5 : px - 0.5;
          if (P.reduceOnly) { if (M.pos[P.symbol]) closePos(P.symbol, fill); return send({ orderId: 'c', orderLinkId: P.orderLinkId }); }
          M.cash -= +P.qty * fill * 0.00055;
          M.pos[P.symbol] = { dir: P.side === 'Buy' ? 1 : -1, qty: +P.qty, entry: fill, stop: +P.stopLoss || 0, lev: M.lev[P.symbol] || 1 };
          return send({ orderId: 'o', orderLinkId: P.orderLinkId });
        }
        case '/v5/order/cancel-all': return send({ list: [] });
        case '/v5/position/trading-stop': if (M.pos[P.symbol]) M.pos[P.symbol].stop = +P.stopLoss; return send({});
        case '/v5/position/closed-pnl': return send({ list: M.closed.filter(x => x.symbol === q.symbol && +x.updatedTime >= +q.startTime) });
        default: res.statusCode = 404; return res.end('{}');
      }
    });
  });
  return { M, srv };
}

// 4h-свічки: висхідний тренд з коливаннями, остання закрита свічка — пробій 30-свічкового максимуму
function trendCandles(boundary, n = 300, base = 50000) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = boundary - (n - k) * H4, mid = base + k * 15 + 250 * Math.sin(k / 4);
    out.push([t, mid - 20, mid + 120, mid - 140, mid + 20, 100]);
  }
  const prevHigh = Math.max(...out.slice(-31, -1).map(c => c[2])), last = out[n - 1];
  last[4] = prevHigh + 300; last[2] = last[4] + 50;
  out.push([boundary, last[4], last[4] + 10, last[4] - 10, last[4], 1]); // свічка, що ще формується, — бот має її ігнорувати
  return out;
}

async function setup(env = {}, mut = () => {}) {
  let T = Math.floor(Date.now() / H4) * H4 + 10_000;
  const clock = () => T;
  const { M, srv } = mockBybit(clock);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  M.candles.BTCUSDT = trendCandles(Math.floor(T / H4) * H4);
  M.setPrice('BTCUSDT', M.candles.BTCUSDT.at(-1)[4]);
  mut(M);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  const C = makeConfig({ BYBIT_MODE: 'demo', BYBIT_API_KEY: KEY, BYBIT_API_SECRET: SECRET, BYBIT_BASE: base, BYBIT_DATA_BASE: base, SYMBOLS: 'BTCUSDT', STATE_DIR: dir, REPORT_HOUR: '99', ...env });
  const ex = new Bybit({ key: C.key, secret: C.secret, base: C.tradeBase, dataBase: C.dataBase });
  const tg = new TG(C), bot = new Bot(C, { ex, tg, store: new FileStore(dir), now: clock });
  return { M, srv, bot, tg, C, setT: x => (T = x), getT: () => T };
}

test('ризик: розмір позиції від стопа, плече і ліквідація далі за стоп', () => {
  const pr = profileOf('normal'), z = sizeOrder({ equity: 219, price: 50000, stop: 49000, profile: pr, spec: specOf('BTCUSDT') });
  assert.ok(z.qty >= 0.001 && z.risk <= pr.riskPct * 1.5, JSON.stringify(z));
  assert.ok(z.liqDist >= 2 * z.dist);
  assert.match(sizeOrder({ equity: 20, price: 50000, stop: 49000, profile: pr, spec: specOf('BTCUSDT') }).reject, /депозит замалий|ризик/);
  assert.match(sizeOrder({ equity: 219, price: 100, stop: 99.95, profile: pr, spec: specOf('SOLUSDT') }).reject, /стоп ближче/);
  assert.equal(profileOf('aggressive', { maxLev: 50, riskPct: 0.2 }).maxLev, 10, 'жорстка межа плеча');
  assert.equal(profileOf('aggressive', { riskPct: 0.2 }).riskPct, 0.03, 'жорстка межа ризику');
  assert.equal(floorStep(0.0029999, 0.001), 0.002);
});

test('ризик-гард: kill-switch, денний ліміт, пауза після серії збитків', () => {
  const g = new RiskGuard(profileOf('normal'), 200), t = Date.UTC(2026, 10, 20, 10);
  assert.equal(g.update(210, t), false);
  for (let k = 0; k < 4; k++) g.onClosed(-1, t);
  assert.match(g.blocked(t + 1), /пауза/);
  assert.equal(g.blocked(t + 13 * 36e5), null);
  g.update(203, t + 13 * 36e5);
  assert.match(g.blocked(t + 13 * 36e5), /денний ліміт/);
  assert.equal(g.update(178, t + 14 * 36e5), true, 'просідання 15% від піку 210');
  assert.match(g.blocked(t), /kill-switch/);
});

test('бектест: без заглядання вперед і портфель = одиночний на одній монеті', () => {
  const rows = [];
  let p = 100;
  for (let k = 0; k < 3000; k++) { const d = Math.sin(k / 30) * 0.8 + Math.sin(k / 7) * 0.3; const o = p; p = p * (1 + d / 100); rows.push([k * 36e5, o, Math.max(o, p) * 1.003, Math.min(o, p) * 0.997, p, 100 + (k % 13) * 10]); }
  const S = toSeries(rows), pr = profileOf('normal'), sp = { qtyStep: 0.01, minQty: 0.01, minNotional: 5, tickSize: 0.01 };
  const a = backtest(S, STRATEGIES.trend(), { profile: pr, spec: sp }), b = backtestPortfolio([{ sym: 'X', S, spec: sp }], () => STRATEGIES.trend(), { profile: pr });
  assert.ok(a.n > 5);
  assert.equal(a.n, b.n);
  assert.ok(Math.abs(a.final - b.final) < 1e-9);
  // зміна майбутніх свічок не змінює угод, закритих до цього моменту
  const rows2 = rows.map((r, k) => (k >= 2500 ? [r[0], r[1] * 2, r[2] * 2, r[3] * 2, r[4] * 2, r[5]] : r));
  const c = backtest(toSeries(rows2), STRATEGIES.trend(), { profile: pr, spec: sp });
  const before = x => x.trades.filter(tr => tr.t1 < 2400 * 36e5).map(tr => tr.pnl.toFixed(9)).join();
  assert.equal(before(a), before(c));
  const mc = monteCarlo([0.01, -0.005, 0.02, -0.01], { paths: 500, horizon: 50, maxDd: 0.15 });
  assert.ok(mc.pTarget >= 0 && mc.pKill >= 0 && mc.pTarget + mc.pKill <= 1);
});

test('бот: перевірка ключа відхиляє небезпечні налаштування', async () => {
  for (const [env, mut, re] of [
    [{}, M => { M.perms = { ContractTrade: ['Order'], Wallet: ['Withdraw'] }; }, /ВИВОДУ/],
    [{ STRATEGY: 'scalp' }, () => {}, /НЕ пройшла бектест/],
    [{ BYBIT_MODE: 'live' }, () => {}, /LIVE_CONFIRM/],
    [{ BYBIT_MODE: 'live', LIVE_CONFIRM: 'YES_REAL_MONEY' }, M => { M.ips = ['*']; }, /IP/],
    [{}, M => { M.readOnly = 1; }, /лише для читання/],
  ]) {
    const x = await setup(env, mut);
    try { await assert.rejects(() => x.bot.init(), re); } finally { x.srv.close(); }
  }
  const ok = await setup({ STRATEGY: 'scalp', ALLOW_UNPROVEN: '1' });
  try { await ok.bot.init(); } finally { ok.srv.close(); }
});

test('бот: вхід зі стопом на біржі, відновлення стопа, вихід по стопу, kill-switch', async () => {
  const { M, srv, bot, tg, setT, getT } = await setup();
  try {
    const lines = await bot.init();
    assert.ok(lines.some(l => l.includes('DEMO')));
    await bot.step();
    assert.equal(M.badSign, 0, 'кожен приватний запит підписано правильно');
    const o = M.orders[0];
    assert.ok(o, 'ордер відкрито');
    assert.equal(o.side, 'Buy');
    assert.equal(o.orderType, 'Market');
    assert.equal(o.positionIdx, 0);
    const px = M.price.BTCUSDT, stop = +o.stopLoss;
    assert.ok(stop > 0 && stop < px, 'стоп ставиться разом з ордером');
    assert.ok(+o.qty * (px - stop) <= 219 * 0.015, 'ризик ≤ 1,5% капіталу');
    assert.ok(M.pos.BTCUSDT && M.pos.BTCUSDT.stop === stop);
    assert.ok(tg.sent.some(m => m.includes('LONG BTCUSDT')));

    await bot.step();
    assert.equal(M.orders.length, 1, 'та сама свічка — повторного входу немає');

    M.pos.BTCUSDT.stop = 0; // біржа «загубила» стоп
    await bot.step();
    assert.equal(M.pos.BTCUSDT.stop, stop, 'стоп відновлено');
    assert.ok(tg.sent.some(m => m.includes('🛡')));

    M.setPrice('BTCUSDT', stop - 50); // спрацював стоп на біржі
    await bot.step();
    assert.equal(bot.state.journal.length, 1);
    assert.equal(bot.state.journal[0].reason, 'стоп');
    assert.ok(bot.state.journal[0].pnl < 0);
    assert.ok(tg.sent.some(m => m.startsWith('❌ BTCUSDT')));

    // наступна 4h-свічка — новий пробій і новий вхід
    setT(getT() + H4);
    M.candles.BTCUSDT = trendCandles(Math.floor(getT() / H4) * H4, 300, 51000);
    M.setPrice('BTCUSDT', M.candles.BTCUSDT.at(-1)[4]);
    await bot.step();
    assert.equal(M.orders.length, 2);
    assert.ok(M.pos.BTCUSDT);

    M.cash -= 60; // різка втрата капіталу → kill-switch
    await bot.step();
    assert.ok(bot.state.halted, 'бот зупинено');
    assert.ok(M.orders.at(-1).reduceOnly, 'позицію закрито ордером reduceOnly');
    assert.equal(M.pos.BTCUSDT, undefined);
    assert.ok(tg.sent.some(m => m.includes('KILL-SWITCH')));

    setT(getT() + H4);
    M.candles.BTCUSDT = trendCandles(Math.floor(getT() / H4) * H4, 300, 52000);
    M.setPrice('BTCUSDT', M.candles.BTCUSDT.at(-1)[4]);
    const n = M.orders.length;
    await bot.step();
    assert.equal(M.orders.length, n, 'після kill-switch нових угод немає');

    await bot.command('/resume_confirm');
    assert.equal(bot.state.halted, null);
    const saved = JSON.parse(fs.readFileSync(path.join(bot.C.dir, 'bot_state.json'), 'utf8'));
    assert.equal(saved.journal.length, 2);
  } finally { srv.close(); }
});

test('бот: чужа позиція на монеті — не торгує її', async () => {
  const { M, srv, bot, tg } = await setup({}, M => { M.pos.BTCUSDT = { dir: -1, qty: 0.01, entry: 50000, stop: 0, lev: 1 }; });
  try {
    await bot.init();
    await bot.step();
    assert.equal(M.orders.length, 0);
    assert.ok(tg.sent.some(m => m.includes('відкрив не бот')));
  } finally { srv.close(); }
});
