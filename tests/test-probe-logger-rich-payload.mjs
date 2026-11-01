import assert from 'node:assert/strict';
import { sanitizeAudit } from '../src/follower-live-store.js';

const mockProbe = {
  scenarioId: 'SCENARIO_4_SINGLE_BUY_5USD',
  reason: 'ENTRY_1',
  signal: { mint: '1111', symbol: 'test' },
  request: {
    swap: {
      endpoint: '/txproxy/v1/get_swap_route',
      params: { token_in_address: 'So11111111111111111111111111111111111111112', token_out_address: '1111' }
    },
    order: {
      endpoint: '/mrtapi/v2/swap_batch_order',
      headers: { authorization: 'Bearer secret_token_12345' },
      body: { side: 'BUY', mint: '1111' }
    }
  },
  response: {
    swap: {
      status: 200,
      latencyMs: 145,
      exchange: 'meteora_dammv2'
    },
    order: {
      status: 200,
      orderId: 'ord_123',
      hash: 'hash_456'
    }
  }
};

const cleaned = sanitizeAudit(mockProbe);
assert.equal(cleaned.request.swap.endpoint, '/txproxy/v1/get_swap_route');
assert.equal(cleaned.response.swap.status, 200);
// Ensure sensitive authorization is redacted
assert.equal(cleaned.request.order.headers.authorization, '[redacted]');
console.log('✅ Probe rich payload structure & redaction verified successfully!');
