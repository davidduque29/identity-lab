const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Element {
  constructor() {
    this.children = [];
    this.style = {};
    this.value = '0.50';
    this.open = false;
    this.events = {};
  }
  append(...items) {
    this.children.push(...items);
  }
  prepend(item) {
    this.children.unshift(item);
  }
  replaceChildren(...items) {
    this.children = items;
  }
  addEventListener(name, fn) {
    this.events[name] = fn;
  }
  setAttribute() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.events.close?.();
  }
  focus() {}
  get lastChild() {
    return { remove: () => this.children.pop() };
  }
}
function createHarness() {
  const nodes = new Map();
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    },
    createElement() {
      return new Element();
    },
    createTextNode(text) {
      return { textContent: text };
    },
    addEventListener() {},
  };
  const faceapi = {
    nets: Object.fromEntries(
      ['tinyFaceDetector', 'faceLandmark68Net', 'faceRecognitionNet'].map((n) => [
        n,
        { loadFromUri: async () => {} },
      ]),
    ),
    euclideanDistance(a, b) {
      return Math.hypot(...Array.from(a, (v, i) => v - b[i]));
    },
  };
  const context = vm.createContext({
    document: doc,
    window: { faceapi, addEventListener() {} },
    faceapi,
    navigator: {},
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    console,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'),
    context,
  );
  return { nodes, context };
}
test('session evidence, threshold snapshots, bounded history and deletion', async () => {
  const { nodes, context } = createHarness();
  await vm.runInContext(
    `(async () => {
    await adapter.load();
    prepareCapture = async () => true;
    resumeMonitor = () => {};
    stream = { getTracks: () => [{stop(){}}] };
    const sample = (value, id) => ({ descriptor: Float32Array.from([value, ...Array(127).fill(0)]), image: 'data:image/jpeg;base64,' + id, capturedAt: new Date(), box: {x:.2,y:.2,width:.4,height:.4} });
    let queue = [sample(0,'reference1'), sample(.1,'reference2'), sample(.2,'reference3')];
    adapter.capture = async () => queue.shift();
    await enroll();
    globalThis.savedReferences = references;
    queue = [sample(.15,'attempt1')]; await verify();
    globalThis.firstAttempt = attempts[0];
  })()`,
    context,
  );
  const first = context.firstAttempt;
  assert.equal(first.sample.image, 'data:image/jpeg;base64,attempt1');
  assert.equal(context.savedReferences.length, 3);
  assert.ok(Math.abs(first.mean - (0.15 + 0.05 + 0.05) / 3) < 1e-6);
  assert.equal(first.threshold, 0.5);
  nodes.get('threshold').value = '0.30';
  await vm.runInContext(
    `(async () => {
    adapter.capture = async () => ({descriptor:Float32Array.from([.9,...Array(127).fill(0)]),image:'data:image/jpeg;base64,new',capturedAt:new Date(),box:{x:0,y:0,width:1,height:1}});
    for(let i=0;i<5;i++) await verify();
    globalThis.sessionCount = attempts.length;
    globalThis.latest = attempts[0];
  })()`,
    context,
  );
  assert.equal(context.sessionCount, 5);
  assert.equal(first.threshold, 0.5, 'old threshold is immutable');
  assert.equal(first.sample.image, '', 'sixth attempt removes oldest image');
  assert.ok(Array.from(first.sample.descriptor).every((v) => v === 0));
  assert.equal(context.latest.match, false);
  vm.runInContext('reset()', context);
  assert.ok(
    context.savedReferences.every(
      (s) => !s.image && Array.from(s.descriptor).every((v) => v === 0),
    ),
  );
  assert.equal(context.latest.sample.image, '');
  assert.equal(nodes.get('photoDetail').children.length, 0);
  assert.equal(nodes.get('attemptHistory').children.length, 0);
  assert.equal(nodes.get('memoryCount').textContent, '0 referencias · 0/5 intentos');
  await vm.runInContext(
    `(async () => {
    stream = { getTracks: () => [] };
    let resolveCapture;
    adapter.capture = () => new Promise(resolve => { resolveCapture = resolve; });
    const pending = enroll();
    await Promise.resolve();
    reset();
    globalThis.lateSample = {descriptor:new Float32Array(128).fill(1),image:'data:image/jpeg;base64,late',capturedAt:new Date(),box:{x:0,y:0,width:1,height:1}};
    resolveCapture(lateSample); await pending;
  })()`,
    context,
  );
  assert.equal(
    context.lateSample.image,
    '',
    'cancelled inference must not restore images',
  );
  assert.ok(Array.from(context.lateSample.descriptor).every((v) => v === 0));
  assert.equal(nodes.get('memoryCount').textContent, '0 referencias · 0/5 intentos');
});

test('guided capture counts down twice and comparison uses a fresh fourth photo', async () => {
  const { context, nodes } = createHarness();
  const delays = [];
  context.setTimeout = (fn, ms) => {
    delays.push(ms);
    fn();
  };
  await vm.runInContext(
    `(async () => {
    await adapter.load();
    resumeMonitor = () => {};
    stream = { getTracks: () => [] };
    captureReady = true;
    lastAssessmentAt = Date.now();
    globalThis.capturedCount = 0;
    adapter.assess = async () => ({ ready: true });
    adapter.capture = async () => ({
      descriptor: new Float32Array(128),
      image: 'data:image/jpeg;base64,photo' + (++capturedCount),
      capturedAt: new Date(),
      box: { x: .3, y: .25, width: .4, height: .5 },
    });
    await enroll();
    globalThis.enrolledImages = references.map(sample => sample.image);
    captureReady = true;
    lastAssessmentAt = Date.now();
    await verify();
    globalThis.comparedImage = attempts[0].sample.image;
  })()`,
    context,
  );
  assert.equal(context.capturedCount, 4);
  assert.deepEqual(Array.from(context.enrolledImages), [
    'data:image/jpeg;base64,photo1',
    'data:image/jpeg;base64,photo2',
    'data:image/jpeg;base64,photo3',
  ]);
  assert.equal(context.comparedImage, 'data:image/jpeg;base64,photo4');
  assert.equal(delays.filter((ms) => ms === 1000).length, 6);
  assert.equal(nodes.get('countdown').hidden, true);
  assert.match(nodes.get('captureFeedback').textContent, /Foto NUEVA/);
  assert.match(nodes.get('captureStage').textContent, /PASO 2/);

  await vm.runInContext(
    `(async () => {
    captureReady = true;
    lastAssessmentAt = Date.now();
    adapter.assess = async () => ({ ready: false, message: 'Aléjate un poco.' });
    await enroll();
    globalThis.remainingReferences = references.length;
  })()`,
    context,
  );
  assert.equal(context.capturedCount, 4, 'misaligned countdown must not take photos');
  assert.equal(
    context.remainingReferences,
    3,
    'cancelled enrollment preserves old references',
  );
  assert.equal(nodes.get('countdown').hidden, true);
  assert.match(nodes.get('status').textContent, /Cuenta regresiva cancelada/);

  await vm.runInContext(
    `(async () => {
    captureReady = true;
    lastAssessmentAt = Date.now() - 3000;
    await verify();
  })()`,
    context,
  );
  assert.equal(context.capturedCount, 4, 'stale readiness must not take photos');
  assert.match(nodes.get('status').textContent, /contorno esté verde/);
});

test('green readiness requires stable observations and resets on movement or stop', async () => {
  const { context, nodes } = createHarness();
  const scheduled = [];
  context.setTimeout = (fn) => {
    scheduled.push(fn);
    return scheduled.length;
  };
  context.clearTimeout = () => {};
  await vm.runInContext(
    `(async () => {
    await adapter.load();
    stream = { getTracks: () => [] };
    globalThis.assessment = { ready: true, message: 'Adecuado', box: { x:.3, y:.25, width:.4, height:.5 } };
    adapter.assess = async () => assessment;
    resumeMonitor();
  })()`,
    context,
  );
  for (let i = 0; i < 2; i++) await scheduled.shift()();
  assert.equal(nodes.get('captureHere').disabled, true);
  await scheduled.shift()();
  assert.equal(nodes.get('captureHere').disabled, false);
  assert.match(nodes.get('alignmentHint').textContent, /Ya puedes/);
  vm.runInContext('assessment.box.x = .35', context);
  await scheduled.shift()();
  assert.equal(
    nodes.get('captureHere').disabled,
    true,
    'movement invalidates green state',
  );
  vm.runInContext('assessment = {ready:false, message:"Acércate"}', context);
  await scheduled.shift()();
  assert.match(nodes.get('alignmentHint').textContent, /Acércate/);
  const oldTick = scheduled.shift();
  vm.runInContext('stop()', context);
  await oldTick();
  assert.equal(nodes.get('captureHere').disabled, true);
  assert.match(nodes.get('alignmentHint').textContent, /Activa la cámara/);
});

test('failed second reference reports the first as discarded and offers a full retry', async () => {
  const { context, nodes } = createHarness();
  await vm.runInContext(
    `(async () => {
    await adapter.load();
    prepareCapture = async () => true;
    resumeMonitor = () => {};
    stream = { getTracks: () => [] };
    globalThis.partialSample = {descriptor: new Float32Array(128).fill(1), image:'data:image/jpeg;base64,partial', capturedAt:new Date(), box:{x:.3,y:.25,width:.4,height:.5}, network:{status:'observed',ip:'8.8.8.8'}};
    let calls = 0;
    adapter.capture = async () => { if (calls++ === 0) return partialSample; throw new Error('Revisa el encuadre.'); };
    await enroll();
  })()`,
    context,
  );
  assert.match(nodes.get('captureOutcome').textContent, /foto 2/);
  assert.match(nodes.get('captureOutcome').textContent, /descartarán/);
  assert.equal(nodes.get('retryCapture').hidden, false);
  assert.equal(context.partialSample.image, '');
  assert.equal(context.partialSample.network, null);
  assert.equal(nodes.get('memoryCount').textContent, '0 referencias · 0/5 intentos');
});

test('persistent registration requests data after first photo and saves only a complete set', async () => {
  const { context } = createHarness();
  await vm.runInContext(
    `(async () => {
    await adapter.load();
    resumeMonitor = () => {};
    prepareCapture = async () => true;
    stream = {getTracks: () => []};
    globalThis.count = 0;
    globalThis.formAt = null;
    globalThis.savedCount = 0;
    window.IdentityWorkflow = {
      mode: 'register', ready: () => true,
      async afterFirstSample() { formAt = count; },
      async save(samples) { savedCount = samples.length; },
      onError() {}, reset() {},
    };
    adapter.assess = async () => ({ready:true});
    adapter.capture = async () => ({descriptor:new Float32Array(128),image:'data:image/jpeg;base64,' + (++count),capturedAt:new Date(),box:{x:.3,y:.25,width:.4,height:.5}});
    await enroll();
  })()`,
    context,
  );
  assert.equal(context.formAt, 1);
  assert.equal(context.savedCount, 3);
  assert.equal(context.count, 3);
});

test('persistent verification sends one fresh descriptor and clears its temporary photo', async () => {
  const { context } = createHarness();
  await vm.runInContext(
    `(async () => {
    await adapter.load();
    resumeMonitor = () => {};
    prepareCapture = async () => true;
    stream = {getTracks: () => []};
    globalThis.temp = {descriptor:new Float32Array(128).fill(.1),image:'data:image/jpeg;base64,temp',capturedAt:new Date(),box:{x:.3,y:.25,width:.4,height:.5}};
    globalThis.sent = 0;
    window.IdentityWorkflow = {
      mode:'verify', ready:()=>true,
      async verify(sample, current) { if(current()) sent++; return {match:true,threshold:.5,remaining:3,mean:.1}; },
      onError() {},reset() {},
    };
    adapter.capture = async () => temp;
    await verify();
    globalThis.retained = attempts.length;
  })()`,
    context,
  );
  assert.equal(context.sent, 1);
  assert.equal(context.temp.image, '');
  assert.ok(Array.from(context.temp.descriptor).every((x) => x === 0));
  assert.equal(context.retained, 0);
});
