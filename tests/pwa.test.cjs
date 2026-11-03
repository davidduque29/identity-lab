const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function worker() {
  const events = {},
    removed = [],
    stored = [];
  const context = vm.createContext({
    URL,
    Set,
    fetch: async () => {
      throw new Error('offline');
    },
    self: {
      location: { href: 'https://example.test/identity-lab/sw.js' },
      addEventListener: (n, f) => (events[n] = f),
      clients: { claim: async () => {} },
      skipWaiting() {},
    },
    caches: {
      open: async () => ({ addAll: async (urls) => stored.push(...urls) }),
      keys: async () => ['identity-lab-static-old', 'orbit-tasks-cache'],
      delete: async (name) => removed.push(name),
      match: async () => ({ offline: true }),
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'),
    context,
  );
  return { events, removed, stored };
}
test('worker caches only its public offline assets and never user data or auth responses', async () => {
  const h = worker();
  let job;
  h.events.install({ waitUntil: (p) => (job = p) });
  await job;
  assert.ok(h.stored.every((x) => /offline\.html|pwa\.css|icons\/icon-/.test(x)));
  for (const url of [
    'https://other.test/auth/v1/token',
    'https://example.test/identity-lab/photo.jpg',
    'https://example.test/identity-lab/admin-login.html?token=secret',
  ]) {
    let handled = false;
    h.events.fetch({
      request: { url, method: 'GET', mode: 'cors', headers: new Headers() },
      respondWith() {
        handled = true;
      },
    });
    assert.equal(handled, false);
  }
});
test('offline navigation returns a neutral page and old caches of other apps are retained', async () => {
  const h = worker();
  let job;
  h.events.fetch({
    request: {
      url: 'https://example.test/identity-lab/portal.html',
      method: 'GET',
      mode: 'navigate',
      headers: new Headers(),
    },
    respondWith: (p) => (job = p),
  });
  assert.equal((await job).offline, true);
  h.events.activate({ waitUntil: (p) => (job = p) });
  await job;
  assert.deepEqual(h.removed, ['identity-lab-static-old']);
});
test('manifest stays scoped to this app and provides installable icons', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../public/manifest.webmanifest'), 'utf8'),
  );
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons)
    assert.ok(fs.existsSync(path.join(__dirname, '../public', icon.src)));
});
