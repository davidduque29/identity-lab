'use strict';
(() => {
  const config = window.IDENTITY_DEPLOYMENT;
  const prefix = 'identity-lab:';
  let pending;
  // The email may return to the site root or portal, not only the login page.
  const callback = new URLSearchParams(location.hash.slice(1));
  if (callback.get('access_token') && callback.get('refresh_token')) {
    if (callback.get('type') === 'recovery') {
      location.replace('admin-login.html' + location.hash);
      return;
    }
    localStorage.setItem(
      prefix + 'admin',
      JSON.stringify({
        access_token: callback.get('access_token'),
        refresh_token: callback.get('refresh_token'),
        expires_at:
          Math.floor(Date.now() / 1000) + Number(callback.get('expires_in') || 3600),
      }),
    );
    history.replaceState(null, '', location.pathname);
    location.replace('portal.html#administracion');
  }

  async function credentials() {
    const admin = JSON.parse(localStorage.getItem(prefix + 'admin') || 'null');
    if (admin && admin.expires_at > Date.now() / 1000 + 60) return admin.access_token;
    if (admin?.refresh_token) {
      const response = await fetch(
        config.url + '/auth/v1/token?grant_type=refresh_token',
        {
          method: 'POST',
          headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: admin.refresh_token }),
        },
      );
      if (response.ok) {
        const session = await response.json();
        localStorage.setItem(prefix + 'admin', JSON.stringify(session));
        return session.access_token;
      }
      localStorage.removeItem(prefix + 'admin');
    }
    const visitor = JSON.parse(localStorage.getItem(prefix + 'visitor') || 'null');
    if (visitor?.expires > Date.now()) return visitor.token;
    const response = await fetch(
      config.url + '/functions/v1/identity-api?action=bootstrap',
      { method: 'POST', headers: { apikey: config.publishableKey } },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo iniciar la sesión.');
    localStorage.setItem(
      prefix + 'visitor',
      JSON.stringify({ token: result.token, expires: Date.now() + 23 * 3600000 }),
    );
    return result.token;
  }
  async function accessToken() {
    if (!pending)
      pending = credentials().finally(() => {
        pending = null;
      });
    return pending;
  }
  async function mediaData(path) {
    const response = await apiFetch(path);
    if (!response.ok) throw new Error('Imagen protegida no disponible.');
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  async function apiFetch(path, options = {}) {
    const parsed = new URL(path, location.origin);
    const query = parsed.pathname.includes('network-context')
      ? '?action=network-context'
      : parsed.search;
    const headers = new Headers(options.headers || {});
    headers.set('apikey', config.publishableKey);
    headers.set('Authorization', 'Bearer ' + (await accessToken()));
    const qr = sessionStorage.getItem(prefix + 'qr');
    if (qr) headers.set('x-identity-qr', qr);
    const response = await fetch(config.url + '/functions/v1/identity-api' + query, {
      ...options,
      credentials: 'omit',
      headers,
    });
    if (!response.headers.get('content-type')?.includes('application/json'))
      return response;
    const result = await response.json();
    if ('qrSession' in result) {
      if (result.qrSession) sessionStorage.setItem(prefix + 'qr', result.qrSession);
      else sessionStorage.removeItem(prefix + 'qr');
      delete result.qrSession;
    }
    if (result.evidence?.referenceUrl) {
      try {
        result.evidence.referenceUrl = await mediaData(result.evidence.referenceUrl);
      } catch {
        result.evidence.referenceUrl = null;
      }
    }
    return new Response(JSON.stringify(result), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  window.IdentityTransport = {
    fetch: apiFetch,
    async image(element, path) {
      try {
        element.src = await mediaData(path);
      } catch {
        element.alt = 'Imagen no disponible';
      }
    },
  };
})();
