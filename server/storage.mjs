// Storage port: the domain never handles provider URLs or credentials.
export class SitesStorage {
  name = 'sites';
  constructor(bucket) {
    this.bucket = bucket;
  }
  async put(key, bytes, contentType) {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
    return key;
  }
  async get(key) {
    return this.bucket.get(key);
  }
  async remove(keys) {
    if (keys.length) await this.bucket.delete(keys);
  }
}
export class DriveStorage {
  name = 'drive';
  // A hosted connector must be eligible and authorized before this adapter is activated.
  async put() {
    throw new Error('Drive pendiente de habilitación de la integración en Sites.');
  }
  async get() {
    throw new Error('Drive pendiente de habilitación de la integración en Sites.');
  }
  async remove() {
    throw new Error('Drive pendiente de habilitación de la integración en Sites.');
  }
}
export function storageFor(env) {
  if (!env.BUCKET) throw new Error('Almacenamiento persistente no disponible.');
  return new SitesStorage(env.BUCKET);
}
