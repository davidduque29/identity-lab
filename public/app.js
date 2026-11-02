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
  if (context?.status === 'observed' && context.ip) return context.ip;
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
    const response = await fetch('/api/network-context', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
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
  $('alignmentLabel').textContent =
    state === 'ready'
      ? '✓ Listo para capturar'
      : state === 'capturing'
        ? 'Captura en curso'
        : 'Ajusta tu encuadre';
}
function updateStage() {
  $('captureStage').textContent = references.length
    ? 'PASO 2 · FOTO NUEVA DE COMPARACIÓN'
    : 'PASO 1 · TRES FOTOS DE REFERENCIA';
  $('registerStep').setAttribute('data-active', String(!references.length));
  $('compareStep').setAttribute('data-active', String(!!references.length));
}
function pauseMonitor() {
  monitorEpoch++;
  clearTimeout(monitorTimer);
  monitorTimer = null;
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
      const moved =
        b &&
        lastBox &&
        (Math.abs(b.x - lastBox.x) > 0.035 ||
          Math.abs(b.y - lastBox.y) > 0.035 ||
          Math.abs(b.width - lastBox.width) > 0.04);
      stableFrames = assessment.ready && !moved ? stableFrames + 1 : 0;
      lastBox = b ? { ...b } : null;
      lastAssessmentAt = Date.now();
      captureReady = assessment.ready && stableFrames >= 3;
      setGuidance(
        captureReady
          ? 'Encuadre adecuado. Ya puedes pulsar el botón de captura.'
          : assessment.ready
            ? 'Bien colocado. Mantente quieto un momento…'
            : assessment.message,
        captureReady ? 'ready' : 'waiting',
      );
      controls();
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
      ? 'PASO 1 · PREPARANDO TRES REFERENCIAS'
      : 'PASO 2 · PREPARANDO UNA FOTO NUEVA';
  try {
    for (let number = 3; number >= 1; number--) {
      const assessment = await adapter.assess();
      if (token !== generation) return false;
      if (!assessment.ready)
        throw new Error(
          assessment.message + ' Cuenta regresiva cancelada; vuelve a intentarlo.',
        );
      $('countdown').hidden = false;
      $('countdown').textContent = String(number);
      setGuidance(
        (kind === 'reference'
          ? 'Registro: tomaremos 3 fotos de referencia'
          : 'Comparación: tomaremos 1 foto NUEVA') +
          ' en ' +
          number +
          '… Mantente quieto.',
        'capturing',
      );
      status(
        kind === 'reference'
          ? 'Cuenta regresiva para registrar tus tres referencias.'
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
        'Al registrar tu rostro aparecerán aquí las tres fotos exactas utilizadas como referencia.',
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
    calculation.append(el('h3', '', 'Esta captura frente a tus 3 referencias'));
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
          ') / 3 = ' +
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
    !!stream && !busy && captureReady && Date.now() - lastAssessmentAt <= 2500;
  $('start').disabled = busy || !!stream;
  $('stop').disabled = !stream;
  $('captureHere').disabled = !ready || !loaded;
  $('retryCapture').disabled = !ready || !loaded;
  $('includeNetwork').disabled = busy;
  $('compareHere').disabled = !ready || !loaded || !references.length;
  $('consent').disabled = !!stream || busy;
  $('captureHere').textContent = busy
    ? 'Captura en curso…'
    : references.length
      ? '1. Repetir las 3 referencias'
      : '1. Capturar 3 fotos de referencia';
  $('captureHere').className = references.length ? 'secondary' : 'primary';
  $('compareHere').className = references.length ? 'primary' : 'secondary';
  $('compareHere').textContent = busy
    ? 'Captura en curso…'
    : '2. Tomar una foto NUEVA y comparar';
  if (!busy) updateStage();
}
function result(title, body, kind = '', distance) {
  $('result').className = 'result ' + kind;
  $('result').replaceChildren(el('span', 'eyebrow', 'RESULTADO'), el('h3', '', title));
  if (distance !== undefined) $('result').append(el('strong', '', distance.toFixed(3)));
  $('result').append(el('p', '', body));
}
function showAttempt(a) {
  result(
    (a.match ? 'Coincidencia' : 'Sin coincidencia') + ' · intento ' + a.number,
    'Distancia media: ' +
      a.mean.toFixed(3) +
      ' · Umbral usado: ' +
      a.threshold.toFixed(2) +
      '. Consulta las fotos y el cálculo más abajo. No verifica presencia real.',
    a.match ? 'success' : 'fail',
    a.mean,
  );
}
function stop() {
  if (busy)
    showCaptureProgress(
      ['retry', 'retry', 'retry'],
      'Registro o comparación interrumpidos. Repite la operación; el registro previo, si existe, se conserva.',
      true,
    );
  generation++;
  pauseMonitor();
  captureReady = false;
  stableFrames = 0;
  lastBox = null;
  $('countdown').hidden = true;
  setGuidance('Activa la cámara para evaluar el encuadre.');
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  $('video').srcObject = null;
  $('empty').style.display = 'flex';
  $('cameraStatus').textContent = 'Cámara apagada';
  busy = false;
  controls();
}
async function start() {
  if (!$('consent').checked) {
    status('Marca la autorización antes de activar la cámara.');
    $('consent').focus();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    status(
      'La cámara no está disponible. Abre el enlace mediante HTTPS en un navegador compatible.',
    );
    return;
  }
  busy = true;
  controls();
  status('Solicitando permiso de cámara y cargando los modelos…');
  const token = ++generation;
  try {
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
    ellipse.setAttribute('rx', video.videoWidth * 0.28);
    ellipse.setAttribute('ry', video.videoHeight * 0.42);
    $('empty').style.display = 'none';
    $('cameraStatus').textContent = 'Cámara activa';
    status('Coloca tu rostro en el óvalo. Espera el contorno verde para capturar.');
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
  if (busy || !stream) return;
  const token = generation,
    samples = [];
  let committed = false;
  if (!(await prepareCapture('reference', token))) {
    finishCapture(token);
    return;
  }
  $('captureFeedback').hidden = true;
  let captureIndex = 0;
  const progress = ['pending', 'pending', 'pending'];
  showCaptureProgress(progress, 'Registro iniciado: prepararemos tres referencias.');
  try {
    for (let i = 0; i < 3; i++) {
      captureIndex = i;
      progress[i] = 'taking';
      showCaptureProgress(progress, 'Tomando la foto ' + (i + 1) + ' de 3…');
      status('Registrando muestra ' + (i + 1) + ' de 3. Mantén el rostro centrado…');
      const sample = await adapter.capture();
      samples.push(sample);
      if (token !== generation) return;
      progress[i] = 'taken';
      showCaptureProgress(
        progress,
        i === 0
          ? 'Primera foto tomada correctamente. Faltan las fotos 2 y 3.'
          : 'Foto ' + (i + 1) + ' tomada correctamente.',
      );
      renderNetworkContext(sample.network);
      captureFlash('✓ Referencia ' + (i + 1) + ' de 3 capturada');
      setGuidance(
        'Referencia ' + (i + 1) + '/3 capturada. Mantente quieto.',
        'capturing',
      );
      await wait(500);
      if (token !== generation) return;
    }
    clearAttempts();
    references.forEach(disposeSample);
    references = samples;
    committed = true;
    showCaptureProgress(
      ['taken', 'taken', 'taken'],
      'Las tres fotos fueron tomadas y registradas. No necesitas repetirlas.',
    );
    $('reference').textContent =
      '✓ Referencia activa · 3 fotos y 3 vectores · solo en memoria';
    result(
      'Referencia registrada',
      'Puedes ver las tres fotos en «Fotos y comparación» y realizar una captura nueva.',
    );
    renderInspection();
    captureFlash('✓ Registro terminado: 3 referencias. Siguiente: toma una foto NUEVA.');
    status(
      'PASO 1 COMPLETO. Ya tienes 3 referencias. Para comparar, pulsa «2. Tomar una foto NUEVA y comparar»: habrá otra cuenta regresiva.',
    );
    log('Referencia registrada: 3 fotos y sus vectores de 128 valores, solo en memoria.');
  } catch (e) {
    if (token === generation) {
      status(e.message);
      const state = progress.map((_, i) => (i < samples.length ? 'cancelled' : 'retry'));
      const message =
        'La foto ' +
        (captureIndex + 1) +
        ' no se pudo aceptar. ' +
        (samples.length
          ? 'Se tomaron ' +
            samples.length +
            ' foto(s), pero se descartarán porque el registro está incompleto. '
          : 'No se guardó ninguna foto nueva. ') +
        'Repite las tres tomas cuando el contorno esté verde.' +
        (references.length ? ' Tu registro anterior sigue activo.' : '');
      showCaptureProgress(state, message, true);
      result('Debes repetir el registro', message + ' ' + e.message, 'fail');
      log('Registro incompleto: ' + e.message);
    }
  } finally {
    if (!committed) samples.forEach(disposeSample);
    finishCapture(token);
  }
}
async function verify() {
  if (busy || !stream || !references.length) return;
  const token = generation,
    threshold = Number($('threshold').value);
  let sample = null,
    committed = false;
  if (!(await prepareCapture('comparison', token))) {
    finishCapture(token);
    return;
  }
  $('captureFeedback').hidden = true;
  try {
    status('Analizando una captura nueva…');
    sample = await adapter.capture();
    if (token !== generation) return;
    const distances = references.map((ref) =>
      adapter.distance(ref.descriptor, sample.descriptor),
    );
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
    const attempt = {
      number: ++attemptNumber,
      sample,
      distances,
      mean,
      threshold,
      match: mean <= threshold,
    };
    closePhoto();
    attempts.unshift(attempt);
    if (attempts.length > 5) disposeSample(attempts.pop().sample);
    committed = true;
    selectedAttempt = attempt;
    showAttempt(attempt);
    renderInspection();
    renderNetworkContext(sample.network);
    captureFlash('✓ Foto NUEVA del intento ' + attempt.number + ' capturada y comparada');
    status(
      'PASO 2 COMPLETO: foto NUEVA tomada a las ' +
        timeLabel(sample.capturedAt) +
        '. Mira el resultado y la foto en «Fotos y comparación».',
    );
    log(
      'Intento ' +
        attempt.number +
        ': ' +
        distances.map((d) => d.toFixed(3)).join(' / ') +
        ' · media ' +
        mean.toFixed(3) +
        ' · umbral ' +
        threshold.toFixed(2),
    );
  } catch (e) {
    if (token === generation) {
      status(e.message);
      result('No se pudo comparar', e.message, 'fail');
      log('Comparación incompleta: ' + e.message);
    }
  } finally {
    if (sample && !committed) disposeSample(sample);
    finishCapture(token);
  }
}
function reset() {
  stop();
  clearAttempts();
  references.forEach(disposeSample);
  references = [];
  $('captureFeedback').hidden = true;
  $('captureFeedback').textContent = '';
  showCaptureProgress(
    ['pending', 'pending', 'pending'],
    'Todavía no se ha guardado ninguna referencia.',
  );
  $('networkStatus').textContent = 'Contexto de conexión borrado de esta sesión.';
  $('reference').textContent = 'Sin referencia registrada';
  $('log').replaceChildren();
  renderInspection();
  result(
    'Esperando tu primera comparación',
    'Aquí verás la distancia entre los vectores faciales.',
  );
  status('Fotos, vectores e historial borrados. La cámara está apagada.');
  controls();
}
$('captureHere').addEventListener('click', enroll);
$('retryCapture').addEventListener('click', enroll);
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
