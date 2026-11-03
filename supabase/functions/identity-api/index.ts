import { createClient } from 'npm:@supabase/supabase-js@2.95.3';
import { handleLab } from './shared/lab.mjs';

const APP_URL = 'https://davidduque29.github.io/identity-lab/';
const ORIGIN = new URL(APP_URL).origin;
const client = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);
const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-identity-qr',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'private, no-store',
  Vary: 'Origin',
};
const hash = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}
class DatabasePort {
  prepare(sql: string) {
    const execute = async (args: unknown[]) =>
      (await rpc('identity_query', { statements: [{ sql, args }] }))[0];
    return {
      bind: (...args: unknown[]) => ({
        sql,
        args,
        first: async () => (await execute(args)).results[0] || null,
        all: () => execute(args),
        run: () => execute(args),
      }),
    };
  }
  batch(statements: unknown[]) {
    return rpc('identity_query', { statements });
  }
}
const db = new DatabasePort();
const bucket = client.storage.from('identity-lab');
const storage = {
  name: 'supabase',
  async put(key: string, bytes: Uint8Array, contentType: string) {
    const { error } = await bucket.upload(key, bytes, { contentType, upsert: true });
    if (error) throw error;
    return key;
  },
  async get(key: string) {
    const { data, error } = await bucket.download(key);
    if (error) return null;
    return { body: data.stream(), httpMetadata: { contentType: data.type } };
  },
  async remove(keys: string[]) {
    if (keys.length) {
      const { error } = await bucket.remove(keys);
      if (error) throw error;
    }
  },
};
const response = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: cors });
Deno.serve(async (request: Request) => {
  if (request.headers.get('origin') !== ORIGIN)
    return response({ error: 'Origen no permitido.' }, 403);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'context';
  try {
    if (action === 'bootstrap' && request.method === 'POST') {
      const token = 'il_' + crypto.randomUUID() + crypto.randomUUID();
      const actor = crypto.randomUUID();
      await rpc('identity_visitor', {
        op: 'create',
        token: await hash(token),
        actor_id: actor,
      });
      return response({ token });
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /i, '') || '';
    let actor: string, email: string;
    if (token.startsWith('il_')) {
      const visitor = await rpc('identity_visitor', {
        op: 'get',
        token: await hash(token),
      });
      if (!visitor?.actor)
        return response({ error: 'La sesión venció. Recarga la página.' }, 401);
      actor = visitor.actor;
      email = actor + '@visitor.invalid';
    } else {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user || !data.user.email_confirmed_at || data.user.is_anonymous)
        return response({ error: 'La sesión administrativa no es válida.' }, 401);
      actor = data.user.id;
      email = data.user.email!;
    }
    if (action === 'network-context')
      return response({
        status: 'unavailable',
        ip: null,
        ipVersion: null,
        observedAt: new Date().toISOString(),
        source: null,
        note: 'IP no disponible: pendiente de una cabecera de origen verificable en el nuevo proveedor.',
      });
    const owner = await db
      .prepare('SELECT payload FROM configuration WHERE key=?')
      .bind('identity-lab-david:admin-email')
      .first();
    const headers = new Headers({
      'oai-authenticated-user-id': actor,
      'oai-authenticated-user-email': email,
      origin: ORIGIN,
    });
    const qr = request.headers.get('x-identity-qr');
    if (qr) headers.set('cookie', 'il_session=' + qr);
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && new TextEncoder().encode(body).length > 3600000)
      return response({ error: 'La solicitud supera el tamaño permitido.' }, 413);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const forwarded = new Request(ORIGIN + '/api/lab' + url.search, {
      method: request.method,
      headers,
      body,
    });
    const result = await handleLab(forwarded, {
      PUBLIC_DEMO: true,
      DB: db,
      STORAGE: storage,
      ADMIN_EMAIL: owner ? JSON.parse(owner.payload) : '',
      PUBLIC_APP_URL: APP_URL,
    });
    const outHeaders = new Headers(result.headers);
    for (const [key, value] of Object.entries(cors)) outHeaders.set(key, value);
    const cookie = result.headers.get('set-cookie');
    outHeaders.delete('set-cookie');
    if (cookie && result.headers.get('content-type')?.includes('application/json')) {
      const out = await result.json();
      out.qrSession = cookie.match(/^il_session=([^;]*)/)?.[1] || null;
      return Response.json(out, { status: result.status, headers: outHeaders });
    }
    return new Response(result.body, { status: result.status, headers: outHeaders });
  } catch (error) {
    console.error(
      'Identity API:',
      error instanceof Error ? error.message : 'request failed',
    );
    return response(
      { error: 'No se pudo completar la operación. Vuelve a intentarlo.' },
      500,
    );
  }
});
