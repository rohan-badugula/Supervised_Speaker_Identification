const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../src/speaker_id/workbench/static');

function app() {
  const elements = new Map();
  for (const [, id] of fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) {
    elements.set(id, {
      value: '', hidden: true, open: false, textContent: '',
      focus() { this.focused = true; },
      scrollIntoView() { this.scrolled = true; },
      close() { this.open = false; },
      querySelectorAll() { return []; },
    });
  }
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id), querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {}, confirm: () => true },
    fetch: () => new Promise(() => {}), setInterval() {}, setTimeout() {}, clearTimeout() {},
    console,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context);
  return {context, elements};
}

test('Analyze exposes setup rejection inside the open dialog', async () => {
  const {context, elements} = app();
  elements.get('run-dialog').open = true;
  elements.get('model-select').value = 'community-1';
  elements.get('threshold').value = '0.55';
  elements.get('margin').value = '0.08';
  context.fetch = async () => ({ok: false, json: async () => ({
    error: 'Analysis cannot start until local setup is complete.', code: 'setup_required',
    issues: ['Set HF_TOKEN in the server terminal, then restart.'],
  })});
  vm.runInContext("state.media = {id:'test',role:'meeting'}; state.data = {jobs:[]};", context);
  await vm.runInContext('runJob()', context);
  const banner = elements.get('run-error');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /HF_TOKEN/);
  assert.equal(banner.focused, true);
  assert.equal(banner.scrolled, true);
  assert.equal(elements.get('error-banner').hidden, true);
  assert.equal(elements.get('run-button').disabled, false);
});

test('Run validation errors remain visible without closing the dialog', () => {
  const {context, elements} = app();
  elements.get('run-dialog').open = true;
  vm.runInContext("fail(new Error('Choose compatible profiles.'))", context);
  assert.equal(elements.get('run-dialog').open, true);
  assert.equal(elements.get('run-error').textContent, 'Choose compatible profiles.');
});

test('Errors outside the run dialog use the page alert', () => {
  const {context, elements} = app();
  vm.runInContext("fail(new Error('Upload failed.'))", context);
  assert.equal(elements.get('error-banner').hidden, false);
  assert.equal(elements.get('error-text').textContent, 'Upload failed.');
});
