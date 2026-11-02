export class ValidationError extends Error {
  status = 400;
}
export const DEFAULTS = Object.freeze({
  maxFailures: 3,
  pauseMinutes: 15,
  qrMinutes: 5,
  threshold: 0.5,
  retentionDays: 90,
});
export const MODEL = 'face-api.js-0.22.2/FaceRecognitionNet-128';
export function validSettings(value) {
  const limits = {
    maxFailures: [1, 10],
    pauseMinutes: [1, 1440],
    qrMinutes: [1, 15],
    threshold: [0.3, 0.65],
    retentionDays: [1, 365],
  };
  const out = {};
  for (const [key, [min, max]] of Object.entries(limits)) {
    const n = Number(value[key]);
    if (
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (key !== 'threshold' && !Number.isInteger(n))
    )
      throw new ValidationError('Configuración inválida: ' + key);
    out[key] = n;
  }
  return out;
}
export function documentKey(type, number) {
  if (!['CC', 'CE', 'TI', 'PAS'].includes(type))
    throw new ValidationError('Tipo de documento inválido.');
  const normalized = String(number || '')
    .toUpperCase()
    .replace(/[ .-]/g, '');
  if (!/^[A-Z0-9]{4,24}$/.test(normalized))
    throw new ValidationError('Número de documento inválido.');
  return type + ':' + normalized;
}
export function validateProfile(value) {
  const out = {};
  for (const [key, required] of [
    ['firstName', true],
    ['middleName', false],
    ['lastName', true],
    ['address', true],
  ]) {
    const v = String(value[key] || '').trim();
    if ((required && !v) || v.length > 180 || /[\x00-\x1f]/.test(v))
      throw new ValidationError('Revisa el campo ' + key);
    out[key] = v;
  }
  const date = String(value.birthDate || '');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    date < '1900-01-01' ||
    date > new Date().toISOString().slice(0, 10)
  )
    throw new ValidationError('Fecha de nacimiento inválida.');
  out.birthDate = date;
  out.documentType = value.documentType;
  out.documentNumber = documentKey(value.documentType, value.documentNumber).split(
    ':',
  )[1];
  if (value.consent !== true)
    throw new ValidationError('Debes aceptar el consentimiento.');
  return out;
}
export function descriptor(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 128 ||
    value.some((n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 5)
  )
    throw new ValidationError('Descriptor biométrico inválido.');
  return value;
}
export function compare(references, probe, threshold) {
  descriptor(probe);
  if (!Array.isArray(references) || references.length !== 3)
    throw new ValidationError('Referencia inválida.');
  const distances = references.map((ref) =>
    Math.sqrt(descriptor(ref).reduce((sum, x, i) => sum + (x - probe[i]) ** 2, 0)),
  );
  const mean = distances.reduce((sum, x) => sum + x, 0) / 3;
  return { distances, mean, threshold, match: mean <= threshold };
}
export function nextAttempt(profile, match, rules, now) {
  if (profile.locked_until > now) return { blocked: true, retryAt: profile.locked_until };
  const old = profile.locked_until && profile.locked_until <= now ? 0 : profile.failures;
  const failures = match ? 0 : old + 1;
  const lockedUntil =
    failures >= rules.maxFailures ? now + rules.pauseMinutes * 60000 : 0;
  return {
    failures,
    lockedUntil,
    remaining: Math.max(0, rules.maxFailures - failures),
    blocked: false,
  };
}
export function rasterData(value, maxBytes = 800000) {
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(value || '');
  if (!match) throw new ValidationError('Selecciona una imagen JPEG o PNG.');
  const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (!bytes.length || bytes.length > maxBytes || (match[1] === 'jpeg' ? !jpeg : !png))
    throw new ValidationError('Imagen inválida o demasiado grande.');
  return { bytes, type: 'image/' + match[1] };
}
