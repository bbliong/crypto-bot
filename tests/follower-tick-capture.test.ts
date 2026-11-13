import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFollowerTicks } from '../src/follower-tick-capture.js';

test('captures raw token items in receipt order without turning unknown events into sells', () => {
  const frame = JSON.stringify({channel:'token_activity',data:[{a:'mint-a',e:'buy',p:0,t:17,qa:2},{a:'mint-a',e:'withdraw',pu:0.1,qa:3}]});
  const ticks = extractFollowerTicks(frame, {sessionId:'s',connectionId:'c',requestId:'r',receiveSequence:7,receivedAt:900,targetWallet:'target'});
  assert.equal(ticks.length, 2);
  assert.deepEqual(ticks.map(t=>t.itemIndex), [0,1]);
  assert.deepEqual(ticks.map(t=>t.raw), [{a:'mint-a',e:'buy',p:0,t:17,qa:2},{a:'mint-a',e:'withdraw',pu:0.1,qa:3}]);
  assert.equal(ticks[1].channel, 'token_activity');
  assert.equal(ticks[1].receiveSequence, 7);
  assert.equal(ticks[0].receivedAt, 900);
});

test('archives only relevant wallet and token channels and redacts credential-shaped fields recursively', () => {
  const context = {sessionId:'s',connectionId:'c',requestId:null,receiveSequence:1,receivedAt:1,targetWallet:'target'};
  assert.deepEqual(extractFollowerTicks(JSON.stringify({channel:'wallet_activity_info',data:[{a:'a',m:'other'},{a:'b',m:'target',nested:{authorization:'secret',value:1}}]}),context).map(t=>t.mint),['b']);
  const [tick] = extractFollowerTicks(JSON.stringify({channel:'token_stat',data:[{a:'mint',p:0,cookie:'secret',apiKey:'secret'}]}),context);
  assert.equal((tick.raw as any).cookie,'[REDACTED]');
  assert.equal((tick.raw as any).apiKey,'[REDACTED]');
  assert.deepEqual(extractFollowerTicks(JSON.stringify({channel:'major_coin_price',data:[{a:'a'}]}),context),[]);
  assert.deepEqual(extractFollowerTicks('{bad',context),[]);
});
