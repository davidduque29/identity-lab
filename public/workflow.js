'use strict';
(() => {
  const mode = new URLSearchParams(location.search).get('flow');
  if (!['register', 'verify'].includes(mode)) return;
  let profile = null,
    targetId = null,
    updateId = null,
    requestId = crypto.randomUUID(),
    submitting = false,
    initialized = false;
  const $w = (id) => document.getElementById(id);
  const api = async (action, data) => {
    const response = await fetch('/api/lab?action=' + action, {
      method: data ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: data ? { 'Content-Type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    const result = await response.json();
    if (!response.ok) {
      const e = new Error(result.error || 'No se pudo completar la operación.');
      Object.assign(e, result);
      throw e;
    }
    return result;
  };
  const section = document.createElement('section');
  section.className = 'workflow-top';
  section.innerHTML =
    '<strong id="workflowTitle"></strong><p id="workflowStatus" role="status">Comprobando la sesión…</p><a href="/portal.html">Volver al inicio</a><div id="personData" class="registered-data" hidden></div>';
  document.querySelector('.workspace').before(section);
  const title =
    mode === 'register'
      ? 'Registro persistente · 3 fotos'
      : 'Verificación · 1 foto nueva';
  $w('workflowTitle').textContent = title;
  $w('threshold').disabled = true;
  $w('includeNetwork').checked = true;
  $w('reset').textContent = 'Limpiar capturas locales (no elimina el registro guardado)';
  $w('clearMemory').textContent = 'Limpiar capturas locales';
  document.querySelector('.memory-footer p').textContent =
    'Esta vista muestra las capturas locales. Limpiarlas no elimina las referencias guardadas en el servidor. Las fotos de comparación se descartan al terminar.';
  if (mode === 'verify') $w('inspection').hidden = true;
  const dialog = document.createElement('dialog');
  dialog.id = 'registrationDialog';
  dialog.className = 'profile-form';
  dialog.innerHTML =
    '<form id="identityForm"><h2 id="identityTitle"></h2><p id="identityInstruction"></p><fieldset id="identityFields"><div class="form-grid"><label>Nombre<input name="firstName" autocomplete="given-name" maxlength="180" required /></label><label>Segundo nombre (opcional)<input name="middleName" autocomplete="additional-name" maxlength="180" /></label></div><label>Apellidos<input name="lastName" autocomplete="family-name" maxlength="180" required /></label><label>Fecha de nacimiento<input name="birthDate" type="date" min="1900-01-01" required /></label><label>Dirección de residencia<input name="address" autocomplete="street-address" maxlength="180" required /></label></fieldset><div class="form-grid"><label>Tipo de documento<select name="documentType"><option value="CC">Cédula de ciudadanía</option><option value="CE">Cédula de extranjería</option><option value="TI">Tarjeta de identidad</option><option value="PAS">Pasaporte</option></select></label><label>Número de documento<input name="documentNumber" maxlength="24" required /></label></div><label id="recordConsentLabel" class="consent"><input name="consent" type="checkbox" required /> Autorizo guardar mis datos, tres fotos de referencia, vectores faciales y eventos con IP para esta demo. Puedo solicitar su eliminación. Los datos son declarados, no verificados contra un documento.</label><label id="updateRecordLabel" class="consent" hidden><input name="updateRecord" type="checkbox" /> Actualizar mis referencias (requiere autorización administrativa previa).</label><p id="identityError" class="error-text" role="alert"></p><div class="button-row"><button id="identitySubmit" class="primary" type="submit"></button><button id="identityCancel" class="secondary" type="button">Cancelar</button></div></form>';
  document.body.append(dialog);
  const form = $w('identityForm');
  form.elements.birthDate.max = new Date().toISOString().slice(0, 10);
  function notice(message) {
    $w('workflowStatus').textContent = message;
  }
  function displayPerson(person) {
    const box = $w('personData');
    box.replaceChildren();
    box.hidden = false;
    const h = document.createElement('h3');
    h.textContent = 'Coincidencia con el registro';
    box.append(h);
    for (const [label, value] of [
      [
        'Nombre',
        [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' '),
      ],
      ['Documento', person.documentType + ' ' + person.documentNumber],
      ['Nacimiento', person.birthDate],
      ['Dirección', person.address],
    ]) {
      const p = document.createElement('p');
      p.textContent = label + ': ' + value;
      box.append(p);
    }
  }
  function askForm(verify = false) {
    $w('identityFields').hidden = verify;
    $w('identityFields').disabled = verify;
    $w('recordConsentLabel').hidden = verify;
    form.elements.consent.required = !verify;
    $w('identityTitle').textContent = verify
      ? 'Busca tu registro'
      : 'Primera foto aceptada ✓';
    $w('identityInstruction').textContent = verify
      ? 'Indica tu documento. Los datos personales se mostrarán después de una coincidencia.'
      : 'Completa tus datos. Después, vuelve a mirar a la cámara para tomar las otras dos referencias.';
    $w('identitySubmit').textContent = verify
      ? 'Continuar a la cámara'
      : 'Confirmar datos y continuar';
    $w('updateRecordLabel').hidden = verify;
    if (profile)
      for (const [k, v] of Object.entries(profile)) {
        if (form.elements[k] && typeof v === 'string') form.elements[k].value = v;
      }
    $w('identityError').textContent = '';
    dialog.showModal();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => {
        if (settled) return;
        settled = true;
        dialog.close();
        reject(new Error('Proceso cancelado. No se guardaron datos nuevos.'));
      };
      $w('identityCancel').onclick = cancel;
      dialog.oncancel = (event) => {
        event.preventDefault();
        cancel();
      };
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (submitting) return;
        submitting = true;
        $w('identitySubmit').disabled = true;
        try {
          const values = Object.fromEntries(new FormData(form));
          if (verify) {
            const record = await api('lookup', {
              documentType: values.documentType,
              documentNumber: values.documentNumber,
            });
            targetId = record.id;
          } else {
            values.consent = form.elements.consent.checked;
            if (form.elements.updateRecord.checked) {
              const record = await api('lookup', {
                documentType: values.documentType,
                documentNumber: values.documentNumber,
              });
              if (!record.updateAllowed)
                throw new Error(
                  'El administrador debe autorizar la actualización de referencias.',
                );
              updateId = record.id;
            } else updateId = null;
            profile = values;
          }
          settled = true;
          dialog.close();
          resolve();
        } catch (e) {
          $w('identityError').textContent =
            e.message +
            (e.retryAt
              ? ' Disponible: ' + new Date(e.retryAt).toLocaleString('es-CO')
              : '');
        } finally {
          submitting = false;
          $w('identitySubmit').disabled = false;
        }
      };
    });
  }
  window.IdentityWorkflow = {
    mode,
    ready: () => initialized,
    async afterFirstSample() {
      if (mode !== 'register') return;
      await askForm(false);
      notice('Datos preparados. Mira de nuevo a la cámara; faltan dos fotos.');
    },
    async save(samples) {
      if (mode !== 'register' || !profile)
        throw new Error('Completa los datos antes de guardar.');
      notice('Guardando el registro y las tres referencias…');
      const result = await api('register', {
        requestId,
        profile,
        updateId,
        samples: samples.map((s) => ({
          image: s.image,
          descriptor: Array.from(s.descriptor),
        })),
      });
      targetId = result.id;
      if (result.cleanupPending) {
        notice(
          'Registro guardado. Quedó pendiente eliminar archivos de la revisión anterior; contacta al administrador.',
        );
        return result;
      }
      notice(
        '✓ Registro guardado. Tres fotos persistentes. Para comparar, vuelve al inicio y elige «Verificar mi rostro».',
      );
      return result;
    },
    async verify(sample, isCurrent = () => true) {
      if (!targetId) throw new Error('Primero selecciona tu registro.');
      $w('personData').hidden = true;
      const result = await api('verify', {
        id: targetId,
        descriptor: Array.from(sample.descriptor),
        requestId: crypto.randomUUID(),
      });
      if (!isCurrent()) return result;
      if (result.match) {
        displayPerson(result.profile);
        notice(
          '✓ Coincidencia. La foto de comparación fue descartada. Sesión completada.',
        );
        initialized = false;
      } else
        notice(
          'Sin coincidencia. Intentos restantes: ' +
            result.remaining +
            (result.retryAt
              ? '. Pausa hasta ' + new Date(result.retryAt).toLocaleString('es-CO')
              : ''),
        );
      return result;
    },
    onError(e) {
      notice(
        e.message +
          (e.retryAt
            ? ' Pausa hasta ' + new Date(e.retryAt).toLocaleString('es-CO')
            : ''),
      );
    },
    reset() {
      $w('personData').replaceChildren();
      $w('personData').hidden = true;
      requestId = crypto.randomUUID();
    },
  };
  (async () => {
    try {
      const ctx = await api('context');
      if (new URLSearchParams(location.search).has('paired') && !ctx.session)
        throw new Error(
          'La sesión QR venció o finalizó. Vuelve al inicio y genera otra.',
        );
      if (ctx.session && ctx.session.mode !== mode)
        throw new Error('El modo no corresponde a la sesión QR. Vuelve al inicio.');
      $w('threshold').value = ctx.rules.threshold;
      $w('thresholdValue').value = ctx.rules.threshold.toFixed(2);
      if (mode === 'verify') await askForm(true);
      initialized = true;
      notice(
        mode === 'register'
          ? 'Acepta el consentimiento y activa la cámara. La primera foto aceptada abrirá el formulario.'
          : 'Registro seleccionado. Activa la cámara y espera el contorno verde para tomar UNA foto nueva.',
      );
    } catch (e) {
      notice(e.message);
    }
  })();
})();
