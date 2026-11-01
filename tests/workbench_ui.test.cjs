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
  vm.runInContext("state.media = {id:'test',role:'meeting'}; state.data = {jobs:[],server:{protocol:1,restart_required:false}};", context);
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

test('Preview presets and custom ranges send seconds to the server', () => {
  const {context, elements} = app();
  vm.runInContext("state.media = {duration:3600}", context);
  elements.get('analysis-duration').value = '600';
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(selectedRange())', context)),
    {start_seconds:0, duration_seconds:600});
  elements.get('analysis-duration').value = 'custom';
  elements.get('analysis-start').value = '5';
  elements.get('analysis-length').value = '10';
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(selectedRange())', context)),
    {start_seconds:300, duration_seconds:600});
  elements.get('analysis-length').value = '0';
  assert.throws(() => vm.runInContext('selectedRange()', context), /greater than zero/);
});

test('Custom ranges can start at the playhead and previews are labeled', () => {
  const {context, elements} = app();
  vm.runInContext("state.media = {duration:3600}", context);
  elements.get('player').currentTime = 1500;
  elements.get('range-from-playhead').onclick();
  assert.equal(elements.get('analysis-duration').value, 'custom');
  assert.match(elements.get('analysis-range-hint').textContent, /25:00–35:00/);
  vm.runInContext('showAnalysisScope({analysis_range:{start_seconds:1500,end_seconds:2100,full_recording:false}})', context);
  assert.equal(elements.get('analysis-scope').hidden, false);
  assert.match(elements.get('analysis-scope').textContent, /rest has not been analyzed/);
});


test('Outdated workers cannot silently receive another analysis request', async () => {
  for (const server of [null, {protocol:1,restart_required:true}]) {
    const {context, elements} = app();
    elements.get('run-dialog').open = true;
    vm.runInContext("state.media = {id:'test',role:'meeting'}; state.data = {jobs:[]};", context);
    context.server = server;
    vm.runInContext('state.data.server = server', context);
    context.fetch = () => assert.fail('Outdated server must not receive a new job');
    await vm.runInContext('runJob()', context);
    assert.match(elements.get('run-error').textContent, /Server restart required/);
    assert.equal(elements.get('run-error').hidden, false);
  }
});
