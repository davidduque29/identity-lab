const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness(reply = { ok: true, status: 200, json: async () => ({}) }, hash = '') {
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
  const context = vm.createContext({
    window: {
      IDENTITY_DEPLOYMENT: { url: 'https://auth.example.test', publishableKey: 'test' },
    },
    document: { getElementById: get },
    location,
    URL,
    URLSearchParams,
    Date,
    history: { replaceState() {} },
    localStorage: { setItem: (k, v) => sessions.set(k, v) },
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
  assert.match(h.get('status').textContent, /límite de envíos/);
});

test('valid callback stores the session and returns to administration', () => {
  const h = harness(
    undefined,
    '#access_token=fake&refresh_token=fake-refresh&expires_in=3600',
  );
  assert.equal(h.location.destination, 'portal.html#administracion');
  assert.equal(JSON.parse(h.sessions.get('identity-lab:admin')).access_token, 'fake');
});
