/* Reglas de encuadre experimentales; no son una prueba de vida. */
(function (root) {
  const fail = (code, message) => ({ ready: false, code, message });
  function evaluate(m) {
    if (!m.faces)
      return fail('no-face', 'No veo un rostro. Colócate frente a la cámara.');
    if (m.faces !== 1)
      return fail('multiple', 'Solo debe aparecer una persona en la cámara.');
    const b = m.box;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite))
      return fail('invalid', 'No pude medir tu rostro. Mira de frente.');
    if (b.x < 0.02 || b.y < 0.02 || b.x + b.width > 0.98 || b.y + b.height > 0.98)
      return fail('cropped', 'Tu rostro está cortado. Aléjate un poco y céntralo.');
    if (b.width > 0.58 || b.height > 0.85)
      return fail('too-close', 'Aléjate un poco de la cámara.');
    if (b.width < 0.28 || b.height < 0.36)
      return fail('too-far', 'Acércate un poco a la cámara.');
    const cx = b.x + b.width / 2,
      cy = b.y + b.height / 2;
    if (cx < 0.4)
      return fail('left', 'Muévete hacia la izquierda de la imagen para centrarte.');
    if (cx > 0.6)
      return fail('right', 'Muévete hacia la derecha de la imagen para centrarte.');
    if (cy < 0.38)
      return fail('high', 'Baja un poco el rostro o ajusta la cámara hacia arriba.');
    if (cy > 0.62)
      return fail('low', 'Sube un poco el rostro o ajusta la cámara hacia abajo.');
    if (!Number.isFinite(m.roll) || !Number.isFinite(m.yaw))
      return fail(
        'pose-unknown',
        'Mira de frente para medir la posición de ojos y nariz.',
      );
    if (Math.abs(m.roll) > 12)
      return fail('tilt', 'Endereza la cabeza; mantén los ojos a la misma altura.');
    if (m.yaw > 0.35) return fail('turned', 'Gira el rostro de frente a la cámara.');
    if (!Number.isFinite(m.brightness) || m.brightness < 45)
      return fail('dark', 'Falta luz sobre tu rostro. Ilumínate de frente.');
    if (m.brightness > 235)
      return fail('bright', 'Hay demasiada luz sobre tu rostro. Evita la luz directa.');
    return { ready: true, code: 'ready', message: 'Encuadre adecuado. Mantente quieto.' };
  }
  const api = { evaluate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptureQuality = api;
})(typeof window !== 'undefined' ? window : globalThis);
