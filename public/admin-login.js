'use strict';
(() => {
  const config = window.IDENTITY_DEPLOYMENT;
  const status = document.getElementById('status');
  let sent = false;
  const callback = new URLSearchParams(location.hash.slice(1));
  if (callback.get('access_token') && callback.get('refresh_token')) {
    localStorage.setItem(
      'identity-lab:admin',
      JSON.stringify({
        access_token: callback.get('access_token'),
        refresh_token: callback.get('refresh_token'),
        expires_at:
          Math.floor(Date.now() / 1000) + Number(callback.get('expires_in') || 3600),
      }),
    );
    history.replaceState(null, '', location.pathname);
    location.replace('portal.html#administracion');
    return;
  }
  if (location.hash === '#salir') {
    const session = JSON.parse(localStorage.getItem('identity-lab:admin') || 'null');
    localStorage.removeItem('identity-lab:admin');
    sessionStorage.removeItem('identity-lab:qr');
    if (session)
      fetch(config.url + '/auth/v1/logout', {
        method: 'POST',
        headers: {
          apikey: config.publishableKey,
          Authorization: 'Bearer ' + session.access_token,
        },
      }).catch(() => {});
    status.textContent = 'Sesión administrativa cerrada.';
  }
  document.getElementById('login').onsubmit = async (event) => {
    event.preventDefault();
    const button = document.getElementById('submit');
    button.disabled = true;
    try {
      const email = document.getElementById('email').value.trim();
      const response = await fetch(
        config.url +
          '/auth/v1/' +
          (sent
            ? 'verify'
            : 'otp?redirect_to=' +
              encodeURIComponent(new URL('admin-login.html', location.href).href)),
        {
          method: 'POST',
          headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(
            sent
              ? {
                  email,
                  token: document.getElementById('code').value.trim(),
                  type: 'email',
                }
              : { email, create_user: true },
          ),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.msg || result.message || 'No se pudo completar el acceso.',
        );
      if (sent) {
        localStorage.setItem('identity-lab:admin', JSON.stringify(result));
        location.replace('portal.html#administracion');
      } else {
        sent = true;
        document.getElementById('codeLabel').hidden = false;
        document.getElementById('code').required = true;
        document.getElementById('email').readOnly = true;
        button.textContent = 'Validar código';
        status.textContent =
          'Revisa tu correo e introduce el código recibido. Si el mensaje trae un enlace, ábrelo para iniciar sesión.';
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
})();
