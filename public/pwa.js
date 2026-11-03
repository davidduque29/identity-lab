'use strict';
(() => {
  if (!('serviceWorker' in navigator)) return;
  let installEvent = null,
    refreshing = false;
  const tools = document.createElement('aside');
  tools.className = 'pwa-tools';
  tools.setAttribute('aria-label', 'Instalación y actualizaciones');
  const install = document.createElement('button');
  install.textContent = 'Instalar app';
  install.type = 'button';
  tools.append(install);
  document.body.append(tools);
  const help = document.createElement('dialog');
  help.className = 'pwa-help';
  help.innerHTML =
    '<h2>Instalar Identity Lab</h2><p>En iPhone: abre esta página en Safari, pulsa Compartir y «Agregar a pantalla de inicio».</p><p>En Android o computador: abre el menú del navegador y busca «Instalar aplicación» o «Agregar a pantalla de inicio».</p><p>El registro y la comparación requieren internet.</p><button type="button">Cerrar</button>';
  help.querySelector('button').onclick = () => help.close();
  document.body.append(help);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  install.hidden = !!standalone;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installEvent = event;
    install.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    install.hidden = true;
    installEvent = null;
  });
  install.onclick = async () => {
    if (!installEvent) {
      help.showModal();
      return;
    }
    const prompt = installEvent;
    installEvent = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === 'accepted') install.hidden = true;
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) location.reload();
  });
  navigator.serviceWorker
    .register('sw.js', { scope: './', updateViaCache: 'none' })
    .then((registration) => {
      function offerUpdate() {
        if (
          !registration.waiting ||
          !navigator.serviceWorker.controller ||
          tools.querySelector('[data-update]')
        )
          return;
        const update = document.createElement('button');
        update.dataset.update = 'true';
        update.textContent = 'Nueva versión · Actualizar';
        update.onclick = () => {
          if (
            !window.confirm(
              'Se recargará la app. Finaliza o cancela cualquier captura o formulario antes de continuar. ¿Actualizar ahora?',
            )
          )
            return;
          refreshing = true;
          registration.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' });
        };
        tools.append(update);
      }
      offerUpdate();
      registration.addEventListener('updatefound', () =>
        registration.installing?.addEventListener('statechange', offerUpdate),
      );
    })
    .catch(() => {
      install.title =
        'Puedes usar la versión web aunque la instalación no esté disponible.';
    });
})();
