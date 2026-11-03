import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'pages-dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(resolve(root, 'public'), out, { recursive: true });
await writeFile(resolve(out, '.nojekyll'), '');
const digest = createHash('sha256');
async function hashFiles(folder) {
  for (const item of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = resolve(folder, item.name);
    if (item.isDirectory()) await hashFiles(path);
    else {
      digest.update(item.name);
      digest.update(await readFile(path));
    }
  }
}
await hashFiles(resolve(root, 'public'));
const buildVersion = digest.digest('hex').slice(0, 16);
const worker = await readFile(resolve(out, 'sw.js'), 'utf8');
await writeFile(resolve(out, 'sw.js'), worker.replace('__BUILD_VERSION__', buildVersion));
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
