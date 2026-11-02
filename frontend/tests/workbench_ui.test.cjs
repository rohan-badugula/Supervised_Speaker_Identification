const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../speaker_frontend/static');

function app() {
  const elements = new Map();
  for (const [, id] of fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)) {
    elements.set(id, {
      value: '', hidden: true, open: false, textContent: '',
      volume:1,muted:false,readyState:4,paused:true,currentTime:0,
      style:{setProperty(){}},classList:{toggle(){}},
      addEventListener(name,callback){this['on'+name]=callback;},
      setAttribute(name,value){this[name]=value;},
      removeAttribute(name){delete this[name];},
      click(){return this.onclick?.();},
      play(){this.paused=false;return Promise.resolve();},
      pause(){this.paused=true;},
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

test('Corrections still target the displayed report after restoring the earlier UI', async () => {
  const {context,elements}=app();
  vm.runInContext("state.jobId='active'; state.report={job_id:'displayed',revision:2};state.labels={0:'Person 2'};renderSegments=()=>{};renderTimeline=()=>{}",context);
  let endpoint;
  context.fetch=async path=>{endpoint=path;return {ok:true,json:async()=>({job_id:'displayed',revision:3})};};
  await elements.get('save-corrections').onclick();
  assert.equal(endpoint,'/api/report/displayed');
});

test('Sidebar hides sub-second detections without changing source indices or output', () => {
  const {context}=app();
  vm.runInContext("var turns=[{start:0,end:.4},{start:2.1,end:3.1},{start:4,end:4.999},{start:5,end:7}];",context);
  assert.equal(vm.runInContext('JSON.stringify(sidebarTurns(turns).map(row=>row.index))',context),'[1,3]');
  assert.equal(vm.runInContext('turns.length',context),4);
  assert.equal(vm.runInContext('sidebarTurns(turns,false,true).length',context),4);
  assert.equal(vm.runInContext('sidebarTurns(turns,true,false).length',context),4);
});

test('Tracker shows measured per-stage counts and keeps verbose details expanded', () => {
  const {context,elements}=app();
  vm.runInContext("state.data={worker:{ready:true}};var job={id:'job',kind:'identify',model:'community-1',status:'running',stage:'Extracting voice features',progress:{phase:'embeddings',completed:3,total:10,unit:'batches'},events:[]};renderJobTracker(job)",context);
  assert.match(elements.get('job-track-count').textContent,/3 \/ 10 batches · 30% of this stage/);
  assert.equal(elements.get('job-track-meter').value,3);
  assert.equal(elements.get('job-track-meter').max,10);
  elements.get('job-track-verbose').open=true;
  vm.runInContext('job.progress.completed=4;renderJobTracker(job)',context);
  assert.equal(elements.get('job-track-verbose').open,true);
  assert.match(elements.get('job-track-steps').innerHTML,/aria-current="step"[^>]*>Voice features/);
});

test('Unmeasured stages stay indeterminate; terminal and unavailable workers do not animate progress', () => {
  const {context,elements}=app();
  vm.runInContext("state.data={worker:{ready:true}};var job={id:'job',model:'community-1',status:'running',stage:'Preparing model',progress:{phase:'model_loading'},events:[]};renderJobTracker(job)",context);
  assert.equal(elements.get('job-track-meter').hidden,false);
  assert.equal(elements.get('job-track-meter').value,undefined);
  assert.match(elements.get('job-track-count').textContent,/no measured total/);
  vm.runInContext("state.data.worker.ready=false;renderJobTracker(job)",context);
  assert.equal(elements.get('job-track-meter').hidden,true);
  assert.match(elements.get('job-track-count').textContent,/Worker unavailable/);
  vm.runInContext("job.status='failed';job.error='Access denied';job.failed_stage='Preparing model';renderJobTracker(job)",context);
  assert.equal(elements.get('job-track-meter').hidden,true);
  assert.match(elements.get('job-track-count').textContent,/This run has stopped/);
  assert.equal(elements.get('job-track-error').textContent,'Access denied');
});

test('A later run tracker labels an older saved result without changing it', () => {
  const {context,elements}=app();
  vm.runInContext("state.data={worker:{ready:true}};state.report={job_id:'older',segments:[{start:0,end:.5}]};renderJobTracker({id:'new',model:'community-1',status:'running',progress:{phase:'segmentation'}})",context);
  assert.match(elements.get('job-track-context').textContent,/earlier saved result/);
  assert.equal(vm.runInContext('state.report.segments.length',context),1);
});

test('Seek slider uses seconds for precise movement in long recordings', () => {
  const {context,elements}=app();
  vm.runInContext("state.media={role:'meeting',duration:7200}",context);
  elements.get('player').duration=7200;
  elements.get('seek-position').value='3600.125';
  elements.get('seek-position').oninput();
  assert.equal(elements.get('player').currentTime,3600.125);
  elements.get('player').currentTime=4;
  elements.get('skip-back').onclick();
  assert.equal(elements.get('player').currentTime,0);
});

test('Mute and zero-volume recovery restore an audible level', () => {
  const {context,elements}=app();
  elements.get('player').volume=.4;
  elements.get('mute-toggle').onclick();
  assert.equal(elements.get('player').muted,true);
  elements.get('mute-toggle').onclick();
  assert.equal(elements.get('player').volume,.4);
  elements.get('volume').value='0';elements.get('volume').oninput();
  assert.equal(elements.get('player').muted,true);
  elements.get('mute-toggle').onclick();
  assert.equal(elements.get('player').muted,false);
  assert.equal(elements.get('player').volume,.4);
});

test('Fullscreen targets the player shell and exits through the document API', async () => {
  const {context,elements}=app();
  vm.runInContext("state.media={video:true}",context);
  let requested=0,exited=0;
  elements.get('player-shell').requestFullscreen=async()=>{requested++;context.document.fullscreenElement=elements.get('player-shell');};
  context.document.exitFullscreen=async()=>{exited++;context.document.fullscreenElement=null;};
  await elements.get('fullscreen').onclick();
  assert.equal(requested,1);
  assert.equal(elements.get('fullscreen').textContent,'Exit fullscreen');
  await elements.get('fullscreen').onclick();
  assert.equal(exited,1);
  assert.equal(elements.get('fullscreen').textContent,'Fullscreen');
});

test('Safari native-video fullscreen is a fallback, and native controls are restored on exit', async () => {
  const {context,elements}=app();
  vm.runInContext("state.media={video:true}",context);
  let entered=0;
  elements.get('player').webkitEnterFullscreen=()=>{entered++;};
  await elements.get('fullscreen').onclick();
  assert.equal(entered,1);
  assert.equal(elements.get('player').controls,true);
  elements.get('player').onwebkitendfullscreen();
  assert.equal(elements.get('player').controls,false);
  assert.equal(elements.get('fullscreen').textContent,'Fullscreen');
});

test('Fullscreen handles prefixed container APIs and blocked requests visibly', async () => {
  const {context,elements}=app();
  vm.runInContext("state.media={video:true}",context);
  let called=0;
  elements.get('player-shell').webkitRequestFullscreen=()=>{called++;};
  await elements.get('fullscreen').onclick();
  assert.equal(called,1);
  elements.get('player-shell').webkitRequestFullscreen=()=>{throw new Error('Blocked');};
  await elements.get('fullscreen').onclick();
  assert.equal(elements.get('error-banner').hidden,false);
  assert.match(elements.get('error-text').textContent,/Could not change fullscreen: Blocked/);
});

test('Native fullscreen is not marked active until the browser confirms entry', async () => {
  const {context,elements}=app();
  vm.runInContext("state.media={video:true}",context);
  elements.get('player').webkitEnterFullscreen=()=>{};
  await elements.get('fullscreen').onclick();
  assert.equal(elements.get('fullscreen').textContent,'Fullscreen');
  elements.get('player').onwebkitbeginfullscreen();
  assert.equal(elements.get('fullscreen').textContent,'Exit fullscreen');
});

test('Legacy WebKit container fullscreen works even if the standard API is disabled', async () => {
  const {context,elements}=app();
  vm.runInContext("state.media={video:true};document.fullscreenEnabled=false;document.webkitFullscreenEnabled=true",context);
  let entered=0;
  elements.get('player-shell').webkitRequestFullScreen=()=>{entered++;};
  await elements.get('fullscreen').onclick();
  assert.equal(entered,1);
});

test('Heartbeat polling does not rebuild library controls or lose their focus', () => {
  const {context}=app();
  vm.runInContext("var first={media:[],collections:[],jobs:[{id:'j',status:'running',heartbeat_at:'before'}]};var second={media:[],collections:[],jobs:[{id:'j',status:'running',heartbeat_at:'after'}]}",context);
  assert.equal(vm.runInContext('catalogViewSignature(first)===catalogViewSignature(second)',context),true);
  vm.runInContext("second.jobs[0].status='completed'",context);
  assert.equal(vm.runInContext('catalogViewSignature(first)===catalogViewSignature(second)',context),false);
});
