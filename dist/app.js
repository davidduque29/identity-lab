'use strict';
const $ = id => document.getElementById(id);
let stream = null, references = [], attempts = [], selectedAttempt = null;
let busy = false, generation = 0, loaded = false, modelPromise = null, attemptNumber = 0;
const adapter = {
  name: 'face-api.js / FaceRecognitionNet',
  async load() {
    if (loaded) return;
    if (!window.faceapi) throw new Error('No se pudo cargar el motor. Recarga la página.');
    if (!modelPromise) modelPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('./models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('./models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('./models')
    ]).then(() => { loaded = true; }).catch(e => { modelPromise = null; throw e; });
    await modelPromise;
  },
  async capture() {
    const video = $('video');
    if (!stream || video.readyState < 2 || !video.videoWidth) throw new Error('La cámara todavía no está lista. Espera un momento.');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const capturedAt = new Date();
    try {
      canvas.getContext('2d').drawImage(video, 0, 0);
      const found = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: .6 })).withFaceLandmarks().withFaceDescriptors();
      if (!found.length) throw new Error('No se detectó un rostro. Acércate y mejora la iluminación.');
      if (found.length !== 1) throw new Error('Debe aparecer una sola persona. Retira los otros rostros del encuadre.');
      const box = found[0].detection.box;
      if (box.width / canvas.width < .18) throw new Error('Tu rostro está muy lejos. Acércate un poco.');
      return {
        descriptor: found[0].descriptor,
        image: canvas.toDataURL('image/jpeg', .85),
        capturedAt,
        box: { x: box.x / canvas.width, y: box.y / canvas.height, width: box.width / canvas.width, height: box.height / canvas.height }
      };
    } finally { canvas.width = 0; canvas.height = 0; }
  },
  distance(a, b) { return faceapi.euclideanDistance(a, b); }
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function timeLabel(date) { return date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(date.getMilliseconds()).padStart(3, '0'); }
function disposeSample(sample) { if (sample) { sample.descriptor.fill(0); sample.image = ''; } }
function clearAttempts() { closePhoto(); attempts.forEach(a => disposeSample(a.sample)); attempts = []; selectedAttempt = null; attemptNumber = 0; }
function closePhoto() { const dialog = $('photoDialog'); if (dialog.open) dialog.close(); $('photoDetail').replaceChildren(); }
function photoPreview(sample, title) {
  const frame = el('div', 'sample-frame');
  const image = el('img'); image.src = sample.image; image.alt = title; image.width = 640; image.height = 480;
  const box = el('span', 'detected-box'); box.setAttribute('aria-hidden', 'true');
  for (const [key, value] of Object.entries({ left: sample.box.x, top: sample.box.y, width: sample.box.width, height: sample.box.height })) box.style[key] = (value * 100) + '%';
  frame.append(image, box); return frame;
}
function openPhoto(sample, title) {
  $('photoTitle').textContent = title;
  const details = $('photoDetail'); details.replaceChildren(photoPreview(sample, title), el('p', 'muted', 'Capturada a las ' + timeLabel(sample.capturedAt) + '. El recuadro indica el rostro detectado. Imagen sin efecto espejo.'));
  const vector = el('details', 'vector-details'); vector.append(el('summary', '', 'Inspeccionar los 128 valores del vector facial'));
  vector.append(el('pre', '', Array.from(sample.descriptor, (v, i) => (i + 1) + ': ' + v.toFixed(6)).join('\n'))); details.append(vector);
  $('photoDialog').showModal();
}
function sampleCard(sample, title) {
  const card = el('figure', 'sample-card'); const button = el('button', 'photo-button');
  button.type = 'button'; button.setAttribute('aria-label', 'Ampliar ' + title); button.append(photoPreview(sample, title)); button.addEventListener('click', () => openPhoto(sample, title));
  const caption = el('figcaption'); caption.append(el('strong', '', title), el('span', '', timeLabel(sample.capturedAt)), el('small', '', 'Ampliar foto y ver vector ↗'));
  card.append(button, caption); return card;
}
function renderInspection() {
  const gallery = $('referenceGallery'); gallery.replaceChildren();
  if (!references.length) gallery.append(el('p', 'gallery-empty', 'Al registrar tu rostro aparecerán aquí las tres fotos exactas utilizadas como referencia.'));
  references.forEach((sample, i) => gallery.append(sampleCard(sample, 'Referencia ' + (i + 1))));
  $('memoryCount').textContent = references.length + ' referencias · ' + attempts.length + '/5 intentos';
  const comparison = $('comparisonDetail'); comparison.replaceChildren();
  const a = selectedAttempt;
  if (!a) comparison.append(el('p', 'gallery-empty', 'Pulsa «Comparar nueva captura» para ver la foto que se compara y el cálculo completo.'));
  else {
    comparison.append(sampleCard(a.sample, 'Captura del intento ' + a.number));
    const calculation = el('div', 'calculation');
    calculation.append(el('h3', '', 'Esta captura frente a tus 3 referencias'));
    const table = el('table', 'distance-table');
    const head = el('thead'), tr = el('tr'); tr.append(el('th', '', 'Comparación'), el('th', '', 'Distancia')); head.append(tr); table.append(head);
    const body = el('tbody'); a.distances.forEach((d, i) => { const row = el('tr'); row.append(el('td', '', 'Captura ↔ referencia ' + (i + 1)), el('td', '', d.toFixed(6))); body.append(row); }); table.append(body); calculation.append(table);
    calculation.append(el('p', 'formula', '(' + a.distances.map(d => d.toFixed(6)).join(' + ') + ') / 3 = ' + a.mean.toFixed(6)));
    calculation.append(el('p', 'decision ' + (a.match ? 'yes' : 'no'), a.mean.toFixed(6) + (a.match ? ' ≤ ' : ' > ') + a.threshold.toFixed(2) + ' → ' + (a.match ? 'Coincidencia' : 'Sin coincidencia')));
    calculation.append(el('p', 'muted', 'Decisión calculada con valores completos; cifras mostradas redondeadas. Se comparan vectores de 128 números, no los píxeles de las fotos. El umbral mostrado es el usado en este intento.'));
    comparison.append(calculation);
  }
  const history = $('attemptHistory'); history.replaceChildren();
  for (const attempt of attempts) {
    const button = el('button', 'attempt-chip' + (attempt === a ? ' selected' : ''), 'Intento ' + attempt.number + ' · ' + attempt.mean.toFixed(3) + ' · ' + (attempt.match ? 'Coincide' : 'No coincide'));
    button.type = 'button'; button.setAttribute('aria-pressed', String(attempt === a));
    button.addEventListener('click', () => { selectedAttempt = attempt; showAttempt(attempt); renderInspection(); }); history.append(button);
  }
}
function log(message) { const li = el('li'), time = el('time', '', new Date().toLocaleTimeString('es-CO')); li.append(time, document.createTextNode(message)); $('log').prepend(li); while ($('log').children.length > 20) $('log').lastChild.remove(); }
function status(message) { $('status').textContent = message; $('stepStatus').textContent = message; }
function controls() {
  const ready = !!stream && !busy;
  $('start').disabled = busy || !!stream; $('stop').disabled = !stream;
  for (const id of ['enroll', 'captureHere']) $(id).disabled = !ready || !loaded;
  for (const id of ['verify', 'compareHere']) $(id).disabled = !ready || !loaded || !references.length;
  $('consent').disabled = !!stream || busy;
  $('captureHere').textContent = busy ? 'Procesando…' : references.length ? 'Volver a registrar mi rostro' : 'Capturar y registrar mi rostro';
}
function result(title, body, kind = '', distance) {
  $('result').className = 'result ' + kind;
  $('result').replaceChildren(el('span', 'eyebrow', 'RESULTADO'), el('h3', '', title));
  if (distance !== undefined) $('result').append(el('strong', '', distance.toFixed(3)));
  $('result').append(el('p', '', body));
}
function showAttempt(a) { result((a.match ? 'Coincidencia' : 'Sin coincidencia') + ' · intento ' + a.number, 'Distancia media: ' + a.mean.toFixed(3) + ' · Umbral usado: ' + a.threshold.toFixed(2) + '. Consulta las fotos y el cálculo más abajo. No verifica presencia real.', a.match ? 'success' : 'fail', a.mean); }
function stop() {
  generation++;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('video').srcObject = null; $('empty').style.display = 'flex'; $('cameraStatus').textContent = 'Cámara apagada'; busy = false; controls();
}
async function start() {
  if (!$('consent').checked) { status('Marca la autorización antes de activar la cámara.'); $('consent').focus(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { status('La cámara no está disponible. Abre el enlace mediante HTTPS en un navegador compatible.'); return; }
  busy = true; controls(); status('Solicitando permiso de cámara y cargando los modelos…'); const token = ++generation;
  try {
    await adapter.load(); if (token !== generation) return;
    const incoming = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    if (token !== generation) { incoming.getTracks().forEach(t => t.stop()); return; }
    stream = incoming; $('video').srcObject = stream; await $('video').play(); if (token !== generation) return;
    $('empty').style.display = 'none'; $('cameraStatus').textContent = 'Cámara activa'; status('Cámara lista. Pulsa «Capturar y registrar mi rostro», aquí arriba.'); log('Cámara activada. Imágenes y vectores se procesan en este navegador.');
  } catch (e) {
    if (token !== generation) return; stop();
    const message = e.name === 'NotAllowedError' ? 'Permiso denegado. Habilita la cámara en el navegador.' : e.name === 'NotFoundError' ? 'No encontramos una cámara. Conecta una webcam o usa el celular.' : e.name === 'NotReadableError' ? 'La cámara está ocupada por otra aplicación.' : e.message;
    status(message); log(message);
  } finally { if (token === generation || !stream) { busy = false; controls(); } }
}
async function enroll() {
  if (busy || !stream) return;
  busy = true; controls(); const token = generation, samples = []; let committed = false;
  try {
    for (let i = 0; i < 3; i++) {
      status('Registrando muestra ' + (i + 1) + ' de 3. Mantén el rostro centrado…');
      samples.push(await adapter.capture()); if (token !== generation) return;
      await new Promise(r => setTimeout(r, 250)); if (token !== generation) return;
    }
    clearAttempts(); references.forEach(disposeSample); references = samples; committed = true;
    $('reference').textContent = '✓ Referencia activa · 3 fotos y 3 vectores · solo en memoria';
    result('Referencia registrada', 'Puedes ver las tres fotos en «Fotos y comparación» y realizar una captura nueva.');
    renderInspection(); status('Registro completado. Más abajo puedes ver las tres fotos de referencia.'); log('Referencia registrada: 3 fotos y sus vectores de 128 valores, solo en memoria.');
  } catch (e) { if (token === generation) { status(e.message); result('Registro incompleto', e.message, 'fail'); log('Registro incompleto: ' + e.message); } }
  finally { if (!committed) samples.forEach(disposeSample); if (token === generation) { busy = false; controls(); } }
}
async function verify() {
  if (busy || !stream || !references.length) return;
  busy = true; controls(); const token = generation, threshold = Number($('threshold').value); let sample = null, committed = false;
  try {
    status('Analizando una captura nueva…'); sample = await adapter.capture(); if (token !== generation) return;
    const distances = references.map(ref => adapter.distance(ref.descriptor, sample.descriptor));
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
    const attempt = { number: ++attemptNumber, sample, distances, mean, threshold, match: mean <= threshold };
    closePhoto(); attempts.unshift(attempt); if (attempts.length > 5) disposeSample(attempts.pop().sample);
    committed = true; selectedAttempt = attempt; showAttempt(attempt); renderInspection();
    status('Comparación completada. Mira la foto nueva y cada distancia en «Fotos y comparación».');
    log('Intento ' + attempt.number + ': ' + distances.map(d => d.toFixed(3)).join(' / ') + ' · media ' + mean.toFixed(3) + ' · umbral ' + threshold.toFixed(2));
  } catch (e) { if (token === generation) { status(e.message); result('No se pudo comparar', e.message, 'fail'); log('Comparación incompleta: ' + e.message); } }
  finally { if (sample && !committed) disposeSample(sample); if (token === generation) { busy = false; controls(); } }
}
function reset() {
  stop(); clearAttempts(); references.forEach(disposeSample); references = [];
  $('reference').textContent = 'Sin referencia registrada'; $('log').replaceChildren(); renderInspection();
  result('Esperando tu primera comparación', 'Aquí verás la distancia entre los vectores faciales.');
  status('Fotos, vectores e historial borrados. La cámara está apagada.'); controls();
}
$('captureHere').addEventListener('click', enroll); $('enroll').addEventListener('click', enroll);
$('compareHere').addEventListener('click', verify); $('verify').addEventListener('click', verify);
$('start').addEventListener('click', start); $('stop').addEventListener('click', () => { stop(); status('Cámara apagada. Las capturas de esta sesión siguen visibles hasta borrarlas o cerrar la página.'); });
$('threshold').addEventListener('input', () => { $('thresholdValue').value = Number($('threshold').value).toFixed(2); });
$('reset').addEventListener('click', reset); $('clearMemory').addEventListener('click', reset);
$('closePhoto').addEventListener('click', closePhoto);
$('photoDialog').addEventListener('close', () => $('photoDetail').replaceChildren());
document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { stop(); status('Cámara apagada al salir de la página.'); } });
window.addEventListener('pagehide', reset);
controls(); renderInspection(); status('Preparando el motor local de reconocimiento…');
adapter.load().then(() => { if (!stream && !busy) status('Motor local listo. Autoriza y activa la cámara para comenzar.'); log('Modelos de detección, puntos faciales y reconocimiento cargados.'); controls(); }).catch(e => { status('No se pudo preparar el motor: ' + e.message); log('Error al cargar modelos. Puedes reintentar activando la cámara.'); });
