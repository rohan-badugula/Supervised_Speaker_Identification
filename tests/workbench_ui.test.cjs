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
      value: '', hidden: true, open: false, checked:false, textContent: '', innerHTML:'',
      classList: {toggle() {}},
      addEventListener(type, callback) { this['on'+type] = callback; },
      showModal() { this.open = true; },
      setAttribute(name,value) { this[name]=value; },
      getAttribute(name) { return this[name] ?? ''; },
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
    console, sessionStorage:{values:new Map(),getItem(key){return this.values.get(key)||null;},setItem(key,value){this.values.set(key,value);}},
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


test('Visible progress shows measured stage counts rather than an invented overall percentage', () => {
  const {context} = app();
  const markup = vm.runInContext(`jobProgressMarkup({status:'running',stage:'Detecting speech',model:'community-1',
    progress:{phase:'segmentation',completed:2,total:8,unit:'chunks'},events:[]})`, context);
  assert.match(markup, /2 of 8 chunks · 25% of this stage/);
  assert.match(markup, /value="2" max="8"/);
  assert.match(markup, /data-job-heartbeat/);
});

test('Unmeasured preparation stays indeterminate and failures are explicit', () => {
  const {context} = app();
  const loading = vm.runInContext(`jobProgressMarkup({status:'running',stage:'Preparing model',model:'community-1',progress:{phase:'model_loading'}})`, context);
  assert.match(loading, /does not report a total/);
  assert.doesNotMatch(loading, /value="0"|100%/);
  const failed = vm.runInContext(`jobProgressMarkup({status:'failed',stage:'Processing failed',failed_stage:'Preparing model',model:'community-1',error:'Access denied'})`, context);
  assert.match(failed, /This run is no longer running/);
  assert.match(failed, /Access denied/);
  assert.match(failed, /Review settings &amp; retry|Review settings & retry/);
});

function meeting(context, {health={ffmpeg:true,audio:true,token:true,ecapa:false}, jobs=[], collections=[]}={}) {
  context.fixture={health,jobs,collections};
  vm.runInContext(`state.media={id:'meeting-a',role:'meeting',name:'Sample meeting.wav',duration:3600};
    state.data={...fixture,server:{protocol:1,restart_required:false},models:[{key:'community-1'},{key:'community-1-ecapa',embedding_model:'ecapa'}]};
    restoreRunChoices(); updateRunReview();`,context);
}

test('First analysis needs no voice collection and defaults to a five-minute preview', () => {
  const {context,elements}=app(); meeting(context);
  assert.equal(elements.get('analysis-duration').value,'300');
  assert.equal(elements.get('mode-anonymous').checked,true);
  assert.equal(elements.get('collection-options').hidden,true);
  assert.equal(elements.get('run-button').disabled,false);
  assert.match(elements.get('run-summary').innerHTML,/00:00–05:00/);
  elements.get('mode-enrolled').checked=true;
  elements.get('mode-enrolled').onchange();
  assert.equal(elements.get('collection-options').hidden,false);
  assert.equal(elements.get('run-button').disabled,true);
  assert.match(elements.get('run-blocker').textContent,/compatible voice collection/);
});

test('Setup blockers disable analysis before submission and keep playback available', async () => {
  const {context,elements}=app(); meeting(context,{health:{ffmpeg:true,audio:true,token:false}});
  vm.runInContext('updateSetup()',context);
  assert.equal(elements.get('readiness-banner').hidden,false);
  assert.match(elements.get('readiness-detail').textContent,/playback and labeling are still available/);
  assert.equal(elements.get('run-button').disabled,true);
  elements.get('run-dialog').open=true;
  context.fetch=()=>assert.fail('Must not submit a job with known missing setup');
  await vm.runInContext('runJob()',context);
  assert.match(elements.get('run-error').textContent,/HF_TOKEN/);
  assert.equal(elements.get('player').disabled,undefined);
});

test('Run drafts survive re-opening and refresh in this tab and remain scoped to their recording', () => {
  const {context,elements}=app(); meeting(context);
  elements.get('analysis-duration').value='custom';
  elements.get('analysis-start').value='12';
  elements.get('analysis-length').value='3';
  elements.get('analysis-length').oninput();
  vm.runInContext("state.runDrafts={}; state.media.id='meeting-b'; restoreRunChoices()",context);
  assert.equal(elements.get('analysis-duration').value,'300');
  vm.runInContext("state.media.id='meeting-a'; restoreRunChoices(); updateRangeHint()",context);
  assert.equal(elements.get('analysis-start').value,'12');
  assert.equal(elements.get('analysis-length').value,'3');
  assert.match(elements.get('run-summary').innerHTML,/12:00–15:00/);
});

test('Retry restores the failed run configuration, including enrolled voices and range', () => {
  const {context,elements}=app(); meeting(context,{collections:[{id:'voices',name:'Reference voices',model:'community-1',speakers:[{name:'Person 1'}]}]});
  vm.runInContext(`openRunSettings({model:'community-1',collection_id:'voices',start_seconds:900,duration_seconds:120,threshold:.7,margin:.1,min_speakers:2,max_speakers:5})`,context);
  assert.equal(elements.get('mode-enrolled').checked,true);
  assert.equal(elements.get('collection-select').value,'voices');
  assert.equal(elements.get('analysis-duration').value,'custom');
  assert.equal(elements.get('analysis-start').value,'15');
  assert.equal(elements.get('analysis-length').value,'2');
  assert.equal(elements.get('threshold').value,'0.7');
  assert.equal(elements.get('run-dialog').open,true);
  assert.equal(elements.get('run-button').disabled,false);
});

test('A model switch never silently falls back from identification to anonymous analysis', () => {
  const {context,elements}=app(); meeting(context,{health:{ffmpeg:true,audio:true,token:true,ecapa:true},collections:[{id:'voices',name:'Native voices',model:'community-1',speakers:[]}]});
  elements.get('mode-enrolled').checked=true;
  elements.get('collection-select').value='voices';
  elements.get('model-select').value='community-1-ecapa';
  elements.get('model-select').onchange();
  assert.equal(elements.get('mode-enrolled').checked,true);
  assert.equal(elements.get('run-button').disabled,true);
  assert.match(elements.get('run-blocker').textContent,/compatible voice collection/);
});

test('An older result is explicitly distinguished from the latest failed run and partial scope', () => {
  const {context,elements}=app(); meeting(context,{jobs:[{id:'failed',media_id:'meeting-a',status:'failed',model:'community-1'}]});
  vm.runInContext(`state.jobId='saved'; state.report={mode:'anonymous',model:'community-1',analysis_range:{start_seconds:600,end_seconds:900,full_recording:false}};updateResultContext()`,context);
  assert.equal(elements.get('result-context').hidden,false);
  assert.match(elements.get('result-context').innerHTML,/SECTION ONLY · 10:00–15:00/);
  assert.match(elements.get('result-context').innerHTML,/latest run did not finish/);
});

test('Returning from setup reopens settings without discarding the chosen section', () => {
  const {context,elements}=app(); meeting(context);
  elements.get('analysis-duration').value='600';
  elements.get('run-dialog').open=true;
  vm.runInContext('openSetup(true)',context);
  assert.equal(elements.get('run-dialog').open,false);
  assert.equal(elements.get('setup-dialog').open,true);
  elements.get('setup-dialog').onclose();
  assert.equal(elements.get('run-dialog').open,true);
  assert.equal(elements.get('analysis-duration').value,'600');
});

test('Reference profile building requires a clean included clip', () => {
  const {context,elements}=app(); meeting(context);
  vm.runInContext("state.media.role='reference'; state.annotations=[{flag:'overlap',included:true}]; updateRunReview()",context);
  assert.equal(elements.get('run-button').disabled,true);
  assert.match(elements.get('run-blocker').textContent,/included clean reference clip/);
  vm.runInContext("state.annotations.push({flag:'clean',included:true}); updateRunReview()",context);
  assert.equal(elements.get('run-button').disabled,false);
});

test('A bounded run covering a short recording does not imply missing audio', () => {
  const {context,elements}=app(); meeting(context);
  vm.runInContext("state.media.duration=12; showAnalysisScope({analysis_range:{start_seconds:0,end_seconds:12,full_recording:false}})",context);
  assert.match(elements.get('analysis-scope').textContent,/covers the complete recording/);
  assert.doesNotMatch(elements.get('analysis-scope').textContent,/rest has not/);
});

test('Starting a new run keeps the previous displayed result explicitly labeled', () => {
  const {context,elements}=app(); meeting(context,{jobs:[{id:'new',media_id:'meeting-a',status:'running',model:'community-1'}]});
  vm.runInContext("state.jobId='new'; state.report={job_id:'old',mode:'anonymous',model:'community-1'};updateResultContext()",context);
  assert.match(elements.get('result-context').innerHTML,/new run is processing; this is the previous saved result/);
});

test('Corrections target the displayed report even when a different run is active', async () => {
  const {context,elements}=app(); meeting(context);
  vm.runInContext("state.jobId='new'; state.report={job_id:'displayed',revision:2};state.labels={0:'Person 2'};renderSegments=()=>{};renderTimeline=()=>{}",context);
  let endpoint;
  context.fetch=async (path)=>{endpoint=path;return {ok:true,json:async()=>({job_id:'displayed',revision:3})};};
  await elements.get('save-corrections').onclick();
  assert.equal(endpoint,'/api/report/displayed');
});
