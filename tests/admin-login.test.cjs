const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness(
  reply = { ok: true, status: 200, json: async () => ({}) },
  hash = '',
  existingSession = false,
) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: true, focus() {} });
    return nodes.get(id);
  };
  get('email').value = 'admin@example.test';
  const calls = [],
    sessions = new Map();
  const location = {
    hash,
    pathname: '/identity-lab/admin-login.html',
    href: 'https://davidduque29.github.io/identity-lab/admin-login.html',
    replace(value) {
      this.destination = value;
    },
  };
  if (existingSession)
    sessions.set('identity-lab:admin', JSON.stringify({ access_token: 'fake' }));
  const context = vm.createContext({
    window: {
      IDENTITY_DEPLOYMENT: { url: 'https://auth.example.test', publishableKey: 'test' },
      IdentityTransport: existingSession ? { fetch: async () => reply } : undefined,
    },
    document: { getElementById: get },
    location,
    URL,
    URLSearchParams,
    Date,
    history: { replaceState() {} },
    localStorage: {
      setItem: (k, v) => sessions.set(k, v),
      getItem: (k) => sessions.get(k),
    },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return reply;
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL('../public/admin-login.js', 'file://' + __filename), 'utf8'),
    context,
  );
  return { get, calls, sessions, location };
}

test('admin requests a link for an existing account with the Pages callback; code is optional', async () => {
  const h = harness();
  await h.get('login').onsubmit({ preventDefault() {} });
  const request = h.calls[0];
  assert.equal(new URL(request.url).searchParams.get('redirect_to'), h.location.href);
  assert.equal(request.body.create_user, false);
  assert.match(h.get('status').textContent, /Abre el enlace/);
  assert.equal(h.get('codeLabel').hidden, true);
  h.get('resend').onclick();
  assert.equal(h.calls.length, 1);
  assert.match(h.get('status').textContent, /Espera/);
  h.get('useCode').onclick();
  assert.equal(h.get('codeLabel').hidden, false);
  assert.equal(h.get('submit').textContent, 'Validar código');
});

test('mail rate limits show an error instead of claiming delivery', async () => {
  const h = harness({ ok: false, status: 429, json: async () => ({}) });
  await h.get('login').onsubmit({ preventDefault() {} });
  assert.match(h.get('status').textContent, /límite temporal/);
});

test('valid callback stores the session and returns to administration', () => {
  const h = harness(
    undefined,
    '#access_token=fake&refresh_token=fake-refresh&expires_in=3600',
  );
  assert.equal(h.location.destination, 'portal.html#administracion');
  assert.equal(JSON.parse(h.sessions.get('identity-lab:admin')).access_token, 'fake');
});

test('an existing authorized session resumes administration without sending another email', async () => {
  const h = harness({ ok: true, json: async () => ({ admin: true }) }, '', true);
  await new Promise(setImmediate);
  assert.equal(h.location.destination, 'portal.html#administracion');
  assert.equal(h.calls.length, 0);
});

test('a stored non-admin session does not gain access to administration', async () => {
  const h = harness({ ok: true, json: async () => ({ admin: false }) }, '', true);
  await new Promise(setImmediate);
  assert.equal(h.location.destination, undefined);
  assert.match(h.get('status').textContent, /no tiene permisos/);
});

test('an email callback landing on the site root preserves the session and clears tokens from the URL', () => {
  const saved = new Map();
  const location = {
    hash: '#access_token=fake&refresh_token=refresh&expires_in=3600',
    pathname: '/identity-lab/',
    replace(value) {
      this.destination = value;
    },
  };
  let cleared = false;
  const context = vm.createContext({
    window: { IDENTITY_DEPLOYMENT: {} },
    location,
    URLSearchParams,
    Date,
    localStorage: { setItem: (k, v) => saved.set(k, v) },
    history: {
      replaceState() {
        cleared = true;
      },
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL('../public/transport.js', 'file://' + __filename), 'utf8'),
    context,
  );
  assert.equal(JSON.parse(saved.get('identity-lab:admin')).access_token, 'fake');
  assert.equal(location.destination, 'portal.html#administracion');
  assert.equal(cleared, true);
});
