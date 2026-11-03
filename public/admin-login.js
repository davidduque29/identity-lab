'use strict';
(() => {
  const config = window.IDENTITY_DEPLOYMENT;
  const get = (id) => document.getElementById(id);
  const storageKey = 'identity-lab:admin';
  const callback = new URLSearchParams(location.hash.slice(1));
  let mode = 'login',
    recoveryToken = null,
    pending = false,
    attempt = 0;
  let recoveryAvailableAt = 0;

  async function request(path, body, { method = 'POST', token } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(config.url + path, {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          apikey: config.publishableKey,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      if (!response.ok) {
        const message =
          response.status === 429
            ? 'Supabase ha pausado temporalmente esta operación por límite de intentos o correos. No solicites más enlaces seguidos.'
            : path.includes('/token')
              ? 'Correo o contraseña incorrectos. Si no la recuerdas, usa «Olvidé mi contraseña».'
              : value.msg ||
                value.message ||
                value.error_description ||
                value.error ||
                'No se pudo completar la operación.';
        throw new Error(message);
      }
      return value;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          'La comprobación tardó demasiado. Revisa tu conexión e inténtalo nuevamente.',
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || 'null');
    } catch {
      localStorage.removeItem(storageKey);
      return null;
    }
  }
  async function authorize(session, current) {
    const context = await request('/functions/v1/identity-api?action=context', null, {
      method: 'GET',
      token: session.access_token,
    });
    if (!context.admin)
      throw new Error('Tu cuenta no tiene permisos de administración en Identity Lab.');
    if (current !== attempt) return;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...session,
        expires_at:
          session.expires_at || Math.floor(Date.now() / 1000) + session.expires_in,
      }),
    );
    location.replace('portal.html#administracion');
  }
  function setMode(next) {
    mode = next;
    get('confirmLabel').hidden = next !== 'set-password';
    get('confirmPassword').required = next === 'set-password';
    get('passwordHint').hidden = next !== 'set-password';
    get('password').autocomplete =
      next === 'set-password' ? 'new-password' : 'current-password';
    get('password').minLength = next === 'set-password' ? 15 : 0;
    get('recover').hidden = next === 'set-password';
    get('submit').textContent =
      next === 'set-password' ? 'Guardar contraseña y entrar' : 'Entrar';
    get('email').required = next !== 'set-password';
    get('email').readOnly = next === 'set-password';
    get('cancelRecovery').hidden = next !== 'set-password';
    get('loginInstruction').textContent =
      next === 'set-password'
        ? 'Elige tu contraseña. Después podrás entrar sin solicitar enlaces de correo.'
        : 'Entra con el correo y la contraseña de tu cuenta de Identity Lab.';
  }
  get('togglePassword').onclick = () => {
    const show = get('password').type === 'password';
    get('password').type = show ? 'text' : 'password';
    get('togglePassword').textContent = show ? 'Ocultar' : 'Mostrar';
    get('togglePassword').setAttribute(
      'aria-label',
      show ? 'Ocultar contraseña' : 'Mostrar contraseña',
    );
    get('togglePassword').setAttribute('aria-pressed', String(show));
  };
  get('cancelRecovery').onclick = () => {
    attempt++;
    recoveryToken = null;
    localStorage.removeItem(storageKey);
    get('password').value = '';
    get('confirmPassword').value = '';
    setMode('login');
    get('status').textContent =
      'Recuperación cancelada. Puedes iniciar sesión con tu contraseña actual.';
  };
  get('recover').onclick = async () => {
    if (pending) return;
    attempt++;
    if (!get('email').reportValidity()) return;
    if (Date.now() < recoveryAvailableAt) {
      get('status').textContent =
        'Espera antes de solicitar otro correo de recuperación.';
      return;
    }
    pending = true;
    get('recover').disabled = true;
    try {
      const redirect = new URL('admin-login.html', location.href);
      redirect.hash = '';
      await request('/auth/v1/recover?redirect_to=' + encodeURIComponent(redirect.href), {
        email: get('email').value.trim(),
      });
      recoveryAvailableAt = Date.now() + 60000;
      get('status').textContent =
        'Si el correo tiene una cuenta, recibirás un enlace para configurar tu contraseña. Abre únicamente el mensaje más reciente. Este correo solo se necesita para recuperar o configurar la contraseña.';
    } catch (error) {
      get('status').textContent = error.message;
    } finally {
      pending = false;
      get('recover').disabled = false;
    }
  };
  get('login').onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    const current = ++attempt;
    pending = true;
    get('submit').disabled = true;
    get('status').textContent = 'Validando tu acceso…';
    try {
      let session;
      if (mode === 'set-password') {
        const password = get('password').value;
        if (password.length < 15)
          throw new Error('La contraseña debe tener al menos 15 caracteres.');
        if (password !== get('confirmPassword').value)
          throw new Error('Las contraseñas no coinciden.');
        await request(
          '/auth/v1/user',
          { password },
          { method: 'PUT', token: recoveryToken.access_token },
        );
        session = recoveryToken;
        get('confirmPassword').value = '';
      } else {
        session = await request('/auth/v1/token?grant_type=password', {
          email: get('email').value.trim(),
          password: get('password').value,
        });
      }
      get('password').value = '';
      await authorize(session, current);
    } catch (error) {
      if (current === attempt) get('status').textContent = error.message;
    } finally {
      pending = false;
      get('submit').disabled = false;
    }
  };

  (async () => {
    const current = ++attempt;
    if (callback.get('error') || callback.get('error_description')) {
      history.replaceState(null, '', location.pathname);
      get('status').textContent =
        'El enlace ya se utilizó o venció. Puedes entrar con tu contraseña o solicitar recuperación.';
      return;
    }
    if (location.hash === '#salir') {
      const session = readSession();
      localStorage.removeItem(storageKey);
      sessionStorage.removeItem('identity-lab:qr');
      history.replaceState(null, '', location.pathname);
      get('status').textContent = 'Sesión administrativa cerrada.';
      if (session)
        await request('/auth/v1/logout', null, { token: session.access_token }).catch(
          () => {},
        );
      return;
    }
    let session =
      callback.get('access_token') && callback.get('refresh_token')
        ? {
            access_token: callback.get('access_token'),
            refresh_token: callback.get('refresh_token'),
            expires_at:
              Math.floor(Date.now() / 1000) + Number(callback.get('expires_in') || 3600),
          }
        : readSession();
    if (!session) return;
    if (callback.get('access_token')) history.replaceState(null, '', location.pathname);
    if (callback.get('type') === 'recovery') {
      recoveryToken = session;
      setMode('set-password');
      get('status').textContent = 'Enlace recibido. Define tu contraseña para continuar.';
      return;
    }
    get('status').textContent = 'Comprobando tu sesión administrativa…';
    try {
      if (!session.expires_at || session.expires_at <= Date.now() / 1000 + 60)
        session = await request('/auth/v1/token?grant_type=refresh_token', {
          refresh_token: session.refresh_token,
        });
      await authorize(session, current);
    } catch (error) {
      if (current === attempt) {
        localStorage.removeItem(storageKey);
        get('status').textContent =
          error.message + ' Puedes entrar con tu correo y contraseña.';
      }
    }
  })();
})();
