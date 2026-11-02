const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../public/capture-quality.js'), 'utf8'),
  sandbox,
);
const quality = sandbox.module.exports;

const good = {
  faces: 1,
  box: { x: 0.3, y: 0.25, width: 0.4, height: 0.5 },
  roll: 0,
  yaw: 0.05,
  brightness: 120,
};

const cases = [
  ['no-face', { faces: 0 }],
  ['multiple', { faces: 2 }],
  ['cropped', { box: { x: 0, y: 0.25, width: 0.4, height: 0.5 } }],
  ['too-close', { box: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 } }],
  ['too-far', { box: { x: 0.4, y: 0.35, width: 0.2, height: 0.3 } }],
  ['left', { box: { x: 0.05, y: 0.25, width: 0.4, height: 0.5 } }],
  ['right', { box: { x: 0.55, y: 0.25, width: 0.4, height: 0.5 } }],
  ['high', { box: { x: 0.3, y: 0.03, width: 0.4, height: 0.5 } }],
  ['low', { box: { x: 0.3, y: 0.45, width: 0.4, height: 0.5 } }],
  ['tilt', { roll: 20 }],
  ['turned', { yaw: 0.5 }],
  ['dark', { brightness: 25 }],
  ['bright', { brightness: 245 }],
  ['pose-unknown', { roll: NaN }],
];

for (const [code, input] of cases) {
  test(`capture guidance rejects ${code}`, () => {
    const actual = quality.evaluate({ ...good, ...input });
    assert.equal(actual.ready, false);
    assert.equal(actual.code, code);
    assert.ok(actual.message.length > 10);
  });
}

test('centered, frontal and illuminated face is ready', () => {
  assert.equal(quality.evaluate(good).ready, true);
});
