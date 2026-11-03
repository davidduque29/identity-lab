'use strict';
(() => {
  const get = (id) => document.getElementById(id);
  const api = window.IdentityTransport.fetch;
  let offset = 0;
  const status = (text, tone = 'info') => {
    get('status').textContent = text;
    get('status').setAttribute('data-tone', tone);
  };
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const date = (value) => new Date(Number(value)).toLocaleString('es-CO');
  function renderProfiles(profiles) {
    get('profiles').replaceChildren();
    if (!profiles.length)
      get('profiles').append(
        element(
          'p',
          'Todavía no tienes registros vinculados. Inicia tu registro facial desde esta sesión. Si ya registraste ese documento sin cuenta, el administrador deberá revisar su vinculación.',
          'history-empty',
        ),
      );
    profiles.forEach((p) => {
      const card = element('article', '', 'profile-card');
      const data = p.data;
      const fullName = [
        data.firstName,
        data.middleName,
        data.firstSurname || data.lastName,
        data.secondSurname,
      ]
        .filter(Boolean)
        .join(' ');
      card.append(element('h3', fullName || 'Mi registro'));
      if (p.status === 'active') {
        const img = document.createElement('img');
        img.className = 'profile-photo';
        img.alt = 'Tu foto de referencia';
        window.IdentityTransport.image(
          img,
          '/api/lab?action=my-reference&id=' + encodeURIComponent(p.id),
        );
        card.append(img);
      }
      card.append(
        element('p', 'Documento: ' + data.documentType + ' ' + data.documentNumber),
        element('p', 'Registro: ' + date(p.created_at)),
        element('p', 'Estado: ' + (p.status === 'active' ? 'Activo' : 'Inactivo')),
      );
      const remove = element('button', 'Solicitar eliminación', 'secondary');
      remove.onclick = async () => {
        remove.disabled = true;
        remove.textContent = 'Enviando solicitud…';
        try {
          const response = await api('/api/lab?action=request-my-deletion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: p.id }),
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error || 'No se pudo registrar la solicitud.');
          remove.textContent = 'Solicitud registrada';
          status(
            'Solicitud registrada. El administrador debe revisarla y completar la eliminación; tus datos todavía no se han borrado.',
            'success',
          );
        } catch (error) {
          status(error.message, 'error');
          remove.disabled = false;
          remove.textContent = 'Solicitar eliminación';
        }
      };
      card.append(remove);
      get('profiles').append(card);
    });
  }
  const labels = {
    'deletion-request': 'Eliminación solicitada · pendiente de revisión',
    register: 'Registro facial creado',
    verify: 'Comparación facial',
    'verify-blocked': 'Comparación temporalmente bloqueada',
    'update-reference': 'Foto de referencia actualizada',
  };
  function renderActivity(events) {
    if (!events.length && offset === 0)
      get('activity').append(
        element('p', 'Aún no hay actividad en tu cuenta.', 'history-empty'),
      );
    events.forEach((event) => {
      const row = element('article', '', 'activity-item');
      row.append(element('strong', labels[event.action] || 'Actividad de la cuenta'));
      const time = element('time', date(event.createdAt));
      time.dateTime = new Date(Number(event.createdAt)).toISOString();
      row.append(time);
      if (typeof event.match === 'boolean') {
        const result = element(
          'span',
          event.match ? 'Coincidencia' : 'Sin coincidencia',
          'activity-result',
        );
        result.setAttribute('data-match', String(event.match));
        row.append(result);
      }
      get('activity').append(row);
    });
  }
  async function load() {
    get('more').disabled = true;
    get('more').textContent = 'Cargando…';
    try {
      const response = await api('/api/lab?action=my-history&offset=' + offset, {
        cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || 'No se pudo consultar el historial.');
      get('accountEmail').textContent = data.email;
      get('signInLink').hidden = true;
      get('signOut').hidden = false;
      get('memberContent').hidden = false;
      if (offset === 0) renderProfiles(data.profiles);
      renderActivity(data.events);
      offset = data.nextOffset;
      get('more').hidden = offset === null;
      status('Estás viendo únicamente la información de tu cuenta.', 'success');
    } catch (error) {
      if (get('memberContent').hidden)
        get('accountEmail').textContent = 'Acceso personal protegido';
      status(error.message, 'error');
    } finally {
      get('more').disabled = false;
      get('more').textContent = 'Ver actividad anterior';
    }
  }
  get('more').onclick = load;
  get('signOut').onclick = () => location.replace('user-access.html#salir');
  load();
})();
