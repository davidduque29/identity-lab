import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'pages-dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(resolve(root, 'public'), out, { recursive: true });
await writeFile(resolve(out, '.nojekyll'), '');
// Backend code lives exclusively in Supabase. GitHub Pages publishes only these assets.
const shared = resolve(root, 'supabase/functions/identity-api/shared');
await mkdir(shared, { recursive: true });
for (const file of ['lab.mjs', 'domain.mjs', 'storage.mjs', 'network-context.mjs']) {
  await cp(resolve(root, 'server', file), resolve(shared, file));
}
await writeFile(
  resolve(root, 'supabase/functions/identity-api/deno.json'),
  JSON.stringify({ imports: { qrcode: 'npm:qrcode@1.5.4' } }, null, 2),
);
console.log('Static Pages build ready:', out);
