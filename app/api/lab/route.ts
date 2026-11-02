import { env } from 'cloudflare:workers';
import { handleLab } from '../../../server/lab.mjs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleLab(request, env);
}
export function POST(request: Request) {
  return handleLab(request, env);
}
