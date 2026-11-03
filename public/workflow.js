'use strict';
(() => {
  const requested = new URLSearchParams(location.search).get('flow');
  // Every public entry uses the complete enrollment flow; there is no silent local-only mode.
  let mode = requested === 'verify' ? 'verify' : 'register';
  const newRequestId = () =>
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
  let profile = null,
    targetId = null,
    updateId = null,
    requestId = newRequestId();
  let submitting = false,
    initialized = false,
    pauseUntil = 0,
    saved = false,
    completed = false,
    preparation = null;
  const $w = (id) => document.getElementById(id);
  async function api(action, data) {
    const response = await fetch('/api/lab?action=' + action, {
      method: data ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: data ? { 'Content-Type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'No se pudo completar la operación.');
      Object.assign(error, result);
      throw error;
    }
    return result;
  }
  const section = document.createElement('section');
  section.className = 'workflow-top';
  section.innerHTML =
    '<strong id="workflowTitle"></strong><p id="workflowStatus" role="status">Comprobando la sesión…</p><a href="/portal.html">Inicio y sesiones QR</a>';
  document.querySelector('.workspace').before(section);
  const notice = (message) => {
    $w('workflowStatus').textContent = message;
  };
  function modeUI() {
    $w('workflowTitle').textContent =
      '1. Foto de registro → 2. Foto NUEVA → 3. Resultado';
    $w('captureHere').hidden = !!targetId || mode === 'verify';
    $w('compareHere').hidden = !targetId || completed;
    $w('repeatComparison').hidden = !completed;
    $w('registerStep').hidden = false;
    $w('compareStep').hidden = false;
    $w('inspection').hidden = true;
  }
  const time = (value) =>
    new Date(value || Date.now()).toLocaleTimeString('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  function imageEvidence(prefix, src, label) {
    $w(prefix + 'ProofImage').onerror = () => {
      $w(prefix + 'ProofImage').hidden = true;
      $w(prefix + 'ProofPlaceholder').hidden = false;
      $w(prefix + 'ProofPlaceholder').textContent =
        'No se pudo mostrar la miniatura. El resultado se conserva.';
    };
    $w(prefix + 'ProofImage').src = src;
    $w(prefix + 'ProofImage').hidden = false;
    $w(prefix + 'ProofPlaceholder').hidden = true;
    $w(prefix + 'ProofTime').textContent = label;
  }
  function clearComparisonEvidence() {
    $w('comparisonProofImage').src = '';
    $w('comparisonProofImage').hidden = true;
    $w('comparisonProofPlaceholder').hidden = false;
    $w('comparisonProofTime').textContent =
      'Pendiente: todavía no se ha tomado la foto 2';
    $w('personData').replaceChildren();
    $w('personData').hidden = true;
  }
  modeUI();
  $w('threshold').disabled = true;
  $w('includeNetwork').checked = true;
  $w('reset').textContent = 'Limpiar esta pantalla';
  $w('clearMemory').textContent = 'Limpiar esta pantalla';
  const dialog = document.createElement('dialog');
  dialog.id = 'registrationDialog';
  dialog.className = 'profile-form';
  dialog.innerHTML =
    '<form id="identityForm"><h2 id="identityTitle"></h2><p id="identityInstruction"></p><img id="registrationPreview" class="registration-preview" alt="Tu foto de referencia aceptada" hidden /><fieldset id="identityFields"><div class="form-grid"><label>Nombre<input name="firstName" autocomplete="given-name" maxlength="180" required /></label><label>Segundo nombre (opcional)<input name="middleName" autocomplete="additional-name" maxlength="180" /></label></div><label>Apellidos<input name="lastName" autocomplete="family-name" maxlength="180" required /></label><label>Fecha de nacimiento<input name="birthDate" type="date" min="1900-01-01" required /></label><label>Dirección de residencia<input name="address" autocomplete="street-address" maxlength="180" required /></label></fieldset><div class="form-grid"><label>Tipo de documento<select name="documentType"><option value="CC">Cédula de ciudadanía</option><option value="CE">Cédula de extranjería</option><option value="TI">Tarjeta de identidad</option><option value="PAS">Pasaporte</option></select></label><label>Número de documento<input name="documentNumber" maxlength="24" required /></label></div><label id="recordConsentLabel" class="consent"><input name="consent" type="checkbox" required /> Autorizo guardar mis datos, una foto de referencia, su plantilla facial y eventos con IP para esta demo. Puedo solicitar su eliminación. Mis datos son declarados, no verificados contra un documento.</label><label id="updateRecordLabel" class="consent" hidden><input name="updateRecord" type="checkbox" /> Actualizar mi registro (requiere autorización administrativa).</label><p id="identityError" class="error-text" role="alert"></p><div class="button-row"><button id="identitySubmit" class="primary" type="submit"></button><button id="identityCancel" class="secondary" type="button">Cancelar</button></div></form>';
  document.body.append(dialog);
  const form = $w('identityForm');
  form.elements.birthDate.max = new Date().toISOString().slice(0, 10);
  function askForm(verify = false) {
    $w('identityFields').hidden = verify;
    $w('identityFields').disabled = verify;
    $w('recordConsentLabel').hidden = verify;
    form.elements.consent.required = !verify;
    $w('identityTitle').textContent = verify
      ? 'Busca tu registro'
      : 'Foto aceptada ✓ Completa tus datos';
    $w('identityInstruction').textContent = verify
      ? 'Indica tu documento y después toma una foto nueva. Tus datos aparecerán si coincide.'
      : 'Ya no necesitas otra toma para registrarte. Confirma estos datos para guardar tu única foto de referencia.';
    $w('identitySubmit').textContent = verify
      ? 'Continuar a la cámara'
      : 'Confirmar y guardar mi registro';
    $w('updateRecordLabel').hidden = verify;
    if (profile)
      for (const [k, v] of Object.entries(profile))
        if (form.elements[k] && typeof v === 'string') form.elements[k].value = v;
    $w('identityError').textContent = '';
    dialog.showModal();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => {
        if (settled || submitting) return;
        settled = true;
        dialog.close();
        reject(new Error('Registro cancelado. La foto temporal se descarta.'));
      };
      $w('identityCancel').onclick = cancel;
      dialog.oncancel = (e) => {
        e.preventDefault();
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
                throw new Error('El administrador debe autorizar la actualización.');
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
  function displayPerson(person) {
    const box = $w('personData');
    box.replaceChildren();
    box.hidden = false;
    for (const [label, value] of [
      [
        'Persona registrada',
        [person.firstName, person.middleName, person.lastName].filter(Boolean).join(' '),
      ],
      ['Documento', person.documentType + ' ' + person.documentNumber],
      ['Nacimiento', person.birthDate],
      ['Dirección', person.address],
    ]) {
      const p = document.createElement('p'),
        strong = document.createElement('strong');
      strong.textContent = label + ': ';
      p.append(strong, document.createTextNode(value));
      box.append(p);
    }
  }
  window.IdentityWorkflow = {
    mode,
    ready: () => initialized && !completed && Date.now() >= pauseUntil,
    canCompare: () => !!targetId && initialized && !completed && Date.now() >= pauseUntil,
    completed: () => completed,
    async prepareVerification() {
      if (preparation) {
        await api(
          preparation === 'begin' ? 'begin-verification' : 'repeat-verification',
          { id: targetId },
        );
        preparation = null;
      }
      mode = 'verify';
      window.IdentityWorkflow.mode = mode;
      modeUI();
      notice(
        'Ahora tomaremos la FOTO 2, una captura NUEVA, y la compararemos con tu registro.',
      );
    },
    async afterFirstSample(sample) {
      requestId = newRequestId();
      $w('registrationPreview').src = sample.image;
      $w('registrationPreview').hidden = false;
      await askForm(false);
      notice('Guardando tu foto y tus datos…');
    },
    async save(samples) {
      if (!profile) throw new Error('Completa los datos antes de guardar.');
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
      saved = true;
      preparation = 'begin';
      completed = false;
      modeUI();
      imageEvidence(
        'reference',
        samples[0].image,
        'Capturada: ' + time(samples[0].capturedAt),
      );
      clearComparisonEvidence();
      $w('proofStatus').textContent =
        'Solo está tomada la FOTO 1. Falta tomar la FOTO 2 para comprobar el reconocimiento.';
      notice(
        result.cleanupPending
          ? 'Registro guardado. Hay archivos anteriores pendientes de limpieza; contacta al administrador.'
          : '✓ FOTO 1 guardada con tus datos. Pulsa «2. Tomar FOTO NUEVA y comparar» debajo de la cámara. Todavía no se ha comparado.',
      );
      return result;
    },
    async verify(sample, isCurrent = () => true) {
      if (!targetId) throw new Error('Selecciona primero tu registro.');
      $w('personData').hidden = true;
      imageEvidence(
        'comparison',
        sample.image,
        'Capturada AHORA: ' + time(sample.capturedAt),
      );
      $w('proofStatus').textContent =
        'La FOTO 2 acaba de tomarse. Comparando con la FOTO 1 registrada…';
      const result = await api('verify', {
        id: targetId,
        descriptor: Array.from(sample.descriptor),
        requestId: newRequestId(),
      });
      preparation = 'repeat';
      if (!isCurrent()) return result;
      if (result.evidence?.referenceUrl)
        imageEvidence(
          'reference',
          result.evidence.referenceUrl,
          'Registro guardado: ' + time(result.evidence.referenceSavedAt),
        );
      completed = true;
      initialized = false;
      modeUI();
      $w('proofStatus').textContent =
        'COMPARACIÓN TERMINADA: se usó la FOTO 1 de registro y la FOTO 2 nueva de las ' +
        time(sample.capturedAt) +
        '. No se tomó ninguna otra foto.';
      pauseUntil = result.retryAt || 0;
      if (result.match) {
        displayPerson(result.profile);
        notice(
          '✓ Se compararon las dos fotos. Tu rostro coincide con el registro. La cámara se apagará.',
        );
        initialized = false;
      } else
        notice(
          'No se confirmó la coincidencia. Intentos restantes: ' +
            result.remaining +
            (pauseUntil
              ? '. Pausa hasta ' + new Date(pauseUntil).toLocaleString('es-CO')
              : '. Puedes volver a intentarlo.'),
        );
      return result;
    },
    onError(e) {
      pauseUntil = e.retryAt || 0;
      notice(
        e.message +
          (pauseUntil
            ? ' Pausa hasta ' + new Date(pauseUntil).toLocaleString('es-CO')
            : ''),
      );
    },
    reset() {
      $w('personData').replaceChildren();
      $w('personData').hidden = true;
      clearComparisonEvidence();
      $w('registrationPreview').src = '';
      $w('registrationPreview').hidden = true;
      $w('referenceProofImage').src = '';
      $w('referenceProofImage').hidden = true;
      $w('referenceProofPlaceholder').hidden = false;
      $w('referenceProofTime').textContent = targetId
        ? 'Registro existente; referencia protegida'
        : 'Pendiente';
      $w('proofStatus').textContent =
        'Miniaturas de esta sesión borradas. El registro persistente se conserva.';
      completed = false;
      initialized = true;
      modeUI();
      requestId = newRequestId();
    },
  };
  $w('repeatComparison').onclick = async () => {
    $w('repeatComparison').disabled = true;
    try {
      await api('repeat-verification', { id: targetId });
      preparation = null;
      clearComparisonEvidence();
      completed = false;
      initialized = true;
      mode = 'verify';
      window.IdentityWorkflow.mode = mode;
      modeUI();
      notice(
        'Nueva comparación preparada. Activa la cámara y toma una FOTO NUEVA. El registro no cambia.',
      );
      $w('proofStatus').textContent =
        'La foto anterior de comparación fue borrada. Falta una FOTO 2 nueva.';
      window.CaptureUI?.prepareNewComparison();
    } catch (e) {
      window.IdentityWorkflow.onError(e);
    } finally {
      $w('repeatComparison').disabled = false;
    }
  };
  (async () => {
    try {
      const ctx = await api('context');
      if (new URLSearchParams(location.search).has('paired') && !ctx.session)
        throw new Error('El QR venció o finalizó. Vuelve al inicio y genera otro.');
      if (ctx.session && ctx.session.mode !== mode)
        throw new Error('Este QR corresponde a otro paso. Vuelve al inicio.');
      $w('threshold').value = ctx.rules.threshold;
      $w('thresholdValue').value = ctx.rules.threshold.toFixed(2);
      if (mode === 'verify') {
        await askForm(true);
        $w('referenceProofPlaceholder').textContent =
          'Referencia guardada: se mostrará después de una coincidencia.';
        $w('referenceProofTime').textContent =
          'Registro existente; se mostrará después de una coincidencia.';
      }
      initialized = true;
      modeUI();
      notice(
        mode === 'register'
          ? 'Activa la cámara y toma UNA foto. Al aceptarla se abrirá el formulario de datos.'
          : 'Registro seleccionado. Activa la cámara y toma una foto nueva.',
      );
    } catch (e) {
      notice(e.message);
    }
  })();
})();
