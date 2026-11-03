'use strict';
const $ = (id) => document.getElementById(id);
let stream = null,
  references = [],
  attempts = [],
  selectedAttempt = null;
let busy = false,
  generation = 0,
  loaded = false,
  modelPromise = null,
  attemptNumber = 0;
let monitorTimer = null,
  monitorEpoch = 0,
  visionTask = null;
let captureReady = false,
  stableFrames = 0,
  lastAssessmentAt = 0,
  lastBox = null;
let autoCaptureMode = null,
  autoCapturePending = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serialize inference so live guidance never overlaps a capture.
async function withVision(task) {
  while (visionTask) await visionTask.catch(() => {});
  const current = Promise.resolve().then(task);
  visionTask = current;
  try {
    return await current;
  } finally {
    if (visionTask === current) visionTask = null;
  }
}

function measureFace(canvas, found) {
  if (found.length !== 1) return { faces: found.length };
  const face = found[0],
    box = face.detection.box;
  const center = (points) => ({
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  });
  const left = center(face.landmarks.getLeftEye()),
    right = center(face.landmarks.getRightEye());
  const nosePoints = face.landmarks.getNose(),
    nose = nosePoints[3];
  const eyeDistance = Math.hypot(right.x - left.x, right.y - left.y);
  const roll = (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI;
  const midpoint = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const yaw = Math.abs(
    ((nose.x - midpoint.x) * (right.x - left.x) +
      (nose.y - midpoint.y) * (right.y - left.y)) /
      (eyeDistance * eyeDistance),
  );
  const x = Math.max(0, Math.floor(box.x)),
    y = Math.max(0, Math.floor(box.y));
  const width = Math.max(1, Math.min(canvas.width - x, Math.floor(box.width)));
  const height = Math.max(1, Math.min(canvas.height - y, Math.floor(box.height)));
  const pixels = canvas.getContext('2d').getImageData(x, y, width, height).data;
  let light = 0,
    count = 0;
  for (let i = 0; i < pixels.length; i += 64) {
    light += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    count++;
  }
  return {
    faces: 1,
    box: {
      x: box.x / canvas.width,
      y: box.y / canvas.height,
      width: box.width / canvas.width,
      height: box.height / canvas.height,
    },
    roll,
    yaw,
    brightness: light / count,
  };
}

function cameraFrame() {
  const video = $('video');
  if (!stream || video.readyState < 2 || !video.videoWidth)
    throw new Error('La cámara todavía no está lista. Espera un momento.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas;
}

function networkLabel(context) {
  if (context?.status === 'observed' && context.ip)
    return (context.ip.includes(':') ? 'IPv6: ' : 'IPv4: ') + context.ip;
  if (context?.status === 'disabled') return 'No incluida';
  if (context?.status === 'proxy')
    return 'No disponible: el servidor observa un intermediario';
  if (context?.status === 'local') return 'No disponible en conexión local';
  return 'No disponible';
}
async function readNetworkContext() {
  if (!$('includeNetwork').checked) return { status: 'disabled', ip: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await (window.IdentityTransport?.fetch || fetch)(
      '/api/network-context',
      {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      },
    );
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json')
    )
      throw new Error('Context unavailable');
    const data = await response.json();
    return {
      status: data.status,
      ip: typeof data.ip === 'string' ? data.ip.slice(0, 45) : null,
      observedAt: data.observedAt,
    };
  } catch {
    return { status: 'unavailable', ip: null };
  } finally {
    clearTimeout(timer);
  }
}
function renderNetworkContext(context) {
  $('networkStatus').textContent = 'IP observada: ' + networkLabel(context);
}
function showCaptureProgress(states, message, retry = false) {
  const list = $('captureProgress');
  list.replaceChildren();
  states.forEach((state, i) => {
    const labels = {
      pending: 'pendiente',
      taking: 'capturando…',
      taken: 'tomada ✓',
      retry: 'repetir',
      cancelled: 'descartada: registro incompleto',
    };
    const item = el('li', '', 'Foto ' + (i + 1) + ': ' + labels[state]);
    item.setAttribute('data-state', state);
    list.append(item);
  });
  $('captureOutcome').textContent = message;
  $('retryCapture').hidden = !retry;
}
const adapter = {
  name: 'face-api.js / FaceRecognitionNet',
  async load() {
    if (loaded) return;
    if (!window.faceapi)
      throw new Error('No se pudo cargar el motor. Recarga la página.');
    if (!modelPromise)
      modelPromise = Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('./models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('./models'),
      ])
        .then(() => {
          loaded = true;
        })
        .catch((e) => {
          modelPromise = null;
          throw e;
        });
    await modelPromise;
  },
  async assess() {
    return withVision(async () => {
      const canvas = cameraFrame();
      try {
        const found = await faceapi
          .detectAllFaces(
            canvas,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.6 }),
          )
          .withFaceLandmarks();
        const measurement = measureFace(canvas, found);
        return { ...CaptureQuality.evaluate(measurement), box: measurement.box };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    });
  },
  async capture() {
    return withVision(async () => {
      const canvas = cameraFrame(),
        capturedAt = new Date();
      try {
        const found = await faceapi
          .detectAllFaces(
            canvas,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.6 }),
          )
          .withFaceLandmarks()
          .withFaceDescriptors();
        const measurement = measureFace(canvas, found),
          assessment = CaptureQuality.evaluate(measurement);
        if (!assessment.ready)
          throw new Error(assessment.message + ' No se guardó esta toma.');
        return {
          descriptor: found[0].descriptor,
          image: canvas.toDataURL('image/jpeg', 0.85),
          capturedAt,
          box: measurement.box,
          network: await readNetworkContext(),
        };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    });
  },
  distance(a, b) {
    return faceapi.euclideanDistance(a, b);
  },
};
function setGuidance(message, state = 'waiting') {
  $('alignmentGuide').setAttribute('data-state', state);
  $('alignmentHint').setAttribute('data-state', state);
  $('alignmentHint').textContent = message;
  $('cameraPrompt').textContent = message;
  $('alignmentLabel').textContent =
    state === 'ready'
      ? '✓ Listo para capturar'
      : state === 'complete'
        ? '✓ Comparación finalizada'
        : state === 'capturing'
          ? 'Captura en curso'
          : 'Ajusta tu encuadre';
}
function updateStage() {
  if (window.IdentityWorkflow?.completed?.()) {
    $('captureStage').textContent = 'PASO 3 · COMPARACIÓN FINALIZADA';
    return;
  }
  const hasReference = window.IdentityWorkflow
    ? window.IdentityWorkflow.mode === 'verify' ||
      !!window.IdentityWorkflow.canCompare?.()
    : !!references.length;
  $('captureStage').textContent = hasReference
    ? 'PASO 2 · FOTO NUEVA DE COMPARACIÓN'
    : 'PASO 1 · UNA FOTO DE REFERENCIA';
  $('registerStep').setAttribute('data-active', String(!hasReference));
  $('compareStep').setAttribute('data-active', String(hasReference));
}
function pauseMonitor() {
  monitorEpoch++;
  clearTimeout(monitorTimer);
  monitorTimer = null;
}
function boxMoved(a, b) {
  return !!(
    a &&
    b &&
    (Math.abs(a.x - b.x) > 0.035 ||
      Math.abs(a.y - b.y) > 0.035 ||
      Math.abs(a.width - b.width) > 0.04)
  );
}
async function triggerAutomaticCapture() {
  if (
    !autoCaptureMode ||
    autoCapturePending ||
    busy ||
    !captureReady ||
    !window.IdentityWorkflow?.ready()
  )
    return;
  autoCapturePending = true;
  try {
    if (autoCaptureMode === 'reference') await enroll();
    else await verifyPersistent();
  } finally {
    autoCapturePending = false;
    controls();
  }
}
function resumeMonitor() {
  pauseMonitor();
  if (!stream || busy) return;
  const epoch = monitorEpoch,
    token = generation;
  async function tick() {
    if (token !== generation || epoch !== monitorEpoch || !stream || busy) return;
    try {
      const assessment = await adapter.assess();
      if (token !== generation || epoch !== monitorEpoch || !stream || busy) return;
      const b = assessment.box;
      const moved = boxMoved(b, lastBox);
      stableFrames = assessment.ready && !moved ? stableFrames + 1 : 0;
      lastBox = b ? { ...b } : null;
      lastAssessmentAt = Date.now();
      captureReady = assessment.ready && stableFrames >= 3;
      setGuidance(
        captureReady
          ? autoCaptureMode
            ? 'No te muevas. La foto se tomará automáticamente.'
            : 'Encuadre adecuado. Selecciona el siguiente paso para continuar.'
          : assessment.ready
            ? 'Bien colocado. Mantente quieto un momento…'
            : assessment.message,
        captureReady ? 'ready' : 'waiting',
      );
      controls();
      if (captureReady && autoCaptureMode) await triggerAutomaticCapture();
    } catch (e) {
      if (token !== generation || epoch !== monitorEpoch || busy) return;
      captureReady = false;
      stableFrames = 0;
      lastBox = null;
      setGuidance('No pude evaluar el encuadre. ' + e.message);
      controls();
    }
    if (token === generation && epoch === monitorEpoch && stream && !busy)
      monitorTimer = setTimeout(tick, 350);
  }
  monitorTimer = setTimeout(tick, 0);
}
async function prepareCapture(kind, token) {
  if (!captureReady || Date.now() - lastAssessmentAt > 2500) {
    status('Espera a que el contorno esté verde antes de capturar.');
    return false;
  }
  pauseMonitor();
  busy = true;
  $('captureFeedback').hidden = true;
  controls();
  $('captureStage').textContent =
    kind === 'reference'
      ? 'PASO 1 · PREPARANDO UNA REFERENCIA'
      : 'PASO 2 · PREPARANDO UNA FOTO NUEVA';
  const anchor = lastBox ? { ...lastBox } : null;
  try {
    setGuidance(
      'No te muevas. La ' +
        (kind === 'reference' ? 'FOTO 1 de registro' : 'FOTO 2 de comparación') +
        ' se tomará automáticamente.',
      'capturing',
    );
    status('No te muevas: enseguida comienza la cuenta regresiva.');
    await wait(800);
    if (token !== generation) return false;
    for (let number = 3; number >= 1; number--) {
      const assessment = await adapter.assess();
      if (token !== generation) return false;
      if (!assessment.ready || boxMoved(anchor, assessment.box))
        throw new Error(
          (assessment.ready ? 'Detecté movimiento.' : assessment.message) +
            ' Cuenta regresiva cancelada. Vuelve a centrarte y se reiniciará automáticamente.',
        );
      $('countdown').hidden = false;
      $('countdown').textContent = String(number);
      setGuidance(
        (kind === 'reference'
          ? 'Registro: tomaremos una foto de referencia'
          : 'Comparación: tomaremos 1 foto NUEVA') +
          ' en ' +
          number +
          '… Mantente quieto.',
        'capturing',
      );
      status(
        kind === 'reference'
          ? 'Cuenta regresiva para registrar tu foto de referencia.'
          : 'Cuenta regresiva para una NUEVA captura de comparación.',
      );
      await wait(1000);
      if (token !== generation) return false;
    }
    return true;
  } catch (e) {
    if (token === generation) {
      status(e.message);
      setGuidance(e.message);
    }
    return false;
  } finally {
    $('countdown').hidden = true;
  }
}
function captureFlash(message) {
  $('captureFeedback').textContent = message;
  $('captureFeedback').hidden = false;
}
function finishCapture(token) {
  if (token !== generation) return;
  busy = false;
  captureReady = false;
  stableFrames = 0;
  lastBox = null;
  $('countdown').hidden = true;
  updateStage();
  controls();
  resumeMonitor();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function timeLabel(date) {
  return (
    date.toLocaleTimeString('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) +
    '.' +
    String(date.getMilliseconds()).padStart(3, '0')
  );
}
function disposeSample(sample) {
  if (sample) {
    sample.descriptor.fill(0);
    sample.image = '';
    if (sample.network) sample.network = null;
  }
}
function clearAttempts() {
  closePhoto();
  attempts.forEach((a) => disposeSample(a.sample));
  attempts = [];
  selectedAttempt = null;
  attemptNumber = 0;
}
function closePhoto() {
  const dialog = $('photoDialog');
  if (dialog.open) dialog.close();
  $('photoDetail').replaceChildren();
}
function photoPreview(sample, title) {
  const frame = el('div', 'sample-frame');
  const image = el('img');
  image.src = sample.image;
  image.alt = title;
  image.width = 640;
  image.height = 480;
  const box = el('span', 'detected-box');
  box.setAttribute('aria-hidden', 'true');
  for (const [key, value] of Object.entries({
    left: sample.box.x,
    top: sample.box.y,
    width: sample.box.width,
    height: sample.box.height,
  }))
    box.style[key] = value * 100 + '%';
  frame.append(image, box);
  return frame;
}
function openPhoto(sample, title) {
  $('photoTitle').textContent = title;
  const details = $('photoDetail');
  details.replaceChildren(
    photoPreview(sample, title),
    el(
      'p',
      'muted',
      'Capturada a las ' +
        timeLabel(sample.capturedAt) +
        '. El recuadro indica el rostro detectado. Imagen sin efecto espejo.',
    ),
  );
  details.append(
    el(
      'p',
      'network-detail',
      'IP observada en esta toma: ' + networkLabel(sample.network),
    ),
  );
  if (sample.network?.observedAt)
    details.append(
      el('p', 'muted', 'Consulta de conexión: ' + sample.network.observedAt),
    );
  const vector = el('details', 'vector-details');
  vector.append(el('summary', '', 'Inspeccionar los 128 valores del vector facial'));
  vector.append(
    el(
      'pre',
      '',
      Array.from(sample.descriptor, (v, i) => i + 1 + ': ' + v.toFixed(6)).join('\n'),
    ),
  );
  details.append(vector);
  $('photoDialog').showModal();
}
function sampleCard(sample, title) {
  const card = el('figure', 'sample-card');
  const button = el('button', 'photo-button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Ampliar ' + title);
  button.append(photoPreview(sample, title));
  button.addEventListener('click', () => openPhoto(sample, title));
  const caption = el('figcaption');
  caption.append(
    el('strong', '', title),
    el('span', '', timeLabel(sample.capturedAt)),
    el('span', '', 'IP: ' + networkLabel(sample.network)),
    el('small', '', 'Ampliar foto y ver vector ↗'),
  );
  card.append(button, caption);
  return card;
}
function renderInspection() {
  const gallery = $('referenceGallery');
  gallery.replaceChildren();
  if (!references.length)
    gallery.append(
      el(
        'p',
        'gallery-empty',
        'Al registrar tu rostro aparecerán aquí la foto exacta utilizada como referencia.',
      ),
    );
  references.forEach((sample, i) =>
    gallery.append(sampleCard(sample, 'Referencia ' + (i + 1))),
  );
  $('memoryCount').textContent =
    references.length + ' referencias · ' + attempts.length + '/5 intentos';
  const comparison = $('comparisonDetail');
  comparison.replaceChildren();
  const a = selectedAttempt;
  if (!a)
    comparison.append(
      el(
        'p',
        'gallery-empty',
        'Pulsa el botón 2 para tomar una foto NUEVA y ver su comparación completa.',
      ),
    );
  else {
    comparison.append(sampleCard(a.sample, 'Captura del intento ' + a.number));
    const calculation = el('div', 'calculation');
    calculation.append(el('h3', '', 'Esta captura frente a tu referencia'));
    const table = el('table', 'distance-table');
    const head = el('thead'),
      tr = el('tr');
    tr.append(el('th', '', 'Comparación'), el('th', '', 'Distancia'));
    head.append(tr);
    table.append(head);
    const body = el('tbody');
    a.distances.forEach((d, i) => {
      const row = el('tr');
      row.append(
        el('td', '', 'Captura ↔ referencia ' + (i + 1)),
        el('td', '', d.toFixed(6)),
      );
      body.append(row);
    });
    table.append(body);
    calculation.append(table);
    calculation.append(
      el(
        'p',
        'formula',
        '(' +
          a.distances.map((d) => d.toFixed(6)).join(' + ') +
          ') / ' +
          a.distances.length +
          ' = ' +
          a.mean.toFixed(6),
      ),
    );
    calculation.append(
      el(
        'p',
        'decision ' + (a.match ? 'yes' : 'no'),
        a.mean.toFixed(6) +
          (a.match ? ' ≤ ' : ' > ') +
          a.threshold.toFixed(2) +
          ' → ' +
          (a.match ? 'Coincidencia' : 'Sin coincidencia'),
      ),
    );
    calculation.append(
      el(
        'p',
        'muted',
        'Decisión calculada con valores completos; cifras mostradas redondeadas. Se comparan vectores de 128 números, no los píxeles de las fotos. El umbral mostrado es el usado en este intento.',
      ),
    );
    const referenceIPs = references.map((ref) => ref.network?.ip).filter(Boolean);
    if (a.sample.network?.ip && referenceIPs.some((ip) => ip !== a.sample.network.ip)) {
      calculation.append(
        el(
          'p',
          'network-change',
          'La IP observada cambió respecto al registro. Puede ocurrir al cambiar de red o usar VPN; no demuestra suplantación.',
        ),
      );
    }
    comparison.append(calculation);
  }
  const history = $('attemptHistory');
  history.replaceChildren();
  for (const attempt of attempts) {
    const button = el(
      'button',
      'attempt-chip' + (attempt === a ? ' selected' : ''),
      'Intento ' +
        attempt.number +
        ' · ' +
        attempt.mean.toFixed(3) +
        ' · ' +
        (attempt.match ? 'Coincide' : 'No coincide'),
    );
    button.type = 'button';
    button.setAttribute('aria-pressed', String(attempt === a));
    button.addEventListener('click', () => {
      selectedAttempt = attempt;
      showAttempt(attempt);
      renderInspection();
    });
    history.append(button);
  }
}
function log(message) {
  const li = el('li'),
    time = el('time', '', new Date().toLocaleTimeString('es-CO'));
  li.append(time, document.createTextNode(message));
  $('log').prepend(li);
  while ($('log').children.length > 20) $('log').lastChild.remove();
}
function status(message) {
  $('status').textContent = message;
  $('stepStatus').textContent = message;
}
function controls() {
  const ready =
    !!window.IdentityWorkflow &&
    !!stream &&
    !busy &&
    captureReady &&
    Date.now() - lastAssessmentAt <= 2500;
  $('start').disabled =
    busy ||
    !!stream ||
    !window.IdentityWorkflow ||
    !!window.IdentityWorkflow?.completed?.();
  $('stop').disabled = !stream;
  $('captureHere').disabled =
    !ready ||
    !loaded ||
    (!!window.IdentityWorkflow &&
      (!window.IdentityWorkflow.ready() ||
        window.IdentityWorkflow.mode === 'verify' ||
        !!references.length));
  $('retryCapture').disabled = $('captureHere').disabled;
  $('includeNetwork').disabled = busy || !!window.IdentityWorkflow;
  $('compareHere').disabled =
    !ready ||
    !loaded ||
    (window.IdentityWorkflow
      ? !(window.IdentityWorkflow.canCompare
          ? window.IdentityWorkflow.canCompare()
          : window.IdentityWorkflow.ready() && window.IdentityWorkflow.mode === 'verify')
      : !references.length);
  $('consent').disabled = !!stream || busy;
  $('captureHere').textContent = busy
    ? 'Captura en curso…'
    : references.length
      ? '1. Actualizar mi referencia'
      : 'Foto 1 · captura automática';
  $('captureHere').className = references.length ? 'secondary' : 'primary';
  $('compareHere').className = references.length ? 'primary' : 'secondary';
  $('compareHere').textContent = busy
    ? 'Captura en curso…'
    : '2. Tomar FOTO NUEVA y comparar';
  $('armComparison').disabled =
    busy ||
    autoCapturePending ||
    !!autoCaptureMode ||
    !window.IdentityWorkflow?.canCompare?.();
  $('comparisonActionInstruction').textContent =
    autoCaptureMode === 'comparison'
      ? 'Captura automática activada. Céntrate y no te muevas: aparecerá la cuenta regresiva, sin pulsar otro botón.'
      : 'Tu registro está guardado. Continúa para encender la cámara y tomar automáticamente una foto NUEVA para comparar.';
  if (!busy) updateStage();
}
function result(title, body, kind = '', distance) {
  $('result').className = 'result ' + kind;
  $('result').replaceChildren(el('span', 'eyebrow', 'RESULTADO'), el('h3', '', title));
  if (distance !== undefined)
    $('result').append(
      el('strong', '', similarityDisplay(distance, Number($('threshold').value)) + '%'),
    );
  $('result').append(el('p', '', body));
}
function similarityDisplay(distance, threshold) {
  return Math.max(
    1,
    Math.min(100, Math.round(100 * Math.exp(-Math.LN2 * (distance / threshold) ** 2))),
  );
}
function showUserResult(match, similarity, remaining) {
  const root = $('result');
  root.className = 'result ' + (match ? 'success' : 'fail');
  root.replaceChildren(
    el('span', 'eyebrow', 'RESULTADO'),
    el(
      'h3',
      '',
      match ? 'Tu rostro coincide con el registro' : 'No se confirmó la coincidencia',
    ),
    el('strong', 'similarity-score', similarity + '%'),
  );
  const bar = el('div', 'similarity-track'),
    fill = el('span', 'similarity-fill');
  fill.style.width = similarity + '%';
  bar.append(fill);
  bar.setAttribute('aria-hidden', 'true');
  root.append(bar);
  root.append(el('p', '', 'Similitud orientativa. No es una probabilidad de identidad.'));
  if (!match && remaining !== undefined)
    root.append(el('p', '', 'Intentos restantes: ' + remaining));
}
function showAttempt(a) {
  showUserResult(a.match, similarityDisplay(a.mean, a.threshold));
}
function stop({ completed = false, registered = false } = {}) {
  autoCaptureMode = null;
  if (busy && !completed && !registered)
    showCaptureProgress(
      ['retry'],
      'Registro o comparación interrumpidos. Repite la operación; el registro previo, si existe, se conserva.',
      true,
    );
  generation++;
  pauseMonitor();
  captureReady = false;
  stableFrames = 0;
  lastBox = null;
  $('countdown').hidden = true;
  setGuidance(
    completed
      ? 'Comparación finalizada. Revisa las dos fotos y el resultado.'
      : registered
        ? 'FOTO 1 guardada. Continúa con la segunda foto desde el botón de arriba.'
        : 'Activa la cámara para evaluar el encuadre.',
    completed ? 'complete' : 'waiting',
  );
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  $('video').srcObject = null;
  $('empty').style.display = 'flex';
  $('emptyTitle').textContent = completed
    ? 'Comparación finalizada'
    : registered
      ? 'FOTO 1 guardada'
      : 'El primer paso eres tú';
  $('emptyMessage').textContent = completed
    ? 'Se tomó una foto nueva para compararla con el registro. Revisa las dos capturas y el resultado.'
    : registered
      ? 'Falta la FOTO 2 para comparar. Pulsa «Continuar con la segunda foto», encima de esta cámara.'
      : 'Activa la cámara y ubica tu rostro en el centro, con buena iluminación.';
  $('emptyIcon').textContent = completed ? '✓' : '◎';
  $('cameraStatus').textContent = 'Cámara apagada';
  busy = false;
  controls();
}
async function start() {
  if (busy || stream) return;
  if (!$('consent').checked) {
    status('Debes dar tu autorización para usar el rostro antes de activar la cámara.');
    window.alert(
      'Debes marcar «Autorizo usar mi rostro en esta demo» antes de activar la cámara.',
    );
    $('consent').focus();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    status(
      'La cámara no está disponible. Abre el enlace mediante HTTPS en un navegador compatible.',
    );
    return;
  }
  if (!window.IdentityWorkflow?.ready()) {
    status('Completa primero el paso indicado arriba.');
    return;
  }
  busy = true;
  autoCaptureMode = null;
  controls();
  status('Solicitando permiso de cámara y cargando los modelos…');
  const token = ++generation;
  try {
    const comparison = !!window.IdentityWorkflow.canCompare?.();
    if (comparison) await window.IdentityWorkflow.prepareVerification();
    await adapter.load();
    if (token !== generation) return;
    const incoming = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    if (token !== generation) {
      incoming.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = incoming;
    $('video').srcObject = stream;
    await $('video').play();
    if (token !== generation) return;
    const video = $('video'),
      ellipse = $('guideEllipse');
    $('alignmentGuide').setAttribute(
      'viewBox',
      '0 0 ' + video.videoWidth + ' ' + video.videoHeight,
    );
    ellipse.setAttribute('cx', video.videoWidth / 2);
    ellipse.setAttribute('cy', video.videoHeight / 2);
    ellipse.setAttribute(
      'rx',
      Math.min(video.videoWidth * 0.23, video.videoHeight * 0.31 * 0.7),
    );
    ellipse.setAttribute('ry', video.videoHeight * 0.31);
    $('empty').style.display = 'none';
    $('cameraStatus').textContent = 'Cámara activa';
    autoCaptureMode = comparison ? 'comparison' : 'reference';
    stableFrames = 0;
    lastBox = null;
    captureReady = false;
    status(
      'Coloca tu rostro en el óvalo. La ' +
        (comparison ? 'FOTO 2 de comparación' : 'FOTO 1 de registro') +
        ' se tomará automáticamente cuando estés estable.',
    );
    log('Cámara activada. Imágenes y vectores se procesan en este navegador.');
  } catch (e) {
    if (token !== generation) return;
    stop();
    const message =
      e.name === 'NotAllowedError'
        ? 'Permiso denegado. Habilita la cámara en el navegador.'
        : e.name === 'NotFoundError'
          ? 'No encontramos una cámara. Conecta una webcam o usa el celular.'
          : e.name === 'NotReadableError'
            ? 'La cámara está ocupada por otra aplicación.'
            : e.message;
    status(message);
    if (e.name === 'NotAllowedError')
      window.alert(
        message +
          ' Pulsa el icono de permisos junto a la dirección de la página y permite el acceso.',
      );
    log(message);
  } finally {
    if (token === generation || !stream) {
      busy = false;
      controls();
      if (stream) resumeMonitor();
    }
  }
}
async function enroll() {
  if (!window.IdentityWorkflow) {
    status('No se pudo preparar el registro. Recarga la página para continuar.');
    return;
  }
  if (busy || !stream) return;
  if (
    window.IdentityWorkflow &&
    (!window.IdentityWorkflow.ready() ||
      window.IdentityWorkflow.mode !== 'register' ||
      references.length)
  )
    return;
  const token = generation;
  let sample = null,
    committed = false;
  if (!(await prepareCapture('reference', token))) {
    finishCapture(token);
    return;
  }
  try {
    showCaptureProgress(['taking'], 'Tomando tu única foto de referencia…');
    sample = await adapter.capture();
    autoCaptureMode = null;
    if (token !== generation) return;
    showCaptureProgress(
      ['taken'],
      'Foto aceptada. Completa tus datos para confirmar el registro.',
    );
    captureFlash('✓ Foto aceptada. No necesitas otra toma para registrarte.');
    if (window.IdentityWorkflow) {
      await window.IdentityWorkflow.afterFirstSample(sample);
      if (token !== generation) return;
      await window.IdentityWorkflow.save([sample]);
      if (token !== generation) return;
    }
    clearAttempts();
    references.forEach(disposeSample);
    references = [sample];
    committed = true;
    $('reference').textContent = '✓ Registro confirmado · una foto de referencia';
    showCaptureProgress(['taken'], 'Registro completo: una única foto aceptada.');
    $('referencePreview').src = sample.image;
    $('referencePreview').hidden = false;
    renderInspection();
    renderNetworkContext(sample.network);
    result(
      'Registro completado',
      'FOTO 1 guardada. Todavía no se ha comparado. Pulsa «Continuar con la segunda foto» encima de la cámara.',
    );
    status(
      'Registro completo. El siguiente paso usa una foto NUEVA para verificar tu rostro.',
    );
    log('Referencia única confirmada.');
    stop({ registered: true });
    status(
      'FOTO 1 guardada. Falta la FOTO 2: pulsa «Continuar con la segunda foto» encima de la cámara.',
    );
  } catch (e) {
    if (token === generation) {
      window.IdentityWorkflow?.onError(e);
      status(e.message);
      showCaptureProgress(
        ['retry'],
        'No se confirmó el registro. Revisa el mensaje e inténtalo de nuevo.',
        true,
      );
      result('Registro sin confirmar', e.message, 'fail');
    }
  } finally {
    if (sample && !committed) disposeSample(sample);
    finishCapture(token);
  }
}
async function verify() {
  if (!window.IdentityWorkflow) {
    status('No se pudo preparar la verificación. Recarga la página.');
    return;
  }
  return verifyPersistent();
}
async function verifyPersistent() {
  if (
    busy ||
    !stream ||
    !(window.IdentityWorkflow.canCompare
      ? window.IdentityWorkflow.canCompare()
      : window.IdentityWorkflow.ready() && window.IdentityWorkflow.mode === 'verify')
  )
    return;
  const token = generation;
  let sample = null;
  busy = true;
  pauseMonitor();
  controls();
  status('Preparando la FOTO 2. Aún no se ha tomado la foto nueva.');
  try {
    await window.IdentityWorkflow.prepareVerification?.();
    if (token !== generation) return;
  } catch (e) {
    autoCaptureMode = null;
    window.IdentityWorkflow.onError(e);
    status(e.message);
    finishCapture(token);
    return;
  }
  if (!(await prepareCapture('comparison', token))) {
    finishCapture(token);
    return;
  }
  try {
    sample = await adapter.capture();
    autoCaptureMode = null;
    if (token !== generation) return;
    const response = await window.IdentityWorkflow.verify(
      sample,
      () => token === generation,
    );
    if (token !== generation) return;
    showUserResult(response.match, response.similarity, response.remaining);
    captureFlash('✓ FOTO 2 tomada y comparada con la FOTO 1. Comparación terminada.');
    showCaptureProgress(
      ['taken'],
      'Dos capturas distintas: foto de registro + foto nueva de comparación.',
    );
    stop({ completed: true });
    log(
      'Verificación completada: ' +
        (response.match ? 'coincidencia' : 'sin coincidencia'),
    );
    status(
      response.match
        ? 'COMPARACIÓN TERMINADA: foto de registro frente a foto nueva. Revisa las miniaturas y tus datos junto al resultado.'
        : 'COMPARACIÓN TERMINADA. No se confirmó coincidencia. Revisa las miniaturas y los intentos restantes.',
    );
  } catch (e) {
    window.IdentityWorkflow.onError(e);
    status(e.message);
    result('No se pudo comparar', e.message, 'fail');
  } finally {
    if (sample) disposeSample(sample);
    finishCapture(token);
  }
}
function reset() {
  window.IdentityWorkflow?.reset();
  stop();
  clearAttempts();
  references.forEach(disposeSample);
  references = [];
  $('captureFeedback').hidden = true;
  $('captureFeedback').textContent = '';
  showCaptureProgress(['pending'], 'Todavía no se ha guardado ninguna referencia.');
  $('networkStatus').textContent = 'Contexto de conexión borrado de esta sesión.';
  $('reference').textContent = 'Sin referencia registrada';
  $('referencePreview').src = '';
  $('referencePreview').hidden = true;
  $('log').replaceChildren();
  renderInspection();
  result(
    'Esperando tu primera comparación',
    'Aquí verás si tu rostro coincide y un índice de similitud orientativo.',
  );
  status('Fotos, vectores e historial borrados. La cámara está apagada.');
  controls();
}
window.CaptureUI = {
  refreshControls: controls,
  async prepareNewComparison() {
    if (busy || autoCapturePending || !window.IdentityWorkflow?.canCompare?.()) return;
    result(
      'Esperando la FOTO 2 automática',
      'Céntrate y no te muevas. El registro anterior se conserva.',
    );
    if (!stream) {
      await start();
      return;
    }
    const token = generation;
    busy = true;
    autoCaptureMode = null;
    pauseMonitor();
    controls();
    try {
      await window.IdentityWorkflow.prepareVerification();
      if (token !== generation) return;
      autoCaptureMode = 'comparison';
      stableFrames = 0;
      captureReady = false;
      lastBox = null;
      status('FOTO 2 automática preparada. Céntrate; comenzará la cuenta regresiva.');
    } catch (e) {
      window.IdentityWorkflow.onError(e);
      status(e.message);
    } finally {
      if (token === generation) {
        busy = false;
        controls();
        resumeMonitor();
      }
    }
  },
};
$('captureHere').addEventListener('click', enroll);
$('retryCapture').addEventListener('click', () => {
  autoCaptureMode = 'reference';
  stableFrames = 0;
  captureReady = false;
  lastBox = null;
  resumeMonitor();
  status('Reintento preparado. Céntrate; la foto se tomará automáticamente.');
});
$('compareHere').addEventListener('click', verify);
$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => {
  stop();
  status(
    'Cámara apagada. Las capturas de esta sesión siguen visibles hasta borrarlas o cerrar la página.',
  );
});
$('threshold').addEventListener('input', () => {
  $('thresholdValue').value = Number($('threshold').value).toFixed(2);
});
$('reset').addEventListener('click', reset);
$('clearMemory').addEventListener('click', reset);
$('closePhoto').addEventListener('click', closePhoto);
$('photoDialog').addEventListener('close', () => $('photoDetail').replaceChildren());
document.addEventListener('visibilitychange', () => {
  if (document.hidden && stream) {
    stop();
    status('Cámara apagada al salir de la página.');
  }
});
window.addEventListener('pagehide', reset);
controls();
renderInspection();
status('Preparando el motor local de reconocimiento…');
adapter
  .load()
  .then(() => {
    if (!stream && !busy)
      status('Motor local listo. Autoriza y activa la cámara para comenzar.');
    log('Modelos de detección, puntos faciales y reconocimiento cargados.');
    controls();
  })
  .catch((e) => {
    status('No se pudo preparar el motor: ' + e.message);
    log('Error al cargar modelos. Puedes reintentar activando la cámara.');
  });
