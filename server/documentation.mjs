// Manuals are private server data. Neither bytes nor download URLs belong in Pages.
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TYPES = new Set([DOCX, 'application/pdf']);
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const available = (document, admin) =>
  ID.test(document?.id || '') &&
  (document.audience === 'user' || (admin && document.audience === 'admin'));

async function readConfiguration(db, key) {
  const row = await db
    .prepare('SELECT payload FROM configuration WHERE key=?')
    .bind(key)
    .first();
  return row ? JSON.parse(row.payload) : null;
}

export async function serveDocumentation({ request, db, tenant, admin, member }) {
  const json = (data, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  if (!member)
    return json({ error: 'Inicia sesión para consultar la documentación.' }, 401);
  const url = new URL(request.url);
  const registry = (await readConfiguration(db, tenant + ':documentation')) || [];
  const documents = registry.filter((document) => available(document, admin));
  if (url.searchParams.get('action') === 'documentation') {
    return json({
      admin,
      documents: documents.map(
        ({
          id,
          title,
          description,
          audience,
          version,
          updatedAt,
          filename,
          size,
          contentType,
        }) => ({
          id,
          title,
          description,
          audience,
          version,
          updatedAt,
          filename,
          size,
          contentType,
        }),
      ),
    });
  }
  // Resolve the ID only through the authorized catalog. Guessed IDs cannot fetch a file.
  const document = documents.find((item) => item.id === url.searchParams.get('id'));
  if (!document) return json({ error: 'Manual no disponible para tu cuenta.' }, 404);
  const file = await readConfiguration(db, tenant + ':document:' + document.id);
  if (
    !file ||
    !TYPES.has(document.contentType) ||
    !/^[a-zA-Z0-9_.-]+$/.test(document.filename)
  )
    return json({ error: 'El archivo del manual no está disponible.' }, 404);
  const bytes = Uint8Array.from(atob(file.content), (character) =>
    character.charCodeAt(0),
  );
  if (bytes.length !== document.size)
    return json({ error: 'No pudimos comprobar el archivo. Inténtalo más tarde.' }, 503);
  return new Response(bytes, {
    headers: {
      'Content-Type': document.contentType,
      'Content-Disposition': 'attachment; filename="' + document.filename + '"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
