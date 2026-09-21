import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stats,pricePath,number} from '../scripts/research-math.mjs';
test('missing numbers are not zero and median handles even samples',()=>{assert.equal(number(null),null);assert.deepEqual(stats([1,3,null]).median,2);assert.equal(stats([]).mean,null);});
test('ignore historical bootstrap and compute trough strictly after peak',()=>{const p=pricePath(10,1000,6000,[{occurredAt:500,priceUsd:100},{occurredAt:2000,priceUsd:7},{occurredAt:3000,priceUsd:15},{occurredAt:4000,priceUsd:12}]);assert.equal(p.peakGain,50);assert.equal(p.trough.p,12);assert.equal(p.afterPeakDrawdown,20);assert.equal(p.hits.minus20,2000);assert.equal(p.hits[50],3000);});
test('peak at last sample has no observed subsequent trough',()=>{assert.equal(pricePath(10,1000,3000,[{occurredAt:2000,priceUsd:15}]).trough,null);});
