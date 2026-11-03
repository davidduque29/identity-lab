import {
  DEFAULTS,
  MODEL,
  documentKey,
  validateProfile,
  validSettings,
  descriptor,
  compare,
  publicVerification,
  nextAttempt,
  rasterData,
} from './domain.mjs';
import { storageFor } from './storage.mjs';
import { getNetworkContext } from './network-context.mjs';
import QRCode from 'qrcode';

const TENANT = 'identity-lab-david';
const json = (data, status = 200, extra = {}) =>
  Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
const fail = (message, status = 400, extra = {}) => {
  throw Object.assign(new Error(message), { status, ...extra });
};
const uuid = () => crypto.randomUUID();
const hash = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const parse = (value) => JSON.parse(value);

export async function handleLab(request, env) {
  try {
    const actor = request.headers.get('oai-authenticated-user-id');
    const email = request.headers.get('oai-authenticated-user-email');
    if (!actor || !email)
      return json(
        {
          error: 'No se pudo iniciar la sesión del laboratorio.',
          signIn: 'admin-login.html',
        },
        401,
      );
    if (!env.DB) fail('La base de datos aún no está disponible.', 503);
    const db = env.DB,
      storage = storageFor(env),
      admin = !!env.ADMIN_EMAIL && email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
    const url = new URL(request.url),
      action = url.searchParams.get('action') || 'context';
    const now = Date.now();
    const one = (sql, ...args) =>
      db
        .prepare(sql)
        .bind(...args)
        .first();
    const run = (sql, ...args) =>
      db
        .prepare(sql)
        .bind(...args)
        .run();
    const list = async (sql, ...args) =>
      (
        await db
          .prepare(sql)
          .bind(...args)
          .all()
      ).results;
    const row = await one(
      'SELECT payload FROM configuration WHERE key=?',
      TENANT + ':rules',
    );
    const rules = row ? parse(row.payload) : { ...DEFAULTS };
    const audit = async (name, payload, profileId = null, id = uuid()) =>
      run(
        'INSERT INTO events (id,tenant,actor,profile_id,action,payload,created_at) VALUES (?,?,?,?,?,?,?)',
        id,
        TENANT,
        actor,
        profileId,
        name,
        JSON.stringify({ ...payload, network: getNetworkContext(request), rules }),
        now,
      );
    const mustAdmin = () => {
      if (!admin) fail('Solo el administrador puede realizar esta operación.', 403);
    };
    let session = null;
    const cookie = request.headers
      .get('cookie')
      ?.match(/(?:^|;\s*)il_session=([^;]+)/)?.[1];
    if (cookie) {
      const sessionRow = await one(
        'SELECT * FROM sessions WHERE token_hash=? AND claimant=? AND expires_at>? AND status IN (?,?)',
        await hash(cookie),
        actor,
        now,
        'claimed',
        'registered',
      );
      if (sessionRow) session = sessionRow;
    }
    // Public demo: records are tenant-wide; personal data is returned only after a match.
    const principal = env.PUBLIC_DEMO ? TENANT : session?.creator || actor;
    if (cookie && !session && ['register', 'verify', 'lookup'].includes(action))
      fail('La sesión QR venció o finalizó. Genera una nueva.', 410);
    const profileAccess = (p) =>
      p && p.tenant === TENANT && p.owner === principal && p.status === 'active';
    const requireProfile = async (id) => {
      const p = await one(
        'SELECT * FROM profiles WHERE id=? AND tenant=?',
        String(id),
        TENANT,
      );
      if (!profileAccess(p)) fail('Registro no disponible para esta sesión.', 404);
      return p;
    };
    if (request.method === 'GET') {
      if (action === 'context') {
        const avatar = admin
          ? await one('SELECT payload FROM configuration WHERE key=?', TENANT + ':avatar')
          : null;
        return json({
          admin,
          existingRecord: env.PUBLIC_DEMO
            ? await one(
                'SELECT profiles.id FROM profiles JOIN events ON profiles.id=events.profile_id WHERE profiles.tenant=? AND events.actor=? AND events.action=? AND profiles.status=? ORDER BY events.created_at DESC LIMIT 1',
                TENANT,
                actor,
                'register',
                'active',
              )
            : null,
          email,
          rules,
          session: session
            ? {
                mode: session.mode,
                status: session.status,
                expiresAt: session.expires_at,
              }
            : null,
          storage: admin ? storage.name : undefined,
          drive: admin
            ? {
                ready: false,
                reason:
                  'El destino activo es Supabase. Drive requiere un adaptador autorizado.',
              }
            : undefined,
          avatar: avatar ? parse(avatar.payload) : { kind: 'preset', value: '🌿' },
        });
      }
      if (action === 'qr-status') {
        const s = await one(
          'SELECT id,status,expires_at FROM sessions WHERE id=? AND creator=?',
          url.searchParams.get('id'),
          actor,
        );
        if (!s) fail('Sesión no disponible.', 404);
        return json({ ...s, status: s.expires_at <= now ? 'expired' : s.status });
      }
      if (action === 'admin') {
        mustAdmin();
        const offset = Math.min(
          100000,
          Math.max(0, Number(url.searchParams.get('offset')) || 0),
        );
        const users = await list(
          'SELECT id,data,status,failures,locked_until,update_allowed,created_at,updated_at,media FROM profiles WHERE tenant=? ORDER BY created_at DESC LIMIT 50 OFFSET ?',
          TENANT,
          offset,
        );
        const events = await list(
          'SELECT id,actor,profile_id,action,payload,created_at FROM events WHERE tenant=? ORDER BY created_at DESC LIMIT 100 OFFSET ?',
          TENANT,
          offset,
        );
        const count = await one(
          'SELECT COUNT(*) AS total FROM profiles WHERE tenant=?',
          TENANT,
        );
        return json({
          users: users.map(({ media, ...p }) => ({
            ...p,
            data: parse(p.data),
            referenceCount: parse(media).length,
          })),
          events: events.map((e) => ({ ...e, payload: parse(e.payload) })),
          total: count.total,
          offset,
        });
      }
      if (action === 'reference-proof') {
        const evidence = await one(
          'SELECT payload,created_at,profile_id FROM events WHERE id=? AND actor=? AND tenant=? AND action=?',
          url.searchParams.get('attemptId'),
          actor,
          TENANT,
          'verify',
        );
        if (
          !evidence ||
          evidence.created_at < now - 300000 ||
          evidence.profile_id !== url.searchParams.get('id')
        )
          fail('Esta evidencia ya no está disponible.', 404);
        const details = parse(evidence.payload);
        if (!details.result?.match || !details.referenceMedia)
          fail('Referencia protegida.', 403);
        const person = await one(
          'SELECT media,status FROM profiles WHERE id=? AND tenant=?',
          evidence.profile_id,
          TENANT,
        );
        if (
          !person ||
          person.status !== 'active' ||
          parse(person.media)[0] !== details.referenceMedia
        )
          fail('La referencia cambió. Realiza otra comparación.', 409);
        const image = await storage.get(details.referenceMedia);
        if (!image) fail('Referencia no disponible.', 404);
        return new Response(image.body, {
          headers: {
            'Content-Type': image.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (['admin-profile', 'reference-photo'].includes(action)) {
        mustAdmin();
        const p = await one(
          'SELECT * FROM profiles WHERE id=? AND tenant=?',
          url.searchParams.get('id'),
          TENANT,
        );
        if (!p) fail('Registro no disponible.', 404);
        if (action === 'admin-profile')
          return json({
            profile: parse(p.data),
            biometric: parse(p.biometric),
            referenceCount: parse(p.media).length,
            createdAt: p.created_at,
          });
        const image = await storage.get(parse(p.media)[0]);
        if (!image) fail('Foto no disponible.', 404);
        return new Response(image.body, {
          headers: {
            'Content-Type': image.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (action === 'avatar') {
        mustAdmin();
        const image = await storage.get(TENANT + '/admin/avatar');
        if (!image) fail('Sin foto de perfil.', 404);
        return new Response(image.body, {
          headers: {
            'Content-Type': image.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      fail('Acción no disponible.', 404);
    }
    if (request.method !== 'POST') fail('Método no permitido.', 405);
    if (request.headers.get('origin') !== url.origin) fail('Origen no permitido.', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      fail('Formato no permitido.', 415);
    const reader = request.body?.getReader();
    if (!reader) fail('Falta el cuerpo de la solicitud.');
    let size = 0;
    const chunks = [];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 3600000) {
        await reader.cancel();
        fail('La solicitud supera el tamaño permitido.', 413);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.length;
    }
    const raw = new TextDecoder().decode(bytes);
    const data = parse(raw);
    if (action === 'qr') {
      if (!['register', 'verify'].includes(data.mode))
        fail('Selecciona registro o verificación.');
      const token = uuid() + uuid(),
        id = uuid(),
        expiresAt = now + rules.qrMinutes * 60000;
      await run('DELETE FROM sessions WHERE expires_at < ?', now - 86400000);
      await run(
        'INSERT INTO sessions (id,token_hash,creator,mode,expires_at,status) VALUES (?,?,?,?,?,?)',
        id,
        await hash(token),
        actor,
        data.mode,
        expiresAt,
        'pending',
      );
      const link = (env.PUBLIC_APP_URL || url.origin + '/') + 'portal.html#qr=' + token;
      const svg = await QRCode.toString(link, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        color: { dark: '#175c49', light: '#ffffff' },
      });
      return json({ id, link, svg, expiresAt });
    }
    if (action === 'claim') {
      const tokenHash = await hash(String(data.token || ''));
      const claimed = (
        await run(
          'UPDATE sessions SET claimant=?,status=? WHERE token_hash=? AND status=? AND expires_at>?',
          actor,
          'claimed',
          tokenHash,
          'pending',
          now,
        )
      ).meta.changes;
      if (!claimed) fail('El QR venció o ya fue utilizado. Genera uno nuevo.', 410);
      const s = await one(
        'SELECT mode FROM sessions WHERE token_hash=? AND claimant=?',
        tokenHash,
        actor,
      );
      return json({ mode: s.mode }, 200, {
        'Set-Cookie':
          'il_session=' +
          data.token +
          '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' +
          rules.qrMinutes * 60,
      });
    }
    if (action === 'end') {
      if (session)
        await run('UPDATE sessions SET status=? WHERE id=?', 'finished', session.id);
      return json({ ok: true }, 200, {
        'Set-Cookie': 'il_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
      });
    }
    if (action === 'repeat-verification') {
      if (cookie) {
        const previous = await one(
          'SELECT * FROM sessions WHERE token_hash=? AND claimant=? AND expires_at>? AND mode=? AND status IN (?,?)',
          await hash(cookie),
          actor,
          now,
          'verify',
          'finished',
          'claimed',
        );
        if (!previous)
          fail('La sesión venció. Abre otra verificación desde el inicio.', 410);
        const person = await one(
          'SELECT locked_until,status,owner FROM profiles WHERE id=? AND tenant=?',
          data.id,
          TENANT,
        );
        if (
          !person ||
          person.owner !== (env.PUBLIC_DEMO ? TENANT : previous.creator) ||
          person.status !== 'active'
        )
          fail('Registro no disponible.', 404);
        if (person.locked_until > now)
          fail('La validación está en pausa.', 429, { retryAt: person.locked_until });
        await run(
          'UPDATE sessions SET status=?,expires_at=? WHERE id=?',
          'claimed',
          now + rules.qrMinutes * 60000,
          previous.id,
        );
        return json({ ok: true }, 200, {
          'Set-Cookie':
            'il_session=' +
            cookie +
            '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' +
            rules.qrMinutes * 60,
        });
      }
      const person = await requireProfile(data.id);
      if (person.locked_until > now)
        fail('La validación está en pausa.', 429, { retryAt: person.locked_until });
      return json({ ok: true });
    }
    if (action === 'begin-verification') {
      if (session) {
        if (session.status !== 'registered') fail('Completa primero tu registro.', 409);
        await run(
          'UPDATE sessions SET mode=?,status=?,expires_at=? WHERE id=? AND claimant=?',
          'verify',
          'claimed',
          now + rules.qrMinutes * 60000,
          session.id,
          actor,
        );
        return json({ ok: true }, 200, {
          'Set-Cookie':
            'il_session=' +
            cookie +
            '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' +
            rules.qrMinutes * 60,
        });
      }
      return json({ ok: true });
    }
    if (action === 'record-status') {
      const doc = await hash(
        TENANT + ':' + documentKey(data.documentType, data.documentNumber),
      );
      const p = await one(
        'SELECT * FROM profiles WHERE tenant=? AND document_key=?',
        TENANT,
        doc,
      );
      return json({ exists: !!p });
    }
    if (action === 'lookup') {
      const doc = await hash(
        TENANT + ':' + documentKey(data.documentType, data.documentNumber),
      );
      const p = await one(
        'SELECT * FROM profiles WHERE tenant=? AND document_key=? AND owner=? AND status=?',
        TENANT,
        doc,
        principal,
        'active',
      );
      if (!p)
        fail(
          'No hay un registro disponible para tu cuenta y documento. Primero regístrate.',
          404,
        );
      if (p.locked_until > now)
        fail('Validación en pausa. Espera antes de intentarlo nuevamente.', 429, {
          retryAt: p.locked_until,
        });
      return json({
        id: p.id,
        remaining: rules.maxFailures,
        updateAllowed: !!p.update_allowed,
      });
    }
    if (action === 'register') {
      if (session?.status === 'registered')
        fail(
          'El registro de esta sesión ya terminó. Genera un QR nuevo para continuar.',
          410,
        );
      if (session && session.mode !== 'register')
        fail('Este QR es para verificar, no para registrar.', 403);
      const idempotency = String(data.requestId || '');
      if (!/^[\w-]{20,100}$/.test(idempotency))
        fail('Identificador de solicitud inválido.');
      const done = await one(
        'SELECT profile_id FROM events WHERE id=? AND actor=? AND action IN (?,?)',
        idempotency,
        actor,
        'register',
        'update-reference',
      );
      if (done) return json({ id: done.profile_id, saved: true });
      const profile = validateProfile(data.profile);
      const doc = await hash(
        TENANT + ':' + documentKey(profile.documentType, profile.documentNumber),
      );
      let existing = await one(
        'SELECT * FROM profiles WHERE tenant=? AND document_key=?',
        TENANT,
        doc,
      );
      if (
        existing &&
        (!data.updateId ||
          existing.id !== data.updateId ||
          !profileAccess(existing) ||
          !existing.update_allowed)
      )
        fail(
          'Este documento ya tiene un registro. Usa «Verificar» o solicita autorización para actualizarlo.',
          409,
        );
      if (!Array.isArray(data.samples) || data.samples.length !== 1)
        fail('Se necesita una única foto aceptada.');
      const images = data.samples.map((s) => ({
        ...rasterData(s.image),
        descriptor: descriptor(s.descriptor),
      }));
      const id = existing?.id || uuid(),
        revision = uuid();
      const keys = images.map(
        (_, i) =>
          TENANT + '/users/' + id + '/' + revision + '/referencia-0' + (i + 1) + '.jpg',
      );
      const profileData = {
        ...profile,
        consent: {
          accepted: true,
          version: '2026-11-02-v2-single',
          at: new Date(now).toISOString(),
          actor,
        },
        selfDeclared: true,
      };
      const biometric = {
        model: MODEL,
        schemaVersion: 2,
        descriptors: images.map((i) => i.descriptor),
      };
      try {
        for (let i = 0; i < 1; i++)
          await storage.put(keys[i], images[i].bytes, images[i].type);
        const statement = existing
          ? db
              .prepare(
                'UPDATE profiles SET data=?,biometric=?,media=?,update_allowed=0,version=version+1,updated_at=?,last_attempt=? WHERE id=? AND version=? AND update_allowed=1 AND status=?',
              )
              .bind(
                JSON.stringify(profileData),
                JSON.stringify(biometric),
                JSON.stringify(keys),
                now,
                idempotency,
                id,
                existing.version,
                'active',
              )
          : db
              .prepare(
                'INSERT INTO profiles (id,tenant,owner,document_key,data,biometric,media,created_at,updated_at,last_attempt) VALUES (?,?,?,?,?,?,?,?,?,?)',
              )
              .bind(
                id,
                TENANT,
                principal,
                doc,
                JSON.stringify(profileData),
                JSON.stringify(biometric),
                JSON.stringify(keys),
                now,
                now,
                idempotency,
              );
        const eventPayload = JSON.stringify({
          model: MODEL,
          photos: 1,
          storage: storage.name,
          network: getNetworkContext(request),
          rules,
        });
        const outcome = await db.batch([
          statement,
          db
            .prepare(
              'INSERT INTO events (id,tenant,actor,profile_id,action,payload,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM profiles WHERE id=? AND last_attempt=?)',
            )
            .bind(
              idempotency,
              TENANT,
              actor,
              id,
              existing ? 'update-reference' : 'register',
              eventPayload,
              now,
              id,
              idempotency,
            ),
        ]);
        if (!outcome[0].meta.changes)
          fail('El registro cambió mientras lo actualizabas. Vuelve a intentarlo.', 409);
      } catch (e) {
        await storage.remove(keys);
        if (String(e.message).includes('UNIQUE') || e.code === '23505')
          fail(
            'Ya existe un registro para este documento. No se crearon duplicados.',
            409,
          );
        throw e;
      }
      let cleanupPending = false;
      if (existing) {
        try {
          await storage.remove(parse(existing.media));
        } catch {
          cleanupPending = true;
        }
      }
      if (session)
        await run('UPDATE sessions SET status=? WHERE id=?', 'registered', session.id);
      return json({ id, saved: true, photos: 1, cleanupPending });
    }
    if (action === 'verify') {
      if (session && session.mode !== 'verify')
        fail('Finaliza el registro y abre una sesión de verificación.', 403);
      const probe = descriptor(data.descriptor),
        attemptId = String(data.requestId || '');
      if (!/^[\w-]{20,100}$/.test(attemptId)) fail('Identificador de intento inválido.');
      let p = await requireProfile(data.id);
      const resultFor = (event, person) => {
        const v = parse(event.payload);
        return {
          ...publicVerification(v.result, v.remaining, v.retryAt, parse(person.data)),
          evidence: {
            referenceSavedAt: v.referenceSavedAt || null,
            comparedAt: v.comparedAt || null,
            attemptId,
            referenceUrl:
              v.result.match && v.referenceMedia
                ? '/api/lab?action=reference-proof&id=' +
                  encodeURIComponent(person.id) +
                  '&attemptId=' +
                  encodeURIComponent(attemptId)
                : null,
          },
        };
      };
      const existingEvent = await one(
        'SELECT payload FROM events WHERE id=? AND actor=? AND profile_id=? AND action=?',
        attemptId,
        actor,
        p.id,
        'verify',
      );
      if (existingEvent) return json(resultFor(existingEvent, p));
      for (let retry = 0; retry < 4; retry++) {
        if (retry) p = await requireProfile(data.id);
        if (p.locked_until > now) {
          await audit('verify-blocked', { retryAt: p.locked_until }, p.id);
          fail('Alcanzaste el límite de intentos. Validación en pausa.', 429, {
            retryAt: p.locked_until,
          });
        }
        const result = compare(
          parse(p.biometric).descriptors.slice(0, 1),
          probe,
          rules.threshold,
        );
        const counter = nextAttempt(p, result.match, rules, now);
        const payload = {
          result,
          remaining: counter.remaining,
          retryAt: counter.lockedUntil || null,
          network: getNetworkContext(request),
          rules,
          referenceMedia: parse(p.media)[0],
          referenceSavedAt: p.updated_at,
          comparedAt: now,
        };
        const batch = await db.batch([
          db
            .prepare(
              'UPDATE profiles SET failures=?,locked_until=?,version=version+1,last_attempt=? WHERE id=? AND version=? AND status=?',
            )
            .bind(
              counter.failures,
              counter.lockedUntil,
              attemptId,
              p.id,
              p.version,
              'active',
            ),
          db
            .prepare(
              'INSERT OR IGNORE INTO events (id,tenant,actor,profile_id,action,payload,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM profiles WHERE id=? AND last_attempt=?)',
            )
            .bind(
              attemptId,
              TENANT,
              actor,
              p.id,
              'verify',
              JSON.stringify(payload),
              now,
              p.id,
              attemptId,
            ),
        ]);
        if (batch[0].meta.changes) {
          if (session)
            await run(
              'UPDATE sessions SET status=? WHERE id=?',
              result.match ? 'finished' : 'claimed',
              session.id,
            );
          return json(resultFor({ payload: JSON.stringify(payload) }, p));
        }
        const concurrent = await one(
          'SELECT payload FROM events WHERE id=? AND actor=? AND profile_id=? AND action=?',
          attemptId,
          actor,
          p.id,
          'verify',
        );
        if (concurrent) return json(resultFor(concurrent, p));
      }
      fail('Hay otra validación en curso. Espera e inténtalo de nuevo.', 429);
    }
    if (action === 'rules') {
      mustAdmin();
      const value = validSettings(data.rules);
      await db.batch([
        db
          .prepare(
            'INSERT INTO configuration (key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',
          )
          .bind(TENANT + ':rules', JSON.stringify(value)),
        db
          .prepare(
            'INSERT INTO events (id,tenant,actor,action,payload,created_at) VALUES (?,?,?,?,?,?)',
          )
          .bind(
            uuid(),
            TENANT,
            actor,
            'rules',
            JSON.stringify({
              before: rules,
              after: value,
              network: getNetworkContext(request),
            }),
            now,
          ),
      ]);
      return json({ rules: value });
    }
    if (['unlock', 'allow-update', 'delete', 'compact-reference'].includes(action)) {
      mustAdmin();
      const reason = String(data.reason || '').trim();
      if (reason.length < 5 || reason.length > 300)
        fail('Indica un motivo entre 5 y 300 caracteres.');
      const p = await one(
        'SELECT * FROM profiles WHERE id=? AND tenant=?',
        data.id,
        TENANT,
      );
      if (!p) fail('Usuario no disponible.', 404);
      if (action === 'compact-reference') {
        const media = parse(p.media),
          biometric = parse(p.biometric);
        if (media.length > 1) {
          const changed = await run(
            'UPDATE profiles SET media=?,biometric=?,version=version+1 WHERE id=? AND version=?',
            JSON.stringify(media.slice(0, 1)),
            JSON.stringify({
              ...biometric,
              schemaVersion: 2,
              descriptors: biometric.descriptors.slice(0, 1),
            }),
            p.id,
            p.version,
          );
          if (!changed.meta.changes)
            fail('El registro cambió. Actualiza y vuelve a intentarlo.', 409);
          await storage.remove(media.slice(1));
        }
      } else if (action === 'delete') {
        await run(
          'UPDATE profiles SET status=?,version=version+1 WHERE id=?',
          'deleting',
          p.id,
        );
        await storage.remove(parse(p.media));
        // Remove personal data and biometric templates; retained audit uses only an internal ID.
        await run('DELETE FROM profiles WHERE id=?', p.id);
      } else if (action === 'unlock')
        await run(
          'UPDATE profiles SET failures=0,locked_until=0,version=version+1 WHERE id=?',
          p.id,
        );
      else
        await run(
          'UPDATE profiles SET update_allowed=1,version=version+1 WHERE id=?',
          p.id,
        );
      await audit(action, { reason }, p.id);
      return json({ ok: true });
    }
    if (action === 'avatar') {
      mustAdmin();
      const presets = [
        '🌿',
        '🦊',
        '🐼',
        '🐧',
        '🦋',
        '🐱',
        '🐶',
        '🐢',
        '🦉',
        '🐬',
        '🚲',
        '🏀',
        '🎧',
        '🥑',
        '🍉',
        '☕',
      ];
      let avatar;
      if (data.kind === 'preset' && presets.includes(data.value))
        avatar = { kind: 'preset', value: data.value };
      else if (data.kind === 'upload') {
        const image = rasterData(data.image, 250000);
        await storage.put(TENANT + '/admin/avatar', image.bytes, image.type);
        avatar = { kind: 'upload', value: '/api/lab?action=avatar' };
      } else fail('Selecciona un avatar o sube una imagen válida.');
      await run(
        'INSERT INTO configuration (key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',
        TENANT + ':avatar',
        JSON.stringify(avatar),
      );
      if (avatar.kind === 'preset') await storage.remove([TENANT + '/admin/avatar']);
      await audit('avatar', { kind: avatar.kind });
      return json({ avatar });
    }
    if (action === 'purge-events') {
      mustAdmin();
      const outcome = await run(
        'DELETE FROM events WHERE tenant=? AND created_at<?',
        TENANT,
        now - rules.retentionDays * 86400000,
      );
      await audit('purge-events', { removed: outcome.meta.changes });
      return json({ removed: outcome.meta.changes });
    }
    fail('Acción no disponible.', 404);
  } catch (e) {
    const status = e.status || (e instanceof SyntaxError ? 400 : 500);
    return json(
      {
        error:
          status < 500
            ? e.message
            : 'No se pudo completar la operación. Puedes reintentar; no se confirma ningún guardado hasta recibir éxito.',
        retryAt: e.retryAt || null,
      },
      status,
    );
  }
}
