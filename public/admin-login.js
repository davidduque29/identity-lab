'use strict';
(() => {
  const config = window.IDENTITY_DEPLOYMENT;
  const status = document.getElementById('status');
  let codeMode = false;
  let resendAt = 0;
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
  if (callback.get('error_description')) {
    status.textContent = 'El enlace no es válido o venció. Solicita uno nuevo.';
    history.replaceState(null, '', location.pathname);
  }
  document.getElementById('useCode').onclick = () => {
    codeMode = true;
    document.getElementById('codeLabel').hidden = false;
    document.getElementById('code').required = true;
    document.getElementById('submit').hidden = false;
    document.getElementById('submit').textContent = 'Validar código';
    document.getElementById('code').focus();
  };
  document.getElementById('resend').onclick = () => {
    if (Date.now() < resendAt) {
      status.textContent =
        'Espera ' +
        Math.ceil((resendAt - Date.now()) / 1000) +
        ' segundos antes de pedir otro enlace.';
      return;
    }
    codeMode = false;
    document.getElementById('code').required = false;
    document.getElementById('codeLabel').hidden = true;
    document.getElementById('login').requestSubmit();
  };
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
  if (
    location.hash !== '#salir' &&
    localStorage.getItem('identity-lab:admin') &&
    window.IdentityTransport
  ) {
    status.textContent = 'Comprobando tu sesión administrativa…';
    window.IdentityTransport.fetch('/api/lab?action=context')
      .then(async (response) => {
        const context = await response.json();
        if (response.ok && context.admin) location.replace('portal.html#administracion');
        else
          status.textContent = response.ok
            ? 'Esta sesión no tiene permisos administrativos. Usa el correo autorizado.'
            : 'No se pudo validar tu sesión. Puedes solicitar un enlace nuevo.';
      })
      .catch(() => {
        status.textContent = 'No se pudo comprobar tu sesión. Revisa la conexión.';
      });
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
          (codeMode
            ? 'verify'
            : 'otp?redirect_to=' +
              encodeURIComponent(new URL('admin-login.html', location.href).href)),
        {
          method: 'POST',
          headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(
            codeMode
              ? {
                  email,
                  token: document.getElementById('code').value.trim(),
                  type: 'email',
                }
              : { email, create_user: false },
          ),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? 'Supabase alcanzó el límite temporal de envíos de correo. Recargar o solicitar más enlaces no elimina la pausa. Intenta más tarde y usa únicamente el correo más reciente.'
            : result.msg || result.message || 'No se pudo completar el acceso.',
        );
      if (codeMode) {
        localStorage.setItem('identity-lab:admin', JSON.stringify(result));
        location.replace('portal.html#administracion');
      } else {
        resendAt = Date.now() + 60000;
        document.getElementById('useCode').hidden = false;
        document.getElementById('resend').hidden = false;
        document.getElementById('email').readOnly = true;
        button.hidden = true;
        status.textContent =
          'Solicitud aceptada. Revisa la bandeja de entrada y correo no deseado del correo indicado. Abre el enlace del mensaje más reciente de Identity Lab; no necesitas un código numérico. Si tu plantilla sí incluye un código, pulsa «Mi correo trae un código».';
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
})();
