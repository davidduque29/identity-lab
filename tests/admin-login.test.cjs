const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness({
  hash = '',
  stored = null,
  admin = true,
  failure = false,
  timeout = false,
} = {}) {
  const nodes = new Map(),
    saved = new Map(),
    calls = [];
  if (stored) saved.set('identity-lab:admin', JSON.stringify(stored));
  const get = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: '',
        hidden: false,
        type: 'password',
        reportValidity: () => true,
        setAttribute(k, v) {
          this[k] = v;
        },
      });
    return nodes.get(id);
  };
  get('email').value = 'admin@example.test';
  get('password').value = 'fake test password only';
  const location = {
    hash,
    pathname: '/identity-lab/admin-login.html',
    href: 'https://davidduque29.github.io/identity-lab/admin-login.html',
    replace(v) {
      this.destination = v;
    },
  };
  const session = {
    access_token: 'fake',
    refresh_token: 'fake-refresh',
    expires_in: 3600,
  };
  const context = vm.createContext({
    window: {
      IDENTITY_DEPLOYMENT: { url: 'https://auth.example.test', publishableKey: 'fake' },
    },
    document: { getElementById: get },
    location,
    URL,
    URLSearchParams,
    Date,
    AbortController,
    history: { replaceState() {} },
    sessionStorage: { removeItem() {} },
    localStorage: {
      getItem: (k) => saved.get(k),
      setItem: (k, v) => saved.set(k, v),
      removeItem: (k) => saved.delete(k),
    },
    setTimeout: timeout
      ? (fn) => {
          queueMicrotask(fn);
          return 0;
        }
      : setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (timeout) {
        await new Promise((resolve) => setImmediate(resolve));
        if (options.signal.aborted) throw new Error('aborted');
      }
      return {
        ok: !failure,
        status: failure ? 429 : 200,
        json: async () => (url.includes('action=context') ? { admin } : session),
      };
    },
  });
  vm.runInContext(
    fs.readFileSync(
      require('node:path').join(__dirname, '../public/admin-login.js'),
      'utf8',
    ),
    context,
  );
  return { get, saved, calls, location };
}
const tick = () => new Promise(setImmediate);
const submit = (h) => h.get('login').onsubmit({ preventDefault() {} });

test('password sign-in checks server authorization before storing a session and never requests email', async () => {
  const h = harness();
  await submit(h);
  assert.ok(h.calls[0].url.endsWith('token?grant_type=password'));
  assert.equal(h.calls[0].body.email, 'admin@example.test');
  assert.ok(h.calls[1].url.includes('action=context'));
  assert.equal(h.location.destination, 'portal.html#administracion');
  assert.ok(h.saved.has('identity-lab:admin'));
  assert.equal(h.get('password').value, '');
});
test('an authenticated non-admin is denied without keeping the new session', async () => {
  const h = harness({ admin: false });
  await submit(h);
  assert.equal(h.location.destination, undefined);
  assert.equal(h.saved.has('identity-lab:admin'), false);
  assert.match(h.get('status').textContent, /no tiene permisos/);
});
test('existing valid session resumes without password or email request', async () => {
  const h = harness({
    stored: { access_token: 'fake', expires_at: Date.now() / 1000 + 3600 },
  });
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.location.destination, 'portal.html#administracion');
});
test('session check has a timeout and returns to an actionable login', async () => {
  const h = harness({
    timeout: true,
    stored: { access_token: 'fake', expires_at: Date.now() / 1000 + 3600 },
  });
  await tick();
  await tick();
  assert.match(h.get('status').textContent, /tardó demasiado/);
  assert.equal(h.saved.has('identity-lab:admin'), false);
});
test('recovery sends to the existing allowed callback and reports mail limits', async () => {
  const h = harness({ failure: true });
  await h.get('recover').onclick();
  assert.equal(new URL(h.calls[0].url).searchParams.get('redirect_to'), h.location.href);
  assert.match(h.get('status').textContent, /límite/);
});
test('recovery callback asks for a new password rather than skipping to the portal', async () => {
  const h = harness({ hash: '#access_token=fake&refresh_token=fake&type=recovery' });
  await tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.get('confirmLabel').hidden, false);
  assert.equal(h.location.destination, undefined);
  h.get('confirmPassword').value = 'mismatch';
  await submit(h);
  assert.match(h.get('status').textContent, /no coinciden/);
  h.get('confirmPassword').value = h.get('password').value;
  await submit(h);
  assert.equal(h.calls[0].options.method, 'PUT');
  assert.ok(h.calls[0].url.endsWith('/auth/v1/user'));
  assert.equal(h.location.destination, 'portal.html#administracion');
});
test('password visibility toggles without changing its value', () => {
  const h = harness();
  h.get('togglePassword').onclick();
  assert.equal(h.get('password').type, 'text');
  h.get('togglePassword').onclick();
  assert.equal(h.get('password').type, 'password');
});
