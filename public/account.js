'use strict';
(() => {
  const menu = document.getElementById('accountMenu');
  if (!menu) return;
  const label = document.getElementById('accountLabel');
  const subtitle = document.getElementById('accountRole');
  const avatar = document.getElementById('headerAvatar');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
  menu.querySelectorAll('a, button').forEach((item) =>
    item.addEventListener('click', () => {
      menu.open = false;
    }),
  );
  fetch('/api/lab?action=context', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: controller.signal,
  })
    .then(async (response) => {
      const context = await response.json();
      if (!response.ok)
        throw new Error('Inicia sesión para ver las opciones de tu cuenta.');
      label.textContent = context.email;
      subtitle.textContent = context.admin
        ? 'Cuenta administradora'
        : 'Cuenta autorizada';
      document.getElementById('accountSignIn').hidden = true;
      document.getElementById('accountSignOut').hidden = false;
      const adminLink = document.getElementById('accountAdminLink');
      if (adminLink) adminLink.hidden = !context.admin;
      document.getElementById('accountProfileLink').hidden = !context.admin;
      if (context.admin && context.avatar?.kind === 'upload') {
        const img = new Image();
        img.src = '/api/lab?action=avatar';
        img.alt = 'Foto de tu cuenta';
        avatar.replaceChildren(img);
      } else if (context.admin && context.avatar?.kind === 'preset')
        avatar.textContent = context.avatar.value;
    })
    .catch(() => {
      label.textContent = 'Tu cuenta';
      subtitle.textContent = 'Inicia sesión para ver tus permisos.';
    })
    .finally(() => clearTimeout(timeout));
})();
