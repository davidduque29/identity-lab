'use strict';
(() => {
  const config = window.IDENTITY_DEPLOYMENT;
  const get = (id) => document.getElementById(id);
  const storageKey = 'identity-lab:admin';
  const callback = new URLSearchParams(location.hash.slice(1));
  const memberAccess =
    document.body?.getAttribute('data-audience') === 'member' ||
    callback.get('type') === 'signup';
  const signingUp = () => mode === 'signup';
  const choosingPassword = () => mode === 'set-password' || signingUp();
  let mode = 'login',
    recoveryToken = null,
    pending = false,
    attempt = 0;
  let recoveryAvailableAt = 0;

  function showStatus(message, tone = 'info') {
    get('status').textContent = message;
    get('status').setAttribute('data-tone', tone);
  }
  function setButtonBusy(id, busy, label) {
    get(id).disabled = busy;
    get(id).setAttribute('aria-busy', String(busy));
    get(id).textContent = label;
  }
  function updatePasswordFeedback() {
    if (!choosingPassword()) return;
    const password = get('password').value;
    const confirmation = get('confirmPassword').value;
    const longEnough = [...password].length >= 15;
    const matches = Boolean(password) && password === confirmation;
    get('lengthRequirement').textContent = longEnough
      ? '✓ Mínimo de 15 caracteres cumplido.'
      : '○ Mínimo 15 caracteres.';
    get('lengthRequirement').setAttribute('data-met', String(longEnough));
    get('matchRequirement').textContent = matches
      ? '✓ Las contraseñas coinciden.'
      : confirmation
        ? '○ Las contraseñas todavía no coinciden.'
        : '○ Confirma tu nueva contraseña.';
    get('matchRequirement').setAttribute('data-met', String(matches));
    const normalized = password
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const emailName = get('email').value.split('@')[0].toLowerCase();
    const commonPattern =
      /password|contrasena|qwerty|12345|abcde|letmein|admin|(.)\1{3}|^(.{1,8})\2+$/i.test(
        normalized,
      ) ||
      (emailName.length >= 4 && normalized.includes(emailName));
    const variety = new Set(normalized).size;
    const score = !password
      ? 0
      : !longEnough || commonPattern || variety < 7
        ? 1
        : [...password].length >= 20 && variety >= 10
          ? 3
          : 2;
    const label = ['Sin evaluar', 'Débil', 'Media', 'Fuerte'][score];
    get('passwordStrength').value = score;
    get('passwordStrength').textContent = label;
    get('strengthText').textContent = label;
  }
  get('password').oninput = updatePasswordFeedback;
  get('confirmPassword').oninput = updatePasswordFeedback;

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
    if (!context.admin && !memberAccess && mode !== 'set-password')
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
    sessionStorage.removeItem('identity-lab:qr');
    location.replace(
      memberAccess || !context.admin ? 'my-history.html' : 'portal.html#administracion',
    );
  }
  function setMode(next) {
    mode = next;
    get('confirmLabel').hidden = !choosingPassword();
    get('confirmPassword').required = choosingPassword();
    get('passwordHint').hidden = !choosingPassword();
    get('passwordFeedback').hidden = !choosingPassword();
    get('passwordLabelText').textContent = choosingPassword()
      ? 'Nueva contraseña'
      : 'Contraseña';
    get('password').placeholder = choosingPassword()
      ? 'Crea una frase de al menos 15 caracteres'
      : 'Escribe tu contraseña';
    get('password').autocomplete = choosingPassword()
      ? 'new-password'
      : 'current-password';
    get('password').minLength = 0;
    get('recover').hidden = choosingPassword();
    get('submit').textContent = signingUp()
      ? 'Crear mi cuenta'
      : next === 'set-password'
        ? 'Guardar contraseña y entrar'
        : 'Entrar';
    get('email').required = next !== 'set-password';
    get('email').readOnly = next === 'set-password';
    get('emailLabel').hidden = false;
    get('recoveryAccountHint').hidden = next !== 'set-password';
    get('cancelRecovery').hidden = !choosingPassword();
    if (get('signupToggle'))
      get('signupToggle').hidden = !memberAccess || choosingPassword();
    if (get('signupConsent')) get('signupConsent').required = signingUp();
    if (get('signupConsentLabel')) get('signupConsentLabel').hidden = !signingUp();
    get('loginInstruction').textContent = signingUp()
      ? 'Crea tu cuenta para consultar los registros realizados con tu sesión iniciada. Confirma tu correo para acceder.'
      : next === 'set-password'
        ? 'Elige tu contraseña. Después podrás entrar sin solicitar enlaces de correo.'
        : memberAccess
          ? 'Entra para consultar tu registro y tu historial de verificaciones.'
          : 'Entra con el correo y la contraseña de tu cuenta de Identity Lab.';
    updatePasswordFeedback();
  }
  if (get('signupToggle'))
    get('signupToggle').onclick = () => {
      if (pending) return;
      get('password').value = '';
      get('confirmPassword').value = '';
      setMode('signup');
      showStatus(
        'Tu cuenta tendrá acceso únicamente a su información. Los registros anteriores sin cuenta no se vinculan automáticamente.',
      );
    };
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
    showStatus('Puedes iniciar sesión con tu correo y contraseña.');
  };
  get('recover').onclick = async () => {
    if (pending) return;
    attempt++;
    if (!get('email').reportValidity()) return;
    if (Date.now() < recoveryAvailableAt) {
      showStatus('Espera antes de solicitar otro correo de recuperación.');
      return;
    }
    pending = true;
    setButtonBusy('recover', true, 'Enviando…');
    showStatus('Estamos enviando tu enlace de recuperación…');
    try {
      const redirect = new URL('admin-login.html', location.href);
      redirect.hash = '';
      await request('/auth/v1/recover?redirect_to=' + encodeURIComponent(redirect.href), {
        email: get('email').value.trim(),
      });
      recoveryAvailableAt = Date.now() + 60000;
      showStatus(
        'Solicitud recibida. Si el correo corresponde a una cuenta, recibirás un enlace para elegir una nueva contraseña. Revisa también el correo no deseado y abre únicamente el mensaje más reciente.',
        'success',
      );
    } catch (error) {
      showStatus(error.message, 'error');
    } finally {
      pending = false;
      setButtonBusy('recover', false, 'Olvidé mi contraseña');
    }
  };
  get('login').onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    const current = ++attempt;
    pending = true;
    setButtonBusy(
      'submit',
      true,
      signingUp()
        ? 'Creando cuenta…'
        : mode === 'set-password'
          ? 'Guardando…'
          : 'Entrando…',
    );
    showStatus(
      mode === 'set-password' ? 'Guardando tu nueva contraseña…' : 'Validando tu acceso…',
    );
    let passwordSaved = false;
    try {
      let session;
      if (choosingPassword()) {
        const password = get('password').value;
        if ([...password].length < 15)
          throw new Error('La contraseña debe tener al menos 15 caracteres.');
        if (password !== get('confirmPassword').value)
          throw new Error('Las contraseñas no coinciden.');
        if (signingUp()) {
          if (!get('signupConsent').checked)
            throw new Error('Confirma que deseas crear tu cuenta.');
          const redirect = new URL('admin-login.html', location.href);
          const result = await request(
            '/auth/v1/signup?redirect_to=' + encodeURIComponent(redirect.href),
            {
              email: get('email').value.trim(),
              password,
            },
          );
          get('password').value = '';
          get('confirmPassword').value = '';
          if (result.access_token) {
            await authorize(result, current);
            return;
          }
          setMode('login');
          showStatus(
            'Solicitud recibida. Revisa tu correo para confirmar la cuenta. Si ya tienes una, entra con tu contraseña. No necesitas solicitar otro enlace.',
            'success',
          );
          return;
        }
        await request(
          '/auth/v1/user',
          { password },
          { method: 'PUT', token: recoveryToken.access_token },
        );
        session = recoveryToken;
        passwordSaved = true;
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
      if (current === attempt) {
        if (passwordSaved) {
          recoveryToken = null;
          setMode('login');
          showStatus(
            'Tu contraseña se guardó correctamente, pero no pudimos abrir el panel. ' +
              error.message +
              ' Puedes volver a entrar con tu correo y tu nueva contraseña.',
          );
        } else showStatus(error.message, 'error');
      }
    } finally {
      pending = false;
      setButtonBusy(
        'submit',
        false,
        signingUp()
          ? 'Crear mi cuenta'
          : mode === 'set-password'
            ? 'Guardar contraseña y entrar'
            : 'Entrar',
      );
    }
  };

  (async () => {
    if (memberAccess) setMode('login');
    const current = ++attempt;
    if (callback.get('error') || callback.get('error_description')) {
      history.replaceState(null, '', location.pathname);
      showStatus(
        'El enlace ya se utilizó o venció. Puedes entrar con tu contraseña o solicitar recuperación.',
      );
      return;
    }
    if (location.hash === '#salir') {
      const session = readSession();
      localStorage.removeItem(storageKey);
      sessionStorage.removeItem('identity-lab:qr');
      history.replaceState(null, '', location.pathname);
      showStatus('Sesión cerrada.');
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
      setMode('set-password');
      get('email').value = '';
      get('emailLabel').hidden = true;
      get('recoveryAccountHint').hidden = true;
      pending = true;
      get('submit').disabled = true;
      showStatus('Comprobando la cuenta del enlace recibido…');
      try {
        const user = await request('/auth/v1/user', null, {
          method: 'GET',
          token: session.access_token,
        });
        if (current !== attempt) return;
        if (!user.email)
          throw new Error('No se pudo identificar el correo de la cuenta.');
        recoveryToken = session;
        get('email').value = user.email;
        get('emailLabel').hidden = false;
        get('recoveryAccountHint').hidden = false;
        showStatus(
          'Cuenta verificada. Escribe y confirma tu nueva contraseña para continuar.',
        );
      } catch (error) {
        if (current !== attempt) return;
        recoveryToken = null;
        setMode('login');
        showStatus(
          'No pudimos comprobar el enlace. ' +
            error.message +
            ' Tu contraseña no se ha cambiado.',
        );
      } finally {
        pending = false;
        get('submit').disabled = false;
      }
      return;
    }
    showStatus('Comprobando tu sesión administrativa…');
    try {
      if (!session.expires_at || session.expires_at <= Date.now() / 1000 + 60)
        session = await request('/auth/v1/token?grant_type=refresh_token', {
          refresh_token: session.refresh_token,
        });
      await authorize(session, current);
    } catch (error) {
      if (current === attempt) {
        localStorage.removeItem(storageKey);
        showStatus(error.message + ' Puedes entrar con tu correo y contraseña.');
      }
    }
  })();
})();
