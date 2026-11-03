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
  member = false,
  contextFailure = false,
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
    document: {
      getElementById: get,
      body: { getAttribute: () => (member ? 'member' : null) },
    },
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
        ok: !failure && !(contextFailure && url.includes('action=context')),
        status: failure ? 429 : 200,
        json: async () =>
          url.includes('/signup?')
            ? { id: 'new-account' }
            : url.includes('action=context')
              ? { admin }
              : url.endsWith('/auth/v1/user')
                ? { email: 'verified@example.test' }
                : session,
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
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.get('email').value, 'verified@example.test');
  assert.equal(h.get('email').readOnly, true);
  assert.equal(h.get('emailLabel').hidden, false);
  assert.equal(h.get('recoveryAccountHint').hidden, false);
  assert.equal(h.get('confirmLabel').hidden, false);
  assert.equal(h.location.destination, undefined);
  h.get('confirmPassword').value = 'mismatch';
  await submit(h);
  assert.match(h.get('status').textContent, /no coinciden/);
  h.get('confirmPassword').value = h.get('password').value;
  await submit(h);
  assert.equal(h.calls[1].options.method, 'PUT');
  assert.deepEqual(h.calls[1].body, { password: 'fake test password only' });
  assert.equal(h.location.destination, 'portal.html#administracion');
});
test('invalid recovery token cannot change a password or leave a blank locked email', async () => {
  const h = harness({
    hash: '#access_token=fake&refresh_token=fake&type=recovery',
    failure: true,
  });
  await tick();
  assert.equal(h.get('confirmLabel').hidden, true);
  assert.equal(h.get('email').readOnly, false);
  assert.match(h.get('status').textContent, /no se ha cambiado/);
  assert.equal(
    h.calls.some((call) => call.options.method === 'PUT'),
    false,
  );
});
test('saved password is reported separately from denied administrative access', async () => {
  const h = harness({
    hash: '#access_token=fake&refresh_token=fake&type=recovery',
    contextFailure: true,
  });
  await tick();
  h.get('confirmPassword').value = h.get('password').value;
  await submit(h);
  assert.match(h.get('status').textContent, /contraseña se guardó correctamente/);
  assert.equal(h.get('email').readOnly, false);
  assert.equal(h.location.destination, undefined);
});
test('member account can sign in but admin-only sign-in still rejects non-admins', async () => {
  const h = harness({ member: true, admin: false });
  await submit(h);
  assert.equal(h.location.destination, 'my-history.html');
});
test('member signup waits for email confirmation and never grants a session or role', async () => {
  const h = harness({ member: true, admin: false });
  h.get('signupToggle').onclick();
  h.get('password').value = 'unique test phrase 25';
  h.get('confirmPassword').value = h.get('password').value;
  h.get('signupConsent').checked = true;
  await submit(h);
  assert.ok(h.calls[0].url.includes('/signup?'));
  assert.deepEqual(Object.keys(h.calls[0].body).sort(), ['email', 'password']);
  assert.equal(h.saved.has('identity-lab:admin'), false);
  assert.equal(h.location.destination, undefined);
  assert.match(h.get('status').textContent, /confirmar/);
});
test('password visibility toggles without changing its value', () => {
  const h = harness();
  h.get('togglePassword').onclick();
  assert.equal(h.get('password').type, 'text');
  h.get('togglePassword').onclick();
  assert.equal(h.get('password').type, 'password');
});
test('recovery button immediately confirms progress and restores after completion', async () => {
  const h = harness();
  const sending = h.get('recover').onclick();
  assert.equal(h.get('recover').textContent, 'Enviando…');
  assert.equal(h.get('recover').disabled, true);
  assert.equal(h.get('recover')['aria-busy'], 'true');
  await sending;
  assert.equal(h.get('recover').textContent, 'Olvidé mi contraseña');
  assert.equal(h.get('recover').disabled, false);
  assert.equal(h.get('status')['data-tone'], 'success');
});
test('password feedback distinguishes common patterns, length and confirmation without network requests', async () => {
  const h = harness({ hash: '#access_token=fake&refresh_token=fake&type=recovery' });
  await tick();
  const before = h.calls.length;
  for (const [password, strength] of [
    ['', 'Sin evaluar'],
    ['short', 'Débil'],
    ['password123456789012345', 'Débil'],
    ['abcabcabcabcabcabcabc', 'Débil'],
    ['Lago Cobre!7Faro', 'Media'],
    ['Bosque! cobre 42 nave Cedro', 'Fuerte'],
  ]) {
    h.get('password').value = password;
    h.get('password').oninput();
    assert.equal(h.get('strengthText').textContent, strength);
  }
  h.get('confirmPassword').value = h.get('password').value;
  h.get('confirmPassword').oninput();
  assert.match(h.get('matchRequirement').textContent, /✓/);
  h.get('confirmPassword').value = 'different';
  h.get('confirmPassword').oninput();
  assert.match(h.get('matchRequirement').textContent, /no coinciden/);
  assert.equal(h.calls.length, before);
});
