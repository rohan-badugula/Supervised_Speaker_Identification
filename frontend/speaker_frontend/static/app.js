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
async function refresh(){const next=await api('/api/state');const changed=catalogViewSignature(next)!==catalogViewSignature(state.data);state.data=next;state.csrf=state.data.csrf;$('server-update').hidden=!serverNeedsRestart();$('connection-state').textContent='● LOCALHOST CONNECTED';updateCounts();updateSetup();updateCurrentJob();if(!state.media){if(changed)renderPage();}else{updateRunHistory();const job=state.data.jobs.find(j=>j.id===state.jobId);if(job?.status==='completed'&&job.report&&state.report?.job_id!==job.id&&!unsaved())await loadReport(job.id);}}
function updateCounts(){for(const [key,role] of [['meeting-count','meeting'],['reference-count','reference']])$(key).textContent=state.data.media.filter(m=>m.role===role).length;$('job-count').textContent=state.data.jobs.filter(j=>['queued','running'].includes(j.status)).length;}
function updateSetup(){const h=state.data.health;const ready=h.ffmpeg&&h.audio&&h.token&&!serverNeedsRestart();$('setup-dot').classList.toggle('ready',ready);const checks=[['FFmpeg audio extraction',h.ffmpeg],['Community-1 dependencies',h.audio],['ECAPA dependencies (optional)',h.ecapa],['Hugging Face token in server environment',h.token]];$('setup-checks').innerHTML=checks.map(([label,ok])=>`<div class="setup-check ${ok?'good':''}"><span>${esc(label)}</span><span>${ok?'Ready':'Not configured'}</span></div>`).join('');const spec=state.data.models.find(m=>m.key===$('model-select').value);const missing=[];if(!h.ffmpeg)missing.push('FFmpeg');if(!h.audio)missing.push('audio dependencies');if(spec?.embedding_model&&!h.ecapa)missing.push('ECAPA');if(!h.token)missing.push('HF_TOKEN');$('runtime-note').textContent=serverNeedsRestart()?'Restart required: the Python worker is older than this interface. Restart from the terminal where HF_TOKEN is set, then refresh.':missing.length?`Processing needs ${missing.join(', ')}. Open Local setup for instructions.`:'Ready to process locally on CPU. Long recordings may take time.';}
function showView(view){if(!allowLeave())return;state.view=view;state.media=null;state.report=null;state.jobId=null;state.dirty=false;state.labels={};$('player').pause();$('player').removeAttribute('src');$('player').load();document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));$('page-title').textContent=titles[view][0];$('page-description').textContent=titles[view][1];$('upload-button').hidden=!['meetings','references'].includes(view);$('upload-button').textContent=view==='references'?'＋ Import reference':'＋ Import media';renderPage();}
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
async function openMedia(id,jobId=null){if(!allowLeave())return;const media=state.data.media.find(m=>m.id===id);if(!media)return;state.media=media;state.report=null;state.annotations=structuredClone(media.annotations);state.dirty=false;state.labels={};state.rows=100;state.jobId=jobId;state.clipEnd=null;const ref=media.role==='reference';state.view=ref?'references':'meetings';document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));$('page-title').textContent=titles[state.view][0];$('page-description').textContent=titles[state.view][1];$('upload-button').hidden=false;$('upload-button').textContent=ref?'＋ Import reference':'＋ Import media';renderPage();$('recording-name').textContent=media.name;$('recording-meta').textContent=`${media.video?'Video':'Audio'} · ${size(media.size)} · ${media.duration?time(media.duration):'Loading duration…'}`;$('recording-type').textContent=ref?'REFERENCE':'MEETING';$('save-status').textContent='';$('analysis-scope').hidden=true;$('analysis-duration').value='full';$('analysis-start').value='0';$('analysis-length').value='10';updateRangeHint();$('reference-editor').hidden=!ref;$('enrollment-options').hidden=!ref;$('meeting-options').hidden=ref;$('run-title').textContent=ref?'Build voice profiles':'Analyze recording';$('run-button').innerHTML=ref?'Build profiles <span aria-hidden="true">→</span>':'Analyze speakers <span aria-hidden="true">→</span>';$('save-labels').hidden=!ref;$('save-corrections').hidden=true;$('export-json').hidden=!ref||!media.annotations.length;$('export-json').href=`/api/labels/${media.id}`;$('export-csv').hidden=true;$('quality-heading').textContent=ref?'QUALITY':'MATCH';$('segments-description').textContent=ref?'Only included, clean clips are used for voice profiles.':'Edit a speaker label to correct a segment. The original prediction is preserved.';$('segment-search').value='';$('show-short-turns').checked=false;$('timeline-zoom').value='1';$('clip-start').value='';$('clip-end').value='';$('clip-speaker').value='Person 1';$('player').parentElement.classList.toggle('audio',!media.video);$('fullscreen').hidden=!media.video;$('media-format').textContent=media.name.split('.').pop().toUpperCase();$('player').src=`/api/media/${media.id}`;$('player').load();populateModels();populateCollections();updateRunHistory();renderSegments();renderTimeline();updateCurrentJob();if(!ref){const latest=jobId?state.data.jobs.find(j=>j.id===jobId):state.data.jobs.find(j=>j.media_id===id&&j.status==='completed'&&j.report);if(latest?.status==='completed'&&latest.report)await loadReport(latest.id);}}
function populateModels(){const value=$('model-select').value||'community-1';$('model-select').innerHTML=state.data.models.map(m=>`<option value="${esc(m.key)}">${m.key==='community-1'?'Community-1':'Community-1 + ECAPA'}</option>`).join('');$('model-select').value=value;updateModelHint();}
function updateModelHint(){$('model-hint').textContent=$('model-select').value==='community-1'?'Diarization and identity matching with native speaker embeddings.':'Community-1 activity with ECAPA identity embeddings from clean regions.';updateSetup();}
function populateCollections(){const current=$('collection-select').value;const compatible=state.data.collections.filter(c=>c.model===$('model-select').value);$('collection-select').innerHTML='<option value="">Anonymous · no saved profiles</option>'+compatible.map(c=>`<option value="${esc(c.id)}">${esc(c.name)} · ${c.speakers.length} voices</option>`).join('');if(compatible.some(c=>c.id===current))$('collection-select').value=current;}
function updateRunHistory(){if(!state.media)return;const runs=state.data.jobs.filter(j=>j.media_id===state.media.id&&j.report&&j.status==='completed');const selected=state.jobId;const signature=JSON.stringify([state.media.id,selected,runs.map(j=>[j.id,j.updated])]);if(signature===state.historySignature)return;state.historySignature=signature;$('run-history').hidden=!runs.length;$('run-history').innerHTML=runs.map(j=>`<option value="${esc(j.id)}">${esc(j.model)} · ${esc(rangeLabel(j))} · ${new Date(j.updated).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</option>`).join('');if(runs.some(j=>j.id===selected))$('run-history').value=selected;}
async function loadReport(id){const mediaId=state.media?.id;try{const report=await api(`/api/report/${id}`);if(state.media?.id!==mediaId)return;state.report=report;showAnalysisScope(report);state.jobId=id;state.labels={};state.rows=100;$('save-corrections').hidden=false;$('export-json').hidden=false;$('export-csv').hidden=false;$('export-json').href=`/api/export/${id}/json`;$('export-csv').href=`/api/export/${id}/csv`;$('run-history').value=id;$('timeline-description').textContent=report.mode==='anonymous'?'Anonymous labels belong to this run and may change between sections.':'Overlapping speakers appear on separate tracks. Click a segment to seek.';renderSegments();renderTimeline();updateCurrentJob();}catch(error){fail(error);}}
function segments(){return state.media?.role==='reference'?state.annotations:(state.report?.segments||[]);}
function effectiveSpeaker(item,index){return state.labels[index]??item.speaker;}
function duration(){const actual=$('player').duration;return Number.isFinite(actual)&&actual>0?actual:Math.max(state.media?.duration||0,...segments().map(s=>s.end),1);}
function renderTimeline(){const items=segments();if(!items.length){$('timeline').style.width='100%';$('timeline').innerHTML='<div class="empty-inline">'+(state.media?.role==='reference'?'Mark clips to build your reference timeline.':'Run speaker analysis to see activity across the recording.')+'</div>';$('speaker-summary').innerHTML='';return;}const names=[...new Set(items.map((s,i)=>effectiveSpeaker(s,i)))];const total=duration();$('timeline').style.width=`${Number($('timeline-zoom').value)*100}%`;$('timeline').innerHTML=`<div class="timeline-ruler">${Array.from({length:6},(_,i)=>`<span class="ruler-tick" style="left:${i*20}%">${time(total*i/5)}</span>`).join('')}</div>${names.map(name=>`<div class="track"><div class="track-label" title="${esc(name)}">${esc(name)}</div><div class="track-lane">${items.map((s,i)=>effectiveSpeaker(s,i)===name?`<button class="track-segment" data-index="${i}" style="left:${s.start/total*100}%;width:${(s.end-s.start)/total*100}%;--speaker:${color(name)}" title="${esc(name)} · ${precise(s.start)}–${precise(s.end)}" aria-label="Play ${esc(name)} from ${time(s.start)}"></button>`:'').join('')}</div></div>`).join('')}<div class="playhead"><span id="playhead-line" class="playhead-line"></span></div>`;$('timeline').querySelectorAll('[data-index]').forEach(b=>b.onclick=()=>seek(items[Number(b.dataset.index)].start));const totals={};items.forEach((s,i)=>{if(state.media.role==='reference'&&(!s.included||s.flag!=='clean'))return;const name=effectiveSpeaker(s,i);totals[name]=(totals[name]||0)+s.end-s.start;});$('speaker-summary').innerHTML=Object.entries(totals).map(([name,seconds])=>`<span><i class="color-dot" style="--speaker:${color(name)}"></i>${esc(name)} <strong>${time(seconds)}</strong>${state.media.role==='reference'?' clean':''}</span>`).join('');updatePlayback();}
function renderSegments() {
  const all = segments();
  const query = $('segment-search').value.toLowerCase();
  const reference = state.media?.role === 'reference';
  const visible = sidebarTurns(all, reference, $('show-short-turns').checked);
  const filtered = visible.filter(({item, index}) =>
    `${effectiveSpeaker(item, index)} ${item.cluster || ''}`.toLowerCase().includes(query));
  const hidden = all.length - visible.length;
  $('short-turn-filter').hidden = reference;
  $('short-turn-note').hidden = !hidden;
  $('short-turn-note').textContent = `${hidden} turns under 1 second hidden here. Timeline and exports retain every turn.`;
  $('segment-count').textContent = String(visible.length).padStart(2, '0');
  $('filter-count').textContent = `${filtered.length} turns`;
  $('segments-empty').hidden = filtered.length > 0;
  $('segments-empty').textContent = all.length ? (hidden === all.length ? 'All detected turns are shorter than 1 second. Enable the checkbox above to inspect them.' : 'No voices match this filter.') : reference
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
  $('seek-position').max = duration();
  if (!state.scrubbing) $('seek-position').value = player.currentTime;
  $('seek-position').style.setProperty('--played',`${Math.max(0,Math.min(100,player.currentTime/duration()*100))}%`);
  trackerText('playback-status',player.error?'Playback unavailable':player.seeking?'Seeking…':player.readyState<2?'Loading recording…':player.ended?'End of recording':!player.paused&&player.readyState<3?'Buffering…':player.paused?'Paused':'Playing');
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
async function runJob(){if(!state.media)return;$('run-error').hidden=true;if(serverNeedsRestart()){fail(new Error('Server restart required. Stop the old worker with Ctrl+C, run .venv/bin/python tools/run_workbench.py in the terminal where HF_TOKEN is set, then refresh.'));return;}if(state.media.role!=='reference'&&!allowLeave())return;$('run-button').disabled=true;try{const ref=state.media.role==='reference';if(ref&&state.dirty)await saveAnnotations();const body={kind:ref?'enroll':'identify',media_id:state.media.id,model:$('model-select').value};if(ref)body.name=$('collection-name').value;else Object.assign(body,selectedRange(),{collection_id:$('collection-select').value||null,threshold:Number($('threshold').value),margin:Number($('margin').value),min_speakers:$('min-speakers').value||null,max_speakers:$('max-speakers').value||null});const job=await api('/api/jobs',body);state.jobId=job.id;state.labels={};state.data.jobs.unshift(job);updateCurrentJob();$('run-dialog').close();toast('Job queued. You can keep using the workbench.');await refresh();}catch(error){fail(error);}finally{$('run-button').disabled=false;updateCurrentJob();}}
function updateCurrentJob() {
  if (!state.media || !state.data) { $('job-tracker').hidden=true; return; }
  const jobs=state.data.jobs.filter(job=>job.media_id===state.media.id);
  const job=jobs.find(job=>job.status==='running') || jobs.find(job=>job.status==='queued') || jobs[0];
  const panel=$('current-job');
  panel.hidden=!job || job.status==='completed';
  if (job) panel.textContent=[job.stage,stageCount(job),job.error].filter(Boolean).join(' · ');
  const active=jobs.some(job=>['queued','running'].includes(job.status));
  $('run-button').disabled=active;
  $('session-job').textContent=active?job.stage:job?.status==='failed'?'Last run failed':'';
  renderJobTracker(job);
}
function renderProfiles(){const collections=state.data.collections;if(!collections.length){$('profiles-page').innerHTML='<div class="empty-library"><div class="empty-symbol">◉</div><h2>Voices you can come back to</h2><p>Upload a reference recording, label clean clips, then build a profile collection. It will stay available for future meetings.</p><button id="go-reference" class="primary">Prepare reference voices →</button></div>';$('go-reference').onclick=()=>showView('references');return;}$('profiles-page').innerHTML=`<div class="profile-grid">${collections.map(c=>`<article class="profile-card"><span class="tag">${esc(c.model)}</span><h2 style="margin-top:15px">${esc(c.name)}</h2><p class="profile-meta">${c.speakers.length} voices · Saved ${new Date(c.updated).toLocaleDateString()}</p>${c.speakers.map(s=>`<div class="profile-speaker"><span>${esc(s.name)}</span><span class="muted">${time(s.seconds)} · ${s.clips} clips</span></div><div class="coverage" title="Reference duration against a five-minute collection target; not accuracy"><span style="width:${Math.min(100,s.seconds/300*100)}%"></span></div>`).join('')}<p class="field-hint">Bars show collected speech toward 5 minutes, not model accuracy.</p><button class="secondary" data-reference="${esc(c.media_id)}">Review source clips ↗</button></article>`).join('')}</div>`;$('profiles-page').querySelectorAll('[data-reference]').forEach(b=>b.onclick=()=>openMedia(b.dataset.reference));}
function renderJobs(){const jobs=state.data.jobs;if(!jobs.length){$('jobs-page').innerHTML='<div class="empty-library"><div class="empty-symbol">↻</div><h2>No processing jobs yet</h2><p>Open a meeting to analyze speakers, or build a collection from your reference clips. Jobs run one at a time on this computer.</p></div>';return;}$('jobs-page').innerHTML=`<div class="jobs-list">${jobs.map(j=>`<article class="job-card"><span class="job-status ${esc(j.status)}">${esc(j.status)}</span><div class="job-info"><h3>${esc(j.kind==='enroll'?'Build profiles':'Analyze speakers')} · ${esc(j.media_name)}</h3><p>${esc(j.model)} · ${esc(rangeLabel(j))} · ${esc(j.stage)}${stageCount(j)?` · ${esc(stageCount(j))}`:''}${j.elapsed_seconds!==undefined?` · ${j.elapsed_seconds}s`:''}</p>${j.error?`<p class="job-error">${esc(j.error)}</p>`:''}</div><button class="secondary" data-job="${esc(j.id)}">${j.report?'Review timeline':'Open recording'} ↗</button></article>`).join('')}</div>`;$('jobs-page').querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>{const j=jobs.find(j=>j.id===b.dataset.job);openMedia(j.media_id,j.report?j.id:null);});}
async function upload(file){if(state.uploading)return;if(!allowLeave())return;if(!file.size||file.size>4*1024**3){fail(new Error('Choose a nonempty file no larger than 4 GiB.'));return;}const role=state.view==='references'?'reference':'meeting';state.uploading=true;$('upload-button').disabled=true;$('upload-progress').hidden=false;$('upload-name').textContent=file.name;$('upload-percent').textContent='0%';$('upload-meter').value=0;try{const media=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',`/api/upload?name=${encodeURIComponent(file.name)}&role=${role}`);xhr.setRequestHeader('X-Workbench-Token',state.csrf);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.upload.onprogress=e=>{if(e.lengthComputable){const percent=Math.round(e.loaded/e.total*100);$('upload-meter').value=percent;$('upload-percent').textContent=percent===100?'Saving locally…':`${percent}%`;}};xhr.onload=()=>{try{const body=JSON.parse(xhr.responseText);if(xhr.status>=200&&xhr.status<300)resolve(body);else reject(new Error(body.error||'Upload failed'));}catch{reject(new Error('Upload failed. Check the connection.'));}};xhr.onerror=()=>reject(new Error('Upload connection failed. The file was not saved.'));xhr.send(file);});state.dirty=false;state.labels={};await refresh();await openMedia(media.id);toast('Recording saved locally');}catch(error){fail(error);}finally{state.uploading=false;$('upload-button').disabled=false;$('upload-progress').hidden=true;$('file-input').value='';}}
$('upload-button').onclick=()=>$('file-input').click();$('file-input').onchange=()=>{if($('file-input').files[0])upload($('file-input').files[0]);};document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>showView(b.dataset.view));$('back-library').onclick=()=>showView(state.view);$('setup-button').onclick=()=>$('setup-dialog').showModal();$('close-setup').onclick=()=>$('setup-dialog').close();$('dismiss-error').onclick=()=>$('error-banner').hidden=true;$('player').ontimeupdate=updatePlayback;$('player').onseeked=updatePlayback;$('player').onloadedmetadata=()=>{if(!state.media)return;const d=$('player').duration;$('player').playbackRate=Number($('playback-speed').value)||1;$('recording-meta').textContent=`${state.media.video?'Video':'Audio'} · ${size(state.media.size)} · ${time(d)}`;if(Number.isFinite(d)&&d>0&&!state.media.duration){state.media.duration=d;api(`/api/media/${state.media.id}/duration`,{duration:d}).catch(fail);}renderTimeline();updatePlayback();};$('player').onerror=()=>{if(state.media)fail(new Error('This browser cannot play the file or its codec. The original is saved; audio processing can still be available through FFmpeg.'));};$('playback-speed').onchange=()=>{ $('player').playbackRate=Number($('playback-speed').value); };$('timeline-zoom').oninput=renderTimeline;$('segment-search').oninput=()=>{state.rows=100;renderSegments();};$('more-segments').onclick=()=>{state.rows+=100;renderSegments();};$('mark-in').onclick=()=>$('clip-start').value=$('player').currentTime.toFixed(3);$('mark-out').onclick=()=>$('clip-end').value=$('player').currentTime.toFixed(3);$('clip-form').onsubmit=e=>{e.preventDefault();const start=Number($('clip-start').value),end=Number($('clip-end').value),speaker=$('clip-speaker').value.trim();if(!Number.isFinite(start+end)||start<0||end<=start||end>duration()+.1||!speaker||speaker==='UNKNOWN'){fail(new Error('Choose valid in/out points within the recording and a speaker label other than UNKNOWN.'));return;}state.annotations.push({id:crypto.randomUUID(),start,end,speaker,flag:$('clip-quality').value,included:true});state.annotations.sort((a,b)=>a.start-b.start);markDirty();renderSegments();renderTimeline();$('clip-start').value='';$('clip-end').value='';toast('Clip added. Save labels to keep it.');};$('save-labels').onclick=()=>saveAnnotations().catch(fail);$('save-corrections').onclick=async()=>{if(!Object.keys(state.labels).length){toast('No corrections to save');return;}try{state.report=await api(`/api/report/${state.report.job_id}`,{labels:state.labels,revision:state.report.revision||0});state.labels={};$('save-status').textContent='Corrections saved';renderSegments();renderTimeline();toast('Corrections saved; original predictions preserved');}catch(error){fail(error);}};$('model-select').onchange=()=>{updateModelHint();populateCollections();};$('run-button').onclick=runJob;$('run-history').onchange=()=>{if(allowLeave())loadReport($('run-history').value);else $('run-history').value=state.jobId;};$('refresh-results').onclick=()=>{if(allowLeave()){state.labels={};state.dirty=false;openMedia(state.media.id).catch(fail);}};
window.addEventListener('beforeunload',e=>{if(unsaved()||state.uploading){e.preventDefault();e.returnValue='';}});document.addEventListener('keydown',handlePlaybackKey);
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
$('configure-run').onclick = () => { $('run-error').hidden=true; updateSetup(); updateRangeHint(); $('run-dialog').showModal(); };
$('close-run').onclick = () => $('run-dialog').close();
$('play-toggle').onclick = togglePlayback;
$('skip-back').onclick = () => seek($('player').currentTime - 10);
$('skip-forward').onclick = () => seek($('player').currentTime + 10);
$('seek-position').oninput = () => seek(Number($('seek-position').value));
$('seek-position').onpointerdown=()=>{state.scrubbing=true;};
$('seek-position').onchange=$('seek-position').onpointercancel=()=>{state.scrubbing=false;updatePlayback();};
document.addEventListener('pointerup',()=>{if(state.scrubbing){state.scrubbing=false;updatePlayback();}});
$('fullscreen').onclick = toggleFullscreen;
$('player').ondblclick=toggleFullscreen;
$('player').onplay = updatePlayback;
$('player').onpause = updatePlayback;
$('player').onended = updatePlayback;
$('player').onwaiting=$('player').oncanplay=$('player').onseeking=updatePlayback;
$('player').onvolumechange=syncVolume;
$('mute-toggle').onclick=()=>{const player=$('player');if(player.muted||player.volume===0){player.muted=false;if(player.volume===0)player.volume=state.lastVolume||1;}else{state.lastVolume=player.volume;player.muted=true;}syncVolume();};
$('volume').oninput=()=>{const value=Math.max(0,Math.min(1,Number($('volume').value)));$('player').volume=value;$('player').muted=value===0;if(value>0)state.lastVolume=value;syncVolume();};
document.addEventListener('fullscreenchange',syncFullscreen);
document.addEventListener('webkitfullscreenchange',syncFullscreen);
$('player').addEventListener('webkitbeginfullscreen',()=>{state.nativeFullscreen=true;syncFullscreen();});
$('player').addEventListener('webkitendfullscreen',()=>{state.nativeFullscreen=false;$('player').controls=false;syncFullscreen();});
$('runtime-setup').onclick = () => { $('run-dialog').close(); $('setup-dialog').showModal(); };


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
}
function showAnalysisScope(report) {
  const range = report.analysis_range;
  $('analysis-scope').hidden = !range || range.full_recording;
  if (range && !range.full_recording) {
    $('analysis-scope').textContent = `PREVIEW RUN / ${time(range.start_seconds)}–${time(range.end_seconds)} of the original recording. The rest has not been analyzed.`;
  }
}
function rangeLabel(job) {
  if (job.kind === 'enroll') return 'Reference clips';
  if (job.duration_seconds == null && !job.start_seconds) return 'Full recording';
  if (!job.start_seconds) return `First ${job.duration_seconds / 60} min`;
  return `${time(job.start_seconds)} + ${job.duration_seconds == null ? 'remaining' : `${job.duration_seconds / 60} min`}`;
}
$('analysis-duration').onchange = updateRangeHint;
$('analysis-start').oninput = updateRangeHint;
$('analysis-length').oninput = updateRangeHint;
$('range-from-playhead').onclick = () => {
  $('analysis-duration').value = 'custom';
  $('analysis-start').value = ($('player').currentTime / 60).toFixed(3);
  $('analysis-length').value = '10';
  updateRangeHint();
};

function serverNeedsRestart() {
  const server = state.data?.server;
  return !server || server.protocol < 1 || server.restart_required === true;
}

function sidebarTurns(items, reference=false, showShort=false) {
  return items.map((item,index)=>({item,index})).filter(({item})=>reference || showShort || item.end-item.start+1e-9>=1);
}
$('show-short-turns').onchange=()=>{state.rows=100;renderSegments();};


const PROCESS_STEPS = [
  ['model','Model','Loading the selected model weights from cache or downloading them. The model is fixed for this run.'],
  ['audio','Audio','Extracting the selected section as mono 16 kHz audio. Original video and timestamps are preserved.'],
  ['speech','Speech','Detecting speech activity, speaker changes and how many speakers may be talking simultaneously.'],
  ['features','Voice features','Extracting numerical voice embeddings for speech regions; these are not words or transcripts.'],
  ['group','Group voices','Clustering related voice features and assembling an overlap-preserving speaker timeline.'],
  ['labels','Assign labels','Assigning anonymous labels, or extracting clean identity features and matching compatible saved voice profiles. Uncertain identities remain UNKNOWN.'],
  ['save','Save','Recording provenance and saving the authoritative JSON/CSV files.']
];
const PHASE_STEP = {model_loading:'model',extracting_audio:'audio',analyzing:'speech',segmentation:'speech',speaker_counting:'speech',embeddings:'features',clustering:'group',discrete_diarization:'group',identity_embeddings:'labels',matching:'labels',provenance:'save',saving:'save'};
function stageCount(job) {
  const p=job.progress || {};
  if (!['running','queued'].includes(job.status) || !Number.isFinite(p.total) || p.total<=0 || !Number.isFinite(p.completed)) return '';
  const count=Math.max(0,Math.min(p.total,p.completed));
  return `${count} / ${p.total} ${p.unit || 'items'} · ${Math.floor(count/p.total*100)}% of this stage`;
}
function trackerSteps(job) {
  return job.kind==='enroll' ? [['model','Model',PROCESS_STEPS[0][2]],['references','Reference clips','Extracting each included clean clip and computing a reusable voice profile. This does not train model weights.'],['save','Save collection','Saving model-compatible voiceprints and their local source metadata.']] : PROCESS_STEPS;
}
function currentStep(job) {
  return job.progress?.phase==='references'?'references':PHASE_STEP[job.progress?.phase];
}
function trackerStepMarkup(job) {
  const current=currentStep(job);
  const seen=new Set((job.events || []).map(event=>event.phase==='references'?'references':PHASE_STEP[event.phase]));
  return trackerSteps(job).map(([key,label])=>`<li ${job.status==='running'&&key===current?'aria-current="step"':''} class="${seen.has(key)?'visited':''}">${esc(label)}</li>`).join('');
}
function trackerText(id,text) { if ($(id).textContent!==text) $(id).textContent=text; }
function renderJobTracker(job) {
  $('job-tracker').hidden=!job;
  state.trackerJob=job || null;
  if (!job) return;
  const active=['queued','running'].includes(job.status);
  const workerDown=job.status==='running' && state.data.worker && state.data.worker.ready===false;
  const phase=currentStep(job);
  trackerText('job-track-title',`${job.status.toUpperCase()} · ${job.stage || job.status}`);
  const previous=state.report && state.report.job_id!==job.id;
  trackerText('job-track-context',`${job.model} · ${rangeLabel(job)}${previous?' · The timeline below is an earlier saved result.':''}`);
  const key=JSON.stringify([job.id,job.status,job.progress?.phase,job.events]);
  if ($('job-track-steps')._key!==key) { $('job-track-steps')._key=key; $('job-track-steps').innerHTML=trackerStepMarkup(job); }
  const meter=$('job-track-meter'),count=stageCount(job);
  meter.hidden=!active || workerDown;
  if (count) { meter.max=job.progress.total;meter.value=Math.max(0,Math.min(job.progress.total,job.progress.completed)); }
  else meter.removeAttribute('value');
  meter.setAttribute('aria-valuetext',count || 'Stage in progress; no measured total');
  const detail=workerDown?'Worker unavailable. Restart the services to recover this run.':job.status==='queued'?'Waiting for the local worker.':job.status==='completed'?(job.kind==='enroll'?'Voice collection saved for reuse.':'Final timeline saved. JSON and CSV are ready.'):job.status==='failed'?`Failed during ${job.failed_stage || 'processing'}. This run has stopped.`:job.status==='interrupted'?'This run was interrupted. Start a new run to retry.':count || 'This stage has no measured total. No overall percentage or completion time is estimated.';
  trackerText('job-track-count',detail);
  $('job-track-error').hidden=!job.error;
  trackerText('job-track-error',job.error?.split('\n')[0] || '');
  trackerText('job-track-explanation',trackerSteps(job).find(step=>step[0]===phase)?.[2] || (job.status==='queued'?'Jobs run one at a time. This tracker describes processing; it does not mean partial speaker results are available.':'The final report preserves the model output, including overlapping and short turns.'));
  const events=JSON.stringify(job.events || []);
  if ($('job-track-events')._key!==events) { $('job-track-events')._key=events; $('job-track-events').innerHTML=(job.events || []).map(event=>`<li><time>${esc(new Date(event.at).toLocaleTimeString())}</time> ${esc(event.message)}</li>`).join(''); }
  $('job-track-diagnostics').hidden=!job.error;
  $('job-track-diagnostics').textContent=job.error || '';
  updateTrackerClock();
}
function updateTrackerClock() {
  const job=state.trackerJob;
  if (!job) return;
  const since=stamp=>Math.max(0,Math.floor((Date.now()-Date.parse(stamp))/1000));
  const start=job.started_at || job.queued_at;
  const active=['queued','running'].includes(job.status);
  const seconds=job.elapsed_seconds ?? (start && active?since(start):null);
  trackerText('job-track-clock',seconds==null?'':`${time(seconds)} ${job.status==='queued'?'waiting':'elapsed'}`);
  trackerText('job-track-heartbeat',job.status==='running'?`Worker heartbeat: ${job.heartbeat_at?since(job.heartbeat_at)+'s ago':'not reported'}. Model/stage progress: ${job.last_progress_at?since(job.last_progress_at)+'s ago':'not reported'}. A heartbeat indicates worker activity, not model advancement.`:'');
}
setInterval(updateTrackerClock,1000);


function togglePlayback() {
  const player=$('player');
  state.clipEnd=null;
  if (player.paused) player.play().catch(fail); else player.pause();
}
function syncVolume() {
  const player=$('player'),muted=player.muted || player.volume===0;
  $('volume').value=player.muted?0:player.volume;
  $('volume').setAttribute('aria-valuetext',`${Math.round((muted?0:player.volume)*100)} percent`);
  $('mute-toggle').textContent=muted?'Unmute':'Mute';
  $('mute-toggle').setAttribute('aria-label',muted?'Unmute audio':'Mute audio');
  $('mute-toggle').setAttribute('aria-pressed',String(muted));
}
function fullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement || state.nativeFullscreen || $('player').webkitDisplayingFullscreen);
}
function syncFullscreen() {
  const active=fullscreenActive();
  $('fullscreen').textContent=active?'Exit fullscreen':'Fullscreen';
  $('fullscreen').setAttribute('aria-label',active?'Exit fullscreen':'Enter fullscreen');
  $('fullscreen').setAttribute('aria-pressed',String(active));
}
async function toggleFullscreen() {
  if (!state.media?.video) return;
  const player=$('player'),shell=$('player-shell');
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement) {
      const exit=document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
      if (!exit) throw new Error('Use Escape to exit fullscreen.');
      await exit.call(document);
      return;
    }
    if (state.nativeFullscreen || player.webkitDisplayingFullscreen) {
      const exit=player.webkitExitFullscreen || player.webkitExitFullScreen;
      if (!exit) throw new Error('Use the native Done control to exit fullscreen.');
      exit.call(player);
      state.nativeFullscreen=false;player.controls=false;
      return;
    }
    let rejection;
    const requests=[
      [shell.requestFullscreen,document.fullscreenEnabled],
      [shell.webkitRequestFullscreen || shell.webkitRequestFullScreen,document.webkitFullscreenEnabled]
    ];
    for (const [request,enabled] of requests) {
      if (request && enabled!==false) {
        try { await request.call(shell);return; } catch(error) {rejection=error;}
      }
    }
    const native=player.webkitEnterFullscreen || player.webkitEnterFullScreen;
    if (native) {
      if (player.readyState<1) throw new Error('Wait until the video finishes loading its metadata, then try again.');
      player.controls=true;
      try {
        native.call(player);
        state.nativeFullscreen=!!player.webkitDisplayingFullscreen;
        setTimeout(()=>{
          if (state.media?.video && !fullscreenActive() && player.controls) {
            fail(new Error('The browser did not enter fullscreen. Use the video’s native fullscreen control, or try the Fullscreen button again.'));
          }
        },1000);
        return;
      }
      catch(error) {player.controls=false;state.nativeFullscreen=false;throw error;}
    }
    throw rejection || new Error('Fullscreen is unavailable in this browser.');
  } catch(error) {
    fail(new Error(`Could not change fullscreen: ${error.message || 'the browser blocked the request'}`));
  } finally { syncFullscreen(); }
}
function handlePlaybackKey(event) {
  if (!state.media || $('setup-dialog').open || $('run-dialog').open || event.ctrlKey || event.metaKey || event.altKey) return;
  const focused=document.activeElement;
  if (focused?.isContentEditable || ['INPUT','SELECT','TEXTAREA'].includes(focused?.tagName)) return;
  if ((event.code==='Space' || event.key===' ') && focused?.tagName==='BUTTON') return;
  const key=event.key?.toLowerCase();
  if (event.code==='Space' || key==='k') {event.preventDefault();togglePlayback();}
  else if (key==='arrowleft' || key==='j') {event.preventDefault();seek($('player').currentTime-(key==='j'?10:5));}
  else if (key==='arrowright' || key==='l') {event.preventDefault();seek($('player').currentTime+(key==='l'?10:5));}
  else if (key==='f' && state.media.video) {event.preventDefault();toggleFullscreen();}
  else if (key==='m') {event.preventDefault();$('mute-toggle').click();}
  else if (state.media.role==='reference' && key==='i') $('mark-in').click();
  else if (state.media.role==='reference' && key==='o') $('mark-out').click();
}
syncVolume();

function catalogViewSignature(data) {
  if (!data) return '';
  const jobs=data.jobs.map(job=>state.view==='jobs' ? [job.id,job.status,job.stage,job.model,job.media_name,job.start_seconds,job.duration_seconds,job.progress,job.elapsed_seconds,job.error,job.report] : [job.id,job.media_id,job.status]);
  return JSON.stringify([data.media,data.collections,jobs]);
}
