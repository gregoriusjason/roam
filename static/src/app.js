(() => {
  'use strict';
  const initial = JSON.parse(document.getElementById('initial-data').textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = (name) => `<i data-lucide="${name}"></i>`;
  const icons = () => window.lucide?.createIcons();
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const state = { user:null, memories:[], journeys:[], ai_ready:initial.aiReady };
  const selected = { origin: initial.locations.find(p => p.id === 'waverley'), destination: initial.locations.find(p => p.id === 'university') };
  let route = null, map = null, markerLayer, routeLayer, footprintLayer, currentCheckpoint = null, photo = null, detourPhoto = null;
  let speaking = false, recognition = null, recording = false, toastTimer, geoMarker, sending = false;
  const placesById = new Map(initial.places.map(p => [p.id, p]));
  let interactions = new Map(), lastRequest = null, shownStops = new Set();

  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 5000);
  }
  async function api(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(path, { ...options, signal:controller.signal, headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...options.headers} });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('That took longer than expected. Please try again.');
      if (error instanceof TypeError) throw new Error('Couldn’t connect. Check your internet and try again.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function refreshState() {
    Object.assign(state, await api('/api/state'));
    state.journeys.forEach(j => j.route.checkpoints.forEach(p => placesById.set(p.id,p)));
    state.memories.forEach(m => { if(!placesById.has(m.checkpoint_id)) placesById.set(m.checkpoint_id,m.checkpoint); });
  }
  function visitedIds() {
    return new Set([...state.memories.map(m=>m.checkpoint_id), ...state.journeys.flatMap(j=>j.completed_stops)]);
  }
  function activeJourney() { return state.journeys.find(j => j.id === route?.id && j.status === 'active'); }
  function checkpointById(id) { return placesById.get(id); }
  function formatDate(value, short=false) {
    const d = new Date(value.includes('T') ? value : value.replace(' ','T')+'Z');
    return d.toLocaleDateString(undefined, {day:'numeric',month:short?'short':'long',...(short?{}:{year:'numeric'})});
  }
  function setView(name, updateHash=true) {
    if (!['explore','journeys','memories'].includes(name)) name = 'explore';
    for(const view of ['explore','journeys','memories']) $(`${view}-view`).hidden = view !== name;
    document.querySelectorAll('[data-view]').forEach(a=>{
      a.classList.toggle('active',a.dataset.view===name);
      if(a.dataset.view===name) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
    });
    if(updateHash) history.replaceState(null,'',`#${name}`);
    if(name==='journeys') renderJourneys();
    if(name==='memories') renderMemories();
    if(name==='explore') setTimeout(()=>map?.invalidateSize(),50);
    window.scrollTo({top:0,behavior:'instant'});
    icons();
  }
  document.querySelectorAll('[data-view]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();setView(a.dataset.view);}));
  document.querySelectorAll('[data-go-explore]').forEach(b=>b.addEventListener('click',()=>setView('explore')));
  window.addEventListener('hashchange',()=>setView(location.hash.slice(1),false));

  function markerIcon(p, number, endpoint=false) {
    const done = visitedIds().has(p.id);
    const symbols = {'History':'landmark','Nature':'leaf','Arts & culture':'palette','Hidden gems':'gem','Local life':'coffee'};
    return L.divIcon({className:'roam-marker', iconSize:[34,34], iconAnchor:[17,17],
      html:`<div class="marker-inner ${done?'visited':''} ${endpoint?'endpoint':''}">${number || icon(endpoint?'map-pin':symbols[p.category]||'map-pin')}<span class="marker-label">${esc(p.name)}</span></div>`});
  }
  function addMarker(p, number, endpoint=false) {
    const marker = L.marker([p.lat,p.lng],{icon:markerIcon(p,number,endpoint),title:p.name,keyboard:true}).addTo(markerLayer);
    const popup = document.createElement('div'); popup.className='map-popup';
    const strong = document.createElement('strong');strong.textContent=p.name;popup.append(strong);
    if(!endpoint){const br=document.createElement('br'),small=document.createElement('small'),button=document.createElement('button');
      small.textContent=visitedIds().has(p.id)?'A familiar place · revisit your story':`${p.category||'Discovery'} · a new story`;
      button.textContent='Take a closer look';button.onclick=()=>openCheckpoint(p);popup.append(br,small,button);}
    marker.bindPopup(popup);
    marker.on('click',()=>icons());
    return marker;
  }
  function drawFootprint() {
    footprintLayer.clearLayers();
    if(state.footprint) L.geoJSON(state.footprint,{interactive:false,style:{stroke:false,fillColor:'#ffd60a',fillOpacity:.45}}).addTo(footprintLayer);
  }
  function drawMap(fit=true) {
    if(!map) return;
    drawFootprint();
    markerLayer.clearLayers();routeLayer.clearLayers();
    if(route) {
      L.geoJSON(route.geometry,{style:{color:'#ffffff',weight:9,opacity:.95,lineCap:'round'}}).addTo(routeLayer);
      const line=L.geoJSON(route.geometry,{style:{color:'#708f4e',weight:5,opacity:1,lineCap:'round'}}).addTo(routeLayer);
      addMarker(route.origin,'A',true);route.checkpoints.forEach((p,i)=>addMarker(p,String(i+1)));addMarker(route.destination,'B',true);
      if(fit) map.fitBounds(line.getBounds(),{paddingTopLeft:[55,75],paddingBottomRight:[55,155],maxZoom:16});
      $('map-status-text').textContent=activeJourney()?'Your adventure is underway':`${route.checkpoints.length} stops. A fresh way there.`;
      $('map-feature').hidden=true;$('map-feature').setAttribute('aria-hidden','true');
      document.querySelector('.map-legend').style.bottom='30px';
    } else {
      const visible=window.innerWidth<=700?[initial.places[1],initial.places[2],initial.places[3]]:[initial.places[0],initial.places[1],initial.places[2],initial.places[3],initial.places[6]];
      visible.forEach(p=>addMarker(p));
      if(fit) map.fitBounds(L.latLngBounds(initial.places.filter(p=>p.image).map(p=>[p.lat,p.lng])),{paddingTopLeft:[65,80],paddingBottomRight:[65,150]});
    }
    icons();
  }
  function initMap() {
    if(!window.L){$('map-error').hidden=false;return;}
    map=L.map('map',{zoomControl:false,scrollWheelZoom:false}).setView([55.951,-3.195],14);
    const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',maxZoom:19}).addTo(map);
    let failures=0; tiles.on('tileerror',()=>{if(++failures>3)$('map-error').hidden=false;});tiles.on('tileload',()=>{$('map-error').hidden=true;});
    L.control.zoom({position:'topright'}).addTo(map);
    footprintLayer=L.layerGroup().addTo(map);markerLayer=L.layerGroup().addTo(map);routeLayer=L.layerGroup().addTo(map);
    const syncMapSize=()=>{
      document.querySelector('.map-shell').style.height=window.innerWidth>700?`${document.querySelector('.planner-column').offsetHeight-25}px`:'';
      map.invalidateSize();
    };
    new ResizeObserver(syncMapSize).observe(document.querySelector('.planner-column'));
    window.addEventListener('resize',syncMapSize);
    drawMap();
    $('fit-map').onclick=()=>drawMap(true);
  }

  const arrivalDefault=new Date(Date.now()+75*60000);
  $('arrival-input').value=`${String(arrivalDefault.getHours()).padStart(2,'0')}:${String(arrivalDefault.getMinutes()).padStart(2,'0')}`;
  for(const field of ['origin','destination']) {
    $(`${field}-input`).addEventListener('input',()=>{
      selected[field]=null;
      const query=$(`${field}-input`).value.trim().toLowerCase();
      const local=initial.locations.filter(p=>query && p.name.toLowerCase().includes(query)).slice(0,5);
      renderPlaces(field,local,false);
    });
    $(`${field}-input`).addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();search(field);}if(e.key==='Escape')$(`${field}-results`).hidden=true;});
  }
  function renderPlaces(field, places, searched=true) {
    const box=$(`${field}-results`);box.replaceChildren();box.hidden=false;
    if(!places.length) {
      if(searched){const p=document.createElement('p');p.className='place-result muted';p.textContent='No places found. Try adding the city name.';box.append(p);}
      else {const b=document.createElement('button');b.type='button';b.className='place-result';b.textContent='Search for this place →';b.onclick=()=>search(field);box.append(b);}
      return;
    }
    places.forEach(p=>{const b=document.createElement('button');b.type='button';b.className='place-result';
      b.innerHTML=`<strong>${esc(p.name)}</strong><small>${esc(p.area||'Edinburgh, Scotland')}</small>`;
      b.onclick=()=>{selected[field]=p;$(`${field}-input`).value=p.name;box.hidden=true;if(map)map.setView([p.lat,p.lng],14);if(p.area&&!p.area.includes('Edinburgh'))$('city-label').textContent=p.area;};box.append(b);});
  }
  async function search(field) {
    const query=$(`${field}-input`).value.trim();
    if(query.length<2){toast('Enter at least two letters to find a place.');return;}
    const box=$(`${field}-results`);box.hidden=false;box.innerHTML='<p class="place-result muted">Looking for that place…</p>';
    try{const data=await api(`/api/places?q=${encodeURIComponent(query)}`);renderPlaces(field,data.places);}
    catch(error){box.hidden=true;toast(error.message);}
  }
  document.querySelectorAll('.search-place').forEach(b=>b.onclick=()=>search(b.dataset.field));
  document.addEventListener('click',e=>{if(!e.target.closest('.field-wrap'))document.querySelectorAll('.place-results').forEach(b=>b.hidden=true);});
  $('city-button').onclick=()=>{$('origin-input').focus();$('origin-input').select();toast('Search a starting point around Edinburgh, then choose a nearby destination.');};
  function locationStatus(message, tone='info') {
    const node=$('location-status');node.textContent=message;node.className=`location-status ${tone}`;node.hidden=!message;
  }
  $('locate-button').onclick=async()=>{
    if(!navigator.geolocation){locationStatus('Location is unavailable in this browser. Search for Edinburgh Waverley instead.','error');return;}
    if(!window.isSecureContext && !['localhost','127.0.0.1'].includes(location.hostname)){
      locationStatus('Your phone blocks location on this HTTP address. Open the app over HTTPS, or choose a starting point below.','error');
      toast('Location needs HTTPS on your phone.');return;
    }
    if(navigator.permissions?.query){
      try{const permission=await navigator.permissions.query({name:'geolocation'});if(permission.state==='denied'){locationStatus('Location is blocked for this site. Enable it in your browser settings, then try again.','error');return;}}catch(_){/* Older browsers do not expose permission state. */}
    }
    $('locate-button').disabled=true;locationStatus('Finding you around Edinburgh…','loading');
    navigator.geolocation.getCurrentPosition(pos=>{
      selected.origin={id:'gps',name:'My current location',lat:pos.coords.latitude,lng:pos.coords.longitude};
      $('origin-input').value=selected.origin.name;$('origin-results').hidden=true;locationStatus(`Location found (±${Math.round(pos.coords.accuracy)} m). You can still edit it.`, 'success');
      if(map){geoMarker?.remove();geoMarker=L.circleMarker([selected.origin.lat,selected.origin.lng],{radius:8,color:'#fff',weight:3,fillColor:'#5682b1',fillOpacity:1}).addTo(map);map.setView([selected.origin.lat,selected.origin.lng],15);}
      $('city-label').textContent='Around your location';$('locate-button').disabled=false;toast('Starting point set to your current location.');
    },error=>{
      const message=error.code===1?'Location permission was denied. Enable it in your browser settings or search for a place.':error.code===2?'Your location could not be found. Try again near a window, or search for a place.':'Location took too long. Try again, or choose Edinburgh Waverley.';
      locationStatus(message,'error');$('locate-button').disabled=false;toast(message);
    },{enableHighAccuracy:false,timeout:30000,maximumAge:300000});
  };
  document.querySelectorAll('[data-interest]').forEach(b=>b.onclick=()=>{b.classList.toggle('selected');b.setAttribute('aria-pressed',b.classList.contains('selected'));});
  function compressPhoto(file) {
    return new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(file),img=new Image();
      img.onload=()=>{const scale=Math.min(1,1100/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);URL.revokeObjectURL(url);resolve(canvas.toDataURL('image/jpeg',.72));};
      img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('This photo format could not be read. Try a JPEG or PNG.'));};img.src=url;
    });
  }
  function renderDetourPhoto() {
    const box=$('detour-photo-preview');box.hidden=!detourPhoto;box.innerHTML=detourPhoto?`<img src="${detourPhoto}" alt="Visual clue for the detour"><button type="button" aria-label="Remove detour photo">${icon('x')}</button>`:'';
    if(detourPhoto)box.querySelector('button').onclick=()=>{detourPhoto=null;renderDetourPhoto();};icons();
  }
  $('detour-photo-input').addEventListener('change',async e=>{
    const file=e.target.files?.[0];e.target.value='';if(!file)return;
    if(!file.type.startsWith('image/')){toast('Choose a photo to guide your detour.');return;}
    if(file.size>20*1024*1024){toast('That image is too large. Choose one smaller than 20 MB.');return;}
    try{detourPhoto=await compressPhoto(file);if(detourPhoto.length>1800000){detourPhoto=null;toast('That photo is still too large. Choose a smaller image.');return;}renderDetourPhoto();toast('Visual clue attached.');}
    catch(error){toast(error.message);}
  });
  $('trip-form').addEventListener('submit',async e=>{
    e.preventDefault();$('trip-error').hidden=true;
    for(const field of ['origin','destination']){
      if(!selected[field]){
        const exact=initial.locations.find(p=>p.name.toLowerCase()===$(`${field}-input`).value.trim().toLowerCase());
        if(exact)selected[field]=exact;else {await search(field);$('trip-error').textContent=`Choose your ${field==='origin'?'starting point':'destination'} from the search results, then try again.`;$('trip-error').hidden=false;return;}
      }
    }
    const [hours,minutes]=$('arrival-input').value.split(':').map(Number);const arrival=new Date();arrival.setHours(hours,minutes,0,0);
    if(arrival.getTime()-Date.now()<5*60000){$('trip-error').textContent='Choose an arrival time at least 5 minutes from now, today.';$('trip-error').hidden=false;return;}
    const button=$('generate-button');button.disabled=true;button.innerHTML='<span class="loading-spinner"></span><span>Finding a fresh way there…</span>';
    lastRequest={origin:selected.origin,destination:selected.destination,arrival_at:arrival.toISOString(),interests:[...document.querySelectorAll('[data-interest].selected')].map(b=>b.dataset.interest),fresh_only:$('fresh-only').checked,photo:detourPhoto};
    shownStops=new Set();
    try {
      await loadRoute(await api('/api/routes',{method:'POST',body:JSON.stringify(lastRequest)}));
      $('map').scrollIntoView({behavior:'smooth',block:'start'});toast('Your detour is ready. Take a look, then start wandering.');
    } catch(error){$('trip-error').textContent=error.message;$('trip-error').hidden=false;}
    finally{button.disabled=false;button.innerHTML=`${icon('sparkles')}<span>Find my detour</span>${icon('arrow-right')}`;icons();}
  });
  async function loadRoute(data) {
    route=data.route;route.checkpoints.forEach(p=>{placesById.set(p.id,p);shownStops.add(p.id);});
    await refreshState();renderRoute();drawMap();
    $('city-label').textContent=route.origin.name;
  }
  async function regenerateRoute() {
    if(!lastRequest||!route)return;
    const button=$('route-regenerate');button.disabled=true;button.innerHTML='<span class="loading-spinner"></span>Finding new stops…';
    try {
      const previous=route.checkpoints.map(p=>p.id).join();
      await loadRoute(await api('/api/routes',{method:'POST',body:JSON.stringify({...lastRequest,regenerate:true,exclude:[...shownStops].slice(-150),replaces:route.id})}));
      toast(route.checkpoints.map(p=>p.id).join()===previous?'No other stops fit this walk. Try a later arrival time.':'A new way there, through different places.');
    } catch(error){toast(error.message);if($('route-regenerate')){$('route-regenerate').disabled=false;$('route-regenerate').innerHTML=`${icon('refresh-cw')}Regenerate route`;icons();}}
  }
  function renderRoute() {
    const panel=$('route-panel');panel.hidden=!route;if(!route)return;
    const journey=state.journeys.find(j=>j.id===route.id),active=activeJourney(),finished=journey?.status==='completed';const completed=journey?.completed_stops||[];const time=new Date(Date.now()+route.total_minutes*60000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    panel.innerHTML=`<div class="route-heading"><div><span class="eyebrow">${active?'YOUR ADVENTURE, IN PROGRESS':'YOUR LITTLE DETOUR'}</span><h2>${route.checkpoints.length?'A few stories on the way.':'A little walk, all yours.'}</h2></div><span class="badge">${route.mode==='ai'?'AI personalised':'Discovery route'}</span></div>
      <div class="route-metrics"><div><strong>${route.total_minutes} <small>min</small></strong><span>with time to pause</span></div><div><strong>${(route.distance/1000).toFixed(1)} <small>km</small></strong><span>on foot</span></div><div><strong>${route.new_places}</strong><span>new discoveries</span></div></div>
      ${route.warnings.map(w=>`<p class="route-warning">${esc(w)}</p>`).join('')}
      <div class="checkpoint-list">${route.checkpoints.map((p,i)=>`<button class="route-stop" data-stop="${esc(p.id)}"><span class="stop-number ${completed.includes(p.id)?'done':''}">${completed.includes(p.id)?icon('check'):i+1}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.category)} · ${p.visited?'A familiar favourite':'New to your story'}</small></span>${icon('chevron-right')}</button>`).join('')}</div>
      ${active?`<div class="route-progress"><span style="width:${route.checkpoints.length?completed.length/route.checkpoints.length*100:0}%"></span></div><div class="route-progress-label"><span>${completed.length} of ${route.checkpoints.length} checkpoints visited</span><span>At your own pace</span></div>`:''}
      <div class="route-actions"><button class="primary-button" id="route-main-action">${icon(active?'flag':finished?'book-heart':'footprints')}<span>${active?'Finish this walk':finished?'Relive this walk':'Let’s start wandering'}</span>${icon('arrow-right')}</button>${active?'<button class="secondary-button" id="route-next">Open next stop</button>':''}${!active&&!finished&&lastRequest?`<button class="secondary-button" id="route-regenerate">${icon('refresh-cw')}Regenerate route</button>`:''}</div>
      <p class="route-note">${active?'Tap a checkpoint when you arrive to mark your progress and teach Pip.':`Estimated arrival if you leave now: ${time}. Includes 5 minutes at each stop and at least a 5-minute arrival buffer when generated.`} Walking estimates may vary; check access and conditions as you go.</p>`;
    panel.querySelectorAll('[data-stop]').forEach(b=>b.onclick=()=>openCheckpoint(checkpointById(b.dataset.stop)));
    $('route-main-action').onclick=()=>active?finishJourney():finished?showSummary(journey):startJourney();
    if($('route-regenerate'))$('route-regenerate').onclick=regenerateRoute;
    if($('route-next'))$('route-next').onclick=()=>{const next=route.checkpoints.find(p=>!completed.includes(p.id));if(next)openCheckpoint(next);else toast('All checkpoints visited. Finish your walk when you reach the destination.');};
    icons();
  }
  async function startJourney() {
    $('route-main-action').disabled=true;
    try {await api(`/api/journeys/${route.id}`,{method:'POST',body:JSON.stringify({action:'start'})});await refreshState();renderRoute();drawMap(false);toast('Let’s wander. Open a checkpoint when you arrive.');}
    catch(error){toast(error.message);$('route-main-action').disabled=false;}
  }
  async function markVisited(p) {
    if(!activeJourney()){toast('Start your route first to track checkpoint progress.');return;}
    try {await api(`/api/journeys/${route.id}`,{method:'POST',body:JSON.stringify({action:'visit',checkpoint_id:p.id})});await refreshState();renderRoute();drawMap(false);openCheckpoint(p);toast(`${p.name} added to your journey.`);}
    catch(error){toast(error.message);}
  }
  async function finishJourney() {
    $('route-main-action').disabled=true;
    try {await api(`/api/journeys/${route.id}`,{method:'POST',body:JSON.stringify({action:'finish'})});await refreshState();showSummary(state.journeys.find(j=>j.id===route.id));renderRoute();drawMap(false);}
    catch(error){toast(error.message);$('route-main-action').disabled=false;}
  }
  function openCheckpoint(p) {
    if(!p)return;currentCheckpoint=p;
    const notes=state.memories.filter(m=>m.checkpoint_id===p.id),active=activeJourney();
    const onRoute=active&&route.checkpoints.some(c=>c.id===p.id),done=onRoute&&active.completed_stops.includes(p.id);
    $('checkpoint-content').innerHTML=`${p.image?`<img class="checkpoint-cover" src="/static/images/${esc(p.image)}" alt="${esc(p.name)}">`:`<div class="checkpoint-placeholder">${icon('map-pin')}</div>`}<div class="checkpoint-detail"><span class="eyebrow">${esc(p.category||'YOUR DISCOVERY')} ${notes.length?'· A FAMILIAR PLACE':'· A NEW PERSPECTIVE'}</span><h2>${esc(p.name)}</h2><p>${esc(p.description||'Every place has a story. What will you notice here?')}</p>${notes.length?`<div class="recall-note">We have a story here. You wrote: “${esc(notes.at(-1).content)}”</div>`:''}${p.fact?`<details class="fact-card"><summary>A little context, if you’re curious</summary><p>${esc(p.fact)}</p>${p.fact_credit?`<small class="fact-credit">${esc(p.fact_credit)} · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">licence</a></small>`:''}<a href="${esc(p.source)}" target="_blank" rel="noopener">Read the source ${icon('arrow-up-right')}</a></details>`:''}<button class="primary-button" id="teach-checkpoint">${icon('message-circle')}<span>${notes.length?'Tell Pip something new':'Teach Pip about this place'}</span>${icon('arrow-right')}</button>${onRoute?`<button class="secondary-button" id="mark-checkpoint" ${done?'disabled':''}>${icon(done?'check':'map-pin')}${done?'Visited — a memory in the making':'I’m here · mark as visited'}</button>`:''}<p class="small muted">You don’t have to be an expert. A thought, a detail, or a story is a good place to start.</p></div>`;
    $('teach-checkpoint').onclick=()=>{$('checkpoint-dialog').close();openCompanion(p);};
    if($('mark-checkpoint'))$('mark-checkpoint').onclick=()=>markVisited(p);
    if(!$('checkpoint-dialog').open)$('checkpoint-dialog').showModal();icons();
  }
  document.querySelectorAll('[data-place-id]').forEach(b=>b.onclick=()=>openCheckpoint(checkpointById(b.dataset.placeId)));
  $('show-all-places').onclick=()=>{$('map').scrollIntoView({behavior:'smooth',block:'center'});drawMap();};
  $('browse-map').onclick=()=>openCheckpoint(initial.places[0]);
  $('meet-pip-button').onclick=()=>openCompanion(initial.places[0]);
  $('credits-button').onclick=()=>$('credits-dialog').showModal();

  function appendBubble(role,text,image=null,container=$('chat-messages')) {
    const bubble=document.createElement('div');bubble.className=`chat-bubble ${role}`;
    if(role!=='system'){const speaker=document.createElement('span');speaker.className='chat-speaker';speaker.textContent=role==='user'?'You · the storyteller':'Pip · the curious one';bubble.append(speaker);}
    if(image){const img=document.createElement('img');img.src=image;img.alt='Your photo of this place';bubble.append(img);}
    bubble.append(document.createTextNode(text));container.append(bubble);container.scrollTop=container.scrollHeight;return bubble;
  }
  function openCompanion(p) {
    if(sending){toast('Your last note is still being saved. Please wait a moment.');return;}
    currentCheckpoint=p;photo=null;renderPhoto();$('chat-input').value='';
    $('companion-location').textContent=p.name;
    $('companion-mode').textContent=state.ai_ready?(state.user?'You’re the guide. Pip is here to learn.':'Guest session · sign in later to keep this across devices'):'Notebook mode · OpenAI isn’t connected yet';
    const messages=$('chat-messages');messages.replaceChildren();const notes=state.memories.filter(m=>m.checkpoint_id===p.id);
    if(notes.length){appendBubble('assistant',`We have a memory here! At ${p.name}, you told me: “${notes.at(-1).content}” What are you noticing this time?`);}
    else appendBubble('assistant',`So, this is ${p.name}! What catches your eye? I’d love to hear the story through your eyes.`);
    if(!state.ai_ready)appendBubble('system','Pip’s introduction is a preview. Your notes and photos will still be saved here. Live replies begin when OpenAI is connected.');
    const current=interactions.get(p.id)||[];current.forEach(m=>appendBubble(m.role,m.text,m.photo));
    if(!$('companion-dialog').open)$('companion-dialog').show();icons();
  }
  $('chat-form').addEventListener('submit',async e=>{
    e.preventDefault();const message=$('chat-input').value.trim();if(!message||!currentCheckpoint||sending)return;
    sending=true;recognition?.stop();
    const p=currentCheckpoint,attachment=photo;
    $('send-message').disabled=true;$('chat-input').disabled=true;$('mic-button').disabled=true;$('camera-button').disabled=true;
    const userBubble=appendBubble('user',message,attachment);const waiting=appendBubble('system',state.ai_ready?'Pip is thinking…':'Saving your observation…');
    try {
      const belongs=activeJourney()&&route.checkpoints.some(c=>c.id===p.id);
      const result=await api('/api/chat',{method:'POST',body:JSON.stringify({message,checkpoint:p,photo:attachment,journey_id:belongs?route.id:null})});
      waiting.remove();appendBubble(result.mode==='unavailable'?'system':'assistant',result.reply);
      const chat=interactions.get(p.id)||[];chat.push({role:'user',text:message,photo:attachment},{role:result.mode==='unavailable'?'system':'assistant',text:result.reply});interactions.set(p.id,chat);
      $('chat-input').value='';photo=null;renderPhoto();
      if(result.mode==='ai'&&speaking&&'speechSynthesis'in window){speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(result.reply);utterance.lang=navigator.language;utterance.rate=.97;speechSynthesis.speak(utterance);}
      try{await refreshState();drawMap(false);}catch(_){toast('Your note was saved. Refresh the page to update the notebook.');}
    }catch(error){waiting.remove();userBubble.remove();appendBubble('system',error.message+' Your text is still in the message box.');}
    finally{sending=false;$('send-message').disabled=false;$('chat-input').disabled=false;$('mic-button').disabled=false;$('camera-button').disabled=false;}
  });
  $('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&window.innerWidth>700){e.preventDefault();$('chat-form').requestSubmit();}});
  $('voice-toggle').onclick=()=>{
    if(!('speechSynthesis'in window)){toast('Spoken replies aren’t supported by this browser. Text replies still work.');return;}
    speaking=!speaking;$('voice-toggle').setAttribute('aria-pressed',speaking);$('voice-toggle').setAttribute('aria-label',speaking?'Turn spoken replies off':'Turn spoken replies on');$('voice-toggle').innerHTML=icon(speaking?'volume-2':'volume-x');icons();
    if(speaking){const u=new SpeechSynthesisUtterance('Spoken replies are on.');u.volume=.6;speechSynthesis.speak(u);}else speechSynthesis.cancel();
  };
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  $('mic-button').onclick=()=>{
    if(!SpeechRecognition){toast('Voice input isn’t supported here. Try Safari or Chrome, or type your observation.');return;}
    if(!window.isSecureContext){toast('Microphone access needs HTTPS on your phone. You can type your note for now.');return;}
    if(recording){recognition?.stop();return;}
    const existing=$('chat-input').value;
    recognition=new SpeechRecognition();recognition.lang=navigator.language||'en-GB';recognition.continuous=false;recognition.interimResults=true;
    recognition.onstart=()=>{recording=true;$('mic-button').classList.add('recording');$('mic-button').setAttribute('aria-label','Stop recording');$('voice-status').textContent='Listening… tap to stop';};
    recognition.onresult=e=>{const transcript=[...e.results].map(r=>r[0].transcript).join(' ');$('chat-input').value=(existing+(existing?' ':'')+transcript).slice(0,4000);};
    recognition.onerror=e=>{toast(e.error==='not-allowed'?'Microphone access was denied. Check browser permissions, or type your note.':'Couldn’t hear that. Try again, or type your observation.');};
    recognition.onend=()=>{recording=false;$('mic-button').classList.remove('recording');$('mic-button').setAttribute('aria-label','Speak your observation');$('voice-status').textContent='Review your words, then send.';};
    try{recognition.start();}catch(_){toast('The microphone couldn’t start. Please try again.');}
  };
  $('companion-dialog').addEventListener('close',()=>{recognition?.stop();if('speechSynthesis'in window)speechSynthesis.cancel();});
  $('camera-button').onclick=()=>$('camera-input').click();
  $('camera-input').addEventListener('change',async e=>{
    const file=e.target.files?.[0];if(!file)return;
    if(!file.type.startsWith('image/')){toast('Choose a photo to share with Pip.');return;}
    if(file.size>20*1024*1024){toast('That image is too large. Choose one smaller than 20 MB.');return;}
    try{photo=await compressPhoto(file);if(photo.length>1800000){photo=null;toast('That photo is still too large. Choose a smaller image.');return;}renderPhoto();if(!$('chat-input').value)$('chat-input').focus();}
    catch(error){toast(error.message);}e.target.value='';
  });
  function renderPhoto(){const box=$('photo-preview');box.hidden=!photo;box.innerHTML=photo?`<img src="${photo}" alt="Photo attached to your next note"><button type="button" aria-label="Remove attached photo">${icon('x')}</button>`:'';if(photo)box.querySelector('button').onclick=()=>{photo=null;renderPhoto();};icons();}

  function empty(iconName,title,text) {return `<div class="empty-state"><div class="empty-icon">${icon(iconName)}</div><h2>${title}</h2><p>${text}</p><button class="primary-button" data-empty-explore>Find your first detour ${icon('arrow-right')}</button></div>`;}
  function renderJourneys() {
    const journeys=state.journeys.filter(j=>j.status!=='draft');const completed=journeys.filter(j=>j.status==='completed');
    $('journey-stats').innerHTML=[['route',completed.length,'walks completed'],['map-pin',visitedIds().size,'places explored'],['book-heart',state.memories.length,'stories shared']].map(([i,n,label])=>`<div class="stat-card"><div class="stat-icon">${icon(i)}</div><div><strong>${n}</strong><small>${label}</small></div></div>`).join('');
    $('journey-list').innerHTML=journeys.length?journeys.map(j=>`<article class="journey-card"><div><span class="eyebrow">${esc(formatDate(j.created_at))} · ${j.status==='active'?'IN PROGRESS':j.status==='paused'?'PAUSED':'A CHAPTER COMPLETE'}</span><h2>${esc(j.route.origin.name)} <span class="muted">→</span> ${esc(j.route.destination.name)}</h2><p>${j.completed_stops.length} of ${j.route.checkpoints.length} checkpoints visited · ${(j.route.distance/1000).toFixed(1)} km planned · ${state.memories.filter(m=>m.journey_id===j.id).length} memories</p></div><div class="journey-card-actions">${j.status==='completed'?`<button class="secondary-button" data-summary="${j.id}">Relive this walk ${icon('arrow-up-right')}</button>`:`<button class="secondary-button" data-resume="${j.id}">Continue exploring ${icon('arrow-right')}</button>`}</div></article>`).join(''):empty('footprints','Your first chapter is waiting.','A route, a few discoveries, a story only you can tell. Your walks will find a home here.');
    $('journey-list').querySelectorAll('[data-resume]').forEach(b=>b.onclick=async()=>{b.disabled=true;const j=state.journeys.find(x=>x.id===b.dataset.resume);try{if(j.status==='paused')await api(`/api/journeys/${j.id}`,{method:'POST',body:JSON.stringify({action:'resume'})});await refreshState();route=j.route;setView('explore');renderRoute();drawMap();$('route-panel').scrollIntoView({behavior:'smooth',block:'center'});}catch(error){toast(error.message);b.disabled=false;}});
    $('journey-list').querySelectorAll('[data-summary]').forEach(b=>b.onclick=()=>showSummary(state.journeys.find(j=>j.id===b.dataset.summary)));
    bindEmpty();icons();
  }
  function bindEmpty(){document.querySelectorAll('[data-empty-explore]').forEach(b=>b.onclick=()=>setView('explore'));}
  function renderMemories() {
    const query=$('memory-search').value.toLowerCase().trim();const memories=[...state.memories].reverse().filter(m=>(m.content+' '+m.checkpoint.name).toLowerCase().includes(query));
    $('memory-count').textContent=`${memories.length} ${memories.length===1?'memory':'memories'} in our notebook`;
    $('memory-list').innerHTML=memories.length?memories.map(m=>`<article class="memory-card">${m.photo?`<img src="${esc(m.photo)}" alt="Your photo at ${esc(m.checkpoint.name)}" loading="lazy">`:''}<span class="eyebrow">${esc(formatDate(m.created_at,true))} · YOU TAUGHT PIP</span><h2>${esc(m.checkpoint.name)}</h2><blockquote>“${esc(m.content)}”</blockquote><div class="memory-card-footer"><button class="text-button" data-revisit="${esc(m.checkpoint_id)}">Revisit this story ${icon('arrow-up-right')}</button><button class="icon-button" aria-label="Delete this memory" data-delete="${m.id}">${icon('trash-2')}</button></div></article>`).join(''):query?'<div class="empty-state"><h2>No stories found.</h2><p>Try a different place name or a word from your note.</p></div>':empty('book-heart','Start a story worth keeping.','Spot a detail. Share a thought. Teach Pip something about a place, and your memory will be waiting here.');
    $('memory-list').querySelectorAll('[data-revisit]').forEach(b=>b.onclick=()=>openCompanion(checkpointById(b.dataset.revisit)));
    $('memory-list').querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{
      if(!confirm('Delete this memory and its conversation context? This can’t be undone.'))return;
      b.disabled=true;try{const m=state.memories.find(m=>m.id===b.dataset.delete);await api(`/api/memories/${b.dataset.delete}`,{method:'DELETE'});interactions.delete(m.checkpoint_id);await refreshState();renderMemories();drawMap(false);toast('Memory deleted.');}catch(error){toast(error.message);b.disabled=false;}
    });bindEmpty();icons();
  }
  $('memory-search').addEventListener('input',renderMemories);
  $('export-memories').onclick=()=>{
    if(!state.memories.length){toast('Share your first story to start your notebook.');return;}
    const text='# Our Roam notebook\n\nYou explore. You explain. Your AI remembers.\n\n'+state.memories.map(m=>`## ${m.checkpoint.name}\n${formatDate(m.created_at)}\n\n${m.content}\n`).join('\n');
    const blob=new Blob([text],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='our-roam-notebook.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Your notebook has been exported.');
  };
  function showSummary(journey) {
    const memories=state.memories.filter(m=>m.journey_id===journey.id);
    $('summary-content').innerHTML=`<div class="pip-face large"><span></span><span></span><b></b></div><span class="eyebrow">ANOTHER CHAPTER, TOGETHER</span><h2>A little walk.<br><em>A lot to remember.</em></h2><p>${esc(journey.route.origin.name)} to ${esc(journey.route.destination.name)}</p><div class="summary-stats"><div><strong>${journey.completed_stops.length}</strong><span>places visited</span></div><div><strong>${memories.length}</strong><span>stories shared</span></div><div><strong>${(journey.route.distance/1000).toFixed(1)}</strong><span>km planned</span></div></div><div class="summary-notes">${memories.length?memories.map(m=>`<div class="summary-note"><strong>${esc(m.checkpoint.name)}</strong><p>“${esc(m.content)}”</p></div>`).join(''):'<p>Your walk is saved. Next time, share a detail with Pip to add a story to your journey.</p>'}</div><button class="primary-button" id="summary-memories">Open our notebook ${icon('book-heart')}</button><button class="secondary-button" id="summary-journeys">See all my journeys ${icon('route')}</button>`;
    $('summary-memories').onclick=()=>{$('summary-dialog').close();setView('memories');};$('summary-journeys').onclick=()=>{$('summary-dialog').close();setView('journeys');};
    if(!$('summary-dialog').open)$('summary-dialog').showModal();icons();
  }
  async function init() {
    initMap();
    try{await refreshState();const active=state.journeys.find(j=>j.status==='active');if(active){route=active.route;renderRoute();}drawMap();}
    catch(error){toast('Your saved stories couldn’t load. '+error.message);}
    setView(location.hash.slice(1)||'explore',false);icons();
  }
  init();
})();
