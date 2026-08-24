// SceneNFO scan policy extension.
// Loaded after app.js so it can extend the existing v0.1 UI without duplicating the whole app bundle.

renderScan = function(){
  content.innerHTML=`<div class="scan-panel">
    <div class="card section-card" style="margin-top:0">
      <h2 style="margin-top:0">New scan</h2>
      <div class="row"><label>Library<small>Radarr or Sonarr</small></label><select id="scan-library"><option value="movies">Movies</option><option value="tv">TV Shows</option></select></div>
      <div class="row"><label>Mode<small>Dry Run only previews changes. Apply writes verified Scene NFOs.</small></label><select id="scan-mode"><option value="false">Dry Run</option><option value="true">Apply</option></select></div>
      <div class="row"><label>NFO handling<small>Choose what happens when a verified Scene release already has an NFO.</small></label>
        <select id="scan-policy">
          <option value="replace_all">Replace all Scene NFOs</option>
          <option value="missing_only">Only add missing NFOs</option>
        </select>
      </div>
      <div class="card" style="padding:14px;margin-top:12px;background:var(--surface-soft,rgba(127,127,127,.08))">
        <div id="policy-help" class="muted" style="font-size:13px;line-height:1.45">
          Existing Scene NFOs are downloaded again from the configured source priority and safely replaced. Useful for incorrect or damaged Usenet NFOs.
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" id="run-scan">Start Scan</button><button class="btn danger" id="stop-scan">Stop</button></div>
      <div style="margin-top:22px"><div class="muted" id="scan-status">Ready</div><div class="progress-shell" style="margin-top:9px"><div class="progress" id="scan-progress"></div></div><div id="scan-counts" style="margin-top:12px;font-size:13px"></div></div>
    </div>
    <div class="card section-card" style="margin-top:0"><div class="section-head"><div><h2>Live results</h2><p>Updates arrive while the scan is running.</p></div></div><div class="live-list" id="live-list"></div></div>
  </div>`;

  const updateHelp=()=>{
    const policy=$('#scan-policy').value;
    $('#policy-help').textContent = policy==='replace_all'
      ? 'Existing Scene NFOs are downloaded again from the configured source priority and safely replaced. Useful for incorrect or damaged Usenet NFOs.'
      : 'Existing matching Scene NFOs are left untouched. A new NFO is downloaded only when the Scene release has no matching NFO.';
  };
  $('#scan-policy').onchange=updateHelp;
  $('#run-scan').onclick=()=>startLiveScan();
  $('#stop-scan').onclick=()=>activeJob&&api(`/api/scans/${activeJob}/stop`,{method:'POST'});
};

startLiveScan = async function(){
  liveRows=[];
  $('#live-list').innerHTML='';
  const library=$('#scan-library').value;
  const apply=$('#scan-mode').value==='true';
  const nfo_policy=$('#scan-policy').value;
  const x=await api('/api/scans',{method:'POST',body:JSON.stringify({library,apply,nfo_policy})});
  activeJob=x.job_id;
  $('#scan-status').textContent='Starting…';

  const es=new EventSource(`/api/scans/${activeJob}/events`);
  es.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.type==='start'){
      const label=d.nfo_policy==='missing_only'?'Missing only':'Replace all';
      $('#scan-status').textContent=`Starting · ${label}`;
    }
    if(d.type==='inventory') $('#scan-status').textContent=`Found ${d.total} MKVs`;
    if(d.type==='item'){
      const pct=d.total?Math.round(d.index/d.total*100):0;
      $('#scan-progress').style.width=`${pct}%`;
      $('#scan-status').textContent=`${d.index} / ${d.total} · ${d.release}`;
      liveRows.unshift(d);
      liveRows=liveRows.slice(0,250);
      $('#live-list').innerHTML=liveRows.map(r=>`<div class="live-row"><span>${r.index}/${r.total}</span>${pill(r.classification)}<span class="mono">${esc(r.release)}</span><span>${esc(r.action||'')}</span></div>`).join('');
    }
    if(d.type==='item_error') $('#scan-status').textContent=`Error: ${d.message}`;
    if(d.type==='complete'){
      $('#scan-progress').style.width='100%';
      $('#scan-status').textContent='Completed';
      $('#scan-counts').textContent=`${d.scene} Scene · ${d.p2p} P2P · ${d.created} created · ${d.replaced} replaced · ${d.errors} errors`;
      es.close();
      toast('Scan completed');
    }
    if(d.type==='fatal'||d.type==='cancelled'){
      $('#scan-status').textContent=d.message;
      es.close();
    }
  };
  es.onerror=()=>{
    if(es.readyState===EventSource.CLOSED) return;
    $('#scan-status').textContent='Live connection interrupted';
  };
};
