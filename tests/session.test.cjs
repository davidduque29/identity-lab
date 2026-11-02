const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Element {
  constructor() { this.children = []; this.style = {}; this.value = '0.50'; this.open = false; this.events = {}; }
  append(...items) { this.children.push(...items); }
  prepend(item) { this.children.unshift(item); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  focus() {}
  get lastChild() { return { remove: () => this.children.pop() }; }
}
test('session evidence, threshold snapshots, bounded history and deletion', async () => {
  const nodes = new Map();
  const doc = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }, createElement() { return new Element(); }, createTextNode(text) { return { textContent: text }; }, addEventListener() {} };
  const faceapi = { nets: Object.fromEntries(['tinyFaceDetector', 'faceLandmark68Net', 'faceRecognitionNet'].map(n => [n, { loadFromUri: async () => {} }])), euclideanDistance(a, b) { return Math.hypot(...Array.from(a, (v, i) => v - b[i])); } };
  const context = vm.createContext({ document: doc, window: { faceapi, addEventListener() {} }, faceapi, navigator: {}, setTimeout: fn => fn(), console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8'), context);
  await vm.runInContext(`(async () => {
    await adapter.load();
    stream = { getTracks: () => [{stop(){}}] };
    const sample = (value, id) => ({ descriptor: Float32Array.from([value, ...Array(127).fill(0)]), image: 'data:image/jpeg;base64,' + id, capturedAt: new Date(), box: {x:.2,y:.2,width:.4,height:.4} });
    let queue = [sample(0,'reference1'), sample(.1,'reference2'), sample(.2,'reference3')];
    adapter.capture = async () => queue.shift();
    await enroll();
    globalThis.savedReferences = references;
    queue = [sample(.15,'attempt1')]; await verify();
    globalThis.firstAttempt = attempts[0];
  })()`, context);
  const first = context.firstAttempt;
  assert.equal(first.sample.image, 'data:image/jpeg;base64,attempt1');
  assert.equal(context.savedReferences.length, 3);
  assert.ok(Math.abs(first.mean - (0.15 + 0.05 + 0.05) / 3) < 1e-6);
  assert.equal(first.threshold, 0.50);
  nodes.get('threshold').value = '0.30';
  await vm.runInContext(`(async () => {
    adapter.capture = async () => ({descriptor:Float32Array.from([.9,...Array(127).fill(0)]),image:'data:image/jpeg;base64,new',capturedAt:new Date(),box:{x:0,y:0,width:1,height:1}});
    for(let i=0;i<5;i++) await verify();
    globalThis.sessionCount = attempts.length;
    globalThis.latest = attempts[0];
  })()`, context);
  assert.equal(context.sessionCount, 5);
  assert.equal(first.threshold, 0.50, 'old threshold is immutable');
  assert.equal(first.sample.image, '', 'sixth attempt removes oldest image');
  assert.ok(Array.from(first.sample.descriptor).every(v => v === 0));
  assert.equal(context.latest.match, false);
  vm.runInContext('reset()', context);
  assert.ok(context.savedReferences.every(s => !s.image && Array.from(s.descriptor).every(v => v === 0)));
  assert.equal(context.latest.sample.image, '');
  assert.equal(nodes.get('photoDetail').children.length, 0);
  assert.equal(nodes.get('attemptHistory').children.length, 0);
  assert.equal(nodes.get('memoryCount').textContent, '0 referencias · 0/5 intentos');
  await vm.runInContext(`(async () => {
    stream = { getTracks: () => [] };
    let resolveCapture;
    adapter.capture = () => new Promise(resolve => { resolveCapture = resolve; });
    const pending = enroll();
    reset();
    globalThis.lateSample = {descriptor:new Float32Array(128).fill(1),image:'data:image/jpeg;base64,late',capturedAt:new Date(),box:{x:0,y:0,width:1,height:1}};
    resolveCapture(lateSample); await pending;
  })()`, context);
  assert.equal(context.lateSample.image, '', 'cancelled inference must not restore images');
  assert.ok(Array.from(context.lateSample.descriptor).every(v => v === 0));
  assert.equal(nodes.get('memoryCount').textContent, '0 referencias · 0/5 intentos');
});
