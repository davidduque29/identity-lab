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

test('single accepted photo requests data then persists the same sample once', async () => {
  const { context, nodes } = createHarness();
  await vm.runInContext(
    `(async()=>{
    await adapter.load();resumeMonitor=()=>{};prepareCapture=async()=>true;
    stream={getTracks:()=>[]};globalThis.captures=0;globalThis.formAt=0;globalThis.saved=[];
    window.IdentityWorkflow={mode:'register',ready:()=>true,async afterFirstSample(s){formAt=captures;if(!s.image)throw new Error('missing photo');},async save(samples){saved=samples;},onError(){},reset(){}};
    adapter.capture=async()=>({descriptor:new Float32Array(128),image:'data:image/jpeg;base64,one',capturedAt:new Date(),box:{x:.3,y:.25,width:.4,height:.5},network:null});
    const original=adapter.capture;adapter.capture=async()=>{captures++;return original();};
    await enroll();globalThis.referencesCount=references.length;
  })()`,
    context,
  );
  assert.equal(context.captures, 1);
  assert.equal(context.formAt, 1);
  assert.equal(context.saved.length, 1);
  assert.equal(context.referencesCount, 1);
  assert.match(nodes.get('reference').textContent, /una foto/);
});

test('cancelled form discards the only sample and never saves a profile', async () => {
  const { context, nodes } = createHarness();
  await vm.runInContext(
    `(async()=>{
    await adapter.load();resumeMonitor=()=>{};prepareCapture=async()=>true;stream={getTracks:()=>[]};
    globalThis.saved=0;globalThis.sample={descriptor:new Float32Array(128).fill(.2),image:'temporary',capturedAt:new Date(),box:{x:.3,y:.25,width:.4,height:.5},network:{ip:'203.0.113.5'}};
    window.IdentityWorkflow={mode:'register',ready:()=>true,async afterFirstSample(){throw new Error('Cancelado');},async save(){saved++;},onError(){},reset(){}};
    adapter.capture=async()=>sample;await enroll();
  })()`,
    context,
  );
  assert.equal(context.saved, 0);
  assert.equal(context.sample.image, '');
  assert.equal(context.sample.network, null);
  assert.ok([...context.sample.descriptor].every((n) => n === 0));
  assert.equal(nodes.get('retryCapture').hidden, false);
});

test('persistent comparison uses a fresh photo, displays percentage and always discards it', async () => {
  const { context, nodes } = createHarness();
  await vm.runInContext(
    `(async()=>{
    await adapter.load();resumeMonitor=()=>{};prepareCapture=async()=>true;stream={getTracks:()=>[]};
    globalThis.sent=0;globalThis.sample={descriptor:new Float32Array(128).fill(.2),image:'new-temporary-photo',capturedAt:new Date(),box:{x:.3,y:.25,width:.4,height:.5}};
    window.IdentityWorkflow={mode:'verify',ready:()=>true,async verify(s,current){if(s===sample&&current())sent++;return {match:true,similarity:82,remaining:3};},onError(){},reset(){}};
    adapter.capture=async()=>sample;await verify();
  })()`,
    context,
  );
  assert.equal(context.sent, 1);
  assert.equal(context.sample.image, '');
  assert.ok([...context.sample.descriptor].every((n) => n === 0));
  const collect = (n) => [n.textContent || '', ...(n.children || []).flatMap(collect)];
  const texts = collect(nodes.get('result'));
  assert.ok(texts.includes('82%'));
  assert.ok(texts.some((t) => t.includes('No es una probabilidad')));
  assert.ok(!texts.some((t) => /[Uu]mbral|[Dd]istancia/.test(t)));
});

test('green readiness needs stable observations and updates guidance above the frame', async () => {
  const { context, nodes } = createHarness(),
    scheduled = [];
  context.setTimeout = (fn) => {
    scheduled.push(fn);
    return scheduled.length;
  };
  context.clearTimeout = () => {};
  await vm.runInContext(
    `(async()=>{
    await adapter.load();window.IdentityWorkflow={mode:'register',ready:()=>true};stream={getTracks:()=>[]};
    globalThis.assessment={ready:true,message:'Adecuado',box:{x:.3,y:.25,width:.4,height:.5}};adapter.assess=async()=>assessment;resumeMonitor();
  })()`,
    context,
  );
  for (let i = 0; i < 2; i++) await scheduled.shift()();
  assert.equal(nodes.get('captureHere').disabled, true);
  await scheduled.shift()();
  assert.equal(nodes.get('captureHere').disabled, false);
  assert.match(nodes.get('alignmentHint').textContent, /Ya puedes/);
  assert.equal(
    nodes.get('alignmentHint').textContent,
    nodes.get('cameraPrompt').textContent,
  );
  vm.runInContext('assessment.box.x=.35', context);
  await scheduled.shift()();
  assert.equal(nodes.get('captureHere').disabled, true);
  vm.runInContext('stop()', context);
  assert.equal(nodes.get('captureHere').disabled, true);
});

test('cancellation during inference cannot restore a photo after clearing the screen', async () => {
  const { context } = createHarness();
  await vm.runInContext(
    `(async()=>{
    await adapter.load();resumeMonitor=()=>{};prepareCapture=async()=>true;stream={getTracks:()=>[]};
    window.IdentityWorkflow={mode:'register',ready:()=>true,async afterFirstSample(){},async save(){throw new Error('must not save');},onError(){},reset(){}};
    let resolve;adapter.capture=()=>new Promise(r=>{resolve=r;});const pending=enroll();await Promise.resolve();reset();
    globalThis.late={descriptor:new Float32Array(128).fill(1),image:'late',capturedAt:new Date(),box:{x:.3,y:.25,width:.4,height:.5}};resolve(late);await pending;
  })()`,
    context,
  );
  assert.equal(context.late.image, '');
  assert.ok([...context.late.descriptor].every((n) => n === 0));
});

test('missing workflow cannot silently fall back to a registration without the form', async () => {
  const { context, nodes } = createHarness();
  await vm.runInContext(
    `(async()=>{stream={getTracks:()=>[]};globalThis.calls=0;adapter.capture=async()=>{calls++;};await enroll();await verify();})()`,
    context,
  );
  assert.equal(context.calls, 0);
  assert.match(nodes.get('status').textContent, /Recarga/);
  assert.equal(nodes.get('start').disabled, true);
});

test('default entry initializes the full workflow without randomUUID and opens the data form after acceptance', async () => {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const fields = Object.fromEntries(
    ['birthDate', 'consent', 'updateRecord'].map((k) => [k, new Element()]),
  );
  fields.consent.checked = true;
  fields.updateRecord.checked = false;
  get('identityForm').elements = fields;
  const calls = [];
  const webcrypto = require('node:crypto').webcrypto;
  const context = vm.createContext({
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelector: () => ({ before() {} }),
      body: {
        append(node) {
          if (node.id) nodes.set(node.id, node);
        },
      },
    },
    window: {},
    location: { search: '' },
    URLSearchParams,
    Uint8Array,
    Date,
    crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    fetch: async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({ rules: { threshold: 0.5 }, session: null }),
      };
    },
    FormData: class {
      [Symbol.iterator]() {
        return Object.entries({
          firstName: 'Persona',
          lastName: 'Prueba',
          birthDate: '1990-01-01',
          documentType: 'CC',
          documentNumber: '123456',
          address: 'Dirección de prueba',
        })[Symbol.iterator]();
      }
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../public/workflow.js'), 'utf8'),
    context,
  );
  await new Promise(setImmediate);
  assert.equal(context.window.IdentityWorkflow.mode, 'register');
  assert.equal(context.window.IdentityWorkflow.ready(), true);
  assert.equal(get('compareHere').hidden, true);
  const formPromise = context.window.IdentityWorkflow.afterFirstSample({
    image: 'data:image/jpeg;base64,accepted',
  });
  assert.equal(get('registrationDialog').open, true);
  assert.match(get('identityTitle').textContent, /Completa tus datos/);
  assert.equal(get('registrationPreview').src, 'data:image/jpeg;base64,accepted');
  assert.deepEqual(calls, ['/api/lab?action=context']);
  await get('identityForm').onsubmit({ preventDefault() {} });
  await formPromise;
  assert.equal(get('registrationDialog').open, false);
});
