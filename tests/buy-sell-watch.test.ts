import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletBuys, latestActivityBuy, sellAfterBuy, detailWalletSell } from '../src/buy-sell-watch-activity.js';

const wallet = '5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT';
const mint = 'FDW1Et4FS6sYLjByZNNvB8ZzwZ4eh9HG2snB97Jzpump';
const other = '3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD';
const activity = (side: string, timestamp: number, address = mint) => ({ event_type: side, timestamp,
  token: { address, symbol: 'TEST' }, token_amount: '42', price_usd: '0.25', tx_hash: `${side}:${timestamp}` });
const body = (...activities: unknown[]) => ({ data: { activities } });

test('wallet buys ignore transfers and parse buy/swap_buy API and compact rows', () => {
  const buys = walletBuys(body(activity('transfer_in', 300), activity('buy', 100),
    { e: 'swap_buy', a: mint, t: 200, pu: 0.5, ba: '10', h: 'compact' }), wallet);
  assert.equal(buys.length, 2);
  assert.equal(buys[0].timestamp, 200);
  assert.equal(buys[0].wallet, wallet);
  assert.equal(buys[0].priceUsd, 0.5);
  assert.equal(buys[1].symbol, 'TEST');
});

test('only the top activity can open a detail; a top sell blocks every older buy', () => {
  assert.equal(latestActivityBuy(body(activity('sell', 200), activity('buy', 100)), wallet), undefined);
  assert.equal(latestActivityBuy(body(activity('swap_sell', 200), activity('buy', 100)), wallet), undefined);
  // This is the regression: an unsold older mint must not be opened when
  // the latest transaction is a sell, even of a completely different mint.
  assert.equal(latestActivityBuy(body(activity('sell', 200, other), activity('buy', 100)), wallet), undefined);
  assert.equal(latestActivityBuy(body(activity('buy', 100), activity('sell', 50)), wallet)?.timestamp, 100);
  assert.equal(latestActivityBuy(body(activity('transfer_in', 200), activity('buy', 100)), wallet), undefined);
  assert.equal(latestActivityBuy(body(activity('buy', 200, 'invalid'), activity('buy', 100)), wallet), undefined);
  assert.equal(latestActivityBuy(body(), wallet), undefined);
});

test('a rebuy after a sell stays active and the next sell closes that rebuy', () => {
  const feed = body(activity('buy', 300), activity('sell', 200), activity('buy', 100));
  const buy = latestActivityBuy(feed, wallet)!;
  assert.equal(buy.timestamp, 300);
  assert.equal(sellAfterBuy(feed, buy), undefined);
  const sold = body(activity('sell', 400), activity('buy', 300), activity('sell', 200), activity('buy', 100));
  assert.equal(latestActivityBuy(sold, wallet), undefined);
  assert.equal(sellAfterBuy(sold, buy)?.timestamp, 400);
});

test('the first buy opens its own token; malformed mint and missing timestamps are ignored', () => {
  assert.equal(latestActivityBuy(body(activity('buy', 200, other), activity('buy', 100)), wallet)?.mint, other);
  assert.deepEqual(walletBuys(body(activity('buy', 0), activity('buy', 300, 'z'.repeat(44)),
    activity('buy', Infinity)), wallet), []);
});

test('detail socket closes only for a sell by the tracked wallet on the tracked mint', () => {
  const buy = walletBuys(body(activity('buy', 100)), wallet)[0];
  const row = { n: 'sol', e: 'sell', m: wallet, a: mint, t: 200, h: 'sell-signature' };
  const frame = (value: unknown) => ({ channel: 'token_activity', data: [value] });
  assert.equal(detailWalletSell(frame(row), buy), row);
  assert.equal(detailWalletSell({ channel: 'token_activity_info_all', data: [row] }, buy), row);
  assert.equal(detailWalletSell(frame({ ...row, m: other }), buy), undefined);
  assert.equal(detailWalletSell(frame({ ...row, a: other }), buy), undefined);
  assert.equal(detailWalletSell(frame({ ...row, n: 'eth' }), buy), undefined);
  assert.equal(detailWalletSell(frame({ ...row, e: 'buy' }), buy), undefined);
  assert.equal(detailWalletSell(frame({ ...row, t: 99 }), buy), undefined);
  assert.equal(detailWalletSell({ channel: 'unrelated', data: [row] }, buy), undefined);
  assert.equal(detailWalletSell(frame({ ...row, h: buy.tx }), buy), undefined);
  assert.ok(detailWalletSell(frame({ ...row, t: buy.timestamp }), buy));
});
