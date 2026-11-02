import { networkResponse } from '../../../server/network-context.mjs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return networkResponse(request);
}
