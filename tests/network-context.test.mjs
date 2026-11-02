import test from 'node:test';
import assert from 'node:assert/strict';
import { getNetworkContext, networkResponse } from '../server/network-context.mjs';

const request = (headers) =>
  new Request('https://example.test/api/network-context', { headers });
test('edge IP is recorded without trusting a spoofed forwarding chain', () => {
  const context = getNetworkContext(
    request({ 'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '1.2.3.4' }),
  );
  assert.equal(context.ip, '8.8.8.8');
  assert.equal(context.status, 'observed');
});
test('forwarded-for alone, local and inter-worker IPs cannot identify a public client IP', () => {
  for (const headers of [
    { 'x-forwarded-for': '1.2.3.4' },
    { 'cf-connecting-ip': '::1' },
    { 'cf-connecting-ip': '2a06:98c0:3600::103' },
    { 'cf-connecting-ip': 'invalid' },
  ]) {
    assert.equal(getNetworkContext(request(headers)).ip, null);
  }
});
test('IPv6 and cache protection are supported', async () => {
  const response = networkResponse(
    request({ 'cf-connecting-ipv6': '2001:4860:4860::8888' }),
  );
  assert.equal((await response.json()).ip, '2001:4860:4860::8888');
  assert.match(response.headers.get('cache-control'), /no-store/);
});
