import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleLab } from '../server/lab.mjs';
import { DEFAULTS, nextAttempt, validSettings, compare } from '../server/domain.mjs';

function harness() {
  const sql = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter((n) =>
    n.endsWith('.sql'),
  ))
    sql.exec(readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8'));
  const wrap = (query, args = []) => ({
    bind(...values) {
      return wrap(query, values);
    },
    first() {
      return sql.prepare(query).get(...args) || null;
    },
    all() {
      return { results: sql.prepare(query).all(...args) };
    },
    run() {
      return { meta: { changes: Number(sql.prepare(query).run(...args).changes) } };
    },
  });
  const objects = new Map();
  const env = {
    ADMIN_EMAIL: 'admin@example.test',
    DB: {
      prepare: wrap,
      async batch(statements) {
        sql.exec('BEGIN');
        try {
          const out = statements.map((s) => s.run());
          sql.exec('COMMIT');
          return out;
        } catch (e) {
          sql.exec('ROLLBACK');
          throw e;
        }
      },
    },
    BUCKET: {
      async put(k, b, meta) {
        objects.set(k, { body: b, httpMetadata: meta.httpMetadata });
      },
      async get(k) {
        return objects.get(k) || null;
      },
      async delete(keys) {
        for (const k of keys) objects.delete(k);
      },
    },
  };
  async function call(
    action,
    data,
    {
      actor = 'owner',
      email = 'admin@example.test',
      cookie,
      origin = 'https://lab.test',
    } = {},
  ) {
    const headers = new Headers({
      'oai-authenticated-user-id': actor,
      'oai-authenticated-user-email': email,
      'cf-connecting-ip': '203.0.113.40',
    });
    if (data !== undefined) {
      headers.set('content-type', 'application/json');
      headers.set('origin', origin);
    }
    if (cookie) headers.set('cookie', cookie);
    const response = await handleLab(
      new Request('https://lab.test/api/lab?action=' + action, {
        method: data === undefined ? 'GET' : 'POST',
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      env,
    );
    const content = await response.json();
    return { status: response.status, content, headers: response.headers };
  }
  return { sql, objects, call, env };
}
const vec = (n) => Array(128).fill(n);
const registration = (overrides = {}) => ({
  requestId: crypto.randomUUID(),
  profile: {
    firstName: 'Persona',
    middleName: '',
    lastName: 'Prueba',
    birthDate: '1990-01-01',
    documentType: 'CC',
    documentNumber: '123456789',
    address: 'Dirección de prueba',
    consent: true,
  },
  samples: [0, 1, 2].map(() => ({
    descriptor: vec(0),
    image: 'data:image/jpeg;base64,/9j/AA==',
  })),
  ...overrides,
});

test('server registers only three references, prevents duplicates and retries safely', async () => {
  const h = harness(),
    input = registration();
  const first = await h.call('register', input);
  assert.equal(first.status, 200);
  assert.equal(h.objects.size, 3);
  const replay = await h.call('register', input);
  assert.equal(replay.content.id, first.content.id);
  assert.equal(h.objects.size, 3);
  const duplicate = await h.call('register', registration());
  assert.equal(duplicate.status, 409);
  assert.equal(h.objects.size, 3);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM profiles').get().n, 1);
  const event = JSON.parse(h.sql.prepare('SELECT payload FROM events').get().payload);
  assert.equal(event.network.ip, '203.0.113.40');
});

test('three mismatches lock on server; fourth attempt cannot compare; success clears failures', async () => {
  const h = harness(),
    saved = await h.call('register', registration()),
    id = saved.content.id;
  const success = await h.call('verify', {
    id,
    descriptor: vec(0),
    requestId: crypto.randomUUID(),
  });
  assert.equal(success.content.match, true);
  assert.equal(success.content.profile.firstName, 'Persona');
  for (let i = 0; i < 3; i++) {
    const r = await h.call('verify', {
      id,
      descriptor: vec(1),
      requestId: crypto.randomUUID(),
    });
    assert.equal(r.status, 200);
    assert.equal(r.content.match, false);
    assert.equal(r.content.profile, null);
    assert.equal(r.content.remaining, 2 - i);
  }
  const fourth = await h.call('verify', {
    id,
    descriptor: vec(0),
    requestId: crypto.randomUUID(),
  });
  assert.equal(fourth.status, 429);
  assert.ok(fourth.content.retryAt > Date.now());
  assert.equal(h.objects.size, 3);
  await h.call('unlock', { id, reason: 'Prueba administrativa autorizada' });
  const retryId = crypto.randomUUID();
  await h.call('verify', { id, descriptor: vec(1), requestId: retryId });
  await h.call('verify', { id, descriptor: vec(1), requestId: retryId });
  assert.equal(h.sql.prepare('SELECT failures FROM profiles').get().failures, 1);
  await h.call('verify', { id, descriptor: vec(0), requestId: crypto.randomUUID() });
  assert.equal(h.sql.prepare('SELECT failures FROM profiles').get().failures, 0);
});

test('admin authorization, origin validation, private profile ownership and input checks', async () => {
  const h = harness(),
    saved = await h.call('register', registration());
  assert.equal(
    (await h.call('admin', undefined, { actor: 'guest', email: 'guest@example.com' }))
      .status,
    403,
  );
  assert.equal(
    (
      await h.call(
        'rules',
        { rules: DEFAULTS },
        { actor: 'guest', email: 'guest@example.com' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await h.call('rules', { rules: DEFAULTS }, { origin: 'https://evil.test' })).status,
    403,
  );
  assert.equal(
    (
      await h.call(
        'verify',
        { id: saved.content.id, descriptor: vec(0), requestId: crypto.randomUUID() },
        { actor: 'guest', email: 'guest@example.com' },
      )
    ).status,
    404,
  );
  assert.equal((await h.call('register', registration({ samples: [] }))).status, 409);
  const invalid = registration();
  invalid.profile.documentNumber = '987654321';
  invalid.samples[1].descriptor = [NaN];
  assert.equal((await h.call('register', invalid)).status, 400);
  assert.equal(h.objects.size, 3);
});

test('QR is temporary, claimed once, and pairs the phone with the creator scope', async () => {
  const h = harness(),
    qr = await h.call('qr', { mode: 'register' });
  assert.equal(qr.status, 200);
  assert.match(qr.content.svg, /<svg/);
  const token = new URL(qr.content.link).hash.slice(4);
  const guest = { actor: 'phone-user', email: 'guest@example.com' };
  const claim = await h.call('claim', { token }, guest);
  assert.equal(claim.status, 200);
  assert.equal((await h.call('claim', { token }, guest)).status, 410);
  const cookie = claim.headers.get('set-cookie').split(';')[0];
  const saved = await h.call('register', registration(), { ...guest, cookie });
  assert.equal(saved.status, 200);
  assert.equal(h.sql.prepare('SELECT owner FROM profiles').get().owner, 'owner');
  await h.call('end', {}, { ...guest, cookie });
  assert.equal(
    (
      await h.call(
        'lookup',
        { documentType: 'CC', documentNumber: '123456789' },
        { ...guest, cookie },
      )
    ).status,
    410,
  );
});

test('reference update requires permission, replaces photos, and deletion removes biometric data', async () => {
  const h = harness(),
    saved = await h.call('register', registration()),
    id = saved.content.id,
    oldKeys = [...h.objects.keys()];
  assert.equal((await h.call('register', registration({ updateId: id }))).status, 409);
  await h.call('allow-update', { id, reason: 'Nueva referencia solicitada' });
  assert.equal((await h.call('register', registration({ updateId: id }))).status, 200);
  assert.equal(h.objects.size, 3);
  assert.ok(oldKeys.every((k) => !h.objects.has(k)));
  assert.equal(
    (await h.call('delete', { id, reason: 'El titular solicita borrado' })).status,
    200,
  );
  assert.equal(h.objects.size, 0);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM profiles').get().n, 0);
});

test('avatar presets/uploads are admin-only and separate from face samples', async () => {
  const h = harness();
  assert.equal((await h.call('avatar', { kind: 'preset', value: '🦊' })).status, 200);
  assert.equal((await h.call('context')).content.avatar.value, '🦊');
  assert.equal(
    (await h.call('avatar', { kind: 'upload', image: 'data:image/jpeg;base64,/9j/AA==' }))
      .status,
    200,
  );
  assert.equal(h.objects.size, 1);
  assert.equal((await h.call('avatar', { kind: 'preset', value: '🐼' })).status, 200);
  assert.equal(h.objects.size, 0);
  assert.equal(
    (
      await h.call(
        'avatar',
        { kind: 'preset', value: '🦊' },
        { actor: 'guest', email: 'guest@example.com' },
      )
    ).status,
    403,
  );
});

test('rules bounds and expired pause behavior are deterministic', () => {
  assert.throws(() => validSettings({ ...DEFAULTS, pauseMinutes: 0 }));
  assert.equal(
    nextAttempt({ failures: 3, locked_until: 100 }, false, DEFAULTS, 101).failures,
    1,
  );
  assert.equal(
    nextAttempt({ failures: 2, locked_until: 0 }, true, DEFAULTS, 101).failures,
    0,
  );
  assert.equal(compare([vec(0), vec(0), vec(0)], vec(0), 0.5).match, true);
});
