'use strict';

// ── Config ─────────────────────────────────────────────────────────────────
const CFG_URL   = 'https://vcriojbgprbtpctersau.supabase.co/functions/v1/app-config';
const RTC_CFG   = {iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};
const MAX_PEERS = 7, FPS = 15, MAX_REC = 450;

// ── Char sets ───────────────────────────────────────────────────────────────
const CSETS = {
  standard:' .,:;i1tfLCG08@',
  dense:   " .'`\",:;!i~+_-?][}{1)(|tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  minimal: ' .:-=+*%@',
  blocks:  ' ░▒▓█',
  binary:  ' .·01#',
  matrix:  " .:!/1|il;,^`-_~<>()'",
};

// ── State ───────────────────────────────────────────────────────────────────
let sb, currentUser, profile;
let localStream=null, channel=null, roomId=null, userId=null;
let renderTimer=null, frames=0, fpsT=performance.now();
let timerIv=null, callStart=0, callHistId=null;
let chatOpen=false, chatUnread=0;
let micMuted=false, isSpectator=false, isRecording=false;
let recFrames=[], recStart=0;
let curRes={w:200,h:150};
let contrast=128, bright=0, vuGain=3;
let charSet=CSETS.standard.split(''), activeCSKey='standard';
let spotlitId=null;

// Pinned message state
let pinnedMsg=null; // {text,username,ts}

// Call log (for summary)
let callLog = {
  room:'', start:null, end:null,
  myUsername:'', isSpectator:false,
  participants:[], // [{username,joined,left}]
  chat:[],         // [{ts,username,text}]
};

// Audio
let audioCtx=null;
const analysers = new Map(); // uid|'local' → AnalyserNode
const VU_COLS=52, VU_ROWS=12;

const peers = new Map();

// Username colour cache
const colourCache = new Map();

// ── DOM ─────────────────────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
const loadEl=$('loading'), authEl=$('auth-screen'), joinEl=$('join-screen'), callEl=$('call-screen');
const grid=$('video-grid'), waitOvl=$('wait-ovl');
const lAscii=$('local-ascii'), lVid=$('local-video'), lCvs=$('local-canvas'), lCtx=lCvs.getContext('2d');

// ── Boot ────────────────────────────────────────────────────────────────────
(async()=>{
  try{
    const params=new URLSearchParams(window.location.search);
    const tH=params.get('token_hash'), tp=params.get('type');
    const r=await fetch(CFG_URL);
    if(!r.ok) throw new Error('Config fetch failed ('+r.status+')');
    const {supabaseUrl,anonKey}=await r.json();
    sb=window.supabase.createClient(supabaseUrl,anonKey);
    loadSettings();
    applyTheme(localStorage.getItem('ascii-theme')||'terminal');
    if(tH&&tp){
      const{error}=await sb.auth.verifyOtp({token_hash:tH,type:tp});
      if(!error){$('cbanner').style.display='block';setTimeout(()=>$('cbanner').style.display='none',4500);window.history.replaceState({},'',window.location.pathname);}
    }
    const{data:{session}}=await sb.auth.getSession();
    if(session){currentUser=session.user;userId=currentUser.id;await loadProfile();showJoin();}
    else showAuth();
  }catch(e){loadEl.innerHTML=`<div class="logo" style="font-size:3rem;color:var(--red)">ERROR</div><div style="color:var(--red);font-size:.75rem;margin-top:1rem">${e.message}</div>`;}
})();

// ── Screens ─────────────────────────────────────────────────────────────────
function showAuth(){loadEl.style.display='none';authEl.style.display='flex';joinEl.style.display='none';callEl.style.display='none';}
function showJoin(){loadEl.style.display='none';authEl.style.display='none';joinEl.style.display='flex';callEl.style.display='none';$('join-uname').textContent=profile?.username||'—';$('corner-name').textContent=profile?.username||'—';}
function showCall(){loadEl.style.display='none';authEl.style.display='none';joinEl.style.display='none';callEl.style.display='flex';}

// ── Username colours ────────────────────────────────────────────────────────
function uidToColour(uid){
  if(colourCache.has(uid)) return colourCache.get(uid);
  let hash=0;
  for(let i=0;i<uid.length;i++) hash=(hash*31+uid.charCodeAt(i))>>>0;
  const hue=hash%360;
  const isPaper=document.documentElement.dataset.theme==='paper';
  const col=isPaper ? `hsl(${hue},65%,28%)` : `hsl(${hue},90%,62%)`;
  colourCache.set(uid,col);
  return col;
}
function myColour(){return userId ? uidToColour(userId) : 'var(--p)';}

// ── Themes ──────────────────────────────────────────────────────────────────
const THEMES=['terminal','amber','glacier','crimson','matrix','vapor','paper'];
function applyTheme(name){
  if(!THEMES.includes(name)) name='terminal';
  document.documentElement.dataset.theme=name==='terminal'?'':name;
  colourCache.clear();
  document.querySelectorAll('.tsw').forEach(el=>{const on=el.dataset.theme===name;el.classList.toggle('active',on);el.querySelector('.swtk').textContent=on?'✓':'';});
  localStorage.setItem('ascii-theme',name);
  if($('pm-theme')) $('pm-theme').textContent=name;
  if(profile&&profile.theme!==name){profile.theme=name;sb?.from('profiles').update({theme:name}).eq('id',userId).then(()=>{});}
  refreshPeerColours();
}
document.querySelectorAll('.tsw').forEach(el=>el.addEventListener('click',()=>applyTheme(el.dataset.theme)));

function refreshPeerColours(){
  const lname=$('local-name');
  if(lname&&userId) lname.style.color=myColour();
  for(const[pid,p]of peers){
    const nameEl=p.panel?.querySelector('.pname');
    if(nameEl) nameEl.style.color=uidToColour(pid);
    if(p.vuBars) p.vuBars.style.color=uidToColour(pid);
  }
}

// ── Settings ────────────────────────────────────────────────────────────────
function loadSettings(){
  setCS(localStorage.getItem('ascii-cset')||'standard',false);
  contrast=parseInt(localStorage.getItem('ascii-contrast')||'128',10);
  bright  =parseInt(localStorage.getItem('ascii-bright')||'0',10);
  vuGain  =parseFloat(localStorage.getItem('ascii-vu-gain')||'3');
  $('contrast-sl').value=contrast;$('contrast-val').textContent=contrast;
  $('bright-sl').value=bright;    $('bright-val').textContent=bright;
  $('vu-gain-sl').value=vuGain;   $('vu-gain-val').textContent=vuGain+'×';
}
function setCS(k,save=true){if(!CSETS[k])k='standard';activeCSKey=k;charSet=CSETS[k].split('');document.querySelectorAll('.cset-btn').forEach(b=>b.classList.toggle('active',b.dataset.cset===k));if(save)localStorage.setItem('ascii-cset',k);}
document.querySelectorAll('.cset-btn').forEach(b=>b.addEventListener('click',()=>setCS(b.dataset.cset)));
$('contrast-sl').addEventListener('input',e=>{contrast=+e.target.value;$('contrast-val').textContent=contrast;localStorage.setItem('ascii-contrast',contrast);});
$('bright-sl').addEventListener('input',e=>{bright=+e.target.value;$('bright-val').textContent=bright;localStorage.setItem('ascii-bright',bright);});
$('vu-gain-sl').addEventListener('input',e=>{vuGain=+e.target.value;$('vu-gain-val').textContent=vuGain+'×';localStorage.setItem('ascii-vu-gain',vuGain);});

// ── Auth tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.atab').forEach(t=>t.addEventListener('click',()=>{document.querySelectorAll('.atab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.aform').forEach(x=>x.classList.remove('active'));t.classList.add('active');$('form-'+t.dataset.tab).classList.add('active');}));

$('login-btn').addEventListener('click',async()=>{
  const email=$('l-email').value.trim(),pass=$('l-pass').value,e=$('l-err');
  e.textContent='';$('login-btn').disabled=true;$('login-btn').textContent='LOGGING IN...';
  const{data,error}=await sb.auth.signInWithPassword({email,password:pass});
  $('login-btn').disabled=false;$('login-btn').textContent='LOGIN →';
  if(error){e.textContent=error.message;return;}
  currentUser=data.user;userId=currentUser.id;await loadProfile();showJoin();
});
$('l-pass').addEventListener('keydown',e=>{if(e.key==='Enter')$('login-btn').click();});

$('signup-btn').addEventListener('click',async()=>{
  const uname=$('s-user').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  const email=$('s-email').value.trim(),pass=$('s-pass').value,e=$('s-err');
  e.textContent='';
  if(!uname||uname.length<3){e.textContent='Username: 3+ chars, a-z 0-9 _';return;}
  if(!email){e.textContent='Email required';return;}
  if(pass.length<6){e.textContent='Password: 6+ characters';return;}
  const{data:ex}=await sb.from('profiles').select('id').eq('username',uname).maybeSingle();
  if(ex){e.textContent='Username taken';return;}
  $('signup-btn').disabled=true;$('signup-btn').textContent='CREATING...';
  const{data,error}=await sb.auth.signUp({email,password:pass,options:{data:{username:uname,theme:localStorage.getItem('ascii-theme')||'terminal'}}});
  $('signup-btn').disabled=false;$('signup-btn').textContent='CREATE ACCOUNT →';
  if(error){e.textContent=error.message;return;}
  if(data.session){currentUser=data.user;userId=currentUser.id;await loadProfile();showJoin();}
  else{e.style.color='var(--p)';e.textContent='✓ Check your email for a confirmation link.';}
});

$('logout-btn').addEventListener('click',async()=>{closeModal('prof-bd');if(channel)endCall();await sb.auth.signOut();currentUser=null;profile=null;userId=null;showAuth();});

// ── Profile ──────────────────────────────────────────────────────────────────
async function loadProfile(){const{data}=await sb.from('profiles').select('*').eq('id',userId).maybeSingle();profile=data;if(data?.theme)applyTheme(data.theme);}
function openProfileModal(){$('pm-user').textContent=profile?.username||'—';$('pm-email').textContent=currentUser?.email||'—';$('pm-theme').textContent=profile?.theme||'terminal';openModal('prof-bd');}

// ── Call history DB ──────────────────────────────────────────────────────────
async function startCallHistory(){
  if(!userId||!roomId) return;
  const{data}=await sb.from('call_history').insert({user_id:userId,room_id:roomId,spectator:isSpectator,peer_count:0}).select('id').maybeSingle();
  callHistId=data?.id||null;
}
async function endCallHistory(){
  if(!callHistId||!userId) return;
  const dur=callStart?Math.round((Date.now()-callStart)/1000):0;
  await sb.from('call_history').update({ended_at:new Date().toISOString(),duration_s:dur,peer_count:peers.size}).eq('id',callHistId);
  callHistId=null;
}
async function loadHistory(){
  const body=$('history-body');
  body.innerHTML='<div class="hist-empty ldots">loading</div>';
  if(!userId){body.innerHTML='<div class="hist-empty">not logged in</div>';return;}
  const{data,error}=await sb.from('call_history').select('*').eq('user_id',userId).order('started_at',{ascending:false}).limit(30);
  if(error||!data?.length){body.innerHTML='<div class="hist-empty">no calls yet</div>';return;}
  body.innerHTML='';
  for(const h of data){
    const dt=new Date(h.started_at);
    const row=document.createElement('div');row.className='hist-row';
    row.innerHTML=`<div class="hist-meta"><span class="hist-room">${esc(h.room_id)}</span><span class="hist-date">${dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})} ${dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span></div>
    <div class="hist-tags"><span class="hist-tag">⏱ ${h.duration_s!=null?fmtDur(h.duration_s):'—'}</span><span class="hist-tag">👥 ${h.peer_count} peer${h.peer_count!==1?'s':''}</span>${h.spectator?'<span class="hist-tag spectator">👁 spectator</span>':''}</div>`;
    body.appendChild(row);
  }
}

// ── Call summary ─────────────────────────────────────────────────────────────
function initCallLog(){
  callLog={
    room:roomId, start:new Date(), end:null,
    myUsername:profile?.username||currentUser?.email?.split('@')[0]||'—',
    isSpectator,
    participants:[{username:profile?.username||'YOU',joined:new Date(),left:null}],
    chat:[],
  };
}
function buildSummaryText(){
  const dur=callLog.end&&callLog.start?fmtDur(Math.round((callLog.end-callLog.start)/1000)):'—';
  const startStr=callLog.start?callLog.start.toISOString():'—';
  const endStr=callLog.end?callLog.end.toISOString():'—';
  let txt=`╔══════════════════════════════════════════════════╗\n`;
  txt+=`  ASCII.CALL — CALL SUMMARY\n`;
  txt+=`╚══════════════════════════════════════════════════╝\n\n`;
  txt+=`ROOM       : ${callLog.room}\n`;
  txt+=`STARTED    : ${startStr}\n`;
  txt+=`ENDED      : ${endStr}\n`;
  txt+=`DURATION   : ${dur}\n`;
  txt+=`YOUR NAME  : ${callLog.myUsername}${callLog.isSpectator?' (spectator)':''}\n\n`;
  txt+=`── PARTICIPANTS ──────────────────────────────────\n`;
  for(const p of callLog.participants){
    const leftStr=p.left?`  ◀ left ${p.left.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`:'';
    txt+=`  ${p.username}  (joined ${p.joined.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})})${leftStr}\n`;
  }
  txt+=`\n── CHAT LOG (${callLog.chat.length} messages) ───────────────────────\n`;
  if(!callLog.chat.length) txt+=`  (no messages)\n`;
  for(const m of callLog.chat) txt+=`  [${m.ts}] ${m.username}: ${m.text}\n`;
  txt+=`\n── END OF SUMMARY ────────────────────────────────\n`;
  return txt;
}
function showSummary(){
  const txt=buildSummaryText();
  $('summary-body').innerHTML=`<pre>${esc(txt)}</pre>`;
  $('summary-dl-btn').onclick=()=>{
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([txt],{type:'text/plain'}));
    a.download=`summary-${roomId}-${Date.now()}.txt`;a.click();
  };
  openModal('summary-bd');
}

// ── ASCII conversion ─────────────────────────────────────────────────────────
function asciiFromCtx(ctx,w,h){
  const d=ctx.getImageData(0,0,w,h).data;
  const CF=(259*(contrast+255))/(255*(259-contrast));
  const cs=charSet,cl=cs.length-1;
  let out='';
  for(let y=0;y<h;y+=2){
    for(let x=0;x<w;x++){
      const o=(y*w+x)*4;
      const r=Math.max(0,Math.min(255,((d[o]  -128)*CF|0)+128+bright));
      const g=Math.max(0,Math.min(255,((d[o+1]-128)*CF|0)+128+bright));
      const b=Math.max(0,Math.min(255,((d[o+2]-128)*CF|0)+128+bright));
      const br2=(0.299*r+0.587*g+0.114*b)/255;
      out+=cs[cl-Math.round(br2*cl)];
    }
    out+='\n';
  }
  return out;
}

// ── VU meter ─────────────────────────────────────────────────────────────────
function ensureAudioCtx(){if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();}
function attachAnalyser(stream,uid){
  ensureAudioCtx();
  if(analysers.has(uid)) return;
  try{
    const src=audioCtx.createMediaStreamSource(stream);
    const an=audioCtx.createAnalyser();
    an.fftSize=512;an.smoothingTimeConstant=0.75;
    src.connect(an);
    analysers.set(uid,an);
  }catch(e){console.warn('analyser attach failed',e);}
}
function renderVU(uid,targetEl){
  const an=analysers.get(uid);
  if(!an){targetEl.textContent='';return;}
  const bins=new Uint8Array(an.frequencyBinCount);
  an.getByteFrequencyData(bins);
  const cols=VU_COLS,rows=VU_ROWS,step=Math.ceil(bins.length/cols);
  const heights=[];
  for(let c=0;c<cols;c++){
    let sum=0,cnt=0;
    for(let i=0;i<step;i++){const idx=c*step+i;if(idx<bins.length){sum+=bins[idx];cnt++;}}
    const raw=(sum/(cnt||1)/255)*vuGain;
    heights.push(Math.min(rows,Math.round(raw*rows)));
  }
  let out='';
  for(let row=rows-1;row>=0;row--){
    for(let c=0;c<cols;c++) out+=heights[c]>row?'█':' ';
    out+='\n';
  }
  targetEl.textContent=out;
}

// ── Resolution & grid ────────────────────────────────────────────────────────
function getRes(n){
  if(n<=1) return{w:200,h:150};
  if(n<=2) return{w:160,h:120};
  if(n<=4) return{w:110,h:82};
  if(n<=6) return{w:86, h:64};
  return        {w:65, h:48};
}
function resizeAll(res){curRes=res;lCvs.width=res.w;lCvs.height=res.h;for(const[,p]of peers){p.canvas.width=res.w;p.canvas.height=res.h;}}
const gridObs=new ResizeObserver(()=>recomputeFont());
gridObs.observe(grid);

function updateGrid(){
  const n=1+peers.size;
  let cols,rows;
  if(n<=1)      {cols=1;rows=1;}
  else if(n<=2) {cols=2;rows=1;}
  else if(n<=4) {cols=2;rows=2;}
  else if(n<=6) {cols=3;rows=2;}
  else          {cols=4;rows=2;}
  if(spotlitId){
    grid.style.gridTemplateColumns='1fr';
    grid.style.gridTemplateRows='1fr';
    grid.querySelectorAll('.video-panel').forEach(p=>{
      const isLocal=p.id==='local-panel';
      const match=isLocal?(spotlitId==='local'):p.dataset.peer===spotlitId;
      p.classList.toggle('hidden-by-spotlight',!match);
      p.classList.toggle('spotlit',match);
    });
  } else {
    grid.style.gridTemplateColumns=`repeat(${cols},1fr)`;
    grid.style.gridTemplateRows   =`repeat(${rows},1fr)`;
    grid.querySelectorAll('.video-panel').forEach(p=>{p.classList.remove('hidden-by-spotlight','spotlit');});
  }
  waitOvl.style.display=peers.size===0?'flex':'none';
  resizeAll(getRes(n));
  $('peer-count').textContent=n+' online';
  recomputeFont();
}
function recomputeFont(){
  const gw=grid.clientWidth,gh=grid.clientHeight;
  if(!gw||!gh) return;
  const colM=grid.style.gridTemplateColumns.match(/repeat\((\d+)/);
  const rowM=grid.style.gridTemplateRows.match(/repeat\((\d+)/);
  const cols=colM?+colM[1]:1,rows=rowM?+rowM[1]:1,gap=8;
  const pw=(gw-(cols-1)*gap)/cols,ph=(gh-(rows-1)*gap)/rows-30;
  if(pw<=0||ph<=0) return;
  const fs=Math.max(3,Math.min(pw/(curRes.w*0.62),(ph*2)/curRes.h,14));
  document.querySelectorAll('pre.asc,pre.vu-bars').forEach(el=>{el.style.fontSize=fs+'px';el.style.lineHeight=(fs*1.05)+'px';});
}

// ── Render loop ───────────────────────────────────────────────────────────────
function startRender(){
  if(renderTimer)clearInterval(renderTimer);
  renderTimer=setInterval(()=>{
    if(isSpectator){
      if(analysers.has('local')) renderVU('local',$('local-vu-bars'));
    } else if(lVid.readyState>=2){
      const{w,h}=curRes;
      lCtx.save();lCtx.translate(w,0);lCtx.scale(-1,1);
      lCtx.drawImage(lVid,0,0,w,h);lCtx.restore();
      const txt=asciiFromCtx(lCtx,w,h);
      lAscii.textContent=txt;
      if(isRecording){recFrames.push({t:Math.round(performance.now()-recStart),f:txt});if(recFrames.length>=MAX_REC)stopRecording();}
    }
    for(const[pid,p]of peers){
      if(p.spectator){if(analysers.has(pid)) renderVU(pid,p.vuBars);}
      else if(p.rv?.readyState>=2){p.ctx.drawImage(p.rv,0,0,curRes.w,curRes.h);p.ascii.textContent=asciiFromCtx(p.ctx,curRes.w,curRes.h);}
    }
    frames++;const now=performance.now();
    if(now-fpsT>1000){$('stats').textContent=`${frames}fps`;frames=0;fpsT=now;}
  },1000/FPS);
}
function stopRender(){if(renderTimer){clearInterval(renderTimer);renderTimer=null;}}

// ── Timer ────────────────────────────────────────────────────────────────────
function startTimer(){callStart=Date.now();$('ctimer').style.display='inline';timerIv=setInterval(()=>{$('ctimer').textContent=fmtDur(Math.floor((Date.now()-callStart)/1000));},1000);}
function stopTimer(){if(timerIv){clearInterval(timerIv);timerIv=null;}$('ctimer').style.display='none';}
function fmtDur(s){return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}

// ── Mic ──────────────────────────────────────────────────────────────────────
function setMute(m){micMuted=m;localStream?.getAudioTracks().forEach(t=>t.enabled=!m);const btn=$('mic-btn');btn.textContent=m?'🔇 MUTED':'🎤 MIC';btn.classList.toggle('on',!m);btn.classList.toggle('danger',m);}
$('mic-btn').addEventListener('click',()=>setMute(!micMuted));

// ── Snap ─────────────────────────────────────────────────────────────────────
$('snap-btn').addEventListener('click',()=>{
  const txt=lAscii.textContent;if(!txt)return;
  const hdr=`ASCII.CALL SNAPSHOT\n${new Date().toISOString()}\nRoom: ${roomId}\nUser: ${profile?.username||'—'}\n${'─'.repeat(curRes.w)}\n`;
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([hdr+txt],{type:'text/plain'}));a.download=`snap-${Date.now()}.txt`;a.click();
});

// ── Recording ────────────────────────────────────────────────────────────────
function startRecording(){isRecording=true;recFrames=[];recStart=performance.now();$('rec-btn').classList.add('rec-active');$('rec-btn').textContent='■ STOP';}
function stopRecording(){
  isRecording=false;$('rec-btn').classList.remove('rec-active');$('rec-btn').textContent='⏺ REC';
  if(!recFrames.length)return;
  const dur=recFrames[recFrames.length-1].t;
  let out=`ASCII.CALL RECORDING\nDate: ${new Date().toISOString()}\nRoom: ${roomId}\nDuration: ${fmtDur(Math.round(dur/1000))}\n\n`;
  for(const f of recFrames) out+=`=== t=${f.t}ms ===\n${f.f}\n`;
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([out],{type:'text/plain'}));a.download=`rec-${Date.now()}.txt`;a.click();
  recFrames=[];
}
$('rec-btn').addEventListener('click',()=>{if(isRecording)stopRecording();else if(localStream)startRecording();});

// ── Chat ─────────────────────────────────────────────────────────────────────
function toggleChat(){chatOpen=!chatOpen;$('chat-panel').classList.toggle('open',chatOpen);$('chat-btn').classList.toggle('on',chatOpen);if(chatOpen){chatUnread=0;$('chat-badge').style.display='none';}updateGrid();}
function addMsg(uid,uname,text,self){
  const tsStr=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  callLog.chat.push({ts:tsStr,username:uname,text});
  const msgs=$('chat-msgs');
  const colour=self?myColour():(uid?uidToColour(uid):'var(--pd)');
  const d=document.createElement('div');d.className='cmsg';
  d.innerHTML=`<span class="cmeta" style="color:${colour}">${tsStr} ▸ ${esc(uname)}</span>
    <span class="ctxt">${esc(text)}</span>
    <button class="pin-msg-btn" title="Pin message">📌</button>`;
  d.querySelector('.pin-msg-btn').addEventListener('click',e=>{
    e.stopPropagation();
    const payload={text:text.slice(0,200),username:uname,ts:tsStr};
    channel?.send({type:'broadcast',event:'pin',payload:{...payload,action:'pin'}});
    setPinned(payload);
  });
  msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;
  if(!chatOpen&&!self){chatUnread++;const b=$('chat-badge');b.textContent=chatUnread>9?'9+':chatUnread;b.style.display='inline';}
}
function addSys(text){
  const d=document.createElement('div');d.className='sysmsg';d.textContent=text;
  $('chat-msgs').appendChild(d);$('chat-msgs').scrollTop=$('chat-msgs').scrollHeight;
}
function sendMsg(){
  const i=$('chat-input'),t=i.value.trim();if(!t||!channel)return;
  channel.send({type:'broadcast',event:'chat',payload:{text:t.slice(0,300),username:profile?.username||'ANON',uid:userId}});
  addMsg(userId,profile?.username||'YOU',t,true);i.value='';
}
$('chat-btn').addEventListener('click',toggleChat);
$('chat-send').addEventListener('click',sendMsg);
$('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter')sendMsg();});

// ── Pinned messages ───────────────────────────────────────────────────────────
function setPinned(msg){
  pinnedMsg=msg;
  $('pin-text').textContent=msg.text;
  $('pin-meta').textContent=`pinned by ${msg.username} · ${msg.ts}`;
  $('pin-bar').classList.add('visible');
}
function clearPinned(){
  pinnedMsg=null;
  $('pin-bar').classList.remove('visible');
}
$('unpin-btn').addEventListener('click',()=>{
  clearPinned();
  channel?.send({type:'broadcast',event:'pin',payload:{action:'unpin'}});
});

// ── Spotlight ─────────────────────────────────────────────────────────────────
function toggleSpotlight(panelEl){
  const pid=panelEl.id==='local-panel'?'local':(panelEl.dataset.peer||null);
  if(!pid) return;
  spotlitId=spotlitId===pid?null:pid;
  updateGrid();
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&spotlitId){spotlitId=null;updateGrid();}});

// ── Signaling ─────────────────────────────────────────────────────────────────
function sig(payload){channel.send({type:'broadcast',event:'sig',payload:{...payload,from:userId}});}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

// ── Peer management ───────────────────────────────────────────────────────────
function makeRemotePanel(pid,uname,spectator){
  const col=uidToColour(pid);
  const d=document.createElement('div');
  d.className='video-panel';d.dataset.peer=pid;
  d.innerHTML=`
    <div class="vph">
      <span class="pname" style="color:${col}">${esc(uname||pid.slice(0,8).toUpperCase())}</span>
      <div style="display:flex;align-items:center;gap:.4rem">
        ${spectator?'<span class="spec-badge">SPECTATOR</span>':''}
        <span class="ind" id="ind-${pid}"></span>
      </div>
    </div>
    <div class="ascii-wrap">
      <div class="peer-conn" id="conn-${pid}"><div class="peer-conn-txt">connecting</div></div>
      <pre class="asc" id="a-${pid}" style="display:none"></pre>
      <div class="vu-wrap ${spectator?'show':''}" id="vu-${pid}">
        <div class="vu-username" style="color:${col}">${esc(uname||pid.slice(0,8).toUpperCase())}</div>
        <pre class="vu-bars" id="vub-${pid}" style="color:${col}"></pre>
        <span class="spec-badge">LISTEN-ONLY</span>
      </div>
    </div>`;
  return d;
}

async function initPeer(pid,uname,spectatorFlag){
  if(peers.has(pid)) return peers.get(pid).pc;
  if(peers.size>=MAX_PEERS) return null;
  const pc=new RTCPeerConnection(RTC_CFG);
  const canvas=document.createElement('canvas');canvas.width=curRes.w;canvas.height=curRes.h;
  const ctx=canvas.getContext('2d');
  const rv=document.createElement('video');rv.playsInline=true;
  const panel=makeRemotePanel(pid,uname,spectatorFlag);
  grid.appendChild(panel);
  panel.addEventListener('click',e=>{if(e.target.closest('.vph'))return;toggleSpotlight(panel);});
  const aEl=$('a-'+pid),vuWrap=$('vu-'+pid),vuBars=$('vub-'+pid),connEl=$('conn-'+pid),indEl=$('ind-'+pid);
  peers.set(pid,{pc,canvas,ctx,rv,ascii:aEl,vuWrap,vuBars,panel,spectator:!!spectatorFlag});
  if(!spectatorFlag) localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  else localStream?.getAudioTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.ontrack=({streams,track})=>{
    if(track.kind==='video'){
      rv.srcObject=streams[0];rv.play().catch(()=>{});
      if(connEl)connEl.style.display='none';
      if(aEl)aEl.style.display='block';
      if(indEl)indEl.classList.add('live');
    }
    if(track.kind==='audio'){
      attachAnalyser(new MediaStream([track]),pid);
      if(spectatorFlag){if(connEl)connEl.style.display='none';if(vuWrap)vuWrap.classList.add('show');if(indEl)indEl.classList.add('live');}
    }
    setSt('connected','connected');updateGrid();
    callLog.participants.push({username:uname||pid.slice(0,8),joined:new Date(),left:null});
    addSys(`⌗ ${esc(uname||pid.slice(0,8))} joined${spectatorFlag?' (spectator)':''}`);
  };
  pc.onicecandidate=({candidate})=>{if(candidate)sig({type:'ice',to:pid,candidate});};
  pc.onconnectionstatechange=()=>{if(['disconnected','failed','closed'].includes(pc.connectionState))removePeer(pid);};
  updateGrid();
  return pc;
}

async function callPeer(pid,uname,spectatorFlag){
  const pc=await initPeer(pid,uname,spectatorFlag);if(!pc)return;
  const offer=await pc.createOffer();
  await pc.setLocalDescription(offer);
  sig({type:'offer',to:pid,sdp:offer.sdp,username:profile?.username,spectator:isSpectator});
}

async function answerOffer(pid,uname,sdp,theirSpec){
  const polite=userId<pid;
  let p=peers.get(pid);
  if(!p){await initPeer(pid,uname,theirSpec);p=peers.get(pid);}
  const{pc}=p;
  const collision=pc.signalingState!=='stable';
  if(collision){if(!polite)return;await pc.setLocalDescription({type:'rollback'});}
  await pc.setRemoteDescription({type:'offer',sdp});
  const ans=await pc.createAnswer();
  await pc.setLocalDescription(ans);
  sig({type:'answer',to:pid,sdp:ans.sdp,spectator:isSpectator});
}

function removePeer(pid){
  const p=peers.get(pid);if(!p)return;
  const uname=p.panel?.querySelector('.pname')?.textContent||pid.slice(0,8);
  p.pc.close();if(p.rv)p.rv.srcObject=null;
  if(p.panel?.parentNode)p.panel.parentNode.removeChild(p.panel);
  analysers.delete(pid);
  const logEntry=callLog.participants.find(x=>x.username===uname&&!x.left);
  if(logEntry)logEntry.left=new Date();
  peers.delete(pid);
  if(spotlitId===pid)spotlitId=null;
  setSt(peers.size>0?'connected':'waiting',peers.size>0?'connected':'waiting for peers...');
  updateGrid();addSys(`⌗ ${esc(uname)} left`);
}

// ── Join room ─────────────────────────────────────────────────────────────────
async function joinRoom(id,spectator=false){
  isSpectator=spectator;
  roomId=id.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
  $('room-display').textContent=roomId;$('w-code').textContent=roomId;
  $('chat-room-name').textContent=roomId;
  const myUname=(profile?.username||'YOU').toUpperCase();
  $('local-name').textContent=myUname;
  $('local-name').style.color=myColour();
  if(spectator){$('local-spec-badge').style.display='inline';$('local-vu-name').textContent=myUname;}
  initCallLog();
  showCall();setSt('waiting','starting...');
  try{
    localStream=spectator
      ? await navigator.mediaDevices.getUserMedia({audio:true,video:false}).catch(()=>new MediaStream())
      : await navigator.mediaDevices.getUserMedia({video:{width:320,height:240,facingMode:'user'},audio:true});
    if(!spectator){lVid.srcObject=localStream;await lVid.play();}
  }catch(e){if(!spectator){setSt('error','camera: '+e.message);return;}localStream=new MediaStream();}
  if(localStream.getAudioTracks().length) attachAnalyser(localStream,'local');
  if(spectator){lAscii.style.display='none';$('local-vu').classList.add('show');}
  else{lAscii.style.display='block';$('local-vu').classList.remove('show');}
  updateGrid();startRender();startTimer();
  sb.from('rooms').upsert({id:roomId,created_by:userId,last_active:new Date().toISOString()}).then(()=>{});
  await startCallHistory();
  channel=sb.channel('ascii-call:'+roomId,{config:{broadcast:{self:false}}});
  channel.on('broadcast',{event:'sig'},async({payload})=>{
    if(payload.from===userId)return;
    if(payload.to&&payload.to!==userId)return;
    switch(payload.type){
      case 'join':  sig({type:'here',to:payload.from,username:profile?.username,spectator:isSpectator});break;
      case 'here':  if(!peers.has(payload.from))await callPeer(payload.from,payload.username,payload.spectator);break;
      case 'offer': await answerOffer(payload.from,payload.username,payload.sdp,payload.spectator);break;
      case 'answer':{const p=peers.get(payload.from);if(p)await p.pc.setRemoteDescription({type:'answer',sdp:payload.sdp});break;}
      case 'ice':   {const p=peers.get(payload.from);if(p)try{await p.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));}catch(_){}break;}
      case 'leave': removePeer(payload.from);break;
    }
  });
  channel.on('broadcast',{event:'chat'},({payload})=>{addMsg(payload.uid||null,payload.username||'ANON',payload.text,false);});
  channel.on('broadcast',{event:'pin'},({payload})=>{
    if(payload.action==='unpin') clearPinned();
    else setPinned({text:payload.text,username:payload.username,ts:payload.ts});
  });
  await channel.subscribe(status=>{
    if(status==='SUBSCRIBED'){setSt('waiting','in room · waiting for peers...');sig({type:'join',username:profile?.username,spectator:isSpectator});}
  });
  setInterval(()=>{if(channel)sb.from('rooms').update({last_active:new Date().toISOString()}).eq('id',roomId).then(()=>{});},120_000);
  window.addEventListener('resize',updateGrid);
}

// ── End call ──────────────────────────────────────────────────────────────────
function endCall(){
  if(isRecording)stopRecording();
  if(channel)sig({type:'leave'});
  callLog.end=new Date();
  endCallHistory();
  stopRender();stopTimer();
  for(const[pid]of[...peers])removePeer(pid);
  if(channel){sb.removeChannel(channel);channel=null;}
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}
  lVid.srcObject=null;lAscii.textContent='';
  analysers.clear();if(audioCtx){audioCtx.close().catch(()=>{});audioCtx=null;}
  chatOpen=false;chatUnread=0;
  $('chat-panel').classList.remove('open');$('chat-btn').classList.remove('on');
  $('chat-msgs').innerHTML='';$('chat-badge').style.display='none';
  clearPinned();
  setMute(false);isSpectator=false;spotlitId=null;
  $('local-spec-badge').style.display='none';$('local-vu').classList.remove('show');lAscii.style.display='block';
  document.querySelectorAll('[data-peer]').forEach(el=>el.remove());
  waitOvl.style.display='none';
  window.removeEventListener('resize',updateGrid);
  if(currentUser)showJoin();else showAuth();
  showSummary();
}
window.addEventListener('beforeunload',()=>{if(channel)sig({type:'leave'});endCallHistory();});

// ── Status ────────────────────────────────────────────────────────────────────
function setSt(type,msg){$('s-dot').className='dot dot-'+type;$('s-txt').textContent=msg;}

// ── Modals ────────────────────────────────────────────────────────────────────
function openModal(id){$(id).classList.add('open');}
function closeModal(id){$(id).classList.remove('open');}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
document.querySelectorAll('.mbd').forEach(bd=>bd.addEventListener('click',e=>{if(e.target===bd)closeModal(bd.id);}));

// ── UI wiring ─────────────────────────────────────────────────────────────────
$('join-btn').addEventListener('click',()=>{const v=$('room-input').value.trim();if(v.length>=4)joinRoom(v);else{$('room-input').style.borderColor='var(--red)';setTimeout(()=>$('room-input').style.borderColor='',1200);}});
$('new-room-btn').addEventListener('click',()=>joinRoom(Math.random().toString(36).slice(2,8)));
$('spectator-btn').addEventListener('click',()=>{const v=$('room-input').value.trim();if(v.length>=4)joinRoom(v,true);else{$('room-input').style.borderColor='var(--red)';setTimeout(()=>$('room-input').style.borderColor='',1200);}});
$('room-input').addEventListener('keydown',e=>{if(e.key==='Enter')$('join-btn').click();});
$('room-input').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase();});
$('end-btn').addEventListener('click',endCall);
$('copy-btn').addEventListener('click',()=>navigator.clipboard.writeText(roomId||'').then(()=>{$('copy-btn').textContent='[ copied! ]';setTimeout(()=>$('copy-btn').textContent='[ click to copy ]',1800);}));
[$('join-themes-btn'),$('call-themes-btn'),$('pm-themes-btn')].forEach(b=>{if(b)b.addEventListener('click',()=>{closeModal('prof-bd');openModal('themes-bd');});});
[$('join-settings-btn'),$('call-settings-btn')].forEach(b=>{if(b)b.addEventListener('click',()=>openModal('settings-bd'));});
[$('pcorner'),$('call-prof-btn')].forEach(b=>{if(b)b.addEventListener('click',openProfileModal);});
[$('join-history-btn'),$('pm-history-btn')].forEach(b=>{if(b)b.addEventListener('click',async()=>{closeModal('prof-bd');openModal('history-bd');await loadHistory();});});
$('local-panel').addEventListener('click',e=>{if(e.target.closest('.vph')||e.target.closest('#wait-ovl'))return;toggleSpotlight($('local-panel'));});
