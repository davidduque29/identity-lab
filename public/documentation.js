'use strict';
(() => {
  const get = (id) => document.getElementById(id);
  const api = window.IdentityTransport.fetch;
  let documents = [];
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function status(message, tone = 'info') {
    get('documentationStatus').textContent = message;
    get('documentationStatus').dataset.tone = tone;
  }
  async function downloadManual(document, button) {
    button.disabled = true;
    button.textContent = 'Preparando descarga…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await api(
        '/api/lab?action=documentation-file&id=' + encodeURIComponent(document.id),
        {
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || 'No se pudo descargar el manual.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = node('a', '');
      link.href = url;
      link.download = document.filename;
      window.document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status('Descarga preparada. Revisa las descargas de tu navegador.', 'success');
    } catch (error) {
      status(
        error.name === 'AbortError'
          ? 'La descarga tardó demasiado. Inténtalo de nuevo.'
          : error.message,
        'error',
      );
    } finally {
      clearTimeout(timer);
      button.disabled = false;
      button.textContent = 'Descargar manual';
    }
  }
  function renderGroup(audience, container) {
    const query = get('documentationSearch').value.trim().toLocaleLowerCase('es');
    const group = documents.filter((document) => document.audience === audience);
    const filtered = group.filter((document) =>
      (document.title + ' ' + document.description)
        .toLocaleLowerCase('es')
        .includes(query),
    );
    container.replaceChildren();
    if (!filtered.length) {
      const message = group.length
        ? 'No hay manuales que coincidan con tu búsqueda.'
        : audience === 'user'
          ? 'Aún no hay manuales de usuario publicados. Aquí encontrarás las próximas guías de registro, verificación e historial.'
          : 'Aún no hay manuales administrativos publicados.';
      container.append(node('p', message, 'documentation-empty'));
      return;
    }
    filtered.forEach((document) => {
      const card = node('article', '', 'documentation-card');
      const format = document.contentType === 'application/pdf' ? 'PDF' : 'WORD';
      card.append(
        node('span', format, 'documentation-format'),
        node('h3', document.title),
        node('p', document.description),
      );
      const date = new Date(document.updatedAt).toLocaleDateString('es-CO', {
        dateStyle: 'medium',
        timeZone: 'America/Bogota',
      });
      card.append(
        node(
          'p',
          'Versión ' +
            document.version +
            ' · ' +
            date +
            ' · ' +
            Math.ceil(document.size / 1024) +
            ' KB',
          'documentation-meta',
        ),
      );
      const button = node('button', 'Descargar manual', 'primary');
      button.type = 'button';
      button.onclick = () => downloadManual(document, button);
      card.append(button);
      container.append(card);
    });
  }
  function render() {
    renderGroup('admin', get('adminManuals'));
    renderGroup('user', get('userManuals'));
  }
  async function loadDocumentation() {
    get('documentationReload').disabled = true;
    get('documentationSearch').disabled = true;
    get('documentationContent').hidden = true;
    get('documentationSignIn').hidden = true;
    documents = [];
    render();
    status('Comprobando tu acceso a la documentación…');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await api('/api/lab?action=documentation', {
        cache: 'no-store',
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) {
        get('documentationSignIn').hidden = ![401, 403].includes(response.status);
        throw new Error(result.error || 'No se pudo cargar la documentación.');
      }
      documents = result.documents;
      get('adminDocumentation').hidden = !result.admin;
      get('documentationAccount').textContent = result.admin
        ? 'Tu espacio de administración y ayuda'
        : 'Tu espacio de ayuda';
      get('documentationContent').hidden = false;
      render();
      status(
        documents.length
          ? 'Manuales disponibles para tu cuenta.'
          : 'Tu sección está lista. Pronto agregaremos los primeros manuales.',
        'success',
      );
    } catch (error) {
      get('documentationAccount').textContent =
        'Documentación según los permisos de tu cuenta';
      status(
        error.name === 'AbortError'
          ? 'La consulta tardó demasiado. Recarga la página para reintentar.'
          : error.message,
        'error',
      );
    } finally {
      clearTimeout(timer);
      get('documentationReload').disabled = false;
      get('documentationSearch').disabled = false;
    }
  }
  get('documentationSearch').oninput = render;
  get('documentationReload').onclick = loadDocumentation;
  loadDocumentation();
})();
