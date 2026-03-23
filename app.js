'use strict';

// ── Config ─────────────────────────────────────────────────────────────────
const CFG_URL   = 'https://vcriojbgprbtpctersau.supabase.co/functions/v1/app-config';
const RTC_CFG   = {iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};
const MAX_PEERS = 7, FPS = 15, MAX_REC = 450;
const MIN_HIST_PEERS = 1;   // need at least this many REMOTE peers to save history
const MIN_HIST_SECS  = 30;  // call must last at least this many seconds

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

// Device selection
let selectedVideoId = localStorage.getItem('ascii-video-device') || '';
let selectedAudioId = localStorage.getItem('ascii-audio-device') || '';

// Studio mode
let studioStream=null, studioTimer=null, studioFrames=0, studioFpsT=performance.now();
let studioRecFrames=[], studioRecStart=0, studioIsRec=false;
const studioCvs=document.createElement('canvas');
const studioCtx=studioCvs.getContext('2d');
const studioVid=document.createElement('video');
studioVid.muted=true; studioVid.playsInline=true;

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

// Friends & invites
let friendsData = [];      // [{id, other_id, other_username, status, requester}]
let pendingInvites = [];   // incoming room invites

// Web push
let pushSubscription = null;
const PUSH_VAPID_PUBLIC = 'BMBlrSxFDMCvGCCXjCPDRMlSiwnHFRhGVfyHcr4ZAQ3q8B3GqfMy2fHbsNLTX9o6kO8Hhf4hY8zVgCkGdMxU5PY'; // replace with your VAPID public key

// ── DOM ─────────────────────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
const loadEl=$('loading'), authEl=$('auth-screen'), joinEl=$('join-screen'), callEl=$('call-screen');
const grid=$('video-grid'), waitOvl=$('wait-ovl');
const lAscii=$('local-ascii'), lVid=$('local-video'), lCvs=$('local-canvas'), lCtx=lCvs.getContext('2d');
const studioEl=$('studio-screen');
const studioAsciiEl=$('studio-ascii');

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
    applyTheme(localStorage.getItem('ascii-theme')||'paper');
    if(tH&&tp){
      const{error}=await sb.auth.verifyOtp({token_hash:tH,type:tp});
      if(!error){$('cbanner').style.display='block';setTimeout(()=>$('cbanner').style.display='none',4500);window.history.replaceState({},'',window.location.pathname);}
    }
    // Handle OAuth callback (Google etc.) — hash contains access_token
    const { data: { session: oauthSession }, error: oauthErr } = await sb.auth.getSession();
    if (!oauthErr && oauthSession) {
      currentUser = oauthSession.user; userId = currentUser.id;
      await loadProfile();
      // Ensure profile exists for OAuth users (username from email prefix)
      if (!profile) {
        const fallbackUser = currentUser.email?.split('@')[0] || 'user';
        await sb.from('profiles').upsert({ id: userId, username: fallbackUser, theme: 'paper' }, { onConflict: 'id', ignoreDuplicates: true });
        await loadProfile();
      }
      showJoin();
    } else showAuth();
  }catch(e){loadEl.innerHTML=`<div class="logo" style="font-size:3rem;color:var(--red)">ERROR</div><div style="color:var(--red);font-size:.75rem;margin-top:1rem">${e.message}</div>`;}
})();

// ── Screens ─────────────────────────────────────────────────────────────────
function showAuth(){loadEl.style.display='none';authEl.style.display='flex';joinEl.style.display='none';callEl.style.display='none';}
function showJoin(){loadEl.style.display='none';authEl.style.display='none';joinEl.style.display='flex';callEl.style.display='none';studioEl.style.display='none';$('join-uname').textContent=profile?.username||'—';$('corner-name').textContent=profile?.username||'—';}
function showCall(){loadEl.style.display='none';authEl.style.display='none';joinEl.style.display='none';callEl.style.display='flex';studioEl.style.display='none';}
function showStudio(){loadEl.style.display='none';authEl.style.display='none';joinEl.style.display='none';callEl.style.display='none';studioEl.style.display='flex';}

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

// Google OAuth
$('google-btn').addEventListener('click',async()=>{
  await sb.auth.signInWithOAuth({
    provider:'google',
    options:{ redirectTo: window.location.href }
  });
});

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
  const{data,error}=await sb.auth.signUp({email,password:pass,options:{data:{username:uname,theme:localStorage.getItem('ascii-theme')||'paper'}}});
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
  if(!callHistId||!userId){callHistId=null;return;}
  const dur=callStart?Math.round((Date.now()-callStart)/1000):0;
  // Delete the record if the call was solo or too short — not worth keeping
  const maxPeersEver = parseInt($('peer-count')?.dataset?.maxPeers||'0',10)||peers.size;
  if(maxPeersEver < MIN_HIST_PEERS || dur < MIN_HIST_SECS){
    await sb.from('call_history').delete().eq('id',callHistId);
  } else {
    await sb.from('call_history').update({ended_at:new Date().toISOString(),duration_s:dur,peer_count:maxPeersEver}).eq('id',callHistId);
  }
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
  // Track historical max for call history filtering
  const pcEl=$('peer-count');
  const prev=parseInt(pcEl.dataset.maxPeers||'0',10);
  if(peers.size>prev) pcEl.dataset.maxPeers=String(peers.size);
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
      ? await navigator.mediaDevices.getUserMedia({audio:selectedAudioId?{deviceId:{exact:selectedAudioId}}:true,video:false}).catch(()=>new MediaStream())
      : await navigator.mediaDevices.getUserMedia({
          video: selectedVideoId ? {deviceId:{exact:selectedVideoId},width:320,height:240} : {width:320,height:240,facingMode:'user'},
          audio: selectedAudioId ? {deviceId:{exact:selectedAudioId}} : true
        });
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

// ── Device enumeration ────────────────────────────────────────────────────────
async function enumerateDevices(){
  // getUserMedia first so labels are populated (browser requires permission)
  let tempStream=null;
  try{
    tempStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
  }catch(e){
    try{tempStream=await navigator.mediaDevices.getUserMedia({audio:true});}catch(_){}
  }
  const devices=await navigator.mediaDevices.enumerateDevices();
  if(tempStream) tempStream.getTracks().forEach(t=>t.stop());

  const camSel=$('cam-select'), micSel=$('mic-select');
  camSel.innerHTML=''; micSel.innerHTML='';

  const addOpt=(sel,val,label,selected)=>{
    const o=document.createElement('option');
    o.value=val; o.textContent=label; o.selected=selected; sel.appendChild(o);
  };

  const cameras=devices.filter(d=>d.kind==='videoinput');
  const mics   =devices.filter(d=>d.kind==='audioinput');

  if(!cameras.length) addOpt(camSel,'','No cameras found',true);
  cameras.forEach((d,i)=>addOpt(camSel,d.deviceId,d.label||`Camera ${i+1}`,d.deviceId===selectedVideoId));

  if(!mics.length) addOpt(micSel,'','No microphones found',true);
  mics.forEach((d,i)=>addOpt(micSel,d.deviceId,d.label||`Microphone ${i+1}`,d.deviceId===selectedAudioId));
}

async function applyDevices(){
  selectedVideoId=$('cam-select').value;
  selectedAudioId=$('mic-select').value;
  localStorage.setItem('ascii-video-device',selectedVideoId);
  localStorage.setItem('ascii-audio-device',selectedAudioId);
  closeModal('devices-bd');

  // Restart whichever feed is active
  if(studioStream){
    await restartStudioStream();
  } else if(localStream && channel){
    await restartCallStream();
  }
}

async function openDeviceModal(){
  await enumerateDevices();
  openModal('devices-bd');
}

// Restart studio stream with new device
async function restartStudioStream(){
  if(studioTimer){clearInterval(studioTimer);studioTimer=null;}
  if(studioStream){studioStream.getTracks().forEach(t=>t.stop());studioStream=null;}
  await openStudio();
}

// Restart call stream with new device and re-replace tracks in all peers
async function restartCallStream(){
  const oldStream=localStream;
  try{
    localStream=await navigator.mediaDevices.getUserMedia({
      video:selectedVideoId?{deviceId:{exact:selectedVideoId},width:320,height:240}:{width:320,height:240,facingMode:'user'},
      audio:selectedAudioId?{deviceId:{exact:selectedAudioId}}:true,
    });
    lVid.srcObject=localStream;
    await lVid.play();
    // Re-replace tracks in all active peer connections
    for(const[,p]of peers){
      const senders=p.pc.getSenders();
      const vt=localStream.getVideoTracks()[0];
      const at=localStream.getAudioTracks()[0];
      for(const s of senders){
        if(s.track?.kind==='video'&&vt) s.replaceTrack(vt).catch(()=>{});
        if(s.track?.kind==='audio'&&at) s.replaceTrack(at).catch(()=>{});
      }
    }
    if(oldStream) oldStream.getTracks().forEach(t=>t.stop());
    // Re-attach local audio analyser
    if(localStream.getAudioTracks().length) attachAnalyser(localStream,'local');
    setSt('connected','feed restarted with new device');
  }catch(e){setSt('error','device error: '+e.message);}
}

// ── Studio mode ────────────────────────────────────────────────────────────
async function openStudio(){
  showStudio();
  try{
    studioStream=await navigator.mediaDevices.getUserMedia({
      video:selectedVideoId?{deviceId:{exact:selectedVideoId},width:640,height:480}:{width:640,height:480,facingMode:'user'},
      audio:selectedAudioId?{deviceId:{exact:selectedAudioId}}:true,
    });
    studioVid.srcObject=studioStream;
    await studioVid.play();
  }catch(e){
    studioAsciiEl.textContent='camera error: '+e.message;
    return;
  }
  // Size canvas on first frame
  studioVid.addEventListener('loadedmetadata',()=>{
    const asp=studioVid.videoWidth/studioVid.videoHeight;
    studioCvs.width=200; studioCvs.height=Math.round(200/asp);
  },{once:true});

  studioTimer=setInterval(()=>{
    if(studioVid.readyState<2) return;
    const w=studioCvs.width||200, h=studioCvs.height||150;
    // Mirror
    studioCtx.save();studioCtx.translate(w,0);studioCtx.scale(-1,1);
    studioCtx.drawImage(studioVid,0,0,w,h);studioCtx.restore();
    studioAsciiEl.textContent=asciiFromCtx(studioCtx,w,h);
    if(studioIsRec){
      studioRecFrames.push({t:Math.round(performance.now()-studioRecStart),f:studioAsciiEl.textContent});
      if(studioRecFrames.length>=MAX_REC) studioStopRec();
    }
    studioFrames++;
    const now=performance.now();
    if(now-studioFpsT>1000){$('studio-stats').textContent=studioFrames+'fps';studioFrames=0;studioFpsT=now;}
  },1000/FPS);

  // Auto-scale font
  const scaleFont=()=>{
    const w=studioEl.clientWidth, h=studioEl.clientHeight-80;
    if(!w||!h) return;
    const cw=studioCvs.width||200, ch=studioCvs.height||150;
    const fs=Math.max(4,Math.min(w/(cw*0.62),(h*2)/ch,18));
    studioAsciiEl.style.fontSize=fs+'px';
    studioAsciiEl.style.lineHeight=(fs*1.05)+'px';
  };
  scaleFont();
  window._studioScale=scaleFont;
  window.addEventListener('resize',scaleFont);
}

function closeStudio(){
  if(studioIsRec) studioStopRec();
  if(studioTimer){clearInterval(studioTimer);studioTimer=null;}
  if(studioStream){studioStream.getTracks().forEach(t=>t.stop());studioStream=null;}
  studioVid.srcObject=null; studioAsciiEl.textContent='';
  window.removeEventListener('resize',window._studioScale);
  showJoin();
}

function studioStartRec(){
  studioIsRec=true;studioRecFrames=[];studioRecStart=performance.now();
  $('studio-rec-btn').classList.add('rec-active');$('studio-rec-btn').textContent='■ STOP';
}
function studioStopRec(){
  studioIsRec=false;$('studio-rec-btn').classList.remove('rec-active');$('studio-rec-btn').textContent='⏺ REC';
  if(!studioRecFrames.length)return;
  const dur=studioRecFrames[studioRecFrames.length-1].t;
  let out=`ASCII.CALL STUDIO RECORDING\nDate: ${new Date().toISOString()}\nDuration: ${fmtDur(Math.round(dur/1000))}\n\n`;
  for(const f of studioRecFrames)out+=`=== t=${f.t}ms ===\n${f.f}\n`;
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([out],{type:'text/plain'}));a.download=`studio-rec-${Date.now()}.txt`;a.click();
  studioRecFrames=[];
}

// ── Friends ────────────────────────────────────────────────────────────────
async function loadFriends(){
  if(!userId) return;
  const{data}=await sb.from('friends')
    .select('id,requester,addressee,status')
    .or(`requester.eq.${userId},addressee.eq.${userId}`)
    .order('created_at',{ascending:false});
  if(!data) return;
  // Enrich with usernames
  const otherIds=[...new Set(data.map(f=>f.requester===userId?f.addressee:f.requester))];
  const{data:profiles}=await sb.from('profiles').select('id,username').in('id',otherIds);
  const pMap=Object.fromEntries((profiles||[]).map(p=>[p.id,p.username]));
  friendsData=data.map(f=>({
    ...f,
    other_id: f.requester===userId?f.addressee:f.requester,
    other_username: pMap[f.requester===userId?f.addressee:f.requester]||'unknown',
    is_requester: f.requester===userId,
  }));
  renderFriendsList();
}

function renderFriendsList(){
  const body=$('friends-body'); if(!body) return;
  const accepted=friendsData.filter(f=>f.status==='accepted');
  const pending =friendsData.filter(f=>f.status==='pending');
  let html='';
  if(accepted.length){
    html+=`<div class="sec-lbl">FRIENDS (${accepted.length})</div>`;
    for(const f of accepted) html+=friendRow(f,true);
  }
  if(pending.length){
    html+=`<div class="sec-lbl" style="margin-top:${accepted.length?'.9rem':'0'}">PENDING (${pending.length})</div>`;
    for(const f of pending) html+=friendRow(f,false);
  }
  if(!accepted.length&&!pending.length){
    html='<div class="hist-empty">no friends yet — search by username above</div>';
  }
  body.innerHTML=html;
  // Wire up buttons
  body.querySelectorAll('[data-friend-action]').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const action=btn.dataset.friendAction, fid=btn.dataset.fid, uid=btn.dataset.uid;
      if(action==='invite') await inviteFriendToRoom(uid,btn.dataset.uname);
      else if(action==='accept') await respondFriendRequest(fid,'accepted');
      else if(action==='decline') await respondFriendRequest(fid,'blocked');
      else if(action==='remove') await removeFriend(fid);
    });
  });
}

function friendRow(f, isAccepted){
  const canInvite = isAccepted && roomId;
  return `<div class="friend-row">
    <span class="friend-name">${esc(f.other_username)}</span>
    <div style="display:flex;gap:.35rem;flex-wrap:wrap">
      ${canInvite?`<button class="btn" style="font-size:.6rem;padding:.22rem .55rem" data-friend-action="invite" data-uid="${f.other_id}" data-uname="${esc(f.other_username)}">📞 INVITE</button>`:''}
      ${isAccepted?`<button class="btn danger" style="font-size:.6rem;padding:.22rem .55rem" data-friend-action="remove" data-fid="${f.id}">REMOVE</button>`:''}
      ${!isAccepted&&!f.is_requester?`<button class="btn primary" style="font-size:.6rem;padding:.22rem .55rem" data-friend-action="accept" data-fid="${f.id}">ACCEPT</button>`:''}
      ${!isAccepted&&!f.is_requester?`<button class="btn danger" style="font-size:.6rem;padding:.22rem .55rem" data-friend-action="decline" data-fid="${f.id}">DECLINE</button>`:''}
      ${!isAccepted&&f.is_requester?`<span style="font-size:.6rem;color:var(--pd);letter-spacing:.1em">PENDING...</span>`:''}
    </div>
  </div>`;
}

async function searchUsers(){
  const q=$('friend-search').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  if(q.length<2){$('friend-results').innerHTML='';return;}
  const{data}=await sb.from('profiles').select('id,username').ilike('username','%'+q+'%').neq('id',userId).limit(8);
  if(!data?.length){$('friend-results').innerHTML='<div class="hist-empty" style="padding:.5rem 0">no users found</div>';return;}
  const existingIds=new Set(friendsData.map(f=>f.other_id));
  $('friend-results').innerHTML=data.map(u=>`
    <div class="friend-row">
      <span class="friend-name">${esc(u.username)}</span>
      ${existingIds.has(u.id)?'<span style="font-size:.6rem;color:var(--pd);letter-spacing:.1em">ALREADY ADDED</span>':
        `<button class="btn primary" style="font-size:.6rem;padding:.22rem .55rem" onclick="addFriend('${u.id}','${esc(u.username)}')">+ ADD</button>`}
    </div>`).join('');
}

async function addFriend(uid,uname){
  const{error}=await sb.from('friends').insert({requester:userId,addressee:uid});
  if(error){if(error.code==='23505') return;} // duplicate
  await loadFriends();
  $('friend-results').innerHTML='';
  $('friend-search').value='';
  addSysOrToast(`Friend request sent to ${uname}`);
}

async function respondFriendRequest(fid,status){
  await sb.from('friends').update({status,updated_at:new Date().toISOString()}).eq('id',fid);
  await loadFriends();
}

async function removeFriend(fid){
  await sb.from('friends').delete().eq('id',fid);
  await loadFriends();
}

async function inviteFriendToRoom(uid,uname){
  if(!roomId){addSysOrToast('Join a room first before inviting friends.');return;}
  // Send via Edge Function (email + record)
  const{data:{session}}=await sb.auth.getSession();
  const msg=prompt(`Optional message to ${uname} (leave blank to skip):`,'')||undefined;
  try{
    await fetch('https://vcriojbgprbtpctersau.supabase.co/functions/v1/send-room-invite',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
      body:JSON.stringify({to_user_id:uid,room_id:roomId,message:msg}),
    });
  }catch(e){console.warn('invite email failed',e);}
  // Also try push if they have a subscription
  await sendPushToUser(uid,{
    title:'ASCII.CALL — Room Invite',
    body:`${profile?.username||'Someone'} is inviting you to join room ${roomId}`,
    data:{room:roomId},
  });
  addSysOrToast(`Invite sent to ${uname}!`);
}

// Subscribe to realtime for incoming invites
function subscribeInvites(){
  if(!userId) return;
  sb.channel('invites:'+userId)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'room_invites',filter:`to_user=eq.${userId}`},
      async(payload)=>{
        const inv=payload.new;
        const{data:fp}=await sb.from('profiles').select('username').eq('id',inv.from_user).maybeSingle();
        const fname=fp?.username||'Someone';
        showInviteToast(fname,inv.room_id,inv.id);
      })
    .subscribe();
  // Also subscribe to friend requests
  sb.channel('friends:'+userId)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'friends',filter:`addressee=eq.${userId}`},
      async()=>{ await loadFriends(); showFriendsBadge(); })
    .subscribe();
}

function showInviteToast(from,room,invId){
  const toast=document.createElement('div');
  toast.className='invite-toast';
  toast.innerHTML=`<div class="it-from">📞 ${esc(from)} is calling</div>
    <div class="it-room">ROOM: <strong>${esc(room)}</strong></div>
    <div class="it-actions">
      <button class="btn primary" style="font-size:.65rem" onclick="acceptInvite('${esc(room)}','${invId}',this.closest('.invite-toast'))">JOIN →</button>
      <button class="btn" style="font-size:.65rem" onclick="this.closest('.invite-toast').remove()">DISMISS</button>
    </div>`;
  document.body.appendChild(toast);
  setTimeout(()=>toast.remove(),30000);
}

async function acceptInvite(room,invId,toastEl){
  toastEl?.remove();
  await sb.from('room_invites').update({status:'accepted'}).eq('id',invId);
  // If already in a call, end it first
  if(channel) endCall();
  joinRoom(room);
}

function showFriendsBadge(){
  const pending=friendsData.filter(f=>f.status==='pending'&&!f.is_requester).length;
  const b=$('friends-badge'); if(!b) return;
  b.textContent=pending>9?'9+':String(pending);
  b.style.display=pending>0?'inline':'none';
}

function addSysOrToast(msg){
  // Use chat sys message if in a call, otherwise a brief status update
  if(channel) addSys(msg);
  else setSt('connected',msg);
}

// ── Push notifications ──────────────────────────────────────────────────────
async function requestPushPermission(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)) return false;
  const perm=await Notification.requestPermission();
  if(perm!=='granted') return false;
  try{
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:urlBase64ToUint8Array(PUSH_VAPID_PUBLIC),
    });
    pushSubscription=sub;
    const j=sub.toJSON();
    await sb.from('push_subscriptions').upsert({
      user_id:userId,
      endpoint:j.endpoint,
      p256dh:j.keys.p256dh,
      auth_key:j.keys.auth,
    },{onConflict:'endpoint',ignoreDuplicates:true});
    return true;
  }catch(e){console.warn('push subscribe failed',e);return false;}
}

async function sendPushToUser(uid,payload){
  // Best-effort: look up their subscription and use the Edge Function
  // (In production you'd do this server-side; here we just call send-room-invite which handles it)
  console.log('[push] would notify',uid,'with',payload);
}

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=window.atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

// ── Account settings ─────────────────────────────────────────────────────────
async function openAccountModal(){
  $('acc-username').value=profile?.username||'';
  $('acc-email').value=currentUser?.email||'';
  $('acc-err').textContent='';$('acc-ok').textContent='';
  openModal('account-bd');
}

async function saveUsername(){
  const uname=$('acc-username').value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  if(!uname||uname.length<3){$('acc-err').textContent='Username: 3+ chars, a-z 0-9 _';return;}
  if(uname===profile?.username){$('acc-err').textContent='That is already your username.';return;}
  const{data:ex}=await sb.from('profiles').select('id').eq('username',uname).neq('id',userId).maybeSingle();
  if(ex){$('acc-err').textContent='Username taken.';return;}
  const{error}=await sb.from('profiles').update({username:uname}).eq('id',userId);
  if(error){$('acc-err').textContent=error.message;return;}
  profile.username=uname;
  $('join-uname').textContent=uname; $('corner-name').textContent=uname; if($('pm-user')) $('pm-user').textContent=uname;
  $('acc-ok').textContent='Username updated!';
}

async function saveEmail(){
  const email=$('acc-email').value.trim();
  if(!email||email===currentUser?.email){$('acc-err').textContent='Enter a new email address.';return;}
  const{error}=await sb.auth.updateUser({email});
  if(error){$('acc-err').textContent=error.message;return;}
  $('acc-ok').textContent='Confirmation sent to '+email+'. Check your inbox.';
}

async function savePassword(){
  const p=$('acc-pass').value, p2=$('acc-pass2').value;
  if(p.length<6){$('acc-err').textContent='Password: 6+ characters.';return;}
  if(p!==p2){$('acc-err').textContent='Passwords do not match.';return;}
  const{error}=await sb.auth.updateUser({password:p});
  if(error){$('acc-err').textContent=error.message;return;}
  $('acc-pass').value='';$('acc-pass2').value='';
  $('acc-ok').textContent='Password updated!';
}

async function sendMagicLink(){
  const email=currentUser?.email; if(!email) return;
  const{error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:false}});
  if(error){$('acc-err').textContent=error.message;return;}
  $('acc-ok').textContent='Magic link sent to '+email;
}

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

// Friends modal wiring
[$('join-friends-btn'),$('call-friends-btn')].forEach(b=>{if(b)b.addEventListener('click',async()=>{await loadFriends();openModal('friends-bd');});});
if($('friend-search')) $('friend-search').addEventListener('input',searchUsers);

// Account settings wiring
[$('join-account-btn'),$('pm-account-btn')].forEach(b=>{if(b)b.addEventListener('click',()=>{closeModal('prof-bd');openAccountModal();});});
if($('acc-save-username-btn')) $('acc-save-username-btn').addEventListener('click',saveUsername);
if($('acc-save-email-btn'))    $('acc-save-email-btn').addEventListener('click',saveEmail);
if($('acc-save-pass-btn'))     $('acc-save-pass-btn').addEventListener('click',savePassword);
if($('acc-magic-btn'))         $('acc-magic-btn').addEventListener('click',sendMagicLink);

// Push permission prompt
if($('push-enable-btn')) $('push-enable-btn').addEventListener('click',async()=>{
  const ok=await requestPushPermission();
  $('push-enable-btn').textContent=ok?'✓ NOTIFICATIONS ON':'PERMISSION DENIED';
  $('push-enable-btn').disabled=ok;
});

// Subscribe to realtime invites after login
(async()=>{
  // Re-hook after profile load
  const origShowJoin=showJoin;
  showJoin=function(){origShowJoin();subscribeInvites();loadFriends().then(showFriendsBadge);};
})();

// Studio wiring
$('studio-btn').addEventListener('click',openStudio);
$('studio-exit-btn').addEventListener('click',closeStudio);
$('studio-snap-btn').addEventListener('click',()=>{
  const txt=studioAsciiEl.textContent;if(!txt)return;
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([`ASCII.CALL STUDIO SNAPSHOT\n${new Date().toISOString()}\n${'─'.repeat(studioCvs.width||80)}\n`+txt],{type:'text/plain'}));a.download=`studio-snap-${Date.now()}.txt`;a.click();
});
$('studio-rec-btn').addEventListener('click',()=>{if(studioIsRec)studioStopRec();else studioStartRec();});
[$('studio-themes-btn')].forEach(b=>{if(b)b.addEventListener('click',()=>openModal('themes-bd'));});
[$('studio-settings-btn')].forEach(b=>{if(b)b.addEventListener('click',()=>openModal('settings-bd'));});
[$('studio-devices-btn'),$('join-devices-btn'),$('devices-refresh-btn')].forEach(b=>{if(b)b.addEventListener('click',openDeviceModal);});
$('devices-apply-btn').addEventListener('click',applyDevices);
