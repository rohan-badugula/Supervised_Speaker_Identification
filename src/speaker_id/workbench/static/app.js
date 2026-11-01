'use strict';
const $ = (id) => document.getElementById(id);
const state = {data:null, view:'meetings', media:null, report:null, jobId:null, annotations:[], dirty:false, labels:{}, rows:100, clipEnd:null, csrf:'', uploading:false};
const titles = {meetings:['Sessions','Every voice has a place in the conversation.'],references:['Reference room','A place to collect the voices you want to recognize.'],profiles:['Voice bank','Familiar voices, ready for the next conversation.'],jobs:['Run history','Every analysis, with a record of how it went.']};
const palette = ['#c6cce9','#d9b89a','#b7d6c2','#d7bfd9','#dcb3aa','#cfdb9c','#abd0cf','#d6ccae'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const color = (name) => {let hash=0;for(const c of name) hash=(hash*31+c.charCodeAt(0))>>>0;return palette[hash%palette.length];};
const time = (value) => {if(!Number.isFinite(value)) return '--:--';const n=Math.max(0,value);return `${Math.floor(n/3600)?`${Math.floor(n/3600)}:`:''}${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(Math.floor(n)%60).padStart(2,'0')}`;};
const precise = (n) => `${time(n)}.${String(Math.round((n%1)*1000)).padStart(3,'0')}`;
const size = (n) => n>=1024**3?`${(n/1024**3).toFixed(1)} GB`:`${(n/1024**2).toFixed(1)} MB`;
function fail(error) {
  const message = [error.message || String(error), ...(error.details?.issues || [])].join('\n');
  if ($('run-dialog').open) {
    const banner = $('run-error');
    banner.textContent = message;
    banner.hidden = false;
    banner.focus();
    banner.scrollIntoView({block: 'nearest'});
    return;
  }
  $('error-text').textContent = message;
  $('error-banner').hidden = false;
  $('error-banner').scrollIntoView({block: 'nearest'});
}
let toastTimer;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3200);}
async function api(path,body){const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Token':state.csrf},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){const error=new Error(data.error||'Request failed');error.details=data;throw error;}return data;}
function unsaved(){return state.dirty||Object.keys(state.labels).length>0;}
function allowLeave(){return !unsaved()||window.confirm('Discard unsaved labels or corrections?');}
function markDirty(){state.dirty=true;$('save-status').textContent='Unsaved labels';}
async function refresh(){const next=await api('/api/state');const changed=JSON.stringify(next)!==JSON.stringify(state.data);state.data=next;state.csrf=state.data.csrf;$('server-update').hidden=!serverNeedsRestart();$('connection-state').textContent='● LOCALHOST CONNECTED';updateCounts();updateSetup();updateCurrentJob();if(!state.media){if(changed)renderPage();}else{updateRunHistory();const job=state.data.jobs.find(j=>j.id===state.jobId);if(job?.status==='completed'&&job.report&&state.report?.job_id!==job.id&&!unsaved())await loadReport(job.id);}}
function updateCounts(){for(const [key,role] of [['meeting-count','meeting'],['reference-count','reference']])$(key).textContent=state.data.media.filter(m=>m.role===role).length;$('job-count').textContent=state.data.jobs.filter(j=>['queued','running'].includes(j.status)).length;}
function setupIssues() {
  const h = state.data?.health;
  const issues = [];
  if (serverNeedsRestart()) issues.push('Restart the server to load the updated worker.');
  if (!h) return issues;
  if (!h.ffmpeg) issues.push('Install audio extraction support (FFmpeg).');
  if (!h.audio) issues.push('Install Community-1 audio dependencies.');
  const spec = state.data.models?.find(m => m.key === $('model-select').value);
  if (spec?.embedding_model && !h.ecapa) issues.push('Install ECAPA dependencies for the selected model.');
  if (!h.token) issues.push('Set HF_TOKEN in the server terminal, then restart.');
  return issues;
}
function updateSetup() {
  const h = state.data?.health;
  if (!h) return;
  const issues = setupIssues();
  $('setup-dot').classList.toggle('ready', !issues.length);
  $('setup-checks').innerHTML = [['FFmpeg audio extraction',h.ffmpeg],['Community-1 dependencies',h.audio],['ECAPA dependencies (optional)',h.ecapa],['Hugging Face token configured',h.token]].map(([label,ok]) => `<div class="setup-check ${ok?'good':''}"><span>${esc(label)}</span><span>${ok?'Configured':'Not configured'}</span></div>`).join('');
  const detail = issues.length ? issues.join(' ') : 'Local dependencies and token are configured. Model access is checked on first load; CPU processing may take time.';
  $('runtime-note').textContent = detail;
  $('runtime-note').classList.toggle('ready', !issues.length);
  $('runtime-setup').hidden = !issues.length;
  $('readiness-banner').hidden = !issues.length;
  $('readiness-title').textContent = 'Analysis setup needs attention';
  $('readiness-detail').textContent = detail + ' Import, playback and labeling are still available.';
  updateRunReview();
}
function showView(view){if(!allowLeave())return false;state.view=view;state.media=null;state.report=null;state.jobId=null;state.dirty=false;state.labels={};$('player').pause();$('player').removeAttribute('src');$('player').load();document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));$('page-title').textContent=titles[view][0];$('page-description').textContent=titles[view][1];$('upload-button').hidden=!['meetings','references'].includes(view);$('upload-button').textContent=view==='references'?'＋ Import reference':'＋ Import media';renderPage();return true;}
function renderPage() {
  syncShell();
  updateCurrentJob();
  const workspace = !!state.media;
  $('workspace').hidden = !workspace;
  $('library').hidden = workspace || !['meetings', 'references'].includes(state.view);
  $('profiles-page').hidden = workspace || state.view !== 'profiles';
  $('jobs-page').hidden = workspace || state.view !== 'jobs';
  if (workspace) return;
  if (state.view === 'profiles') return renderProfiles();
  if (state.view === 'jobs') return renderJobs();
  const reference = state.view === 'references';
  const role = reference ? 'reference' : 'meeting';
  const media = state.data.media.filter(item => item.role === role);
  if (!media.length) {
    $('library').innerHTML = `
      <div class="archive-intro">
        <div class="archive-story">
          <span class="story-index">${reference ? '01 / BUILD YOUR CAST' : '01 / START A SESSION'}</span>
          <h2>${reference ? 'Familiar voices.<br><em>A little context goes a long way.</em>' : 'Listen back.<br><em>See who spoke.</em>'}</h2>
          <p>${reference ? 'A few clean clips connect a voice to a label. Save the collection, then bring it to your next meeting.' : 'A shared microphone captures the room. Give each voice its own place on the timeline.'}</p>
        </div>
        <div class="import-desk" id="drop-zone">
          <div class="import-symbol" aria-hidden="true">↥</div>
          <h3>${reference ? 'Bring a reference recording' : 'Bring your first recording'}</h3>
          <p>Drop an audio or video file here. The original stays on this computer, ready to play.</p>
          <button class="primary" id="empty-upload">Choose a file <span aria-hidden="true">↗</span></button>
          <p class="fine">MP3 / MP4 / WAV / M4A + MORE · UP TO 4 GiB</p>
        </div>
      </div>
      <div class="archive-guide">
        <div><strong>01</strong><section><h3>${reference ? 'Mark the clean parts' : 'Keep the original'}</h3><p>${reference ? 'Set in and out points around one person speaking.' : 'Listen or watch without making a separate playback copy.'}</p></section></div>
        <div><strong>02</strong><section><h3>${reference ? 'Give each voice a label' : 'Choose your cast'}</h3><p>${reference ? 'Person 1, Person 2 — real names are optional.' : 'Use saved voices, or start with anonymous speakers.'}</p></section></div>
        <div><strong>03</strong><section><h3>${reference ? 'Save for another session' : 'Review the conversation'}</h3><p>${reference ? 'Build profiles once and reuse them with the same model.' : 'Jump between turns, check overlaps, correct the labels.'}</p></section></div>
      </div>`;
    $('empty-upload').onclick = () => $('file-input').click();
    const zone = $('drop-zone');
    zone.ondragover = event => { event.preventDefault(); zone.classList.add('dragging'); };
    zone.ondragleave = () => zone.classList.remove('dragging');
    zone.ondrop = event => {
      event.preventDefault(); zone.classList.remove('dragging');
      if (event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]);
    };
    return;
  }
  $('library').innerHTML = `
    <div class="library-heading"><h3>${reference ? 'REFERENCE RECORDINGS' : 'SESSION INDEX'} / ${String(media.length).padStart(2, '0')}</h3><span>ORIGINALS KEPT LOCALLY</span></div>
    <div class="recording-list">${media.map((item, index) => {
      const job = state.data.jobs.find(job => job.media_id === item.id);
      const status = reference ? `${item.annotations.length} reference clips` : job?.status === 'completed' ? 'Ready to review' : job ? job.status : 'Not analyzed';
      return `<button class="recording-card" data-media="${esc(item.id)}">
        <span class="session-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="session-title"><strong>${esc(item.name)}</strong><small>${item.video ? 'VIDEO' : 'AUDIO'} / ${esc(item.name.split('.').pop().toUpperCase())} / ${size(item.size)} / ${new Date(item.updated).toLocaleDateString()}</small></span>
        <span class="session-status">${esc(status)}</span>
        <span class="session-duration">${item.duration ? time(item.duration) : '—'}</span>
        <span class="card-arrow" aria-hidden="true">↗</span>
      </button>`;
    }).join('')}</div><div class="library-tail">${reference ? 'Open a recording to mark clips and build a voice collection.' : 'Open a session to listen, analyze and review.'}</div>`;
  $('library').querySelectorAll('[data-media]').forEach(button => button.onclick = () => openMedia(button.dataset.media));
}
async function openMedia(id,jobId=null){if(!allowLeave())return;const media=state.data.media.find(m=>m.id===id);if(!media)return;state.media=media;state.report=null;state.annotations=structuredClone(media.annotations);state.dirty=false;state.labels={};state.rows=100;state.jobId=jobId;state.clipEnd=null;const ref=media.role==='reference';state.view=ref?'references':'meetings';document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));$('page-title').textContent=titles[state.view][0];$('page-description').textContent=titles[state.view][1];$('upload-button').hidden=false;$('upload-button').textContent=ref?'＋ Import reference':'＋ Import media';renderPage();$('recording-name').textContent=media.name;$('recording-meta').textContent=`${media.video?'Video':'Audio'} · ${size(media.size)} · ${media.duration?time(media.duration):'Loading duration…'}`;$('recording-type').textContent=ref?'REFERENCE':'MEETING';$('save-status').textContent='';$('analysis-scope').hidden=true;$('reference-editor').hidden=!ref;$('enrollment-options').hidden=!ref;$('meeting-options').hidden=ref;$('run-title').textContent=ref?'Build voice profiles':'Analyze recording';$('run-button').innerHTML=ref?'Build profiles <span aria-hidden="true">→</span>':'Analyze speakers <span aria-hidden="true">→</span>';$('save-labels').hidden=!ref;$('save-corrections').hidden=true;$('export-json').hidden=!ref||!media.annotations.length;$('export-json').href=`/api/labels/${media.id}`;$('export-csv').hidden=true;$('quality-heading').textContent=ref?'QUALITY':'MATCH';$('segments-description').textContent=ref?'Only included, clean clips are used for voice profiles.':'Edit a speaker label to correct a segment. The original prediction is preserved.';$('segment-search').value='';$('timeline-zoom').value='1';$('clip-start').value='';$('clip-end').value='';$('clip-speaker').value='Person 1';$('player').parentElement.classList.toggle('audio',!media.video);$('fullscreen').hidden=!media.video;$('media-format').textContent=media.name.split('.').pop().toUpperCase();$('player').src=`/api/media/${media.id}`;$('player').load();populateModels();populateCollections();restoreRunChoices();updateRangeHint();updateRunHistory();renderSegments();renderTimeline();updateCurrentJob();if(!ref){const latest=jobId?state.data.jobs.find(j=>j.id===jobId):state.data.jobs.find(j=>j.media_id===id&&j.status==='completed'&&j.report);if(latest?.status==='completed'&&latest.report)await loadReport(latest.id);}}
function populateModels(){const value=$('model-select').value||'community-1';$('model-select').innerHTML=state.data.models.map(m=>`<option value="${esc(m.key)}">${m.key==='community-1'?'Community-1':'Community-1 + ECAPA'}</option>`).join('');$('model-select').value=value;updateModelHint();}
function updateModelHint(){$('model-hint').textContent=$('model-select').value==='community-1'?'Diarization and identity matching with native speaker embeddings.':'Community-1 activity with ECAPA identity embeddings from clean regions.';updateSetup();}
function populateCollections() {
  const current = $('collection-select').value;
  const compatible = state.data.collections.filter(c => c.model === $('model-select').value);
  $('collection-select').innerHTML = '<option value="">Choose a collection…</option>' + compatible.map(c => `<option value="${esc(c.id)}">${esc(c.name)} · ${c.speakers.length} voices</option>`).join('');
  if (compatible.some(c => c.id === current)) $('collection-select').value = current;
  $('collection-hint').textContent = compatible.length ? 'Only collections built with this model are listed. Choose the voices you want to recognize.' : 'No compatible voice collection yet. Prepare reference clips, or choose Anonymous speakers to start now.';
  $('prepare-voices').hidden = compatible.length > 0;
}
function updateRunHistory(){if(!state.media)return;const runs=state.data.jobs.filter(j=>j.media_id===state.media.id&&j.report&&j.status==='completed');const selected=state.jobId;const signature=JSON.stringify([state.media.id,selected,runs.map(j=>[j.id,j.updated])]);if(signature===state.historySignature)return;state.historySignature=signature;$('run-history').hidden=!runs.length;$('run-history-label').hidden=!runs.length;$('run-history').innerHTML=runs.map(j=>`<option value="${esc(j.id)}">${esc(j.model)} · ${esc(rangeLabel(j))} · ${new Date(j.updated).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</option>`).join('');if(runs.some(j=>j.id===selected))$('run-history').value=selected;}
async function loadReport(id){const mediaId=state.media?.id;try{const report=await api(`/api/report/${id}`);if(state.media?.id!==mediaId)return;state.report=report;showAnalysisScope(report);state.jobId=id;state.labels={};state.rows=100;$('save-corrections').hidden=false;$('export-json').hidden=false;$('export-csv').hidden=false;$('export-json').href=`/api/export/${id}/json`;$('export-csv').href=`/api/export/${id}/csv`;$('run-history').value=id;$('timeline-description').textContent=report.mode==='anonymous'?'Anonymous labels belong to this run and may change between sections.':'Overlapping speakers appear on separate tracks. Click a segment to seek.';renderSegments();renderTimeline();updateCurrentJob();}catch(error){fail(error);}}
function segments(){return state.media?.role==='reference'?state.annotations:(state.report?.segments||[]);}
function effectiveSpeaker(item,index){return state.labels[index]??item.speaker;}
function duration(){const actual=$('player').duration;return Number.isFinite(actual)&&actual>0?actual:Math.max(state.media?.duration||0,...segments().map(s=>s.end),1);}
function renderTimeline(){const items=segments();if(!items.length){$('timeline').style.width='100%';$('timeline').innerHTML='<div class="empty-inline">'+(state.media?.role==='reference'?'Mark clips to build your reference timeline.':'Run speaker analysis to see activity across the recording.')+'</div>';$('speaker-summary').innerHTML='';return;}const names=[...new Set(items.map((s,i)=>effectiveSpeaker(s,i)))];const total=duration();$('timeline').style.width=`${Number($('timeline-zoom').value)*100}%`;$('timeline').innerHTML=`<div class="timeline-ruler">${Array.from({length:6},(_,i)=>`<span class="ruler-tick" style="left:${i*20}%">${time(total*i/5)}</span>`).join('')}</div>${names.map(name=>`<div class="track"><div class="track-label" title="${esc(name)}">${esc(name)}</div><div class="track-lane">${items.map((s,i)=>effectiveSpeaker(s,i)===name?`<button class="track-segment" data-index="${i}" style="left:${s.start/total*100}%;width:${(s.end-s.start)/total*100}%;--speaker:${color(name)}" title="${esc(name)} · ${precise(s.start)}–${precise(s.end)}" aria-label="Play ${esc(name)} from ${time(s.start)}"></button>`:'').join('')}</div></div>`).join('')}<div class="playhead"><span id="playhead-line" class="playhead-line"></span></div>`;$('timeline').querySelectorAll('[data-index]').forEach(b=>b.onclick=()=>seek(items[Number(b.dataset.index)].start));const totals={};items.forEach((s,i)=>{if(state.media.role==='reference'&&(!s.included||s.flag!=='clean'))return;const name=effectiveSpeaker(s,i);totals[name]=(totals[name]||0)+s.end-s.start;});$('speaker-summary').innerHTML=Object.entries(totals).map(([name,seconds])=>`<span><i class="color-dot" style="--speaker:${color(name)}"></i>${esc(name)} <strong>${time(seconds)}</strong>${state.media.role==='reference'?' clean':''}</span>`).join('');updatePlayback();}
function renderSegments() {
  const all = segments();
  const query = $('segment-search').value.toLowerCase();
  const filtered = all.map((item, index) => ({item, index})).filter(({item, index}) =>
    `${effectiveSpeaker(item, index)} ${item.cluster || ''}`.toLowerCase().includes(query));
  const reference = state.media?.role === 'reference';
  $('segment-count').textContent = String(all.length).padStart(2, '0');
  $('filter-count').textContent = `${filtered.length} turns`;
  $('segments-empty').hidden = filtered.length > 0;
  $('segments-empty').textContent = all.length ? 'No voices match this filter.' : reference
    ? 'Mark a clean clip on the left. Your reference cuts will appear here.'
    : 'Run an analysis to index the voices in this recording.';
  $('more-segments').hidden = filtered.length <= state.rows;
  $('segment-rows').innerHTML = filtered.slice(0, state.rows).map(({item, index}) => {
    const name = effectiveSpeaker(item, index);
    const score = item.similarity == null ? '' : ` · score ${Number(item.similarity).toFixed(3)}`;
    return `<article class="log-entry" role="listitem" data-index="${index}" data-start="${item.start}" data-end="${item.end}">
      <div class="log-entry-top"><span class="log-sequence">${String(index + 1).padStart(2, '0')}</span><button class="time-button" data-play="${index}" title="Play this segment">${precise(item.start)} — ${precise(item.end)}</button><button class="play-segment" data-play="${index}" aria-label="Play segment ${index + 1}">▷</button></div>
      <div class="speaker-label"><i class="color-dot" style="--speaker:${color(name)}"></i><input data-label="${index}" aria-label="Speaker for segment ${index + 1}" maxlength="80" value="${esc(name)}"></div>
      <div class="log-meta"><span>${(item.end - item.start).toFixed(1)}s ${reference ? 'reference' : esc(item.cluster)}${score}</span>${!reference ? `<span class="${item.speaker === 'UNKNOWN' ? 'needs-review' : ''}">${item.reviewed ? '✓ Reviewed' : item.speaker === 'UNKNOWN' ? 'Review identity' : 'Editable label'}</span>` : ''}</div>
      ${reference ? `<div class="row-actions"><select data-quality="${index}" aria-label="Quality for segment ${index + 1}">${['clean', 'overlap', 'noise', 'uncertain'].map(q => `<option ${item.flag === q ? 'selected' : ''}>${q}</option>`).join('')}</select><label><input type="checkbox" data-include="${index}" ${item.included ? 'checked' : ''}> Use clip</label><button data-delete="${index}" aria-label="Remove clip ${index + 1}">×</button></div>` : ''}
    </article>`;
  }).join('');
  $('segment-rows').querySelectorAll('[data-play]').forEach(button => button.onclick = () => {
    const segment = all[Number(button.dataset.play)]; state.clipEnd = segment.end; seek(segment.start, true);
  });
  $('segment-rows').querySelectorAll('[data-label]').forEach(input => input.onchange = () => {
    const index = Number(input.dataset.label), name = input.value.trim();
    if (!name || (reference && name === 'UNKNOWN')) { input.value = effectiveSpeaker(all[index], index); return; }
    if (reference) { all[index].speaker = name; markDirty(); }
    else { state.labels[index] = name; $('save-status').textContent = 'Unsaved review'; }
    renderTimeline();
  });
  $('segment-rows').querySelectorAll('[data-quality]').forEach(input => input.onchange = () => {
    all[Number(input.dataset.quality)].flag = input.value; markDirty(); renderTimeline();
  });
  $('segment-rows').querySelectorAll('[data-include]').forEach(input => input.onchange = () => {
    all[Number(input.dataset.include)].included = input.checked; markDirty(); renderTimeline();
  });
  $('segment-rows').querySelectorAll('[data-delete]').forEach(button => button.onclick = () => {
    all.splice(Number(button.dataset.delete), 1); markDirty(); renderSegments(); renderTimeline();
  });
  $('speaker-suggestions').innerHTML = [...new Set(all.map(item => item.speaker))].map(name => `<option value="${esc(name)}"></option>`).join('');
  updatePlayback();
}
function seek(value, play = false) {
  const player = $('player');
  if (!play) state.clipEnd = null;
  player.currentTime = Math.max(0, Math.min(duration(), value));
  if (play) player.play().catch(fail);
}
function updatePlayback() {
  const player = $('player');
  $('playback-time').textContent = `${time(player.currentTime)} / ${time(player.duration)}`;
  $('stage-time').textContent = time(player.currentTime);
  $('stage-state').textContent = player.ended ? 'End of recording' : player.paused ? 'Paused · original audio' : 'Playing · original audio';
  $('play-toggle').textContent = player.paused ? '▶' : 'Ⅱ';
  $('play-toggle').setAttribute('aria-label', player.paused ? 'Play recording' : 'Pause recording');
  $('seek-position').value = Math.round(player.currentTime / duration() * 1000);
  $('seek-position').setAttribute('aria-valuetext', `${time(player.currentTime)} of ${time(duration())}`);
  const line = $('playhead-line');
  if (line) line.style.left = `${Math.min(100, player.currentTime / duration() * 100)}%`;
  const active = new Set();
  segments().forEach((item, index) => {
    if (player.currentTime >= item.start && player.currentTime < item.end) active.add(effectiveSpeaker(item, index));
  });
  $('active-speakers').innerHTML = [...active].map(name => `<span class="speaker-pill" style="--speaker:${color(name)}">${esc(name)}</span>`).join('');
  $('segment-rows').querySelectorAll('.log-entry').forEach(row => row.classList.toggle('active', player.currentTime >= Number(row.dataset.start) && player.currentTime < Number(row.dataset.end)));
  if (state.clipEnd !== null && player.currentTime >= state.clipEnd) { player.pause(); state.clipEnd = null; }
}
async function saveAnnotations(){if(!state.media)return;const saved=await api(`/api/media/${state.media.id}/annotations`,{annotations:state.annotations,revision:state.media.revision});state.media=saved;const i=state.data.media.findIndex(m=>m.id===saved.id);state.data.media[i]=saved;state.dirty=false;$('save-status').textContent='Labels saved';$('export-json').hidden=false;$('export-json').href=`/api/labels/${saved.id}`;toast('Reference labels saved locally');}
async function runJob(){if(!state.media)return;$('run-error').hidden=true;if(serverNeedsRestart()){fail(new Error('Server restart required. Stop the old worker with Ctrl+C, run .venv/bin/python tools/run_workbench.py in the terminal where HF_TOKEN is set, then refresh.'));return;}const blockers=runBlockers();if(blockers.length){fail(new Error(blockers.join('\n')));return;}if(state.media.role!=='reference'&&!allowLeave())return;saveRunChoices();state.submitting=true;$('run-button').disabled=true;try{const ref=state.media.role==='reference';if(ref&&state.dirty)await saveAnnotations();const body={kind:ref?'enroll':'identify',media_id:state.media.id,model:$('model-select').value};if(ref)body.name=$('collection-name').value;else Object.assign(body,selectedRange(),{collection_id:$('mode-enrolled').checked?$('collection-select').value||null:null,threshold:$('mode-enrolled').checked?Number($('threshold').value):0.55,margin:$('mode-enrolled').checked?Number($('margin').value):0.08,min_speakers:$('min-speakers').value||null,max_speakers:$('max-speakers').value||null});const job=await api('/api/jobs',body);state.jobId=job.id;state.labels={};state.data.jobs.unshift(job);updateCurrentJob();$('run-dialog').close();toast('Job queued. You can keep using the workbench.');await refresh();}catch(error){fail(error);}finally{state.submitting=false;updateCurrentJob();}}
function updateCurrentJob() {
  if (!state.data) return;
  const jobs = state.data.jobs;
  const active = job => ['queued', 'running'].includes(job.status);
  const current = state.media && (jobs.find(job => job.media_id === state.media.id && active(job)) ||
    jobs.find(job => job.media_id === state.media.id));
  const latest = jobs.find(job => job.status === 'running') || jobs.find(active) || jobs[0];
  renderProcessingPanel($('processing-panel'), current, false);
  renderProcessingPanel($('global-activity'), (!state.media || latest?.media_id !== state.media.id) ? latest : null, true);
  const panel = $('current-job');
  panel.hidden = !current || current.status === 'completed';
  if (current) panel.textContent = `${current.stage}${current.error ? ': ' + current.error : ''}`;
  const running = jobs.some(job => job.media_id === state.media?.id && active(job));
  updateRunReview();
  updateWorkflow();
  updateResultContext();
  $('session-job').textContent = current ? (running ? current.stage : current.status === 'failed' ? 'Run failed — see details below' : '') : '';
  updateJobClocks();
}

function jobProgressMarkup(job, global = false) {
  const active = ['queued', 'running'].includes(job.status);
  const progress = job.progress || {};
  const measured = Number.isFinite(progress.total) && progress.total > 0 && Number.isFinite(progress.completed);
  const done = measured ? Math.max(0, Math.min(progress.total, progress.completed)) : 0;
  const percent = measured ? Math.floor(done / progress.total * 100) : null;
  const count = job.status === 'completed' ? (job.kind === 'enroll' ? 'Voice collection saved. Reuse it with the same model.' : 'Finished. The saved result is ready to review.') :
    job.status === 'failed' ? `Failed during: ${job.failed_stage || 'processing'}. This run is no longer running.` :
    job.status === 'interrupted' ? 'The server stopped before this run finished. Start a new run to retry.' :
    job.status === 'queued' ? 'Waiting for the local worker. Other jobs may be ahead of this run.' :
    measured ? `${done} of ${progress.total} ${progress.unit || 'items'} · ${percent}% of this stage` :
    'This stage does not report a total. No completion time is estimated.';
  const meter = active ? `<progress class="stage-progress" aria-label="${esc(job.stage || 'Processing')} stage progress" ${measured ? `value="${done}" max="${progress.total}"` : ''}></progress>` : '';
  const events = (job.events || []).slice(-4);
  const clockStart = job.started_at || job.queued_at;
  const finalSeconds = job.elapsed_seconds ?? (!active && clockStart && job.updated ? Math.max(0,(Date.parse(job.updated)-Date.parse(clockStart))/1000) : null);
  const elapsed = finalSeconds != null ? time(finalSeconds) : active && clockStart ? time(Math.max(0, (Date.now() - Date.parse(clockStart)) / 1000)) : '—';
  return `<div class="processing-heading"><div><span class="processing-status ${esc(job.status)}">${esc(job.status.toUpperCase())}</span><h3>${esc(job.stage || job.status)}</h3></div><span class="job-clock" data-job-clock data-clock-label="${job.status === 'queued' ? 'waiting' : 'elapsed'}" data-start="${esc(clockStart || '')}" data-final="${finalSeconds ?? ''}">${elapsed} ${job.status === 'queued' ? 'waiting' : 'elapsed'}</span></div>
    <p class="processing-context">${esc(global ? job.media_name + ' · ' : '')}${esc(job.model)} · ${esc(rangeLabel(job))}</p>
    ${meter}<p class="processing-detail">${esc(count)}</p>
    ${job.status === 'running' ? `<p class="processing-liveness"><span data-job-heartbeat data-time="${esc(job.heartbeat_at || '')}"></span><span data-job-last-progress data-time="${esc(job.last_progress_at || '')}"></span></p>` : ''}
    ${events.length ? `${!active?'<details class="processing-history"><summary>Stage history</summary>':''}<ol class="processing-events">${events.map(event => `<li><span>${esc(new Date(event.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}))}</span> ${esc(event.message)}</li>`).join('')}</ol>${!active?'</details>':''}` : ''}
    ${job.error ? `<p class="processing-error">${esc(job.error.split('\n')[0])}</p><details class="processing-diagnostics"><summary>Technical error details</summary><pre>${esc(job.error)}</pre></details>` : ''}
    <div class="processing-actions">${job.collection_id ? '<button class="primary" data-open-voices>View saved voices →</button>' : ''}${global || (job.report && state.report?.job_id !== job.id) ? `<button class="secondary" data-open-job="${esc(job.id)}">${job.report ? 'Review result' : 'Open recording'} ↗</button>` : ''}${!global && ['failed','interrupted'].includes(job.status) ? '<button class="primary" data-retry-run>Review settings & retry</button>' : ''}</div>`;
}

function renderProcessingPanel(panel, job, global) {
  panel.hidden = !job;
  panel.classList.toggle('terminal', !!job && !['queued','running'].includes(job.status));
  if (!job) { panel._renderKey = ''; return; }
  const key = JSON.stringify([job.id, job.status, job.stage, job.progress, job.error, job.failed_stage, job.elapsed_seconds, job.events, state.report?.job_id, global]);
  if (panel._renderKey !== key) {
    panel._renderKey = key;
    panel.innerHTML = jobProgressMarkup(job, global);
    panel.querySelectorAll('[data-open-job]').forEach(button => button.onclick = () => openMedia(job.media_id, job.report ? job.id : null));
    panel.querySelectorAll('[data-open-voices]').forEach(button => button.onclick = () => showView('profiles'));
    panel.querySelectorAll('[data-retry-run]').forEach(button => button.onclick = () => openRunSettings(job));
  }
  panel.querySelectorAll('[data-job-heartbeat]').forEach(element => element.setAttribute('data-time', job.heartbeat_at || ''));
  panel.querySelectorAll('[data-job-last-progress]').forEach(element => element.setAttribute('data-time', job.last_progress_at || ''));
}

function updateJobClocks() {
  const secondsSince = timestamp => Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  document.querySelectorAll('[data-job-clock]').forEach(element => {
    const terminal = element.getAttribute('data-final');
    const start = element.getAttribute('data-start');
    const seconds = terminal !== '' ? Number(terminal) : start ? secondsSince(start) : null;
    if (Number.isFinite(seconds)) element.textContent = `${time(seconds)} ${element.getAttribute('data-clock-label') || 'elapsed'}`;
  });
  document.querySelectorAll('[data-job-heartbeat]').forEach(element => {
    const timestamp = element.getAttribute('data-time');
    element.textContent = timestamp ? `Worker heartbeat ${secondsSince(timestamp)}s ago` : 'Waiting for worker heartbeat';
  });
  document.querySelectorAll('[data-job-last-progress]').forEach(element => {
    const timestamp = element.getAttribute('data-time');
    element.textContent = timestamp ? `Stage progress updated ${secondsSince(timestamp)}s ago` : 'No model progress reported yet';
  });
}

function renderProfiles(){const collections=state.data.collections;if(!collections.length){$('profiles-page').innerHTML='<div class="empty-library"><div class="empty-symbol">◉</div><h2>Voices you can come back to</h2><p>Upload a reference recording, label clean clips, then build a profile collection. It will stay available for future meetings.</p><button id="go-reference" class="primary">Prepare reference voices →</button></div>';$('go-reference').onclick=()=>showView('references');return;}$('profiles-page').innerHTML=`<div class="profile-grid">${collections.map(c=>`<article class="profile-card"><span class="tag">${esc(c.model)}</span><h2 style="margin-top:15px">${esc(c.name)}</h2><p class="profile-meta">${c.speakers.length} voices · Saved ${new Date(c.updated).toLocaleDateString()}</p>${c.speakers.map(s=>`<div class="profile-speaker"><span>${esc(s.name)}</span><span class="muted">${time(s.seconds)} · ${s.clips} clips</span></div><div class="coverage" title="Reference duration against a five-minute collection target; not accuracy"><span style="width:${Math.min(100,s.seconds/300*100)}%"></span></div>`).join('')}<p class="field-hint">Bars show collected speech toward 5 minutes, not model accuracy.</p><button class="secondary" data-reference="${esc(c.media_id)}">Review source clips ↗</button></article>`).join('')}</div>`;$('profiles-page').querySelectorAll('[data-reference]').forEach(b=>b.onclick=()=>openMedia(b.dataset.reference));}
function renderJobs(){const jobs=state.data.jobs;if(!jobs.length){$('jobs-page').innerHTML='<div class="empty-library"><div class="empty-symbol">↻</div><h2>No processing jobs yet</h2><p>Open a meeting to analyze speakers, or build a collection from your reference clips. Jobs run one at a time on this computer.</p></div>';return;}$('jobs-page').innerHTML=`<div class="jobs-list">${jobs.map(j=>`<article class="job-card"><span class="job-status ${esc(j.status)}">${esc(j.status)}</span><div class="job-info"><h3>${esc(j.kind==='enroll'?'Build profiles':'Analyze speakers')} · ${esc(j.media_name)}</h3><p>${esc(j.model)} · ${esc(rangeLabel(j))} · ${esc(j.stage)}${j.elapsed_seconds!==undefined?` · ${j.elapsed_seconds}s`:''}</p>${j.error?`<p class="job-error">${esc(j.error)}</p>`:''}</div><button class="secondary" data-job="${esc(j.id)}">${j.report?'Review timeline':'Open recording'} ↗</button></article>`).join('')}</div>`;$('jobs-page').querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>{const j=jobs.find(j=>j.id===b.dataset.job);openMedia(j.media_id,j.report?j.id:null);});}
async function upload(file){if(state.uploading)return;if(!allowLeave())return;if(!file.size||file.size>4*1024**3){fail(new Error('Choose a nonempty file no larger than 4 GiB.'));return;}const role=state.view==='references'?'reference':'meeting';state.uploading=true;$('upload-button').disabled=true;$('upload-progress').hidden=false;$('upload-name').textContent=file.name;$('upload-percent').textContent='0%';$('upload-meter').value=0;try{const media=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',`/api/upload?name=${encodeURIComponent(file.name)}&role=${role}`);xhr.setRequestHeader('X-Workbench-Token',state.csrf);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.upload.onprogress=e=>{if(e.lengthComputable){const percent=Math.round(e.loaded/e.total*100);$('upload-meter').value=percent;$('upload-percent').textContent=percent===100?'Saving locally…':`${percent}%`;}};xhr.onload=()=>{try{const body=JSON.parse(xhr.responseText);if(xhr.status>=200&&xhr.status<300)resolve(body);else reject(new Error(body.error||'Upload failed'));}catch{reject(new Error('Upload failed. Check the connection.'));}};xhr.onerror=()=>reject(new Error('Upload connection failed. The file was not saved.'));xhr.send(file);});state.dirty=false;state.labels={};await refresh();await openMedia(media.id);toast('Recording saved locally');}catch(error){fail(error);}finally{state.uploading=false;$('upload-button').disabled=false;$('upload-progress').hidden=true;$('file-input').value='';}}
$('upload-button').onclick=()=>$('file-input').click();$('file-input').onchange=()=>{if($('file-input').files[0])upload($('file-input').files[0]);};document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>showView(b.dataset.view));$('back-library').onclick=()=>showView(state.view);$('setup-button').onclick=()=>$('setup-dialog').showModal();$('close-setup').onclick=()=>$('setup-dialog').close();$('dismiss-error').onclick=()=>$('error-banner').hidden=true;$('player').ontimeupdate=updatePlayback;$('player').onseeked=updatePlayback;$('player').onloadedmetadata=()=>{if(!state.media)return;const d=$('player').duration;$('recording-meta').textContent=`${state.media.video?'Video':'Audio'} · ${size(state.media.size)} · ${time(d)}`;if(Number.isFinite(d)&&d>0&&!state.media.duration){state.media.duration=d;api(`/api/media/${state.media.id}/duration`,{duration:d}).catch(fail);}renderTimeline();updatePlayback();};$('player').onerror=()=>{if(state.media)fail(new Error('This browser cannot play the file or its codec. The original is saved; audio processing can still be available through FFmpeg.'));};$('playback-speed').onchange=()=>$('player').playbackRate=Number($('playback-speed').value);$('timeline-zoom').oninput=renderTimeline;$('segment-search').oninput=()=>{state.rows=100;renderSegments();};$('more-segments').onclick=()=>{state.rows+=100;renderSegments();};$('mark-in').onclick=()=>$('clip-start').value=$('player').currentTime.toFixed(3);$('mark-out').onclick=()=>$('clip-end').value=$('player').currentTime.toFixed(3);$('clip-form').onsubmit=e=>{e.preventDefault();const start=Number($('clip-start').value),end=Number($('clip-end').value),speaker=$('clip-speaker').value.trim();if(!Number.isFinite(start+end)||start<0||end<=start||end>duration()+.1||!speaker||speaker==='UNKNOWN'){fail(new Error('Choose valid in/out points within the recording and a speaker label other than UNKNOWN.'));return;}state.annotations.push({id:crypto.randomUUID(),start,end,speaker,flag:$('clip-quality').value,included:true});state.annotations.sort((a,b)=>a.start-b.start);markDirty();renderSegments();renderTimeline();$('clip-start').value='';$('clip-end').value='';toast('Clip added. Save labels to keep it.');};$('save-labels').onclick=()=>saveAnnotations().catch(fail);$('save-corrections').onclick=async()=>{if(!Object.keys(state.labels).length){toast('No corrections to save');return;}try{state.report=await api(`/api/report/${state.report.job_id}`,{labels:state.labels,revision:state.report.revision||0});state.labels={};$('save-status').textContent='Corrections saved';renderSegments();renderTimeline();toast('Corrections saved; original predictions preserved');}catch(error){fail(error);}};$('model-select').onchange=()=>{populateCollections();updateModelHint();saveRunChoices();updateRunReview();};$('run-button').onclick=runJob;$('run-history').onchange=()=>{if(allowLeave())loadReport($('run-history').value);else $('run-history').value=state.report?.job_id || state.jobId;};$('refresh-results').onclick=async()=>{if(!allowLeave())return;try{const id=state.media.id;state.labels={};state.dirty=false;await refresh();await openMedia(id);}catch(error){fail(error);}};
window.addEventListener('beforeunload',e=>{if(unsaved()||state.uploading){e.preventDefault();e.returnValue='';}});document.addEventListener('keydown',e=>{if(!state.media||($('setup-dialog').open||$('run-dialog').open)||['INPUT','SELECT','TEXTAREA','BUTTON','VIDEO'].includes(document.activeElement.tagName))return;if(e.code==='Space'){e.preventDefault();if($('player').paused)$('player').play().catch(fail);else $('player').pause();}if(state.media.role==='reference'&&e.key.toLowerCase()==='i')$('mark-in').click();if(state.media.role==='reference'&&e.key.toLowerCase()==='o')$('mark-out').click();});
refresh().catch(fail);setInterval(()=>refresh().catch(()=>{$('connection-state').textContent='CONNECTION LOST · RETRYING';}),3000);


function syncShell() {
  document.body.classList.toggle('is-editing', !!state.media);
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('page-title').innerHTML = `${esc(titles[state.view][0])}<span class="title-period">.</span>`;
  $('page-description').textContent = titles[state.view][1];
  const kind = state.view === 'references' ? 'reference' : 'meeting';
  const count = state.view === 'profiles' ? state.data.collections.length : state.view === 'jobs' ? state.data.jobs.length : state.data.media.filter(item => item.role === kind).length;
  $('archive-count').textContent = String(count).padStart(2, '0');
}
$('brand-home').onclick = event => { event.preventDefault(); showView('meetings'); };
$('configure-run').onclick = () => openRunSettings();
$('close-run').onclick = () => $('run-dialog').close();
$('play-toggle').onclick = () => { if ($('player').paused) $('player').play().catch(fail); else $('player').pause(); };
$('skip-back').onclick = () => seek($('player').currentTime - 10);
$('skip-forward').onclick = () => seek($('player').currentTime + 10);
$('seek-position').oninput = () => seek(Number($('seek-position').value) / 1000 * duration());
$('fullscreen').onclick = () => $('player').parentElement.parentElement.requestFullscreen().catch(fail);
$('player').onplay = updatePlayback;
$('player').onpause = updatePlayback;
$('player').onended = updatePlayback;
$('runtime-setup').onclick = () => openSetup(true);
$('readiness-setup').onclick = () => openSetup(false);
$('setup-dialog').addEventListener('close', () => { if (state.returnToRun && state.media) { state.returnToRun=false; openRunSettings(); } });
$('prepare-voices').onclick = () => { if (showView('references')) $('run-dialog').close(); };


function selectedRange() {
  const preset = $('analysis-duration').value || 'full';
  if (preset === 'full') return {start_seconds: 0, duration_seconds: null};
  const start = preset === 'custom' ? Number($('analysis-start').value) * 60 : 0;
  const length = preset === 'custom' ? Number($('analysis-length').value) * 60 : Number(preset);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(length) || length <= 0)
    throw new Error('Choose a nonnegative start and a length greater than zero. Use Full recording for no limit.');
  const total = state.media?.duration;
  if (total && start >= total) throw new Error('Choose a start before the end of this recording.');
  return {start_seconds: Math.round(start * 1000) / 1000, duration_seconds: Math.round(length * 1000) / 1000};
}
function updateRangeHint() {
  $('custom-range').hidden = $('analysis-duration').value !== 'custom';
  try {
    const range = selectedRange();
    if (range.duration_seconds === null) {
      $('analysis-range-hint').textContent = 'Analyze the complete recording. Original media stays unchanged.';
    } else {
      const end = Math.min(state.media?.duration || Infinity, range.start_seconds + range.duration_seconds);
      $('analysis-range-hint').textContent = `Analyze ${time(range.start_seconds)}–${time(end)} of the original recording. Only this section is sent to the model; results use original timestamps.`;
    }
  } catch (error) { $('analysis-range-hint').textContent = error.message; }
  updateRunReview();
}
function showAnalysisScope(report) {
  const range = report.analysis_range;
  $('analysis-scope').hidden = !range || range.full_recording;
  if (range && !range.full_recording) {
    $('analysis-scope').textContent = `SECTION RUN / ${time(range.start_seconds)}–${time(range.end_seconds)} of the original recording. ${scopeCoverage(range)}`;
  }
}
function rangeLabel(job) {
  if (job.kind === 'enroll') return 'Reference clips';
  if (job.duration_seconds == null && !job.start_seconds) return 'Full recording';
  if (!job.start_seconds) return `First ${job.duration_seconds / 60} min`;
  return `${time(job.start_seconds)} + ${job.duration_seconds == null ? 'remaining' : `${job.duration_seconds / 60} min`}`;
}
$('analysis-duration').onchange = () => { updateRangeHint(); saveRunChoices(); };
$('analysis-start').oninput = () => { updateRangeHint(); saveRunChoices(); };
$('analysis-length').oninput = () => { updateRangeHint(); saveRunChoices(); };
$('range-from-playhead').onclick = () => {
  $('analysis-duration').value = 'custom';
  $('analysis-start').value = ($('player').currentTime / 60).toFixed(3);
  $('analysis-length').value = '10';
  updateRangeHint();
  saveRunChoices();
};

function serverNeedsRestart() {
  const server = state.data?.server;
  return !server || server.protocol < 1 || server.restart_required === true;
}

setInterval(updateJobClocks, 1000);


// Per-recording drafts live only in this browser tab's session, never in Git or the URL.
const draftFields = ['model-select','collection-select','analysis-duration','analysis-start','analysis-length','threshold','margin','min-speakers','max-speakers','collection-name'];
function saveRunChoices() {
  if (!state.media) return;
  const draft = Object.fromEntries(draftFields.map(id => [id,$(id).value]));
  draft.mode = $('mode-enrolled').checked ? 'enrolled' : 'anonymous';
  try { sessionStorage.setItem(`speaker-workbench:run:${state.media.id}`,JSON.stringify(draft)); } catch (_) { /* Storage may be blocked; in-memory choices still work. */ }
  state.runDrafts ||= {};
  state.runDrafts[state.media.id] = draft;
}
function applyRunChoices(draft) {
  $('model-select').value = state.data.models.some(m => m.key === draft['model-select']) ? draft['model-select'] : 'community-1';
  populateCollections();
  for (const id of draftFields.filter(id => id !== 'model-select')) if (draft[id] != null) $(id).value = draft[id];
  // An incompatible/deleted collection stays visibly unselected; never silently switch identity modes.
  if (!state.data.collections.some(c => c.id === $('collection-select').value && c.model === $('model-select').value)) $('collection-select').value = '';
  $('mode-enrolled').checked = draft.mode === 'enrolled';
  $('mode-anonymous').checked = !$('mode-enrolled').checked;
}
function choicesFromJob(job) {
  const preset = [300,600,900,1800,3600].includes(job.duration_seconds) && !job.start_seconds ? String(job.duration_seconds) : job.duration_seconds == null && !job.start_seconds ? 'full' : 'custom';
  return {'model-select':job.model,'collection-select':job.collection_id || '',mode:job.collection_id?'enrolled':'anonymous',
    'analysis-duration':preset,'analysis-start':String((job.start_seconds || 0)/60),'analysis-length':String((job.duration_seconds || 600)/60),
    'threshold':String(job.threshold ?? .55),'margin':String(job.margin ?? .08),'min-speakers':job.min_speakers || '',
    'max-speakers':job.max_speakers || '', 'collection-name':job.collection_name || 'Team reference voices'};
}
function restoreRunChoices() {
  let draft = state.runDrafts?.[state.media.id];
  try { draft ||= JSON.parse(sessionStorage.getItem(`speaker-workbench:run:${state.media.id}`)); } catch (_) {}
  const previous = state.data.jobs.find(job => job.media_id === state.media.id);
  applyRunChoices(draft || (previous ? choicesFromJob(previous) : {'model-select':'community-1',mode:'anonymous','collection-select':'','analysis-duration':'300','analysis-start':'0','analysis-length':'10','threshold':'.55','margin':'.08','min-speakers':'','max-speakers':'','collection-name':'Team reference voices'}));
}
function runBlockers() {
  const issues = setupIssues();
  if (!state.media) return [...issues,'Choose a recording first.'];
  if (state.data.jobs.some(j => j.media_id === state.media.id && ['running','queued'].includes(j.status))) issues.push('This recording already has an active run. Follow its progress on the work surface.');
  if (state.data.jobs.filter(j => ['running','queued'].includes(j.status)).length >= 4) issues.push('The queue is full. Wait for a run to finish.');
  if (state.media.role === 'reference') {
    if (!state.annotations.some(s => s.included && s.flag === 'clean')) issues.push('Mark at least one included clean reference clip before building profiles.');
    if (!$('collection-name').value.trim()) issues.push('Give the voice collection a name.');
  } else {
    if ($('mode-enrolled').checked && !state.data.collections?.some(c => c.id === $('collection-select').value && c.model === $('model-select').value)) issues.push('Choose a compatible voice collection, or switch to Anonymous speakers.');
    try { selectedRange(); } catch (error) { issues.push(error.message); }
    const min = $('min-speakers').value, max = $('max-speakers').value;
    if ([min,max].some(v => v !== '' && (!Number.isInteger(Number(v)) || Number(v)<1 || Number(v)>100))) issues.push('Speaker counts must be whole numbers from 1 to 100.');
    if (min && max && Number(min)>Number(max)) issues.push('Minimum speakers cannot exceed maximum speakers.');
    if ($('mode-enrolled').checked) {
      const threshold = Number($('threshold').value), margin = Number($('margin').value);
      if (!$('threshold').value || !Number.isFinite(threshold) || threshold < -1 || threshold > 1 || !$('margin').value || !Number.isFinite(margin) || margin < 0 || margin > 2) issues.push('Choose a similarity threshold from −1 to 1 and a match margin from 0 to 2.');
    }
  }
  return issues;
}
function updateRunReview() {
  if (!state.data || !state.media) return;
  const ref = state.media.role === 'reference', enrolled = $('mode-enrolled').checked;
  $('collection-options').hidden = !enrolled;
  $('matching-options').hidden = !enrolled;
  $('advanced-options').hidden = ref;
  let scope = 'Choose a valid range';
  try { const range=selectedRange(); scope=range.duration_seconds == null?'Full recording':`${time(range.start_seconds)}–${time(Math.min(state.media.duration || Infinity, range.start_seconds+range.duration_seconds))} · selected section`; } catch (_) {}
  const collection = state.data.collections?.find(c => c.id === $('collection-select').value && c.model === $('model-select').value);
  const fields = [['Recording',state.media.name],['Task',ref?'Build voice profiles':enrolled?'Recognize saved voices':'Anonymous speakers'],['Range',ref?`${state.annotations.filter(s=>s.included && s.flag==='clean').length} included clean clips`:scope],['Model',$('model-select').value],['Voices',ref?$('collection-name').value:enrolled?collection?.name || 'Choose a collection':'Person 1, Person 2…']];
  $('run-output-hint').textContent=ref?'Creates a reusable local voice collection. Each model needs compatible profiles.':'Creates speaker timestamps. Spoken-word transcription comes later.';
  $('run-summary').innerHTML = fields.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('');
  const issues=runBlockers();
  $('run-blocker').textContent=issues.join(' ');
  $('run-blocker').hidden=!issues.length;
  $('run-button').disabled=!!state.submitting || issues.length>0;
  const preset=$('analysis-duration').value;
  $('run-button').textContent=state.submitting?'Adding to queue…':ref?'Build voice profiles →':preset==='full'?'Start full analysis →':preset==='custom'?'Analyze selected section →':`Start ${Number(preset)/60}-minute analysis →`;
}
function openRunSettings(retryJob=null) {
  if (!state.media) return;
  if (retryJob) { applyRunChoices(choicesFromJob(retryJob)); saveRunChoices(); }
  $('run-error').hidden=true;
  updateSetup(); updateRangeHint();
  $('run-dialog').showModal();
  $('run-dialog').scrollTop=0;
  (state.media.role==='reference'?$('collection-name'):$('mode-anonymous')).focus();
}
function openSetup(returnToRun) {
  state.returnToRun=returnToRun;
  if ($('run-dialog').open) $('run-dialog').close();
  $('setup-dialog').showModal();
}
function updateWorkflow() {
  if (!state.media) return;
  const ref=state.media.role==='reference';
  const active=state.data.jobs.some(j=>j.media_id===state.media.id && ['queued','running'].includes(j.status));
  const hasResult=ref?state.data.collections?.some(c=>c.media_id===state.media.id):!!state.report;
  const step=active?2:hasResult?3:2;
  $('workflow-steps').innerHTML=['Recording saved',ref?'Label & build profiles':'Analyze speakers',ref?'Reuse saved voices':'Review timeline'].map((label,i)=>`<li ${i+1===step?'aria-current="step"':''} class="${i+1<step?'done':''}"><span>${i+1}</span>${esc(i===1&&active?'Processing':label)}</li>`).join('');
  $('configure-run').textContent=ref?'Build voice profiles ↗':hasResult?'New analysis ↗':'Analyze speakers ↗';
  $('workspace-guidance').hidden=active || hasResult;
  $('workspace-guidance').textContent=ref?'Mark clean clips below and give each voice a label, then build a reusable collection.':'Ready for a first look? Choose Analyze speakers to run a short anonymous preview. No voice samples needed.';
}
function updateResultContext() {
  const panel=$('result-context');
  panel.hidden=!state.report || state.media?.role==='reference';
  if (panel.hidden) return;
  const report=state.report, range=report.analysis_range;
  const scope=range && !range.full_recording?`SECTION ONLY · ${time(range.start_seconds)}–${time(range.end_seconds)}. ${scopeCoverage(range)}`:'Full recording';
  const latest=state.data.jobs.find(j=>j.media_id===state.media.id);
  const displayedId=report.job_id || state.jobId;
  const newer=latest && latest.id !== displayedId;
  const note=newer && ['queued','running'].includes(latest.status)?' · A new run is processing; this is the previous saved result.':newer && ['failed','interrupted'].includes(latest.status)?' · The latest run did not finish; this is an earlier saved result.':'';
  const model=report.model || state.data.jobs.find(j=>j.id===displayedId)?.model || 'Model not recorded';
  panel.innerHTML=`<strong>Viewing saved result · ${esc(report.mode==='anonymous'?'Anonymous speakers':'Saved voice identification')}</strong><p>${esc(scope)} · ${esc(model)}${esc(note)}</p>`;
}
for (const id of ['mode-anonymous','mode-enrolled','collection-select']) $(id).onchange=()=>{saveRunChoices();updateRunReview();};
for (const id of ['threshold','margin','min-speakers','max-speakers','collection-name']) $(id).oninput=()=>{saveRunChoices();updateRunReview();};

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh().catch(fail); });

function scopeCoverage(range) {
  const total=state.media?.duration;
  return total && range.start_seconds === 0 && range.end_seconds >= total-.1 ? 'This selected section covers the complete recording.' : 'The rest has not been analyzed.';
}
