import { isIP } from 'node:net';

// Only the edge's connecting-IP headers are used; no client-supplied X-Forwarded-For.
export function getNetworkContext(request, now = new Date()) {
  const raw =
    request.headers.get('cf-connecting-ipv6') || request.headers.get('cf-connecting-ip');
  const ip = raw?.trim();
  const valid = ip && isIP(ip);
  const isProxy = ip?.toLowerCase() === '2a06:98c0:3600::103';
  const local =
    ip &&
    (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ||
      ip === '::1' ||
      /^(fc|fd|fe80:)/i.test(ip));
  return {
    status: !valid ? 'unavailable' : isProxy ? 'proxy' : local ? 'local' : 'observed',
    ip: valid && !isProxy && !local ? ip : null,
    observedAt: now.toISOString(),
    source: valid ? 'edge-connecting-ip' : null,
    note: 'IP de conexión observada; puede corresponder a una VPN o red compartida. No identifica un dispositivo ni demuestra identidad.',
  };
}

export function networkResponse(request) {
  if (request.method !== 'GET')
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  return Response.json(getNetworkContext(request), {
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
