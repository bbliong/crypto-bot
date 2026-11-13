import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {attachFollowerShutdown} from '../src/follower-capture-shutdown.js';

test('SIGTERM flushes follower once before exit',async()=>{
 const signals=new EventEmitter();let stops=0,exits=0;
 attachFollowerShutdown(signals,async()=>{stops++;},()=>{exits++;});
 signals.emit('SIGTERM');signals.emit('SIGINT');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(stops,1);assert.equal(exits,1);
});
