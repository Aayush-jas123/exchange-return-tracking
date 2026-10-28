/* OFFCOMFRT athlete portal — page.athlete-portal.liquid behaviour.
   Shopify theme asset. Upload to Online Store > Themes > Edit code > Assets
   as athlete-portal.js BEFORE saving the template that loads it. */
const API='https://exchange-return-tracking.onrender.com/api/athlete';
const BASE='https://exchange-return-tracking.onrender.com';
const S={token:null,athlete:null,tasks:[],picks:[],maxPicks:5,streak:0,leaderboard:[],climb:null,ranks:null,log:[],weekly:null,assignment:null,bricks:[],active:'tasks',orders:[],commissions:null,productRequests:[],shopifyProducts:[],shop:null,unlocks:null,invited:new Set(),arcade:null,arcPeriod:'today',arcadeError:false,gbOpen:new Set()};
const $=id=>document.getElementById(id);
const esc=v=>{const e=document.createElement('div');e.textContent=v||'';return e.innerHTML};
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Avatar builder system (extracted from locker.html) ──
const AV_DK='#0A0A0A';
function AV_S(d,c,w){return '<path d="'+d+'" fill="none" stroke="'+c+'" stroke-width="'+(w||8.4)+'" stroke-linecap="round" stroke-linejoin="round"/>'}
const AV_BASE={
  stand:{n:'Stand',d:function(c){return AV_S('M50 35V60',c)+AV_S('M50 41L39 56M50 41L61 56',c)+AV_S('M50 60L41 84M50 60L59 84',c)}},
  walk:{n:'Walk',d:function(c){return AV_S('M48 35V59',c)+AV_S('M48 41L36 52M48 41L60 49',c)+AV_S('M48 59L35 82M48 59L60 80',c)}},
  reach:{n:'Reach',d:function(c){return AV_S('M44 39V62',c)+AV_S('M44 44L32 58M44 44L62 18',c)+AV_S('M44 62L36 86M44 62L54 86',c)}},
  bow:{n:'Bow',d:function(c){return AV_S('M33 42L62 50',c)+AV_S('M44 45L41 66M54 48L52 68',c,6.5)+AV_S('M62 50L57 86M62 50L73 83',c)}},
  sit:{n:'Sit',d:function(c){return AV_S('M50 41V58',c)+AV_S('M50 46L35 56M50 46L65 56',c)+AV_S('M50 58L32 74H68L50 58',c,7)}}
};
const AV_HEAD={
  none:{n:'Bare',d:function(){return ''}},
  cap:{n:'Cap',d:function(c,bg,x,y){return '<path d="M'+(x-10)+' '+(y-2)+'a10 10 0 0120 0z" fill="'+c+'"/><rect x="'+(x+8)+'" y="'+(y-4)+'" width="13" height="4.6" rx="2.3" fill="'+c+'"/>'}},
  hood:{n:'Hood',d:function(c,bg,x,y){return '<path d="M'+x+' '+(y-14)+'c9 0 15 7 15 16 0 6-2 10-5 13l-4-3c2-3 3-6 3-10 0-6-4-10-9-10s-9 4-9 10c0 4 1 7 3 10l-4 3c-3-3-5-7-5-13 0-9 6-16 15-16z" fill="'+c+'"/>'}},
  band:{n:'Band',d:function(c,bg,x,y){return '<rect x="'+(x-9)+'" y="'+(y-5)+'" width="18" height="5.4" fill="'+bg+'"/><rect x="'+(x-10.5)+'" y="'+(y-6.2)+'" width="21" height="2" fill="'+c+'"/>'}},
  mask:{n:'Covered',d:function(c,bg,x,y){return '<rect x="'+(x-8.4)+'" y="'+(y-2.6)+'" width="16.8" height="4.4" rx="2.2" fill="'+bg+'"/>'}}
};
const AV_MARK={
  none:{n:'Clear',d:function(){return ''}},
  rain:{n:'Rain',d:function(c){return AV_S('M28 6L21 24M46 2L39 20M64 2L57 20M82 8L75 26',c,5)}},
  breath:{n:'Breath',d:function(c){return '<circle cx="70" cy="24" r="6.4" fill="'+c+'" opacity=".82"/><circle cx="81" cy="17" r="4.4" fill="'+c+'" opacity=".58"/><circle cx="88" cy="10" r="2.8" fill="'+c+'" opacity=".38"/>'}},
  voice:{n:'Voice',d:function(c){return AV_S('M18 28c-6 10-6 24 0 34',c,5)+AV_S('M82 28c6 10 6 24 0 34',c,5)}},
  eyes:{n:'Watched',d:function(c){return '<circle cx="21" cy="21" r="5.4" fill="'+c+'" opacity=".5"/><circle cx="79" cy="21" r="5.4" fill="'+c+'" opacity=".5"/><circle cx="50" cy="9" r="4.4" fill="'+c+'" opacity=".34"/>'}}
};
const AV_GROUND={
  none:{n:'Nothing',d:function(){return ''}},
  line:{n:'Line',d:function(c){return '<rect x="4" y="90" width="92" height="4.4" fill="'+c+'" opacity=".75"/>'}},
  mat:{n:'Mat',d:function(c){return '<rect x="12" y="86" width="76" height="8" rx="4" fill="'+c+'" opacity=".55"/>'}},
  blocks:{n:'Blocks',d:function(c){return '<rect x="6" y="90" width="88" height="4" fill="'+c+'" opacity=".5"/><path d="M14 90L24 78M28 90L38 80" stroke="'+c+'" stroke-width="6" stroke-linecap="round"/>'}},
  water:{n:'Water',d:function(c){return '<path d="M2 80q12-7 24 0t24 0 24 0 24 0" fill="none" stroke="'+c+'" stroke-width="5" opacity=".7"/><path d="M2 90q12-7 24 0t24 0 24 0 24 0" fill="none" stroke="'+c+'" stroke-width="5" opacity=".45"/>'}}
};
const AV_FRAME={
  plain:{n:'Plain',lv:5,inv:false,bg:function(){return '<circle cx="50" cy="50" r="50" fill="'+AV_DK+'"/>'},over:function(){return ''}},
  ring:{n:'Ring',lv:5,inv:false,bg:function(){return '<circle cx="50" cy="50" r="50" fill="'+AV_DK+'"/>'},over:function(c){return '<circle cx="50" cy="50" r="45" fill="none" stroke="'+c+'" stroke-width="4"/>'}},
  invert:{n:'Invert',lv:5,inv:true,bg:function(){return '<circle cx="50" cy="50" r="50" fill="#fff"/>'},over:function(){return ''}},
  cut:{n:'Cut',lv:5,inv:false,bg:function(){var m='cm'+(++AV_UID);return '<defs><mask id="'+m+'"><circle cx="50" cy="50" r="50" fill="#fff"/><path d="M50 50L104 6L104 64Z" fill="#000"/></mask></defs><g mask="url(#'+m+')"><circle cx="50" cy="50" r="50" fill="'+AV_DK+'"/><circle cx="50" cy="50" r="45.5" fill="none" stroke="#fff" stroke-width="4.5"/></g>'},over:function(){return ''}},
  halo:{n:'Halo',lv:6,inv:false,bg:function(){return '<circle cx="50" cy="50" r="50" fill="'+AV_DK+'"/>'},over:function(c){return '<g class="halo"><path d="M50 4a46 46 0 0140 24" fill="none" stroke="'+c+'" stroke-width="5" stroke-linecap="round"/><path d="M50 96a46 46 0 01-40-24" fill="none" stroke="'+c+'" stroke-width="5" stroke-linecap="round"/></g>'}}
};
let AV_UID=0;
const AV_SLOTS=[
  {k:'base',n:'Stance',lv:1,set:AV_BASE},
  {k:'head',n:'Head',lv:2,set:AV_HEAD},
  {k:'mark',n:'Air',lv:3,set:AV_MARK},
  {k:'ground',n:'Ground',lv:4,set:AV_GROUND},
  {k:'frame',n:'Frame',lv:5,set:AV_FRAME}
];
function avPieceLv(slot,key){if(slot.k==='frame')return(AV_FRAME[key]||AV_FRAME.plain).lv;return slot.lv}
function avBuild(cfg,SZ){
  var F=AV_FRAME[cfg.frame]||AV_FRAME.plain,ink=F.inv?AV_DK:'#fff',bg=F.inv?'#fff':AV_DK,B=AV_BASE[cfg.base]||AV_BASE.walk,hx=50,hy=26;
  var cid='cl'+(++AV_UID);
  var inner=(AV_GROUND[cfg.ground]||AV_GROUND.none).d(ink)+(AV_MARK[cfg.mark]||AV_MARK.none).d(ink)+B.d(ink)+'<circle cx="'+hx+'" cy="'+hy+'" r="7.6" fill="'+ink+'"/>'+(AV_HEAD[cfg.head]||AV_HEAD.none).d(ink,bg,hx,hy);
  var out=F.bg()+'<defs><clipPath id="'+cid+'"><circle cx="50" cy="50" r="50"/></clipPath></defs><g clip-path="url(#'+cid+')">'+inner+'</g>'+F.over(ink);
  return '<svg width="'+SZ+'" height="'+SZ+'" viewBox="0 0 100 100" aria-hidden="true">'+out+'</svg>'
}
function renderAthleteAvatar(athlete,sz){
  if(!athlete)return avBuild({base:'walk',head:'none',mark:'none',ground:'none',frame:'plain'},sz);
  return avBuild({
    base:athlete.avatar_base||'walk',
    head:athlete.avatar_head||'none',
    mark:athlete.avatar_mark||'none',
    ground:athlete.avatar_ground||'none',
    frame:athlete.avatar_frame||'plain'
  },sz);
}

// Refresh all avatar displays across the portal
function refreshAllAvatars(){
  const a=S.athlete||{};
  // Update mobile account sheet header if open
  try{
    const avBody=$('avBody');
    if(avBody && $('avSheet').classList.contains('on')){
      const idcard=avBody.querySelector('.idcard .big');
      if(idcard) idcard.innerHTML=renderAthleteAvatar(a,42);
    }
  }catch(e){console.error('[Avatar] mobile sheet error:',e)}
  // Update desktop sidebar header
  try{
    const sidebarAvatar=document.querySelector('.sidebar-acct-avatar');
    if(sidebarAvatar) sidebarAvatar.innerHTML=renderAthleteAvatar(a,36)||'';
  }catch(e){console.error('[Avatar] sidebar error:',e)}
  // Update top bar avatar buttons (mobile)
  try{
    document.querySelectorAll('.avbtn').forEach(btn=>{
      btn.innerHTML=renderAthleteAvatar(a,26)||'';
    });
  }catch(e){console.error('[Avatar] topbar error:',e)}
  // Update athlete list in Games tab if visible
  try{ if($('athleteList')) renderLobby(); }catch(e){}
  // Update ranks if visible
  try{ if($('ranksBody')) renderRanks(); }catch(e){}
}

// ── Debug logger: console + on-page diagnostics panel ──
const DBG=[];
function dbg(msg,level='info'){
  const line=`${new Date().toLocaleTimeString('en-GB',{hour12:false})} ${level==='err'?'!!':'··'} ${msg}`;
  DBG.push({line,level});
  if(DBG.length>200)DBG.shift();
  if(level==='err')console.error('[AP]',msg);else console.log('[AP]',msg);
  const log=$('dbgLog');
  if(log){
    const el=document.createElement('div');
    if(level==='err')el.className='err';
    el.textContent=line;
    log.appendChild(el);
    log.scrollTop=log.scrollHeight;
  }
}
const maskToken=t=>t?`${t.slice(0,4)}…${t.slice(-4)} (len ${t.length})`:'(none)';
addEventListener('error',e=>dbg(`JS error: ${e.message} @ ${(e.filename||'').split('/').pop()}:${e.lineno}`,'err'));
addEventListener('unhandledrejection',e=>dbg(`Unhandled rejection: ${e.reason?.message||e.reason}`,'err'));

function makeField(){
  const field=$('field'),frag=document.createDocumentFragment();
  const order=[];
  for(let r=23;r>=0;r--)for(let c=0;c<12;c++)order.push(r*12+c);
  for(let i=0;i<288;i++){const b=document.createElement('i');b.className='bk';frag.appendChild(b);S.bricks.push(b)}
  field.appendChild(frag);
  order.slice(0,Math.round(288*.52)).forEach(i=>S.bricks[i].classList.add('on'));
}
function flash(n=1){if(reduce)return;for(let k=0;k<n;k++)setTimeout(()=>{const b=S.bricks[Math.floor(Math.random()*S.bricks.length)];b.classList.remove('hit');void b.offsetWidth;b.classList.add('hit')},k*85)}
function count(id,to,ms=1200){if(reduce){$(id).textContent=Number(to||0).toLocaleString('en-IN');return}const start=performance.now();(function step(now){const p=Math.min(1,(now-start)/ms),e=1-Math.pow(1-p,3);$(id).textContent=Math.round(Number(to||0)*e).toLocaleString('en-IN');if(p<1)requestAnimationFrame(step)})(start)}
function tick(id,month){const run=()=>{const d=new Date(),end=month?new Date(d.getFullYear(),d.getMonth()+1,1):new Date(d.getFullYear(),d.getMonth(),d.getDate(),23,59);let s=Math.max(0,Math.floor((end-d)/1000)),dd=Math.floor(s/86400),hh=String(Math.floor(s%86400/3600)).padStart(2,'0'),mm=String(Math.floor(s%3600/60)).padStart(2,'0'),ss=String(s%60).padStart(2,'0');$(id).innerHTML=(month?dd+'d ':'')+hh+':'+mm+'<span class="s">:'+ss+'</span>'};run();setInterval(run,1000)}
function toast(msg,value=''){$('toastMessage').textContent=msg;$('toastValue').textContent=value;$('toast').classList.remove('show');void $('toast').offsetWidth;$('toast').classList.add('show')}

// ── Avatar sheet ──
let avScreen='menu'; // 'menu' | 'code' | 'cash' | 'ship' | 'card' | 'set' ('shop' jumps to the Shop screen)
const AV_ICONS={
  avatar:'<circle cx="7.5" cy="5" r="2.8"/><path d="M2.5 13c0-2.8 2.2-5 5-5s5 2.2 5 5"/>',
  code:'<rect x="1.5" y="3.5" width="12" height="8"/><path d="M4 7.5h2M8 7.5h3"/>',
  cash:'<path d="M2 4.5h11v6H2zM2 7.5h11"/><circle cx="7.5" cy="7.5" r="1.6"/>',
  ship:'<path d="M1.5 5.5h8v5h-8zM9.5 7h2.3l1.7 2v1.5h-4z"/><circle cx="4" cy="11.5" r="1.1"/><circle cx="10.6" cy="11.5" r="1.1"/>',
  shop:'<path d="M2.5 5h10l-.8 8H3.3z"/><path d="M5.5 5V4a2 2 0 0 1 4 0v1"/>',
  card:'<rect x="1.5" y="2.5" width="12" height="10"/><circle cx="5.5" cy="6" r="1.4"/><path d="M3 10.5c0-1.4 1.1-2.2 2.5-2.2S8 9.1 8 10.5M9.5 5.5h2.5M9.5 8h2"/>',
  set:'<circle cx="7.5" cy="7.5" r="2.1"/><path d="M7.5 1.6v1.8M7.5 11.6v1.8M1.6 7.5h1.8M11.6 7.5h1.8M3.3 3.3l1.3 1.3M10.4 10.4l1.3 1.3M11.7 3.3l-1.3 1.3M4.6 10.4l-1.3 1.3"/>'
};
const AV_MENU=[
  {k:'avatar',t:'Avatar',s:'Build your look',ic:'avatar',note:''},
  {k:'code',t:'Your code',s:'—',ic:'code',note:''},
  {k:'cash',t:'Earnings',s:'—',ic:'cash',note:''},
  {k:'ship',t:'Shipments',s:'—',ic:'ship',note:''},
  {k:'shop',t:'Shop',s:'—',ic:'shop',note:''},
  {k:'card',t:'Athlete card',s:'Share your level',ic:'card',note:''},
  {k:'set',t:'Settings',s:'Address, size, UPI, link',ic:'set',note:''}
];

function openAvSheet(){avScreen='menu';renderAvMenu();$('avScrim').classList.add('on');$('avSheet').classList.add('on')}
function closeAvSheet(){$('avScrim').classList.remove('on');$('avSheet').classList.remove('on')}
function avGo(key){
  if(key==='shop'){closeAvSheet();show('shop');return}
  const m=AV_MENU.find(x=>x.k===key);if(!m)return;
  avScreen=key;
  const renderers={avatar:renderAvAvatar,code:renderAvCode,cash:renderAvEarnings,ship:renderAvShipments,card:renderAvCard,set:renderAvSettings};
  (renderers[key]||renderAvMenu)();
  $('avBody').insertAdjacentHTML('afterbegin','<div class="avbackrow"><button type="button" onclick="avBack()" aria-label="Back">&larr; Back</button></div>');
}
function avBack(){avScreen='menu';renderAvMenu()}

function renderAvMenu(){
  const a=S.athlete||{};
  const dc=a.discount_code||null;
  const handle=a.instagram_handle||'@athlete';
  const lvl=a.level?a.level.display_name:'—';
  // Update menu labels with live data. Rows are looked up by key because the
  // avatar row was prepended later, so positional indexes drift.
  const row=k=>AV_MENU.find(m=>m.k===k);
  const onTheWay=(S.orders||[]).filter(o=>o.fulfillment_status&&!['DELIVERED','delivered','CANCELLED','cancelled'].includes(o.fulfillment_status)).length;
  row('code').s=dc?`${dc.code} · ${dc.percent}% off`:'No code yet';
  row('code').note=`${a.month_orders||0} orders this month`;
  row('cash').s=S.commissions?logFmt((S.commissions.summary||{}).earned||0):'—';
  row('ship').s=onTheWay?`${onTheWay} on the way`:'Nothing in transit';
  row('shop').s=`${coinBalance().toLocaleString('en-IN')} coins`;
  row('shop').note='';
  $('avBody').innerHTML=`<div class="idcard"><span class="big">${renderAthleteAvatar(a,42)}</span><div><b>${esc(a.name||'Athlete')}</b><em>${esc(handle)} · ${esc(lvl)}</em></div></div><div class="menu">${AV_MENU.map(m=>`<button class="mrow" type="button" data-k="${m.k}"><svg viewBox="0 0 15 15" aria-hidden="true">${AV_ICONS[m.ic]}</svg><span><b>${m.t}</b><em>${m.s}</em></span><s${m.note?' class="hot"':''}>${m.note||''}</s><i>&rsaquo;</i></button>`).join('')}</div><p style="font-size:10.5px;color:var(--dim);margin:4px 0 0;line-height:1.45;flex:none">Six screens, none of them worth a tab. An athlete opens any of these a handful of times a month — usually because something sent them here.</p>`;
  $('avBody').querySelectorAll('.mrow').forEach(b=>{b.onclick=()=>avGo(b.dataset.k)});
}

function renderAvAvatar(){
  const a=S.athlete||{};
  const myLv=a.level?.ordinal||1;
  const LVNAME={1:'Comfort Level - 5',2:'Comfort Level - 4',3:'Comfort Level - 3',4:'Comfort Level - 2',5:'Comfort Level - 1',6:'Zero Comfort'};
  
  // Current avatar config (from athlete data or defaults)
  let cfg={
    base:a.avatar_base||'walk',
    head:a.avatar_head||'none',
    mark:a.avatar_mark||'none',
    ground:a.avatar_ground||'none',
    frame:a.avatar_frame||'plain'
  };
  let selSlot='base';
  
  function normalise(){
    AV_SLOTS.forEach(sl=>{
      if(sl.lv>myLv){cfg[sl.k]=sl.k==='base'?cfg.base:(sl.k==='frame'?'plain':'none')}
    });
    if(avPieceLv(AV_SLOTS[4],cfg.frame)>myLv)cfg.frame='plain';
  }
  
  function paintAll(){
    normalise();
    const openSlots=AV_SLOTS.filter(s=>s.lv<=myLv).length;
    $('avBody').innerHTML=`<div class="avbuilder">
        <div class="avpreview" id="avPreview"></div>
        <div style="font-family:var(--m);font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);text-align:center">${openSlots} of 5 slots open &middot; ${LVNAME[myLv]||'Level '+myLv}</div>
        <div class="avslots" id="avSlots"></div>
        <div class="avopts" id="avOpts"></div>
        <button class="avsave" type="button" id="avSaveBtn">Save</button>
      </div>`;
    paintSlots();
    paintOpts();
    paintPreview();
    $('avSaveBtn').onclick=saveAvatar;
  }
  
  function paintPreview(){
    $('avPreview').innerHTML=avBuild(cfg,120);
  }
  
  function paintSlots(){
    $('avSlots').innerHTML=AV_SLOTS.map(sl=>{
      const locked=sl.lv>myLv;
      return `<button type="button" data-s="${sl.k}"${locked?' class="lk"':''} aria-pressed="${sl.k===selSlot&&!locked}">${sl.n}</button>`;
    }).join('');
    $('avSlots').querySelectorAll('button').forEach(b=>{
      b.onclick=()=>{
        const sl=AV_SLOTS.find(x=>x.k===b.dataset.s);
        if(sl.lv>myLv){toast('Opens at '+LVNAME[sl.lv]);return}
        selSlot=sl.k;
        paintSlots();
        paintOpts();
      };
    });
  }
  
  function paintOpts(){
    const sl=AV_SLOTS.find(x=>x.k===selSlot);
    if(!sl||sl.lv>myLv){
      $('avOpts').innerHTML='<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--dim);font-size:10px">Select a slot to edit</div>';
      return;
    }
    $('avOpts').innerHTML=Object.keys(sl.set).map(k=>{
      const plv=avPieceLv(sl,k);
      const locked=plv>myLv;
      const prev={...cfg};
      prev[sl.k]=k;
      return `<button class="avop" type="button" data-k="${k}"${locked?' disabled':''} aria-pressed="${cfg[sl.k]===k}" style="${locked?'opacity:.3':''}">${avBuild(prev,40)}<span>${locked?LVNAME[plv]||'Locked':sl.set[k].n}</span></button>`;
    }).join('');
    $('avOpts').querySelectorAll('.avop').forEach(b=>{
      if(b.disabled)return;
      b.onclick=()=>{
        cfg[sl.k]=b.dataset.k;
        paintAll();
      };
    });
  }
  
  async function saveAvatar(){
    try{
      console.log('[Avatar] Saving:', cfg);
      const result=await api('/profile',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        avatar_base:cfg.base,
        avatar_head:cfg.head,
        avatar_mark:cfg.mark,
        avatar_ground:cfg.ground,
        avatar_frame:cfg.frame
      })});
      console.log('[Avatar] Save result:', result);
      toast('Avatar saved');
      if(S.athlete){
        S.athlete.avatar_base=cfg.base;
        S.athlete.avatar_head=cfg.head;
        S.athlete.avatar_mark=cfg.mark;
        S.athlete.avatar_ground=cfg.ground;
        S.athlete.avatar_frame=cfg.frame;
      }
      // Refresh all avatar displays
      refreshAllAvatars();
      setTimeout(()=>avBack(),1200);
    }catch(e){
      console.error('[Avatar] Save error:', e);
      toast(e.message||'Error saving avatar');
    }
  }
  
  paintAll();
}

function renderAvCode(){
  const a=S.athlete||{},dc=a.discount_code||null;
  const code=dc?dc.code:'—';
  const pct=dc?dc.percent+'%':'—';
  const fmt=v=>'\u20B9'+Number(v||0).toLocaleString('en-IN');
  const monthly=(S.commissions?.monthly||[])[0]||null;
  const orders=monthly?monthly.orders:(a.month_orders||0);
  const coins=a.coin_balance||0;
  const pending=(S.commissions?.summary||{}).pending||0;
  $('avBody').innerHTML=`<div class="codecard"><button type="button" id="cpCode">Copy</button><div class="cd">${esc(code)}</div><div class="pc">${esc(pct)} off · works everywhere</div></div><div class="reflink"><span>offcomfrt.com/?ref=${esc(code)}</span><button type="button" id="cpRef">Copy</button></div><p style="font-size:10.5px;color:var(--dim);margin:0;line-height:1.45;flex:none">Use the link when the code is awkward — a Story sticker, a bio. It counts the same for thirty days even if they never type anything.</p><div class="rule"></div><div class="kick">This month</div><div class="duo"><div><span class="lab" style="margin:0">Orders</span><b>${orders}</b><em>on your code</em></div><div><span class="lab" style="margin:0">Coins earned</span><b>${Number(coins).toLocaleString('en-IN')}</b><em>from sales</em></div></div><div class="settle"><div class="rowx" style="margin-bottom:6px"><span class="lab" style="margin:0">Coins · available now</span><b style="font-family:var(--m);font-size:15px;font-weight:700">${Number(coins).toLocaleString('en-IN')}</b></div>${pending?`<div class="sr"><s>Settling</s><b>+ ${fmt(pending)}</b></div>`:''}<p style="font-size:10px;color:var(--dim);margin:7px 0 0;line-height:1.45">Coins from a sale clear fourteen days after the order, once the return window shuts. Coins from tasks are yours the moment the task is approved.</p></div>`;
  $('cpCode').onclick=()=>{navigator.clipboard.writeText(code).then(()=>toast('Copied',code)).catch(()=>{})};
  $('cpRef').onclick=()=>{navigator.clipboard.writeText('?ref='+code).then(()=>toast('Copied','?ref='+code)).catch(()=>{})};
}

function renderAvEarnings(){
  const c=S.commissions||{},s=c.summary||{},monthly=c.monthly||[];
  const fmt=v=>'\u20B9'+Number(v||0).toLocaleString('en-IN');
  const rate=s.commission_rate||7;
  const last3=monthly.slice(0,3);
  $('avBody').innerHTML=`<div class="kick">This month earnings</div><div class="money"><div class="mr"><span>Attributed net</span><b>${fmt(s.total_revenue)}</b></div><div class="mr"><span>Commission at ${rate}%</span><b>${fmt(s.total_commission)}</b></div><div class="mr"><span>Less self-purchase</span><b>−${fmt(0)}</b></div><div class="mr"><span>Less refunds</span><b>−${fmt(s.reversed||0)}</b></div><div class="mr tot"><span>Earned so far</span><b>${fmt(s.earned)}</b></div></div><div class="rowx" style="font-family:var(--m);font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);flex:none"><span>Pending ${fmt(s.pending)}</span><span>${s.paid?fmt(s.paid)+' paid':''}</span></div>${last3.length?`<div class="rule"></div><div class="kick">Last months</div><div>${last3.map(m=>`<div class="shiprow"><div><b>${m.month}</b><em>${m.orders} orders · ${fmt(m.revenue)} revenue</em></div><span style="font-family:var(--m);font-size:12px;font-weight:700">${fmt(m.commission)}</span></div>`).join('')}</div>`:''}`;
}

function renderAvShipments(){
  const orders=S.orders||[];
  const active=orders.filter(o=>o.fulfillment_status&&!['DELIVERED','delivered','CANCELLED','cancelled'].includes(o.fulfillment_status));
  const past=orders.filter(o=>['DELIVERED','delivered'].includes(o.fulfillment_status)).slice(0,5);
  const steps=['Packed','Dispatched','In transit','Delivered'];
  function stepFor(status){
    if(!status)return 0;
    const s=status.toLowerCase();
    if(s.includes('deliver'))return 3;
    if(s.includes('transit')||s.includes('ship'))return 2;
    if(s.includes('fulfill')||s.includes('dispatch'))return 1;
    return 0;
  }
  const latest=active[0]||null;
  const curStep=latest?stepFor(latest.fulfillment_status):0;
  $('avBody').innerHTML=`${latest?`<div class="kick">On the way</div><div class="track"><b style="font-size:13px;font-weight:700;display:block">Order #${esc(String(latest.shopify_order_id||'').slice(-6))}</b><em style="font-style:normal;font-family:var(--m);font-size:9px;letter-spacing:.07em;color:var(--dim)">${esc(latest.fulfillment_status||'Processing')}</em><div class="tsteps">${steps.map((x,i)=>`<div class="ts${i<curStep?' done':i===curStep?' now':''}">${x}</div>`).join('')}</div></div><p style="font-size:10.5px;color:var(--dim);margin:0;line-height:1.45;flex:none">The delivery scan is what starts your first task on this level — nothing is due until the kit is in your hands.</p>`:'<div class="locked"><div class="ic">📦</div><b>No active shipments</b><span>When a kit ships, it appears here with a live tracker.</span></div>'}<div class="rule"></div><div class="kick">Delivered</div><div>${past.length?past.map(o=>`<div class="shiprow"><div><b>Order #${esc(String(o.shopify_order_id||'').slice(-6))}</b><em>${esc(o.customer_name||'')} · ${logFmt(o.net_value)}</em></div><span class="chipk go">Delivered</span></div>`).join(''):'<div class="shiprow"><div><b>Nothing yet</b><em>Your first delivery will appear here</em></div></div>'}</div><div class="rule"></div><div class="kick">Need product</div><p style="font-size:10.5px;color:var(--dim);margin:0 0 9px;line-height:1.45;flex:none">Seeding, promotion prizes and replacements are requested from here — pick from the live catalogue and the team approves it.</p><button class="pr-cta" type="button" id="avPrBtn">Request product</button>`;
  const prBtn=$('avPrBtn');
  if(prBtn)prBtn.onclick=()=>{closeAvSheet();openProductRequest()};
}

function renderAvCard(){
  const a=S.athlete||{};
  const lvl=a.level||{};
  const fmt=v=>Number(v||0).toLocaleString('en-IN');
  const rank=S.ranks?S.ranks.current_rank:'—';
  const since=a.joined_at?new Date(a.joined_at).toLocaleDateString('en-US',{month:'short'}):'—';
  $('avBody').innerHTML=`<div class="acard"><div class="dialwrap"><svg class="dial" viewBox="0 0 48 48" width="56" height="56" aria-hidden="true" id="avDial"></svg></div><h5>${esc(lvl.display_name||'Comfort Level')}</h5><div class="hd2">${esc(a.instagram_handle||'@athlete')}</div><div class="meta"><div><em>XP</em><b>${fmt(a.xp_total)}</b></div><div><em>Since</em><b>${since}</b></div><div><em>Rank</em><b>#${rank}</b></div></div></div><button class="dangerbtn" type="button" id="saveCard">Save as image</button><p style="font-size:10.5px;color:var(--dim);margin:0;line-height:1.45;flex:none">The only screen built to leave the app. It carries the level and the handle and nothing else — no rupees, no address, no standing score — because it is designed to be posted.</p>`;
  // Draw dial
  const d3=$('avDial');
  if(d3){
    const lit=lvl.dial_segments_lit||1;
    let s='',cx=24,cy=24,r=17;
    for(let i=0;i<5;i++){
      const a0=(-90+i*72+5)*Math.PI/180,a1=(-90+i*72+67)*Math.PI/180;
      s+=`<path class="${i<lit?'litd':'dark'}" d="M${(cx+r*Math.cos(a0)).toFixed(2)} ${(cy+r*Math.sin(a0)).toFixed(2)} A${r} ${r} 0 0 1 ${(cx+r*Math.cos(a1)).toFixed(2)} ${(cy+r*Math.sin(a1)).toFixed(2)}" fill="none" stroke="#fff" stroke-width="${i<lit?'2.8':'1.3'}" opacity="${i<lit?1:.26}"/>`;
    }
    d3.innerHTML=s+`<text class="num" x="24" y="31" text-anchor="middle" fill="#fff" font-family="var(--f)" font-weight="900" font-size="18">${lit}</text>`;
  }
  $('saveCard').onclick=()=>toast('Card export','Coming soon');
}

function renderAvSettings(){
  const a=S.athlete||{};
  const fmt=v=>'\u20B9'+Number(v||0).toLocaleString('en-IN');
  $('avBody').innerHTML=`<div class="kick">Personal</div>
    <div class="sb-field"><label>Name</label><input type="text" id="editName" value="${esc(a.name||'')}"></div>
    <div class="sb-field"><label>Instagram handle</label><input type="text" id="editHandle" value="${esc(a.instagram_handle||'')}"></div>
    <div class="sb-field"><label>Phone</label><input type="tel" id="editPhone" value="${esc(a.phone||'')}"></div>
    <div class="kick" style="margin-top:14px">Shipping address</div>
    <div class="sb-field"><label>Address line</label><textarea id="editAddress">${esc(a.shipping_address||'')}</textarea></div>
    <div class="sb-field-row">
      <div class="sb-field"><label>City</label><input type="text" id="editCity" value="${esc(a.shipping_city||'')}"></div>
      <div class="sb-field"><label>State</label><input type="text" id="editState" value="${esc(a.shipping_state||'')}"></div>
    </div>
    <div class="sb-field-row">
      <div class="sb-field"><label>Pincode</label><input type="text" id="editPin" value="${esc(a.shipping_pin||'')}"></div>
      <div class="sb-field"><label>Landmark</label><input type="text" id="editLandmark" value="${esc(a.shipping_landmark||'')}"></div>
    </div>
    <div class="sb-field"><label>Address type</label><select id="editAddrType"><option value="home"${a.address_type==='home'?' selected':''}>Home</option><option value="office"${a.address_type==='office'?' selected':''}>Office</option></select></div>
    <button class="sb-savebtn" type="button" id="avSaveProfile">Save changes</button>
    <button class="sb-cancelbtn" type="button" onclick="renderAvSettings()">Cancel</button>
    <div class="rule"></div>
    <div class="kick">Preferences</div>
    <div><div class="setrow"><div><b>Show me on the leaderboard</b><em>Off means you still earn, you just stop appearing</em></div><button class="sw" type="button" aria-pressed="${a.leaderboard_opt_out?'false':'true'}" aria-label="Leaderboard"></button></div><div class="setrow"><div><b>WhatsApp nudges</b><em>Deadlines and approvals only. Never marketing.</em></div><button class="sw" type="button" aria-pressed="true" aria-label="Nudges"></button></div></div>
    <div class="rule"></div>
    <div class="kick">Session</div>
    <div><div class="shiprow"><div><b>This device</b><em>Active now</em></div><span class="chipk go">current</span></div></div>
    <button class="dangerbtn" type="button" id="signoutAll">Sign out everywhere</button>
    <p style="font-size:10.5px;color:var(--dim);margin:0;line-height:1.45;flex:none">Use this if you have lost a phone. Every session ends, including this one, and you sign in again with a fresh code.</p>`;
  $('avSaveProfile').onclick=saveProfile;
  $('avBody').querySelectorAll('.sw').forEach(b=>{
    b.onclick=()=>{
      const on=b.getAttribute('aria-pressed')==='true';
      b.setAttribute('aria-pressed',on?'false':'true');
      toast(on?'Turned off':'Turned on','');
    };
  });
  $('signoutAll').onclick=()=>{closeAvSheet();sessionStorage.removeItem('ap_token');S.token=null;showAuthError();toast('Signed out','everywhere')};
}

// ── Sidebar account ──
function toggleSidebarAcct(){
  $('sidebarAcctHead').classList.toggle('open');
  $('sidebarAcctMenu').classList.toggle('open');
}
function openSidebarAcctSub(key){
  const titles={avatar:'Avatar',code:'Your code',cash:'Earnings',ship:'Shipments',card:'Athlete card',set:'Settings'};
  $('sbSubTitle').textContent=titles[key]||'Account';
  const renderers={avatar:sbRenderAvatar,code:sbRenderCode,cash:sbRenderEarnings,ship:sbRenderShipments,card:sbRenderCard,set:sbRenderSettings};
  (renderers[key]||sbRenderCode)();
  $('sidebarAcctSub').classList.add('open');
}
function closeSidebarAcctSub(){$('sidebarAcctSub').classList.remove('open')}
function sbGoShop(){
  closeSidebarAcctSub();
  $('sidebarAcctHead').classList.remove('open');
  $('sidebarAcctMenu').classList.remove('open');
  show('shop');
}

function updateSidebarAcct(){
  const a=S.athlete||{};
  const handle=a.instagram_handle||'@athlete';
  const lvl=a.level?a.level.display_name:'—';
  $('sbAcctName').textContent=a.name||'Athlete';
  $('sbAcctMeta').textContent=`${esc(handle)} · ${esc(lvl)}`;
  // Render avatar in sidebar header — with retry to handle timing issues
  function renderSidebarAvatar(){
    try{
      const avatarEl=document.querySelector('.sidebar-acct-avatar');
      if(avatarEl){
        const svg=renderAthleteAvatar(a,36);
        if(svg && svg.includes('<svg')){
          avatarEl.innerHTML=svg;
          console.log('[Avatar] Sidebar avatar rendered');
        }else{
          console.warn('[Avatar] renderAthleteAvatar returned invalid SVG:', svg);
        }
      }else{
        console.warn('[Avatar] .sidebar-acct-avatar element not found');
      }
    }catch(e){console.error('[Avatar] sidebar render error:',e)}
  }
  renderSidebarAvatar();
  // Retry multiple times to handle DOM timing issues
  setTimeout(renderSidebarAvatar, 500);
  setTimeout(renderSidebarAvatar, 1500);
  setTimeout(renderSidebarAvatar, 3000);
  const dc=a.discount_code||null;
  $('sbValCode').textContent=dc?`${dc.code} · ${dc.percent}%`:'No code';
  const fmt=v=>'\u20B9'+Number(v||0).toLocaleString('en-IN');
  $('sbValCash').textContent=S.commissions?fmt((S.commissions.summary||{}).earned||0):'\u20B90';
  const active=(S.orders||[]).filter(o=>o.fulfillment_status&&!['DELIVERED','delivered','CANCELLED','cancelled'].includes(o.fulfillment_status)).length;
  $('sbValShip').textContent=active?`${active} active`:'None';
  $('sbValShop').textContent=`${coinBalance().toLocaleString('en-IN')} coins`;
}

function sbRenderAvatar(){
  const a=S.athlete||{};
  const myLv=a.level?.ordinal||1;
  const LVNAME={1:'Comfort Level - 5',2:'Comfort Level - 4',3:'Comfort Level - 3',4:'Comfort Level - 2',5:'Comfort Level - 1',6:'Zero Comfort'};
  let cfg={
    base:a.avatar_base||'walk',
    head:a.avatar_head||'none',
    mark:a.avatar_mark||'none',
    ground:a.avatar_ground||'none',
    frame:a.avatar_frame||'plain'
  };
  let selSlot='base';
  function normalise(){
    AV_SLOTS.forEach(sl=>{
      if(sl.lv>myLv){cfg[sl.k]=sl.k==='base'?cfg.base:(sl.k==='frame'?'plain':'none')}
    });
    if(avPieceLv(AV_SLOTS[4],cfg.frame)>myLv)cfg.frame='plain';
  }
  function paintAll(){
    normalise();
    const openSlots=AV_SLOTS.filter(s=>s.lv<=myLv).length;
    $('sbSubBody').innerHTML=`<div class="avbuilder" style="max-width:280px;margin:0 auto">
        <div class="avpreview" id="sbAvPreview"></div>
        <div style="font-family:var(--m);font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);text-align:center;margin-bottom:8px">${openSlots} of 5 slots open &middot; ${LVNAME[myLv]||'Level '+myLv}</div>
        <div class="avslots" id="sbAvSlots" style="max-width:280px"></div>
        <div class="avopts" id="sbAvOpts" style="max-width:280px"></div>
        <button class="avsave" type="button" id="sbAvSaveBtn" style="width:100%;max-width:280px">Save</button>
      </div>`;
    paintSlots();
    paintOpts();
    paintPreview();
    $('sbAvSaveBtn').onclick=saveAvatar;
  }
  function paintPreview(){
    $('sbAvPreview').innerHTML=avBuild(cfg,100);
  }
  function paintSlots(){
    $('sbAvSlots').innerHTML=AV_SLOTS.map(sl=>{
      const locked=sl.lv>myLv;
      return `<button type="button" data-s="${sl.k}"${locked?' class="lk"':''} aria-pressed="${sl.k===selSlot&&!locked}">${sl.n}</button>`;
    }).join('');
    $('sbAvSlots').querySelectorAll('button').forEach(b=>{
      b.onclick=()=>{
        const sl=AV_SLOTS.find(x=>x.k===b.dataset.s);
        if(sl.lv>myLv){toast('Opens at '+LVNAME[sl.lv]);return}
        selSlot=sl.k;
        paintSlots();
        paintOpts();
      };
    });
  }
  function paintOpts(){
    const sl=AV_SLOTS.find(x=>x.k===selSlot);
    if(!sl||sl.lv>myLv){
      $('sbAvOpts').innerHTML='<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--dim);font-size:9px">Select a slot to edit</div>';
      return;
    }
    $('sbAvOpts').innerHTML=Object.keys(sl.set).map(k=>{
      const plv=avPieceLv(sl,k);
      const locked=plv>myLv;
      const prev={...cfg};
      prev[sl.k]=k;
      return `<button class="avop" type="button" data-k="${k}"${locked?' disabled':''} aria-pressed="${cfg[sl.k]===k}" style="${locked?'opacity:.3':''}">${avBuild(prev,36)}<span>${locked?LVNAME[plv]||'Locked':sl.set[k].n}</span></button>`;
    }).join('');
    $('sbAvOpts').querySelectorAll('.avop').forEach(b=>{
      if(b.disabled)return;
      b.onclick=()=>{
        cfg[sl.k]=b.dataset.k;
        paintAll();
      };
    });
  }
  async function saveAvatar(){
    try{
      console.log('[Avatar] Saving:', cfg);
      const result=await api('/profile',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        avatar_base:cfg.base,
        avatar_head:cfg.head,
        avatar_mark:cfg.mark,
        avatar_ground:cfg.ground,
        avatar_frame:cfg.frame
      })});
      console.log('[Avatar] Save result:', result);
      toast('Avatar saved');
      if(S.athlete){
        S.athlete.avatar_base=cfg.base;
        S.athlete.avatar_head=cfg.head;
        S.athlete.avatar_mark=cfg.mark;
        S.athlete.avatar_ground=cfg.ground;
        S.athlete.avatar_frame=cfg.frame;
      }
      // Refresh all avatar displays
      refreshAllAvatars();
      setTimeout(()=>closeSidebarAcctSub(),1200);
    }catch(e){
      console.error('[Avatar] Save error:', e);
      toast(e.message||'Error saving avatar');
    }
  }
  paintAll();
}

function sbRenderCode(){
  const a=S.athlete||{},dc=a.discount_code||null;
  const code=dc?dc.code:'\u2014';
  const pct=dc?dc.percent+'%':'\u2014';
  const fmt=v=>'\u20B9'+Number(v||0).toLocaleString('en-IN');
  const monthly=(S.commissions?.monthly||[])[0]||null;
  const orders=monthly?monthly.orders:(a.month_orders||0);
  const coins=a.coin_balance||0;
  const pending=(S.commissions?.summary||{}).pending||0;
  $('sbSubBody').innerHTML=`<div class="sb-idcard"><div class="big"></div><div><b>${esc(a.name||'Athlete')}</b><em>${esc(a.instagram_handle||'@athlete')} · ${esc(a.level?a.level.display_name:'\u2014')}</em></div></div><div class="sb-kick">Your discount code</div><div class="sb-codecard"><button type="button" onclick="navigator.clipboard.writeText('${esc(code)}').then(()=>toast('Copied','${esc(code)}'))">Copy</button><div class="cd">${esc(code)}</div><div class="pc">${esc(pct)} off · works everywhere</div></div><div class="sb-note">Use the link offcomfrt.com/?ref=${esc(code)} when the code is awkward — a Story sticker, a bio. It counts the same for thirty days.</div><div class="sb-kick" style="margin-top:14px">This month</div><div class="sb-duo"><div><span class="sb-kick" style="margin:0">Orders</span><b>${orders}</b><em>on your code</em></div><div><span class="sb-kick" style="margin:0">Coins</span><b>${Number(coins).toLocaleString('en-IN')}</b><em>from sales</em></div></div>${pending?`<div class="sb-row"><span>Settling</span><b>+ ${fmt(pending)}</b></div>`:''}<p class="sb-note">Coins from a sale clear fourteen days after the order, once the return window shuts. Coins from tasks are yours the moment the task is approved.</p>`;
}
function sbRenderEarnings(){
  const c=S.commissions||{},s=c.summary||{},monthly=c.monthly||[];
  const fmt=v=>'\u20B9'+Number(v||0).toLocaleString('en-IN');
  const rate=s.commission_rate||7;
  const last3=monthly.slice(0,3);
  $('sbSubBody').innerHTML=`<div class="sb-kick">This month</div><div class="sb-row"><span>Attributed net</span><b>${fmt(s.total_revenue)}</b></div><div class="sb-row"><span>Commission at ${rate}%</span><b>${fmt(s.total_commission)}</b></div><div class="sb-row"><span>Less refunds</span><b>\u2212${fmt(s.reversed||0)}</b></div><div class="sb-row" style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px"><span>Earned so far</span><b style="font-size:14px">${fmt(s.earned)}</b></div><div class="sb-note" style="margin-top:10px">Pending: ${fmt(s.pending)}${s.paid?' · Paid: '+fmt(s.paid):''}</div>${last3.length?`<div class="sb-kick" style="margin-top:14px">Last months</div>${last3.map(m=>`<div class="sb-shiprow"><div><b>${m.month}</b><em>${m.orders} orders · ${fmt(m.revenue)} revenue</em></div><span style="font-family:var(--m);font-size:11px;font-weight:700">${fmt(m.commission)}</span></div>`).join('')}`:''}`;
}
function sbRenderShipments(){
  const orders=S.orders||[];
  const active=orders.filter(o=>o.fulfillment_status&&!['DELIVERED','delivered','CANCELLED','cancelled'].includes(o.fulfillment_status));
  const past=orders.filter(o=>['DELIVERED','delivered'].includes(o.fulfillment_status)).slice(0,5);
  const fmt=v=>'\u20B9'+Number(v||0).toLocaleString('en-IN');
  const latest=active[0]||null;
  $('sbSubBody').innerHTML=`${latest?`<div class="sb-kick">On the way</div><div class="sb-shiprow" style="padding:10px 0;border-bottom:1px solid var(--line)"><div><b>Order #${esc(String(latest.shopify_order_id||'').slice(-6))}</b><em>${esc(latest.fulfillment_status||'Processing')}</em></div><span class="sb-chip go">Active</span></div>`:'<div class="sb-note">No active shipments. When a kit ships, it appears here.</div>'}<div class="sb-kick" style="margin-top:14px">Delivered</div>${past.length?past.map(o=>`<div class="sb-shiprow"><div><b>#${esc(String(o.shopify_order_id||'').slice(-6))}</b><em>${esc(o.customer_name||'')} · ${fmt(o.net_value)}</em></div><span class="sb-chip go">Delivered</span></div>`).join(''):'<div class="sb-note">Your first delivery will appear here.</div>'}<div class="sb-kick" style="margin-top:16px">Need product</div><p class="sb-note">Seeding, promotion prizes and replacements are requested from here — pick from the live catalogue and the team approves it.</p><button class="sb-savebtn" type="button" id="sbPrBtn">Request product</button>`;
  const prBtn=$('sbPrBtn');
  if(prBtn)prBtn.onclick=()=>{closeSidebarAcctSub();openProductRequest()};
}
function sbRenderCard(){
  const a=S.athlete||{};
  const lvl=a.level||{};
  const fmt=v=>Number(v||0).toLocaleString('en-IN');
  const rank=S.ranks?S.ranks.current_rank:'\u2014';
  const since=a.joined_at?new Date(a.joined_at).toLocaleDateString('en-US',{month:'short'}):'\u2014';
  const lit=lvl.dial_segments_lit||1;
  let dialSvg='<svg viewBox="0 0 48 48" width="52" height="52" style="flex:none">';
  let cx=24,cy=24,r=17;
  for(let i=0;i<5;i++){
    const a0=(-90+i*72+5)*Math.PI/180,a1=(-90+i*72+67)*Math.PI/180;
    dialSvg+=`<path d="M${(cx+r*Math.cos(a0)).toFixed(2)} ${(cy+r*Math.sin(a0)).toFixed(2)} A${r} ${r} 0 0 1 ${(cx+r*Math.cos(a1)).toFixed(2)} ${(cy+r*Math.sin(a1)).toFixed(2)}" fill="none" stroke="#fff" stroke-width="${i<lit?'2.8':'1.3'}" opacity="${i<lit?1:.26}"/>`;
  }
  dialSvg+=`<text x="24" y="31" text-anchor="middle" fill="#fff" font-family="var(--f)" font-weight="900" font-size="18">${lit}</text></svg>`;
  $('sbSubBody').innerHTML=`<div class="sb-idcard"><div class="big">${renderAthleteAvatar(a,40)}</div><div><b>${esc(a.name||'Athlete')}</b><em>${esc(a.instagram_handle||'@athlete')}</em></div></div><div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">${dialSvg}<div><div style="font-size:13px;font-weight:700">${esc(lvl.display_name||'Comfort Level')}</div><div style="font-family:var(--m);font-size:8.5px;color:var(--dim);margin-top:3px">${fmt(a.xp_total)} XP · Rank #${rank} · Since ${since}</div></div></div><button class="sb-danger" type="button" onclick="toast('Card export','Coming soon')">Save as image</button><p class="sb-note">The only screen built to leave the app. It carries the level and the handle — no rupees, no address.</p>`;
}
function sbRenderSettings(){
  const a=S.athlete||{};
  $('sbSubBody').innerHTML=`
    <div class="sb-kick">Personal</div>
    <div class="sb-field"><label>Name</label><input type="text" id="editName" value="${esc(a.name||'')}"></div>
    <div class="sb-field"><label>Instagram handle</label><input type="text" id="editHandle" value="${esc(a.instagram_handle||'')}"></div>
    <div class="sb-field"><label>Phone</label><input type="tel" id="editPhone" value="${esc(a.phone||'')}"></div>
    <div class="sb-kick" style="margin-top:14px">Shipping address</div>
    <div class="sb-field"><label>Address line</label><textarea id="editAddress">${esc(a.shipping_address||'')}</textarea></div>
    <div class="sb-field-row">
      <div class="sb-field"><label>City</label><input type="text" id="editCity" value="${esc(a.shipping_city||'')}"></div>
      <div class="sb-field"><label>State</label><input type="text" id="editState" value="${esc(a.shipping_state||'')}"></div>
    </div>
    <div class="sb-field-row">
      <div class="sb-field"><label>Pincode</label><input type="text" id="editPin" value="${esc(a.shipping_pin||'')}"></div>
      <div class="sb-field"><label>Landmark</label><input type="text" id="editLandmark" value="${esc(a.shipping_landmark||'')}"></div>
    </div>
    <div class="sb-field"><label>Address type</label><select id="editAddrType"><option value="home"${a.address_type==='home'?' selected':''}>Home</option><option value="office"${a.address_type==='office'?' selected':''}>Office</option></select></div>
    <button class="sb-savebtn" type="button" id="sbSaveProfile">Save changes</button>
    <button class="sb-cancelbtn" type="button" onclick="sbRenderSettings()">Cancel</button>
    <div class="sb-kick" style="margin-top:16px">Preferences</div>
    <div class="sb-shiprow" style="padding:10px 0;border-bottom:1px solid var(--line)"><div><b>Show on leaderboard</b><em>Off means you still earn, just hidden</em></div><button class="sb-chip" type="button" onclick="this.textContent=this.textContent==='On'?'Off':'On';toast(this.textContent==='On'?'Visible':'Hidden','')">${a.leaderboard_opt_out?'Off':'On'}</button></div>
    <div class="sb-shiprow" style="padding:10px 0"><div><b>WhatsApp nudges</b><em>Deadlines and approvals only</em></div><span class="sb-chip go">On</span></div>
    <div class="sb-kick" style="margin-top:14px">Session</div>
    <div class="sb-shiprow" style="padding:10px 0"><div><b>This device</b><em>Active now</em></div><span class="sb-chip go">current</span></div>
    <button class="sb-danger" type="button" onclick="sessionStorage.removeItem('ap_token');S.token=null;showAuthError();toast('Signed out','everywhere')">Sign out everywhere</button>
    <p class="sb-note">Use this if you have lost a phone. Every session ends, including this one.</p>`;
  $('sbSaveProfile').onclick=saveProfile;
}

async function saveProfile(){
  const btn=$('sbSaveProfile');
  btn.disabled=true;btn.textContent='Saving…';
  try{
    const body={
      name:$('editName').value.trim(),
      instagram_handle:$('editHandle').value.trim(),
      phone:$('editPhone').value.trim(),
      shipping_address:$('editAddress').value.trim(),
      shipping_city:$('editCity').value.trim(),
      shipping_state:$('editState').value.trim(),
      shipping_pin:$('editPin').value.trim(),
      shipping_landmark:$('editLandmark').value.trim(),
      address_type:$('editAddrType').value
    };
    const updated=await api('/profile',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    // Merge updated fields back into S.athlete
    if(updated&&S.athlete){
      for(const k of Object.keys(updated)){S.athlete[k]=updated[k];}
    }
    updateSidebarAcct();
    toast('Profile saved','');
    sbRenderSettings();
  }catch(e){
    toast(e.message||'Save failed','');
    btn.disabled=false;btn.textContent='Save changes';
  }
}

async function api(path,options){
  const url=`${API}/${S.token}${path}`,t0=performance.now();
  let response;
  try{
    response=await fetch(url,options);
  }catch(netErr){
    dbg(`✗ ${path} network error: ${netErr.message}`,'err');
    const e=Error(`Network: ${netErr.message}`);
    e.network=true;
    throw e;
  }
  const ms=Math.round(performance.now()-t0);
  let result;
  try{
    const text=await response.text();
    result=text?JSON.parse(text):{};
  }catch(parseErr){
    dbg(`✗ ${path} HTTP ${response.status} non-JSON response (${ms}ms)`,'err');
    const e=Error(`HTTP ${response.status} — non-JSON response (wrong host or route?)`);
    e.status=response.status;
    throw e;
  }
  if(!response.ok||result.success===false){
    dbg(`✗ ${path} HTTP ${response.status} ${result.error||''} (${ms}ms)`,'err');
    const e=Error(result.error||`Request failed (${response.status})`);
    e.status=response.status;
    throw e;
  }
  dbg(`✓ ${path} ${ms}ms`,'ok');
  return result.data;
}

function show(id){
  S.active=id;
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===id));
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('open'));
  // Pause all footer videos, then play only the active screen's video
  document.querySelectorAll('.footer video').forEach(v=>{v.pause()});
  requestAnimationFrame(()=>{
    $(id).classList.add('open');
    const vid=$(id).querySelector('.footer video');
    if(vid){vid.play().catch(()=>{})}
  });
  if(id==='shop'&&S.token)loadShop();
  // The arcade ladder is only fetched when its tab is actually opened.
  if(id==='games'&&S.token)loadArcade();
}

function renderProfile(){
  const a=S.athlete||{},current=a.level||{},next=a.next_level||{},xp=a.xp_total||0;
  const pct=Math.min(100,Math.max(0,(xp-(current.min_xp||0))/Math.max(1,(next.min_xp||xp+100)-(current.min_xp||0))*100));
  $('taskDial').textContent=current.display_number??'—';
  $('taskLevel').innerHTML=esc(current.display_name||'Comfort Level').replace(' - ','<br>- ');
  $('taskBar').style.width=pct+'%';
  $('taskProgress').textContent=next.min_xp?`${(next.min_xp-xp).toLocaleString('en-IN')} TO ${String(next.display_name||'NEXT LEVEL').toUpperCase()}`:'MAXIMUM COMFORT LEVEL';
  count('taskXp',xp);
  // Sync all .xpv elements
  document.querySelectorAll('.xpv').forEach(el=>{el.textContent=xp.toLocaleString('en-IN')});
}

function renderTasks(){
  const tasks=S.tasks||[],picked=tasks.filter(x=>x.picked);
  const a=S.athlete||{},current=a.level||{},next=a.next_level||{},xp=a.xp_total||0;
  const totalAtLevel=10; // tasks needed to clear this level
  const doneAtLevel=Math.min(totalAtLevel,Math.floor(xp/(next.min_xp?next.min_xp/totalAtLevel:100)));
  const remaining=totalAtLevel-doneAtLevel;
  const xpToNext=next.min_xp?next.min_xp-xp:0;

  // Pips
  let pipsHTML='';
  for(let i=0;i<totalAtLevel;i++) pipsHTML+=`<i class="${i<doneAtLevel?'on':i===doneAtLevel?'next':''}"></i>`;
  $('pips').innerHTML=pipsHTML;

  // Progress hero — show XP remaining to next level
  $('xpLabel').textContent=xpToNext?xpToNext.toLocaleString('en-IN')+' XP to next level':'Maximum level reached';
  $('xpEarned').textContent=xp.toLocaleString('en-IN');
  $('xpToGo').textContent=xpToNext?xpToNext.toLocaleString('en-IN')+' to go':'Level complete';

  // Cleared tasks (from today's completed picks)
  const cleared=tasks.filter(x=>x.picked&&!['PICKED','ASSIGNED','IN_PROGRESS','CHANGES_REQUESTED'].includes(x.pick_status));
  $('donelist').innerHTML=cleared.length?cleared.map(t=>`<div class="dr"><svg viewBox="0 0 15 15" aria-hidden="true"><path d="M3 8l3 3 6-7"/></svg><b>${esc(t.title)}</b><s>+${t.xp_value||0} XP</s></div>`).join(''):'<div class="dr" style="color:var(--dim);font-size:11px">No tasks cleared yet at this level</div>';

  // Task pool — show all missions, 1 pick per 24h
  const available=tasks.filter(x=>!x.picked);
  const alreadyPicked=picked.length>=1; // 1 pick per day
  if(available.length){
    $('poolKick').textContent=`Mission pool · ${alreadyPicked?'1 picked · choose again tomorrow':available.length+' available'}`;
    $('taskpool').innerHTML=available.map((t,i)=>{
      const typeLabel=t.type?t.type.replace(/_/g,' '):'';
      const platLabel=t.platform||'';
      const tags=[typeLabel,platLabel].filter(Boolean).join(' · ');
      return `<div class="mpool" data-id="${t.id}" data-idx="${i}">
        <div class="mpool-head" onclick="togglePool(this)">
          <b>${esc(t.title)}</b>
          <span class="mxp">+${t.xp_value||0} XP</span>
          <i class="marr">&#8250;</i>
        </div>
        <div class="mpool-body"><div class="mpool-body-inner">
          ${t.brief_md?`<p>${esc(t.brief_md)}</p>`:''}
          ${tags?`<p style="margin-top:6px;font-family:var(--m);font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)">${tags}</p>`:''}
          <button class="mpick" ${alreadyPicked?'disabled':''} onclick="event.stopPropagation();pickTask(${t.id})">${alreadyPicked?'Already picked today':'Pick mission'}</button>
        </div></div>
      </div>`;
    }).join('');
  }else{
    $('poolKick').textContent='Mission pool';
    $('taskpool').innerHTML='<div class="dr" style="color:var(--dim);font-size:11px">All missions picked for today</div>';
  }

  // Find focused task
  let focus=tasks.find(x=>x.picked&&['PICKED','ASSIGNED','IN_PROGRESS','CHANGES_REQUESTED'].includes(x.pick_status));
  if(!focus)focus=tasks.find(x=>!x.picked);
  if(!focus)focus=tasks[0];
  S.focusId=focus?focus.id:null;
  const pick=focus?S.picks.find(p=>p.task_template_id===focus.id):null;
  // The proof window starts when the mission is picked, not when the pool opened.
  S.focusDue=pick&&pick.picked_at?new Date(new Date(pick.picked_at).getTime()+((focus.due_days||7)*864e5)):null;

  // Scroll cue
  if(focus){
    $('cueTitle').textContent="Today's task";
    $('cueSub').textContent=focus.title||'Loading…';
  }

  // Banner
  $('bannerTitle').textContent='Daily pool is open';
  $('bannerSub').textContent=`${picked.length} of 1 picked · closes midnight`;

  $('taskPicked').innerHTML=`${picked.length}<s>/1</s>`;
  const heroEl=$('taskHero');
  if(!focus){
    if(heroEl)heroEl.classList.remove('tight');
    $('heroA').textContent='No';$('heroB').textContent='missions';
    $('taskReward').textContent='+0 XP';
    $('taskAction').textContent='No missions today';$('taskAction').disabled=true;
    renderDossier(null,null);
    return;
  }
  // Once a mission is picked the card names it instead of asking again
  if(focus.picked){
    $('heroA').textContent='Your mission';
    $('heroB').textContent=focus.title||'Mission';
  }else{
    $('heroA').textContent='Choose your';
    $('heroB').textContent='mission';
  }
  if(heroEl)heroEl.classList.toggle('tight',!!focus.picked&&String(focus.title||'').length>14);
  $('taskReward').textContent=`+${focus.xp_value||0} XP`;
  $('cueClock').textContent=$('taskClock').textContent.replace(/:\d+$/,'')+' left';
  const canPick=!focus.picked&&picked.length<1;
  $('taskAction').disabled=false;
  if(focus.picked){$('taskAction').textContent=focus.pick_status==='CHANGES_REQUESTED'?'Resubmit proof':'Submit proof';$('taskAction').onclick=()=>openSubmission(focus.assignment_id)}
  else{$('taskAction').textContent=canPick?'Pick this mission':'Already picked today';$('taskAction').onclick=()=>{canPick?scrollToPool(focus.id):toast('You can only pick 1 mission per day')}}
  renderDossier(focus,pick);

  // Running timers — live countdowns, refreshed every 30s by refreshCounters()
  const timerRows=[];
  timerRows.push({t:'Daily pick',s:`${picked.length} of 1 chosen · pool closes at midnight`,right:'<s data-mid>&mdash;</s>'});
  if(focus&&focus.picked&&S.focusDue)timerRows.push({t:focus.title,s:'Proof due '+new Date(S.focusDue).toLocaleDateString('en-IN',{day:'2-digit',month:'short'}),right:`<s data-due="${S.focusDue.toISOString()}">&mdash;</s>`});
  if(S.weekly&&S.weekly.challenge)timerRows.push({t:'Weekly challenge',s:S.weekly.challenge.title||'Active challenge',right:'<s>&mdash;</s>'});
  $('timerlist').innerHTML=timerRows.map(r=>`<div class="tr2"><div><b>${esc(r.t)}</b><em>${esc(r.s)}</em></div>${r.right}</div>`).join('');
  refreshCounters();

  // Scroll cue click
  $('scrollcue').onclick=()=>{
    const target=$('taskAction');
    if(target)target.scrollIntoView({behavior:reduce?'auto':'smooth',block:'center'});
  };
}

// ── Mission dossier: brief, requirements, deadline and utility actions ──
const PROOF_FORMATS={CONTENT_POST:'Live post link · caption · note',UGC_RAW:'Raw files · one hero frame',EVENT:'Attendance photo · check-in',SURVEY:'All answers · no blanks',STREAK:'Streak screen · today visible',CHALLENGE:'Challenge post · tagged caption'};
const PROOF_TAGS={CONTENT_POST:['Link','Caption','Note'],UGC_RAW:['Files','Frame','Note'],EVENT:['Photo','Check-in','Note'],SURVEY:['Answers','Note'],STREAK:['Screen','Date','Note'],CHALLENGE:['Link','Tag','Note']};
const CHECK_TAGS={SURVEY:'Every question answered, no blanks',EVENT:'Attendance frame or check-in photo',UGC_RAW:'Raw files, not compressed screenshots',STREAK:"Streak screen with today's date visible",CHALLENGE:'Caption names the challenge'};
const chkKey=id=>'offc.chk.'+id;

// Short "6d 04h" / "3h 12m" label for countdowns.
function fmtLeft(ms){
  if(!isFinite(ms))return '—';
  if(ms<=0)return 'closed';
  const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4);
  return d?`${d}d ${String(h).padStart(2,'0')}h`:`${h}h ${String(m).padStart(2,'0')}m`;
}
function fmtDate(d){return new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short'}).toUpperCase()}

// Fill the dossier for the selected (or suggested) mission.
function renderDossier(t,pick){
  const briefEl=$('dossBrief'),toggle=$('briefToggle'),acts=$('dossActs');
  const setActs=on=>{if(acts)acts.querySelectorAll('button').forEach(b=>b.disabled=!on)};
  if(!t){
    $('dossLabel').textContent='Nothing selected';
    $('dossTitle').textContent='Pick a mission from the pool';
    $('dossTags').innerHTML='';
    briefEl.textContent='Every mission is a small act against comfort. Open the pool above, read a brief, pick one.';
    briefEl.classList.add('plain');briefEl.classList.remove('open');
    toggle.hidden=true;toggle.setAttribute('aria-expanded','false');
    $('dossDue').textContent='—';$('taskTimeBar').style.width='0%';
    $('proofCheck').innerHTML='<div class="pempty">No mission picked yet</div>';
    $('proofKick').textContent='Proof checklist';
    setActs(false);
    return;
  }
  const type=String(t.type||'').toUpperCase();
  $('dossLabel').textContent=t.picked?(t.pick_status==='CHANGES_REQUESTED'?'Your mission · changes requested':'Your mission · '+String(t.pick_status||'PICKED').replace(/_/g,' ').toLowerCase()):'Briefing · not picked yet';
  $('dossTitle').textContent=t.title||'Mission';

  const tags=[];
  if(t.type)tags.push(`<em>${esc(type.replace(/_/g,' '))}</em>`);
  if(t.platform)tags.push(`<em>${esc(t.platform)}</em>`);
  if(t.coin_value)tags.push(`<em>+${t.coin_value} coins</em>`);
  if(t.due_days)tags.push(`<em>${t.due_days}d window</em>`);
  if(t.requires_disclosure)tags.push('<em class="on">Ad disclosure</em>');
  if(pick&&pick.picked_at)tags.push(`<em>picked ${new Date(pick.picked_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</em>`);
  $('dossTags').innerHTML=tags.join('');

  const brief=String(t.brief_md||'').trim()||'No brief attached — open the brief with your coach if anything is unclear.';
  briefEl.textContent=brief;
  briefEl.classList.remove('open');
  toggle.setAttribute('aria-expanded','false');
  toggle.innerHTML='Read full brief +';
  // Only offer the expander when the copy actually clips at four lines.
  const clipped=brief.length>175;
  toggle.hidden=!clipped;
  briefEl.classList.toggle('plain',!clipped);

  if(S.focusDue){
    $('dossDue').textContent=fmtDate(S.focusDue)+' · '+fmtLeft(new Date(S.focusDue)-Date.now());
    const start=pick&&pick.picked_at?new Date(pick.picked_at).getTime():Date.now();
    const span=Math.max(1,new Date(S.focusDue)-start);
    $('taskTimeBar').style.width=Math.max(0,Math.min(100,Math.round((1-(Date.now()-start)/span)*100)))+'%';
  }else{
    $('dossDue').textContent='—';$('taskTimeBar').style.width='0%';
  }

  $('proofFormat').textContent=PROOF_FORMATS[type]||'Live post link · caption · note';
  $('proofTags').innerHTML=(PROOF_TAGS[type]||['Link','Caption','Note']).map(x=>`<span>${x}</span>`).join('');

  renderChecklist(t);
  setActs(true);
}

// Four things that must be true before proof can be submitted. Self-reported
// only — nothing here blocks the submission, it is a pre-flight list.
function checklistFor(t){
  const type=String(t.type||'').toUpperCase();
  const items=[
    {k:'live',t:`Post is live on ${t.platform||'your platform'}`,tag:'feed'},
    {k:'link',t:'Public link copied, no login wall',tag:'link'}
  ];
  if(t.requires_disclosure)items.push({k:'disc',t:'Ad or collaboration disclosed in the caption',tag:'legal'});
  else items.push({k:'tag',t:'@offcomfrt tagged or credited',tag:'credit'});
  items.push({k:'ev',t:CHECK_TAGS[type]||'One clear frame, face and fit visible',tag:'evidence'});
  return items;
}
function chkState(id){try{return JSON.parse(localStorage.getItem(chkKey(id))||'{}')||{}}catch(e){return {}}}
function chkSave(id,state){try{localStorage.setItem(chkKey(id),JSON.stringify(state))}catch(e){}}
function renderChecklist(t){
  const key=t.assignment_id||t.id,state=chkState(key),items=checklistFor(t);
  $('proofCheck').innerHTML=items.map(it=>`<button type="button" role="checkbox" aria-checked="${state[it.k]?'true':'false'}" data-k="${it.k}" data-key="${key}">
    <span class="bx"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.4l2.3 2.3 4.7-5"/></svg></span>
    <span>${esc(it.t)}</span><span class="ptag">${it.tag}</span></button>`).join('');
  $('proofKick').textContent='Proof checklist · '+items.filter(it=>state[it.k]).length+'/'+items.length;
}
function toggleCheck(btn){
  const key=btn.dataset.key,state=chkState(key),on=btn.getAttribute('aria-checked')==='true';
  if(on)delete state[btn.dataset.k];else state[btn.dataset.k]=1;
  chkSave(key,state);
  btn.setAttribute('aria-checked',on?'false':'true');
  const t=(S.tasks||[]).find(x=>String(x.assignment_id||x.id)===String(key));
  const items=t?checklistFor(t):[];
  const done=items.filter(it=>state[it.k]).length;
  $('proofKick').textContent='Proof checklist · '+done+'/'+items.length;
  if(!reduce&&!on)flash(1);
}

// Plain-text brief so the athlete can drop it into notes or send it to themselves.
function briefTextFor(t){
  if(!t)return '';
  const lines=[t.title||'Mission'];
  if(t.brief_md)lines.push('',t.brief_md);
  const bits=[];
  if(t.xp_value)bits.push(`+${t.xp_value} XP`);
  if(t.coin_value)bits.push(`+${t.coin_value} coins`);
  if(bits.length)lines.push('',bits.join(' · '));
  if(S.focusDue)lines.push('Proof due '+new Date(S.focusDue).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}));
  lines.push('','OFFCOMFRT athlete portal');
  return lines.join('\n');
}
async function copyText(text){
  try{await navigator.clipboard.writeText(text);return true}
  catch(e){
    try{
      const ta=document.createElement('textarea');
      ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
      return true;
    }catch(_){return false}
  }
}
function focusTask(){return (S.tasks||[]).find(x=>x.id===S.focusId)||null}

// Live countdown labels in the Running list.
function refreshCounters(){
  const now=Date.now(),mid=new Date();
  mid.setHours(24,0,0,0);
  document.querySelectorAll('#timerlist [data-mid]').forEach(el=>{el.textContent=fmtLeft(mid-now)});
  document.querySelectorAll('#timerlist [data-due]').forEach(el=>{
    const left=new Date(el.dataset.due)-now;
    el.textContent=fmtLeft(left);
    el.classList.toggle('warn',left>0&&left<864e5);
  });
}
setInterval(refreshCounters,30000);

function renderClimb(){
  const c=S.climb;if(!c)return;
  const cur=c.current_level||{};
  const nxt=c.next_level||null;
  const days=c.days_in_current_level||0;
  const xpReq=cur.min_xp||0;
  const xpHave=S.athlete?.xp_total||0;
  const xpPct=nxt?Math.min(100,Math.round((xpHave-(xpReq||0))/Math.max(1,(nxt.min_xp||xpReq)-(xpReq||0))*100)):100;
  const req=c.requirements||null;
  const n=v=>Number(v||0).toLocaleString('en-IN');
  const standing=c.standing_score||0;
  const streak=c.streak||{current_streak:0,longest_streak:0,total_active_days:0};
  const missionsDone=c.missions_completed||0;
  const overallPct=c.overall_pct||0;
  const xpToNext=c.xp_to_next||0;
  const daysToNext=c.days_to_next||0;
  const dailyRate7=c.daily_rate_7||0;
  const dailyRate30=c.daily_rate_30||0;
  const projDays=c.projected_days;
  const perks=c.current_perks;
  const series=c.daily_xp_series||[];

  let gate=' Final level reached.';
  if(nxt&&req){
    const xpLeft=Math.max(0,(nxt.min_xp||0)-xpHave);
    const daysLeft=Math.max(0,(req.days?.required||0)-days);
    const parts=[];
    if(xpLeft)parts.push(`${n(xpLeft)} XP`);
    if(daysLeft)parts.push(`${daysLeft} more day${daysLeft!==1?'s':''}`);
    gate=parts.length?` ${parts.join(' + ')} to ${esc(nxt.display_name)}.`:` ${esc(nxt.display_name)} unlocks at tonight's check.`;
  }

  // ── 1. Hero card ──
  let html=`<div class="climb-hero">
    <div class="ch-top"><span class="ch-label">Current position</span><span class="ch-live"><i></i>Live</span></div>
    <div class="ch-level">${esc(cur.display_name||'Unranked')}</div>
    <div class="ch-name">Comfort Level &ndash; ${cur.display_number??'0'}</div>
    <div class="ch-sub">${days} day${days!==1?'s':''} at this level.${gate}</div>
    <div class="ch-bar"><i style="width:${xpPct}%"></i></div>
    <dl class="ch-stats">
      <div><dt>XP</dt><dd>${n(xpHave)}</dd></div>
      <div><dt>Level</dt><dd>${cur.display_number??'0'}</dd></div>
      <div><dt>Standing</dt><dd>${Number(standing).toFixed(1)}</dd></div>
    </dl>
  </div>`;

  // ── 2. Activity strip: streak / missions / active days ──
  html+=`<div class="climb-activity">
    <div><dt>Streak</dt><dd>${streak.current_streak||0}<s style="font:500 8px var(--m);color:var(--dim);text-decoration:none;margin-left:3px">d</s></dd></div>
    <div><dt>Missions</dt><dd>${n(missionsDone)}</dd></div>
    <div><dt>Active days</dt><dd>${streak.total_active_days||0}</dd></div>
  </div>`;

  // ── 3. Overall progress to max level ──
  const maxLvl=(c.ladder||[])[(c.ladder||[]).length-1];
  html+=`<div class="climb-overall">
    <div class="co-label">Journey to ${esc(maxLvl?.display_name||'Zero Comfort')}</div>
    <div class="co-pct">${overallPct}%</div>
    <div class="co-bar"><i style="width:${overallPct}%"></i></div>
    <div class="co-marks"><span>${n(xpHave)} XP</span><span>${n(maxLvl?.min_xp||20000)} XP</span></div>
  </div>`;

  // ── 4. Next-level requirements checklist ──
  if(nxt&&req){
    const xpDone=req.xp.complete,daysDone=req.days.complete,standDone=req.standing.complete;
    const xpPctReq=Math.min(100,Math.round((req.xp.current/Math.max(1,req.xp.required))*100));
    const daysPctReq=req.days.required?Math.min(100,Math.round((req.days.current/Math.max(1,req.days.required))*100)):100;
    const standPctReq=req.standing.required?Math.min(100,Math.round((req.standing.current/Math.max(1,req.standing.required))*100)):100;
    const allDone=xpDone&&daysDone&&standDone;
    html+=`<div class="climb-req">
      <div class="cr-label">Next level requirements</div>
      <div class="cr-head"><h3>${esc(nxt.display_name)}</h3><span>${allDone?'All complete':'In progress'}</span></div>
      <div class="req-row ${xpDone?'done':''}">
        <div class="req-icon ${xpDone?'done':''}">${xpDone?'\u2713':'XP'}</div>
        <div class="req-body">
          <div class="req-title">${n(req.xp.required).toLocaleString('en-IN')} XP required</div>
          <div class="req-sub">${n(req.xp.current).toLocaleString('en-IN')} / ${n(req.xp.required).toLocaleString('en-IN')} &middot; ${n(Math.max(0,req.xp.required-req.xp.current)).toLocaleString('en-IN')} to go</div>
          <div class="req-bar"><i style="width:${xpPctReq}%"></i></div>
        </div>
        <div class="req-val">${xpPctReq}%</div>
      </div>
      <div class="req-row ${daysDone?'done':''}">
        <div class="req-icon ${daysDone?'done':''}">${daysDone?'\u2713':'D'}</div>
        <div class="req-body">
          <div class="req-title">${req.days.required} days at current level</div>
          <div class="req-sub">${days} / ${req.days.required} days &middot; ${Math.max(0,req.days.required-days)} day${Math.max(0,req.days.required-days)!==1?'s':''} remaining</div>
          <div class="req-bar"><i style="width:${daysPctReq}%"></i></div>
        </div>
        <div class="req-val">${daysPctReq}%</div>
      </div>
      ${req.standing.required?`<div class="req-row ${standDone?'done':''}">
        <div class="req-icon ${standDone?'done':''}">${standDone?'\u2713':'S'}</div>
        <div class="req-body">
          <div class="req-title">Standing score ${req.standing.required}</div>
          <div class="req-sub">${Number(req.standing.current).toFixed(1)} / ${req.standing.required}</div>
          <div class="req-bar"><i style="width:${standPctReq}%"></i></div>
        </div>
        <div class="req-val">${standPctReq}%</div>
      </div>`:''}
    </div>`;
  }

  // ── 5. XP velocity & projection ──
  html+=`<div class="climb-velocity">
    <div class="cv-label">XP velocity</div>
    <div class="cv-stats">
      <div><dt>Last 7 days</dt><dd>${n(c.xp_last_7)}</dd></div>
      <div><dt>Last 30 days</dt><dd>${n(c.xp_last_30)}</dd></div>
    </div>
    <div class="cv-projection">
      <div class="cvp-label">Daily average (7d)</div>
      <div class="cvp-value">${n(dailyRate7)} <s style="font:500 9px var(--m);color:var(--dim);text-decoration:none">XP/day</s></div>
      <div class="cvp-sub">30d avg: ${n(dailyRate30)} XP/day${projDays!=null&&nxt?` &middot; ~${projDays} day${projDays!==1?'s':''} to ${esc(nxt.display_name)}`:''}</div>
    </div>
  </div>`;

  // ── 6. 14-day XP spark chart ──
  if(series.length){
    const maxDay=Math.max(1,...series.map(d=>d.amount));
    const bars=series.map((d,i)=>{
      const h=Math.max(2,Math.round((d.amount/maxDay)*100));
      const isToday=i===series.length-1;
      const label=new Date(d.date).toLocaleDateString('en-IN',{day:'numeric',month:'short'});
      return `<div class="spark-bar${isToday?' today':''}" style="height:${h}%" title="${label}: ${d.amount} XP"></div>`;
    }).join('');
    const labels=series.map((d,i)=>{
      if(i%3!==0&&i!==series.length-1)return '<span></span>';
      return `<span>${new Date(d.date).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>`;
    }).join('');
    html+=`<div class="climb-spark">
      <div class="cs-label">Last 14 days</div>
      <div class="spark-chart">${bars}</div>
      <div class="spark-labels">${labels}</div>
    </div>`;
  }

  // ── 7. Comfort ladder (enhanced with XP gaps) ──
  const ladder=(c.ladder||[]).map(l=>{
    const isCur=l.id===cur.id;
    const isCleared=l.ordinal<(cur.ordinal||0);
    const isLocked=l.ordinal>(cur.ordinal||0);
    const cls=isCur?'current':isCleared?'cleared':'locked';
    const tag=isCur?'YOU':isCleared?'CLEARED':'LOCKED';
    const tagCls=isCur?'you':isCleared?'cleared':'locked';
    const progPct=isCleared?100:isCur?xpPct:0;
    const gap=isLocked?Math.max(0,(l.min_xp||0)-xpHave):0;
    return `<div class="ladder-row ${cls}">
      <b class="ladder-num">${l.display_number??'0'}</b>
      <div>
        <div class="ladder-title">${esc(l.display_name)}</div>
        <div class="ladder-meta">${n(l.min_xp).toLocaleString('en-IN')} XP${l.min_days_in_previous?` &middot; ${l.min_days_in_previous}d at prev`:' &middot; start'}${isLocked&&gap?` &middot; ${n(gap).toLocaleString('en-IN')} to go`:''}</div>
        <div class="ladder-prog"><i style="width:${progPct}%"></i></div>
      </div>
      <span class="state ${tagCls}">${tag}</span>
    </div>`;
  }).join('');
  html+=`<div class="ladder"><div class="ladder-head"><span class="lh-title">Comfort ladder</span><span class="lh-count">${(c.ladder||[]).length} levels</span></div>${ladder}</div>`;

  // ── 8. XP fuel breakdown (enhanced with proportional bars) ──
  const src=c.xp_sources||{},rules=c.xp_rules||{};
  const totalXp=Math.max(1,(src.tasks||0)+(src.orders||0)+(src.games||0)+(src.bonus||0));
  const srcPct=k=>Math.round(((src[k]||0)/totalXp)*100);
  html+=`<div class="climb-fuel">
    <div class="cw-label" style="font-family:var(--m);font-size:7.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)">What fuels your climb</div>
    <dl class="cf-grid">
      <div><dt>Missions</dt><dd>${n(src.tasks)}</dd></div>
      <div><dt>Orders</dt><dd>${n(src.orders)}</dd></div>
      <div><dt>Arcade</dt><dd>${n(src.games)}</dd></div>
      <div><dt>Bonus</dt><dd>${n(src.bonus)}</dd></div>
    </dl>
    <ul style="margin-top:10px">
      <li><span>Missions</span><b>${srcPct('tasks')}%</b></li>
      <li><span>Coupon orders</span><b>${srcPct('orders')}%</b></li>
      <li><span>Arcade</span><b>${srcPct('games')}%</b></li>
    </ul>
    <ul>
      <li><span>Approved mission</span><b>XP on the mission</b></li>
      <li><span>Order with your code</span><b>+${n(rules.xp_per_order)} XP + ${n(rules.xp_per_1000_revenue)}/&#8377;1,000</b></li>
      <li><span>Arcade today</span><b>${n(c.game_xp_today)} / ${n(rules.game_daily_xp_cap)} XP</b></li>
    </ul>
  </div>`;

  // ── 9. Level perks ──
  if(perks&&Array.isArray(perks)&&perks.length){
    const perkItems=perks.map(p=>`<div class="perk-row"><div class="perk-dot"></div><span>${esc(typeof p==='string'?p:p.text||p.name||'Perk')}</span></div>`).join('');
    html+=`<div class="climb-perks"><div class="cp-label">${esc(cur.display_name||'Your level')} perks</div>${perkItems}</div>`;
  }

  // ── 10. Weekly challenge ──
  if(S.weekly?.challenge){
    const w=S.weekly.challenge;
    const entryStatus=S.weekly.entry?esc(S.weekly.entry.status):null;
    html+=`<div class="climb-weekly">
      <div class="cw-label">Shared weekly challenge</div>
      <h3>${esc(w.title)}</h3>
      <p>${esc(w.description||'')}</p>
      ${entryStatus?`<div class="cw-status">Entry: ${entryStatus}</div>`:`<button class="cta" id="weeklySubmit" style="margin-top:12px;width:100%">Submit weekly entry</button>`}
    </div>`;
  }

  // ── 11. Level movement history (enhanced with from/to names) ──
  const hist=(c.history||[]).map(x=>{
    const fromName=x.from_level?.display_name||'';
    const toName=x.to_level?.display_name||'';
    const arrow=x.direction==='UP'?'\u2191':'\u2193';
    return `<div class="history-row">
      <span>${new Date(x.occurred_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>
      <div>
        <b><span class="hr-dir">${arrow} ${esc(x.direction)}</span></b>
        ${fromName||toName?`<div class="hr-levels">${esc(fromName)} \u2192 ${esc(toName)}</div>`:''}
      </div>
      <span>${esc(x.reason_code||'')}</span>
    </div>`;
  }).join('');
  html+=`<div class="climb-history"><div class="chist-label">Level movement</div>${hist||'<div class="empty" style="padding:0">No level movements recorded yet.</div>'}</div>`;

  $('climbContent').innerHTML=html;
  $('weeklySubmit')?.addEventListener('click',submitWeekly);
}

function renderBoard(){
  const list=[...S.leaderboard].sort((a,b)=>(b.xp_total||0)-(a.xp_total||0));
  const mine=list.findIndex(a=>a.id===S.athlete?.id);
  if(mine>=0)$('taskRank').textContent='#'+(mine+1);
  renderLobby();
}

function renderLobby(){
  renderArcade();
  // Lobbies of every cabinet share one hub — label each room with its game so the
  // Join button opens the right cabinet instead of always Rooftop Racing.
  const rooms=RACE.rooms||[];
  $('lobbyWrap').hidden=!rooms.length;
  $('lobbyCount').textContent=rooms.length?`${rooms.length} open`:'';
  $('raceLobbies').innerHTML=rooms.map(r=>{
    const full=r.n>=r.max,game=r.game||'rooftop-racing';
    return `<div class="arow on"><span class="aface">${r.n}</span><span class="am"><b>${esc((r.h||'Athlete').split(/\s+/)[0])}'s room</b><em>${esc(GAME_LABELS[game]||game)} &middot; ${esc(r.r)} &middot; ${r.n}/${r.max}</em></span><span class="aright"><span class="astat"><i></i>${r.s==='lobby'?'In lobby':'Playing'}</span><button class="invt${r.s==='lobby'&&!full?' w':''}" type="button" data-join="${esc(r.r)}" data-game="${esc(game)}"${full?' disabled':''}>${full?'Full':r.s==='lobby'?'Join':'Join next'}</button></span></div>`;
  }).join('');
}

// ── Arcade ladder ─────────────────────────────────────────────────────────
// Ranked on game XP only. Every figure comes from GET /api/athlete/:token/arcade,
// which rebuilds per-game totals from the arcade ledger rows, so comfort XP,
// missions and orders can never move an athlete up this board.
const ARC_LIVE_MS=90000;
const ARC_PERIOD_LABEL={today:'Today · IST',week:'Last 7 days',all:'All time'};
const arcN=v=>Number(v||0).toLocaleString('en-IN');
function arcAgo(iso){
  if(!iso)return 'never';
  const ms=Date.now()-new Date(iso).getTime();
  if(!isFinite(ms)||ms<0)return 'just now';
  const m=Math.floor(ms/60000);
  if(m<1)return 'just now';
  if(m<60)return m+'m ago';
  const h=Math.floor(m/60);
  if(h<24)return h+'h ago';
  const d=Math.floor(h/24);
  return d===1?'yesterday':d+'d ago';
}
function arcPresence(id){
  const p=RACE.live.get(String(id));
  if(p)return{live:true,p};
  const row=(S.leaderboard||[]).find(a=>String(a.id)===String(id));
  return{live:!!(row&&row.last_seen&&Date.now()-row.last_seen<ARC_LIVE_MS),p:null};
}
function renderArcade(){
  const listEl=$('athleteList');
  if(!listEl)return;
  const d=S.arcade,me=String(S.athlete?.id||'');
  const period=S.arcPeriod||'today',m=d?.me||{};
  const cap=Number(m.daily_cap||0),todayXp=Number(m.today_xp||0);

  // ── Your own standing in the arcade ──
  $('arcMe').innerHTML=[
    ['Your rank',m.rank?`#${m.rank}<s> / ${arcN(m.total_athletes)}</s>`:'&mdash;'],
    ['Arcade XP',d?`+${arcN(m.arcade_xp)}`:'&mdash;'],
    ['Coins',d?arcN(m.coins):'&mdash;'],
    ['Runs',d?arcN(m.runs):'&mdash;'],
    ['Best run',m.best_run?`+${arcN(m.best_run)}`:'&mdash;'],
    ['Today',cap?`${arcN(todayXp)}<s> / ${arcN(cap)}</s>`:'&mdash;']
  ].map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('arcSub').innerHTML=d?`${arcN(d.totals.athletes)} athletes &middot; ${arcN(d.totals.runs)} runs &middot; +${arcN(d.totals.xp)} XP`:'&mdash;';

  // ── Standings: one combined ladder across every cabinet ──
  const rows=(d?.rows||[]);
  $('arcListLabel').textContent='Combined standings';
  const liveCount=rows.filter(r=>arcPresence(r.id).live).length;
  $('athleteCount').textContent=d?(liveCount?`${liveCount} live now`:`${rows.length} ranked${rows.length<d.totals.athletes?` of ${arcN(d.totals.athletes)}`:''}`):'';

  renderArcPodium(rows);

  const leaderXp=Math.max(1,Number(rows[0]?.arcade_xp||0));
  listEl.innerHTML=!d?`<div class="empty">${S.arcadeError?'Arcade ladder unavailable &mdash; retry in a moment':'Loading the arcade ladder&hellip;'}</div>`
    :rows.length?rows.map((r,i)=>{
      const isMe=String(r.id)===me;
      const {live,p}=arcPresence(r.id);
      const sent=S.invited.has(String(r.id));
      // My own row is never joinable or invitable — you cannot race or invite yourself.
      const btn=isMe?'':p&&p.r&&p.s==='lobby'?`<button class="invt w" type="button" data-join="${esc(p.r)}" data-game="${esc(p.g||'rooftop-racing')}">Join</button>`
        :live?`<button class="invt" type="button" data-invite="${esc(String(r.id))}" data-name="${esc(r.name||'')}"${sent?' disabled':''}>${sent?'Sent &check;':'Invite'}</button>`:'';
      const meta=[r.level_name,r.favourite_game_label||'\u2014','played '+arcAgo(r.last_played)].filter(Boolean).join(' &middot; ');
      const pct=Math.max(3,Math.round((Number(r.arcade_xp||0)/leaderXp)*100));
      const gap=i>0?Number(rows[i-1].arcade_xp||0)-Number(r.arcade_xp||0):0;
      const gapTxt=i>0?(gap>0?`&minus;${arcN(gap)} vs #${i}`:'level with #'+i):'arcade leader';
      return `<div class="arcrow${r.rank<=3?' podium':''}${isMe?' you':''}${live?' live':''}" title="${esc(r.name||'Athlete')} &middot; ${arcN(r.coins)} coins &middot; ${r.active_days||0} active days">
        <span class="rk">${r.rank}</span>
        <span class="arav">${renderAthleteAvatar(r,28)}</span>
        <span class="arcm"><b>${esc(r.name||'Athlete')}${isMe?'<i>You</i>':''}</b><em>${meta}</em>
          <span class="arcmr"><span class="arcbar"><i style="width:${pct}%"></i></span><span class="arcgap">${gapTxt}</span></span>
        </span>
        <span class="arcr"><span class="arclive"></span><span class="arcscore"><b>+${arcN(r.arcade_xp)}</b><span>${arcN(r.runs)} run${r.runs===1?'':'s'}${r.best_run?' &middot; best +'+arcN(r.best_run):''}</span></span>${btn}</span>
      </div>`;
    }).join('')
    :'<div class="empty">No arcade runs yet this period</div>';

  $('arcFoot').innerHTML=d?`<span>${ARC_PERIOD_LABEL[period]||period} &middot; ${arcN(d.totals.runs)} runs &middot; +${arcN(d.totals.xp)} XP</span><span>${m.rank?`#${m.rank} of ${arcN(m.total_athletes)} &middot; ${m.gap_to_above?`${arcN(m.gap_to_above)} XP behind ${esc(m.above_name||'above')}`:'top of the arcade'}`:'No runs logged yet'}</span>`:'';

  renderArcBoards();
}

// ── Podium: the top three of the combined board, first place raised ──
function renderArcPodium(rows){
  const el=$('arcPodium');if(!el)return;
  const top=(rows||[]).filter(r=>r.rank<=3);
  if(top.length<2){el.innerHTML='';el.classList.remove('on');return}
  el.classList.add('on');
  const me=String(S.athlete?.id||'');
  const order=top.length>=3?[top[1],top[0],top[2]]:[top[1],top[0]];
  el.innerHTML=order.map(r=>{
    const isMe=String(r.id)===me;
    return `<div class="pcard p${r.rank}${isMe?' you':''}${arcPresence(r.id).live?' live':''}">
      <span class="pcrown">${r.rank===1?'01 &middot; leader':'0'+r.rank}</span>
      <span class="pav">${renderAthleteAvatar(r,r.rank===1?54:44)}</span>
      <b>${esc(r.name||'Athlete')}${isMe?'<i>You</i>':''}</b>
      <em>${esc(r.level_name||'\u2014')}</em>
      <span class="pxp">+${arcN(r.arcade_xp)}<s>XP</s></span>
      <span class="pmeta">${arcN(r.runs)} run${r.runs===1?'':'s'} &middot; ${esc(r.favourite_game_label||'\u2014')}</span>
    </div>`;
  }).join('');
}

// ── Cabinet ladders: one collapsible board per game on a sideways track ──
function renderArcBoards(){
  const el=$('arcBoards');if(!el)return;
  const d=S.arcade,me=String(S.athlete?.id||'');
  const boards=d?.games||[];
  const sub=$('arcCabSub');
  if(!boards.length){
    el.innerHTML=`<div class="empty">${d?'No cabinet boards yet':'Loading cabinet ladders&hellip;'}</div>`;
    if(sub)sub.innerHTML='&mdash;';
    syncBoardsOpen();
    return;
  }
  if(sub)sub.innerHTML=`${boards.length} games &middot; ${arcN(boards.reduce((s,b)=>s+b.totals.runs,0))} runs &middot; +${arcN(boards.reduce((s,b)=>s+b.totals.xp,0))} XP`;
  // Presence updates re-render this track; keep the athlete where they scrolled to.
  const scrollLeft=el.scrollLeft;
  el.innerHTML=boards.map((b,gi)=>{
    const open=S.gbOpen.has(b.slug),lead=b.leader;
    const meta=lead?`${arcN(b.totals.athletes)} ranked &middot; ${arcN(b.totals.runs)} runs &middot; lead ${esc(lead.name)}`:'No paid runs yet';
    const rows=(b.top||[]).map(r=>{
      const isMe=String(r.id)===me;
      return `<div class="gbrow${r.rank===1?' lead':''}${isMe?' you':''}">
        <span class="gbrk">${r.rank}</span>
        <span class="gbrav">${renderAthleteAvatar(r,22)}</span>
        <span class="gbrn"><b>${esc(r.name||'Athlete')}${isMe?'<i>You</i>':''}</b><em>${arcN(r.runs)} run${r.runs===1?'':'s'} &middot; best ${r.best_run?'+'+arcN(r.best_run):'&mdash;'}</em></span>
        <span class="gbrx">+${arcN(r.xp)}<small>XP</small></span>
      </div>`;
    }).join('');
    const foot=b.totals.athletes
      ?`<span>${b.me.rank?`You: #${b.me.rank} of ${arcN(b.me.total_athletes)} &middot; +${arcN(b.me.xp)} XP`:'You have not run this cabinet yet'}</span><span>Best run ${b.totals.best_run?'+'+arcN(b.totals.best_run):'&mdash;'} &middot; ${arcN(b.totals.coins)} coins</span>`
      :`<span>Play ${esc(b.label)} to open this board</span><span>Paid in ${esc(b.unit)}</span>`;
    return `<article class="gbcard${open?' open':''}${b.totals.runs?'':' idle'}" data-gb="${b.slug}">
      <button class="gbt" type="button" data-gbtoggle="${b.slug}" aria-expanded="${open?'true':'false'}" aria-controls="gb-${b.slug}">
        <span class="gbidx">${String(gi+1).padStart(2,'0')}</span>
        <span class="gbtxt"><b>${esc(b.label)}</b><em>${meta}</em></span>
        <span class="gbval">+${arcN(b.totals.xp)}<small>XP</small></span>
        <svg class="gbchev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
      </button>
      <div class="gbbody" id="gb-${b.slug}"><div class="gbin">
        ${rows||'<div class="gbempty">No runs in this window</div>'}
        <div class="gbfoot">${foot}</div>
      </div></div>
    </article>`;
  }).join('');
  if(scrollLeft)el.scrollLeft=scrollLeft;
  syncBoardsOpen();
}

function syncBoardsOpen(){
  const boards=S.arcade?.games||[];
  document.querySelectorAll('#arcBoards .gbcard').forEach(c=>{
    const open=S.gbOpen.has(c.dataset.gb);
    c.classList.toggle('open',open);
    const b=c.querySelector('[data-gbtoggle]');
    if(b)b.setAttribute('aria-expanded',open?'true':'false');
  });
  const all=$('gbExpandAll');
  if(all){
    const full=boards.length>0&&S.gbOpen.size>=boards.length;
    all.textContent=full?'Collapse all':'Expand all';
    all.setAttribute('aria-pressed',full?'true':'false');
  }
}

async function loadArcade(period){
  if(!S.token)return;
  if(period)S.arcPeriod=period;
  try{
    const data=await api('/arcade?period='+encodeURIComponent(S.arcPeriod||'today'));
    S.arcade=data||null;
    S.arcadeError=false;
  }catch(e){S.arcadeError=true;dbg('arcade ladder failed: '+e.message,'err')}
  renderLobby();
}

// ── Live race presence: one socket to the RaceHub for who's online, open lobbies and
// real-time invites. Inviting opens the game, which creates the room and delivers it. ──
const RACE={ws:null,tries:0,timer:0,live:new Map(),rooms:[]};
function raceConnect(){
  if(!S.token||RACE.ws)return;
  let ws;
  try{ws=new WebSocket(BASE.replace(/^http/,'ws')+'/ws/race?c=portal&t='+encodeURIComponent(S.token))}catch(e){return raceRetry()}
  RACE.ws=ws;
  ws.onmessage=e=>{
    let m;try{m=JSON.parse(e.data)}catch(_){return}
    if(m.t==='hello')RACE.tries=0;
    else if(m.t==='pr'){RACE.live=new Map((m.a||[]).map(a=>[String(a.id),a]));RACE.rooms=m.rooms||[];renderLobby()}
    else if(m.t==='inv')raceInvite(m);
  };
  ws.onclose=()=>{if(RACE.ws!==ws)return;RACE.ws=null;RACE.live=new Map();RACE.rooms=[];renderLobby();raceRetry()};
}
function raceRetry(){clearTimeout(RACE.timer);if(S.token)RACE.timer=setTimeout(raceConnect,Math.min(30000,1000*2**RACE.tries++))}
function raceClose(){clearTimeout(RACE.timer);const ws=RACE.ws;RACE.ws=null;if(ws)ws.close()}
// Every cabinet has its own page and rooms are game-scoped, so a lobby or invite
// link must open the game the room belongs to — not always Rooftop Racing.
const GAME_LABELS={'rooftop-racing':'Rooftop Race','fruit-ninja':'Fruit Ninja','ping-pong':'Ping Pong','pac-man':'Pac-Man','crossy-road':'Crossy Road'};
const GAME_URLS={'rooftop-racing':BASE+'/athlete-game.html','fruit-ninja':BASE+'/games/fruit-ninja/index.html','ping-pong':BASE+'/games/ping-pong/index.html','pac-man':BASE+'/games/pac-man/index.html','crossy-road':BASE+'/games/crossy-road/index.html'};
// Every cabinet carries the portal's own URL (`p`) so a game's back control returns
// the athlete to this exact page, whichever domain the store is served on.
const PORTAL_SELF=(location.origin+location.pathname).replace(/\/$/,'');
function gameUrl(extra,game){const g=GAME_URLS[game]?game:'rooftop-racing';return GAME_URLS[g]+'#t='+encodeURIComponent(S.token||'')+(extra||'')+'&p='+encodeURIComponent(PORTAL_SELF)}
function raceInvite(m){
  let el=$('raceInv');
  const game=GAME_URLS[m.g]?m.g:'rooftop-racing';
  if(!el){
    el=document.createElement('div');el.id='raceInv';el.className='rinv';document.body.appendChild(el);
    el.addEventListener('click',e=>{
      const b=e.target.closest('[data-rinv]');if(!b)return;
      if(b.dataset.rinv==='join')location.href=gameUrl('&r='+encodeURIComponent(el.dataset.r),el.dataset.game);
      el.classList.remove('show');
    });
  }
  el.dataset.r=m.r;el.dataset.game=game;
  el.innerHTML=`<span><b>${esc(m.from?.n||'An athlete')}</b> invited you to ${esc(GAME_LABELS[game])}</span><button type="button" class="invt w" data-rinv="join">Join</button><button type="button" class="invt" data-rinv="x" aria-label="Dismiss">&times;</button>`;
  el.classList.add('show');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),25000);
}

let rkFilter='all';
function renderRanks(){
  const r=S.ranks||{};
  const allPts=r.snapshots||[];
  const pts=rkFilter==='7d'?allPts.slice(-7):rkFilter==='30d'?allPts.slice(-30):rkFilter==='90d'?allPts.slice(-90):allPts;
  const max=Math.max(1,...pts.map(x=>x.global_rank||1));
  const delta=r.rank_delta||0;
  const deltaCls=delta>0?'up':delta<0?'down':'same';
  const deltaTxt=delta>0?'▲ UP '+delta+' POS':delta<0?'▼ DOWN '+Math.abs(delta)+' POS':'● NO CHANGE';
  const trendSvg=r.trend>0?'<svg viewBox="0 0 16 16" fill="none" stroke="#4ade80" stroke-width="1.5"><path d="M2 12L8 4L14 8"/></svg>':r.trend<0?'<svg viewBox="0 0 16 16" fill="none" stroke="#f87171" stroke-width="1.5"><path d="M2 4L8 12L14 8"/></svg>':'<svg viewBox="0 0 16 16" fill="none" stroke="var(--dim)" stroke-width="1.5"><path d="M2 8H14"/></svg>';
  const chart=pts.length?pts.map(x=>`<i title="${x.captured_on}: #${x.global_rank}" style="height:${Math.max(8,(max-(x.global_rank||max)+1)/max*100)}%"></i>`).join(''):'<span class="empty">First snapshot captured overnight</span>';
  const chartLegend=pts.length?`<span>${pts[0]?.captured_on||''} — ${pts[pts.length-1]?.captured_on||''}</span><b>BEST #${r.best_rank||'—'} · AVG #${r.avg_rank||'—'}</b>`:'<span>NO DATA YET</span>';
  const nearby=(r.nearby||[]).map(a=>{
    const gap=a.is_self?'':a.global_rank<(r.current_rank||999)?`+${((r.xp_total||0)-(a.xp_total||0)).toLocaleString('en-IN')} XP`:`-${((a.xp_total||0)-(r.xp_total||0)).toLocaleString('en-IN')} XP`;
    return `<div class="rk-athlete-row${a.is_self?' me':''}"><span class="rk-pos">${String(a.global_rank||'—').padStart(2,'0')}</span><div class="rk-ainfo"><b>${esc(a.name||'ATHLETE')}${a.is_self?' (YOU)':''}</b><em>${esc(a.level_name||'—')}</em></div><div class="rk-axp"><b>${Number(a.xp_total||0).toLocaleString('en-IN')}</b><em>${gap||Number(a.standing_score||0).toFixed(1)+' STANDING'}</em></div></div>`;
  }).join('');
  const milestones=(r.level_history||[]).map(x=>{
    const isUp=x.direction==='PROMOTED'||x.direction==='UP';
    const icon=isUp?'↑':'↓';
    const iconCls=isUp?'up':'down';
    const fromName=x.from_level?x.from_level.display_name:'';
    const toName=x.to_level?x.to_level.display_name:'';
    const label=fromName&&toName?`${fromName} → ${toName}`:esc(x.reason_code||'LEVEL CHANGE');
    return `<div class="rk-milestone"><div class="mc-icon ${iconCls}">${icon}</div><div class="mc-body"><b>${esc(x.direction)}</b><span>${label}</span></div><div class="mc-date">${new Date(x.occurred_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'2-digit'})}</div></div>`;
  }).join('');
  const medalCls=['m1','m2','m3','m4','m5'];
  const top5=(r.top5||[]).map((a,i)=>{
    const igHandle=a.instagram_handle?`@${a.instagram_handle}`:'@athlete';
    const postLink=a.latest_post&&a.latest_post.post_url?`<a class="rk-top-post" href="${esc(a.latest_post.post_url)}" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h7v7M13 3L5 11"/></svg>VIEW LATEST POST</a>`:'';
    const avatar=renderAthleteAvatar(a,36);
    return `<div class="rk-top-row"><div class="rk-medal ${medalCls[i]||''}">${String(a.rank).padStart(2,'0')}</div><div class="rk-top-avatar">${avatar}</div><div class="rk-top-info"><b>${esc(a.name||'ATHLETE')}</b><span class="rk-ig">${esc(igHandle)}</span><span class="rk-lvl">${esc(a.level_name||'—')}</span>${postLink}</div><div class="rk-top-stats"><b>${Number(a.xp_total||0).toLocaleString('en-IN')}</b><em>${Number(a.standing_score||0).toFixed(1)} STANDING</em></div></div>`;
  }).join('');
  // Chase targets
  const chase=(r.chase_targets||[]).map(a=>{
    const igHandle=a.instagram_handle?`@${a.instagram_handle}`:'@athlete';
    const avatar=renderAthleteAvatar(a,28);
    return `<div class="rk-chase-row"><span class="rk-chase-pos">#${String(a.rank).padStart(2,'0')}</span><div class="rk-chase-avatar">${avatar}</div><div class="rk-chase-info"><b>${esc(a.name||'ATHLETE')}</b><em>${esc(igHandle)} · ${esc(a.level_name||'—')}</em></div><div class="rk-chase-gap"><b>-${Number(a.xp_gap||0).toLocaleString('en-IN')} XP</b><em>${a.missions_away||'—'} missions away</em></div></div>`;
  }).join('');
  // Biggest climbers
  const climbers=(r.biggest_climbers||[]).map((a,i)=>{
    const igHandle=a.instagram_handle?`@${a.instagram_handle}`:'@athlete';
    const avatar=renderAthleteAvatar(a,28);
    return `<div class="rk-climber-row"><span class="rk-climber-rk">#${String(a.current_rank||'—').padStart(2,'0')}</span><div class="rk-climber-avatar">${avatar}</div><div class="rk-climber-info"><b>${esc(a.name||'ATHLETE')}</b><em>${esc(igHandle)} · ${esc(a.level_name||'—')}</em></div><div class="rk-climber-delta"><svg viewBox="0 0 16 16" fill="none" stroke="#4ade80" stroke-width="2"><path d="M8 12V4M4 7l4-4 4 4"/></svg><b>+${a.improvement||0}</b></div></div>`;
  }).join('');
  // Personal best banner
  const pbBanner=r.is_personal_best?`<div class="rk-pb-banner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><div><span>PERSONAL BEST</span><b>You're at your highest rank ever — #${r.current_rank}!</b></div></div>`:'';
  // Motivation message
  const motivMsg=r.motivation_msg?`<div class="rk-motivation"><b>COACH'S NOTE —</b> ${esc(r.motivation_msg)}</div>`:'';
  $('ranksContent').innerHTML=`
<div class="rank-card">
  <div class="rk-top">
    <div>
      <span class="label">Current global rank</span>
      <div class="rk-num">#${r.current_rank??'—'}</div>
    </div>
    <div class="rk-meta">
      <span class="rk-delta ${deltaCls}">${deltaTxt}</span>
      <span class="rk-level">${esc(r.current_level_name||'—')}</span>
      <span class="rk-score">${Number(r.xp_total||0).toLocaleString('en-IN')} XP · ${Number(r.standing_score||0).toFixed(1)} STANDING</span>
    </div>
  </div>
</div>
<div class="module">
  <div class="rk-top5-hdr"><span>Leaderboard</span><b>TOP 5 ATHLETES</b></div>
  <div class="rk-podium">${top5||'<p>No leaderboard data yet.</p>'}</div>
</div>
${pbBanner}
${motivMsg}
<div class="rk-stats">
  <div class="rk-stat"><b>#${r.best_rank||'—'}</b><span>Best rank</span></div>
  <div class="rk-stat"><b>#${r.avg_rank||'—'}</b><span>Avg rank</span></div>
  <div class="rk-stat"><b>${r.total_athletes||'—'}</b><span>Athletes</span></div>
</div>
<div class="rk-pct">
  <div class="rk-pct-label"><b>Top ${r.percentile||0}%</b><span>Percentile standing</span></div>
  <div class="rk-pct-bar"><div class="rk-pct-fill" style="width:${r.percentile||0}%"></div></div>
</div>
<div class="rk-gaps">
  <div class="rk-gap"><b>${r.xp_gap_above?r.xp_gap_above.toLocaleString('en-IN'):'—'}</b><span>XP to rank above</span>${r.xp_gap_above?`<em>${Math.ceil(r.xp_gap_above/50)} missions away</em>`:''}</div>
  <div class="rk-gap"><b>${r.xp_gap_below?r.xp_gap_below.toLocaleString('en-IN'):'—'}</b><span>XP lead over below</span>${r.xp_gap_below?`<em>Safe by ${r.xp_gap_below.toLocaleString('en-IN')} XP</em>`:''}</div>
</div>
<div class="rk-trend">
  ${trendSvg}
  <span>Overall trend</span>
  <b>${r.trend>0?'IMPROVING':r.trend<0?'DECLINING':'STABLE'}</b>
  <span style="margin-left:auto">${r.trend>0?'+'+r.trend:r.trend} positions over ${allPts.length} days</span>
</div>
<div class="module">
  <div class="rk-filters">
    <button class="rk-pill${rkFilter==='7d'?' active':''}" onclick="rkFilter='7d';renderRanks()">7 DAYS</button>
    <button class="rk-pill${rkFilter==='30d'?' active':''}" onclick="rkFilter='30d';renderRanks()">30 DAYS</button>
    <button class="rk-pill${rkFilter==='90d'?' active':''}" onclick="rkFilter='90d';renderRanks()">90 DAYS</button>
    <button class="rk-pill${rkFilter==='all'?' active':''}" onclick="rkFilter='all';renderRanks()">ALL TIME</button>
  </div>
  <span class="label">Rank history</span>
  <div class="chart">${chart}</div>
  <div class="chart-legend">${chartLegend}</div>
</div>
<div class="module">
  <div class="rk-nearby-hdr"><span>Competitors near you</span><b>${(r.nearby||[]).length} athletes</b></div>
  ${nearby||'<p>No nearby ranks available.</p>'}
</div>
<div class="module">
  <span class="label">Rank milestones</span>
  ${milestones||'<p>No milestones recorded yet.</p>'}
</div>
${(r.chase_targets||[]).length?`<div class="module"><div class="rk-chase-hdr"><span>Your targets</span><b>CHASE &amp; OVERTAKE</b></div>${chase}</div>`:''}
${(r.biggest_climbers||[]).length?`<div class="module"><div class="rk-climbers-hdr"><span>This week</span><b>BIGGEST CLIMBERS</b></div>${climbers}</div>`:''}`;
}

// ══════════════════════════════════════════════════════════════════════════
// Log tab — commission hero, monthly split, orders table, product requests and
// the paginated activity journal. Panels, filters and paging live on LOGUI so a
// re-render keeps the athlete where they were. All of it is client side: the
// portal pulls up to 300 activity events and 100 orders in one call.
// ══════════════════════════════════════════════════════════════════════════
const LOGUI={monthlyOpen:true,monthlyMore:new Set(),ordersOpen:true,ordersPage:1,ordersPer:10,orderFilter:'ALL',prOpen:true,actOpen:true,actPage:1,actPer:12,actFilter:'ALL',actMore:new Set()};
const LOG_KIND_LABEL={MISSION:'Mission',XP:'XP',COINS:'Coins',CLIMB:'Rank'};
const LOG_REASONS={GAME_XP:'Arcade run',GAME_COINS:'Arcade run',RACE_XP:'Rooftop race',TASK_XP:'Mission approved',TASK_COINS:'Mission approved',WEEKLY_CHALLENGE_WIN:'Weekly challenge',LEVEL_UP_BONUS:'Level-up bonus',SIGNUP_BONUS:'Join bonus',REFERRAL_BONUS:'Referral bonus'};
const LOG_PAGE_SIZES=[10,25,50];
const logFmt=v=>'\u20B9'+Number(v||0).toLocaleString('en-IN');

function logKind(e){const t=String(e&&e.type||'').toUpperCase();return LOG_KIND_LABEL[t]?t:'OTHER'}
function logReason(code){
  const raw=String(code||'').trim();
  if(!raw)return '\u2014';
  const hit=LOG_REASONS[raw.toUpperCase()];
  if(hit)return hit;
  const words=raw.replace(/_/g,' ').toLowerCase();
  return words.charAt(0).toUpperCase()+words.slice(1);
}
function logWhen(iso){
  const d=new Date(iso);
  if(!iso||isNaN(d.getTime()))return '\u2014';
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'})+' \u00B7 '+d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
}
function logAgo(iso){
  const d=new Date(iso);
  if(!iso||isNaN(d.getTime()))return '';
  const mins=Math.round((Date.now()-d.getTime())/60000);
  if(mins<1)return 'just now';
  if(mins<60)return mins+'m ago';
  const hrs=Math.round(mins/60);if(hrs<24)return hrs+'h ago';
  const days=Math.round(hrs/24);if(days<7)return days+'d ago';
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'});
}
// Right-hand value of an activity row: ledger events show their signed amount,
// missions show whatever they awarded, rank moves show a direction.
function logValue(e){
  const kind=logKind(e);
  if(kind==='XP'||kind==='COINS'){
    const amt=Number(e.amount||0);
    return {text:(amt>0?'+':'')+amt.toLocaleString('en-IN')+(kind==='COINS'?' coins':' XP'),dir:amt<0?'neg':'pos'};
  }
  if(kind==='MISSION'){
    const bits=[];
    if(Number(e.xp))bits.push('+'+Number(e.xp)+' XP');
    if(Number(e.coins))bits.push('+'+Number(e.coins)+' coins');
    return {text:bits.join(' \u00B7 ')||String(e.status||'').replace(/_/g,' '),dir:bits.length?'pos':''};
  }
  if(kind==='CLIMB'){
    const down=String(e.direction||'').toUpperCase()==='DOWN';
    return {text:down?'Down':'Up',dir:down?'neg':'pos'};
  }
  return {text:String(e.title||''),dir:''};
}
function logPanelHead(key,title,meta){
  return `<button class="log-panel-head" type="button" data-log-toggle="${key}" aria-expanded="${LOGUI[key]?'true':'false'}"><span class="lp-title">${title}</span><span class="lp-meta">${meta}</span><span class="lp-chev"></span></button>`;
}
function logSlice(list,page,per){
  const pages=Math.max(1,Math.ceil(list.length/per));
  const safe=Math.min(Math.max(1,page),pages);
  return {rows:list.slice((safe-1)*per,safe*per),page:safe,pages};
}
function logPager(ns,page,pages,total,per,noun){
  return `<div class="log-pager">
    <span class="pg-info">Page ${page} of ${pages} \u00B7 ${total} ${noun}${total===1?'':'s'}</span>
    <div class="pg-btns">
      ${LOG_PAGE_SIZES.map(n=>`<button type="button" data-pg="${ns}" data-pg-per="${n}" class="${n===per?'on':''}" title="Rows per page">${n}</button>`).join('')}
      <button type="button" data-pg="${ns}" data-pg-go="${page-1}"${page<=1?' disabled':''} aria-label="Newer">&lsaquo;</button>
      <button type="button" data-pg="${ns}" data-pg-go="${page+1}"${page>=pages?' disabled':''} aria-label="Older">&rsaquo;</button>
    </div>
  </div>`;
}

function monthlyPanel(monthly,rate){
  if(!monthly.length)return '';
  const rows=monthly.map(m=>{
    const id='m-'+m.month,open=LOGUI.monthlyMore.has(id);
    const d=new Date(m.month+'-02T00:00:00');
    const label=isNaN(d.getTime())?m.month:d.toLocaleDateString('en-IN',{month:'long',year:'numeric'});
    const codes=Object.entries(m.codes||{}).map(([code,count])=>`${esc(code)} \u00B7 ${count} order${count!==1?'s':''}`).join('  \u2022  ');
    return `<div class="monthly-row" data-month="${id}" role="button" tabindex="0" aria-expanded="${open?'true':'false'}">
        <div><div class="mr-month">${esc(label)}</div><div class="mr-meta">${m.orders} order${m.orders!==1?'s':''} \u00B7 ${logFmt(m.revenue)} revenue</div>${codes?`<div class="mr-meta" style="margin-top:2px">${codes}</div>`:''}</div>
        <div class="mr-ord">${m.orders}</div>
        <div class="mr-comm">${logFmt(m.commission)}</div>
      </div>${open?`<div class="monthly-more"><div><span>Earned</span><b>${logFmt(m.earned)}</b></div><div><span>Pending</span><b>${logFmt(m.pending)}</b></div><div><span>Paid</span><b>${logFmt(m.paid)}</b></div><div><span>Reversed</span><b>${logFmt(m.reversed)}</b></div></div>`:''}`;
  }).join('');
  return `<section class="log-panel${LOGUI.monthlyOpen?' open':''}" id="logMonthly">${logPanelHead('monthlyOpen','Monthly breakdown',`${rate}% rate \u00B7 ${monthly.length} month${monthly.length===1?'':'s'}`)}<div class="log-panel-body">${rows}</div></section>`;
}

function ordersPanel(orders,rate){
  const statusOf=o=>o.is_cancelled?'REVERSED':String(o.commission_status||'PENDING').toUpperCase();
  const counts={ALL:orders.length,EARNED:0,PENDING:0,PAID:0,REVERSED:0};
  orders.forEach(o=>{const st=statusOf(o);if(counts[st]!==undefined)counts[st]++});
  const filtered=LOGUI.orderFilter==='ALL'?orders:orders.filter(o=>statusOf(o)===LOGUI.orderFilter);
  const {rows:slice,page,pages}=logSlice(filtered,LOGUI.ordersPage,LOGUI.ordersPer);
  LOGUI.ordersPage=page;
  const chips=['ALL','EARNED','PENDING','PAID','REVERSED'].map(k=>`<button type="button" class="log-chip${LOGUI.orderFilter===k?' on':''}" data-ord-filter="${k}">${k==='ALL'?'All':k.charAt(0)+k.slice(1).toLowerCase()}<s>${counts[k]||0}</s></button>`).join('');
  const head='<div class="ord-head" aria-hidden="true"><span>Date</span><span>Order</span><span>Customer</span><span>Code</span><span>Net</span><span>Commission</span><span>Status</span></div>';
  const rows=slice.map(o=>{
    const net=parseFloat(o.net_value)||0;
    const comm=Math.round(net*rate/100*100)/100;
    const st=statusOf(o).toLowerCase();
    const d=new Date(o.placed_at);
    const dateStr=isNaN(d.getTime())?'\u2014':d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'});
    const code=o.code_used||'DIRECT';
    return `<div class="ord-row">
        <span class="od-oid">#${esc(String(o.shopify_order_id||'\u2014'))}</span>
        <span class="od-cust">${esc(o.customer_name||'Customer')}</span>
        <span class="od-when">${dateStr}<span class="monly"> \u00B7 ${esc(code)}</span></span>
        <span class="od-code">${esc(code)}</span>
        <span class="od-net">${logFmt(net)}</span>
        <span class="od-comm">${logFmt(comm)}</span>
        <span class="od-status"><span class="od-pill ${st}">${st}</span></span>
      </div>`;
  }).join('');
  const body=orders.length
    ? `<div class="log-toolbar">${chips}<span class="tf-right">${filtered.length===orders.length?orders.length+' orders':filtered.length+' of '+orders.length}</span></div>${head}${rows||'<div class="empty" style="padding:16px 18px">No orders in this state.</div>'}${pages>1?logPager('orders',page,pages,filtered.length,LOGUI.ordersPer,'order'):''}`
    : '<div class="empty" style="padding:16px 18px">No commissioned orders yet. They land here the moment an order is placed on your code.</div>';
  return `<section class="log-panel${LOGUI.ordersOpen?' open':''}" id="logOrders">${logPanelHead('ordersOpen','Orders',`${orders.length} total \u00B7 ${rate}% on net`)}<div class="log-panel-body">${body}</div></section>`;
}

function requestsPanel(prs){
  const rows=prs.map(p=>{
    const items=(p.items||[]).map(it=>esc(it.title||it.variant_id||'Item')).join(' \u00B7 ');
    const d=new Date(p.requested_at);
    const when=isNaN(d.getTime())?'\u2014':d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    const st=String(p.status||'requested').toLowerCase();
    return `<div class="pr-row">
      <div>
        <div class="pr-reason">${esc(p.reason||'Request')}</div>
        <div class="pr-date">${when}${p.notes?' \u00B7 '+esc(p.notes):''}</div>
        ${items?`<div class="pr-items">${items}</div>`:''}
      </div>
      <span class="pr-status ${st}">${st.replace('_',' ')}</span>
    </div>`;
  }).join('');
  return `<section class="log-panel${LOGUI.prOpen?' open':''}" id="logRequests">${logPanelHead('prOpen','Product requests',`${prs.length} total`)}<div class="log-panel-body">${rows||'<div class="empty" style="padding:16px 18px">Nothing requested yet.</div>'}<p class="pr-hint">Request a product from Account &rarr; Shipments. An approved request comes back as a seeding shipment.</p></div></section>`;
}

function actMore(n){
  const e=n.e;
  const fields=[
    ['Exact time',logWhen(e.occurred_at)],
    ['Kind',LOG_KIND_LABEL[n.kind]||n.kind],
    ['Reason code',e.detail?String(e.detail):null],
    ['Status',e.status?String(e.status).replace(/_/g,' '):null],
    ['XP',e.xp?String(e.xp):null],
    ['Coins',e.coins?String(e.coins):null],
    ['Amount',e.amount!==undefined&&e.amount!==null?String(e.amount):null],
    ['Balance after',e.balance_after!==undefined&&e.balance_after!==null?String(e.balance_after):null],
    ['Reference',e.id||null]
  ].filter(f=>f[1]!==null&&f[1]!=='');
  return `<div class="act-more"><dl class="act-detail">${fields.map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></div>`;
}

function activityPanel(events){
  const norm=events.slice().sort((a,b)=>new Date(b.occurred_at)-new Date(a.occurred_at)).map((e,i)=>{
    const kind=logKind(e),val=logValue(e);
    return {e,kind,id:e.id||('e'+i),value:val.text,dir:val.dir};
  });
  const counts={ALL:norm.length,MISSION:0,XP:0,COINS:0,CLIMB:0};
  norm.forEach(n=>{if(counts[n.kind]!==undefined)counts[n.kind]++});
  const filtered=LOGUI.actFilter==='ALL'?norm:norm.filter(n=>n.kind===LOGUI.actFilter);
  const {rows:slice,page,pages}=logSlice(filtered,LOGUI.actPage,LOGUI.actPer);
  LOGUI.actPage=page;
  const chips=['ALL','MISSION','XP','COINS','CLIMB'].map(k=>`<button type="button" class="log-chip${LOGUI.actFilter===k?' on':''}" data-act-filter="${k}">${k==='ALL'?'All':LOG_KIND_LABEL[k]}<s>${counts[k]||0}</s></button>`).join('');
  const head='<div class="act-head" aria-hidden="true"><span>When</span><span>Kind</span><span>Activity</span><span>Detail</span><span>Impact</span></div>';
  const rows=slice.map(n=>{
    const open=LOGUI.actMore.has(n.id);
    return `<div class="act-row${open?' open':''}" data-act-row="${esc(n.id)}" role="button" tabindex="0" aria-expanded="${open?'true':'false'}">
        <span class="ar-title">${esc(n.e.title||'Event')}</span>
        <span class="ar-val ${n.dir}">${esc(n.value)}</span>
        <span class="ar-kind ${n.kind.toLowerCase()}">${LOG_KIND_LABEL[n.kind]||esc(n.kind)}</span>
        <span class="ar-when">${logWhen(n.e.occurred_at)}</span>
        <span class="ar-detail">${esc(logReason(n.e.detail))}</span>
      </div>${open?actMore(n):''}`;
  }).join('');
  const meta=norm.length?`${norm.length} events \u00B7 ${logAgo(norm[0].e.occurred_at)}`:'0 events';
  const body=norm.length
    ? `<div class="log-toolbar">${chips}<span class="tf-right">${filtered.length===norm.length?norm.length+' events':filtered.length+' of '+norm.length}</span></div>${head}${rows||'<div class="empty" style="padding:16px 18px">No events of this kind.</div>'}${pages>1?logPager('act',page,pages,filtered.length,LOGUI.actPer,'event'):''}`
    : '<div class="empty" style="padding:16px 18px">Approved work, XP, coins and rank moves appear here.</div>';
  return `<section class="log-panel${LOGUI.actOpen?' open':''}" id="logActivity">${logPanelHead('actOpen','Activity log',meta)}<div class="log-panel-body">${body}</div></section>`;
}

function renderLog(){
  const c=S.commissions||{};
  const s=c.summary||{};
  const monthly=c.monthly||[];
  const orders=S.orders||[];
  const prs=S.productRequests||[];
  const events=S.log||[];
  const rate=s.commission_rate||7;

  let html=`<div class="comm-hero">
    <div class="cm-top"><span class="cm-label">Total commission earned</span><span class="cm-live"><i></i>Live</span></div>
    <div class="cm-earned">${logFmt(s.total_commission)}</div>
    <div class="cm-sub">${s.total_orders||0} orders &middot; ${logFmt(s.total_revenue)} attributed &middot; ${rate}% on net</div>
    <dl class="cm-stats four">
      <div><dt>Earned</dt><dd>${logFmt(s.earned)}</dd></div>
      <div><dt>Pending</dt><dd>${logFmt(s.pending)}</dd></div>
      <div><dt>Paid</dt><dd>${logFmt(s.paid)}</dd></div>
      <div><dt>Reversed</dt><dd>${logFmt(s.reversed)}</dd></div>
    </dl>
  </div>`;

  html+=monthlyPanel(monthly,rate);
  html+=ordersPanel(orders,rate);
  html+=requestsPanel(prs);
  html+=activityPanel(events);

  $('logContent').innerHTML=html;
  bindLog();
}

// One delegated pass per render: every panel control is a data-* button, so a
// re-render never leaves a stale handler behind.
function bindLog(){
  const root=$('logContent');if(!root)return;
  const keep=fn=>{const sc=root.parentElement;const top=sc?sc.scrollTop:0;fn();if(sc)sc.scrollTop=top};
  root.querySelectorAll('[data-log-toggle]').forEach(b=>{b.onclick=()=>{
    const key=b.dataset.logToggle;LOGUI[key]=!LOGUI[key];renderLog();
    const again=$('logContent').querySelector(`[data-log-toggle="${key}"]`);if(again)again.scrollIntoView({block:'nearest'});
  }});
  root.querySelectorAll('[data-ord-filter]').forEach(b=>{b.onclick=()=>keep(()=>{LOGUI.orderFilter=b.dataset.ordFilter;LOGUI.ordersPage=1;renderLog()})});
  root.querySelectorAll('[data-act-filter]').forEach(b=>{b.onclick=()=>keep(()=>{LOGUI.actFilter=b.dataset.actFilter;LOGUI.actPage=1;renderLog()})});
  root.querySelectorAll('[data-pg]').forEach(b=>{b.onclick=()=>keep(()=>{
    const ns=b.dataset.pg;
    if(b.dataset.pgPer){
      const n=Number(b.dataset.pgPer);
      if(ns==='orders'){LOGUI.ordersPer=n;LOGUI.ordersPage=1}else{LOGUI.actPer=n;LOGUI.actPage=1}
    }else if(b.dataset.pgGo){
      const n=Math.max(1,Number(b.dataset.pgGo));
      if(ns==='orders')LOGUI.ordersPage=n;else LOGUI.actPage=n;
    }
    renderLog();
  })});
  root.querySelectorAll('[data-act-row]').forEach(r=>{r.onclick=()=>keep(()=>{
    const id=r.dataset.actRow;
    if(LOGUI.actMore.has(id))LOGUI.actMore.delete(id);else LOGUI.actMore.add(id);
    renderLog();
  })});
  root.querySelectorAll('[data-month]').forEach(r=>{r.onclick=()=>keep(()=>{
    const id=r.dataset.month;
    if(LOGUI.monthlyMore.has(id))LOGUI.monthlyMore.delete(id);else LOGUI.monthlyMore.add(id);
    renderLog();
  })});
  root.querySelectorAll('[data-act-row],[data-month]').forEach(r=>{r.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();r.click()}}});
}

function togglePool(head){
  const row=head.closest('.mpool');
  const wasOpen=row.classList.contains('open');
  // Close all rows
  document.querySelectorAll('.mpool.open').forEach(r=>r.classList.remove('open'));
  // Toggle the tapped row
  if(!wasOpen)row.classList.add('open');
}

// Scroll the task screen's own scroll zone (never the page) to an element.
function scrollTaskTo(el){
  if(!el)return;
  el.scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'});
}

// "Pick this mission" points the athlete at the pool instead of silently
// picking the first available mission — open that row and scroll back up to it.
function scrollToPool(id){
  const pool=$('taskpool');if(!pool)return;
  const row=id?pool.querySelector(`.mpool[data-id="${id}"]`):pool.querySelector('.mpool');
  document.querySelectorAll('.mpool.open').forEach(r=>r.classList.remove('open'));
  if(row){row.classList.add('open','hl');setTimeout(()=>row.classList.remove('hl'),1600)}
  scrollTaskTo($('poolKick')||pool);
}

// After a real pick the mission card names the chosen mission — bring it into view.
function scrollToMission(){scrollTaskTo($('taskHero'))}

async function pickTask(id){try{await api('/daily-tasks/pick',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_template_id:id})});toast('Mission picked');flash(6);await loadTasks();scrollToMission()}catch(e){toast(e.message)}}
function openSubmission(id){
  S.assignment=id;
  const focus=S.tasks.find(x=>x.assignment_id===id)||S.tasks.find(x=>x.picked);
  $('sheetTaskTitle').textContent=focus?focus.title.toUpperCase():'—';
  $('proofUrl').value='';$('proofCaption').value='';$('proofNotes').value='';$('proofDisclosure').checked=false;$('proofPlatform').value='instagram';$('captionCount').textContent='0';
  $('sheet').classList.add('open');
}
async function submitProof(){
  const url=$('proofUrl').value.trim();
  if(!url)return toast('Post URL required');
  const btn=$('submitProof');btn.disabled=true;btn.textContent='Submitting…';
  try{
    await api('/submissions/'+S.assignment,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post_url:url,caption:$('proofCaption').value.trim(),disclosure_found:$('proofDisclosure').checked,platform:$('proofPlatform').value,notes:$('proofNotes').value.trim()})});
    $('sheet').classList.remove('open');toast('Proof submitted');flash(12);await loadTasks();
  }catch(e){toast(e.message)}
  finally{btn.disabled=false;btn.textContent='Submit'}
}
async function submitWeekly(){const url=prompt('Paste your weekly post URL');if(!url)return;try{await api('/weekly-challenge/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge_id:S.weekly.challenge.id,submission_url:url,caption:'',disclosure_found:false})});toast('Weekly entry submitted');S.weekly=await api('/weekly-challenge');renderClimb()}catch(e){toast(e.message)}}

// ── Product request sheet ──
let selectedProducts={}; // {productId: {product, variantId}}
async function loadShopifyProducts(){
  if(S.shopifyProducts.length)return;
  try{
    const res=await fetch('https://exchange-return-tracking.onrender.com/api/athlete-products');
    const data=await res.json();
    S.shopifyProducts=data.products||[];
  }catch(e){dbg('Failed to load products: '+e.message,'err')}
}
function renderProductGrid(filter=''){
  const q=filter.toLowerCase().trim();
  const products=q?S.shopifyProducts.filter(p=>p.title.toLowerCase().includes(q)||p.product_type.toLowerCase().includes(q)||(p.vendor||'').toLowerCase().includes(q)):S.shopifyProducts;
  if(!products.length){$('productGrid').innerHTML='<div class="product-empty">No products found</div>';return}
  $('productGrid').innerHTML=products.map(p=>{
    const isSelected=selectedProducts[p.id];
    const img=p.image?`<img class="pc-img" src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy" width="600" height="600"/>`:'<div class="pc-img-placeholder">&#x1F455;</div>';
    const vars=p.variants.slice(0,3).map(v=>`<div class="pc-var"><span>${esc(v.title)}</span><span>\u20B9${Number(v.price).toLocaleString('en-IN')}</span></div>`).join('');
    return `<div class="product-card${isSelected?' selected':''}" data-pid="${p.id}" data-title="${esc(p.title)}">
      ${img}
      <div class="pc-check">\u2713</div>
      <div class="pc-info"><div class="pc-title">${esc(p.title)}</div><div class="pc-type">${esc(p.product_type||p.vendor||'Product')}</div></div>
      ${vars?`<div class="pc-variants">${vars}</div>`:''}
    </div>`;
  }).join('');
  $('productGrid').querySelectorAll('.product-card').forEach(card=>{
    card.addEventListener('click',()=>toggleProduct(card.dataset.pid,card.dataset.title));
  });
}
function toggleProduct(pid,title){
  if(selectedProducts[pid]){
    delete selectedProducts[pid];
  }else{
    const p=S.shopifyProducts.find(x=>x.id===pid);
    if(p&&p.variants.length)selectedProducts[pid]={product:p,variantId:p.variants[0].id};
    else if(p)selectedProducts[pid]={product:p,variantId:null};
  }
  renderProductGrid($('productSearch').value);
  updateSelectedSummary();
}
function updateSelectedSummary(){
  const count=Object.keys(selectedProducts).length;
  $('selectedSummary').textContent=count?count+' item'+(count!==1?'s':'')+' selected':'';
}
function openProductRequest(){
  selectedProducts={};
  $('prReason').value='SEEDING';$('prAddress').value='';$('prNotes').value='';$('productSearch').value='';$('selectedSummary').textContent='';
  $('prSheet').classList.add('open');
  loadShopifyProducts().then(()=>renderProductGrid());
}
function closeProductRequest(){$('prSheet').classList.remove('open')}
async function submitProductRequest(){
  const reason=$('prReason').value;
  const items=Object.values(selectedProducts).map(({product,variantId})=>{
    const v=product.variants.find(x=>x.id===variantId)||product.variants[0];
    return {title:product.title+(v&&v.title!=='Default'?' ('+v.title+')':''),variant_id:v?v.id:null,qty:1,image_url:product.image||''};
  });
  if(!items.length)return toast('Select at least one product');
  const address=$('prAddress').value.trim()||null;
  const btn=$('submitPr');btn.disabled=true;btn.textContent='Submitting\u2026';
  try{
    await api('/product-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason,items,address})});
    closeProductRequest();toast('Product request submitted');
    S.productRequests=await api('/product-requests');renderLog();
  }catch(e){toast(e.message)}
  finally{btn.disabled=false;btn.textContent='Submit request'}
}
async function loadTasks(){const data=await api('/daily-tasks');S.tasks=data?.tasks||[];S.picks=data?.picks||[];S.maxPicks=data?.maxPicks||5;renderTasks()}
async function refreshBoard(){try{const board=await api('/leaderboard');if(JSON.stringify(board)!==JSON.stringify(S.leaderboard)){S.leaderboard=board||[];renderBoard();flash(2)}else{renderLobby()}}catch(e){}}

function enterPortal(){$('loading').hidden=true;$('portal').classList.add('ready');show('tasks');linkGames();loadUnlocks();raceConnect();if(!reduce)setInterval(refreshBoard,30000)}

// ── Coin shop: spend-only currency earned from the arcade and level-ups. Coins
// never feed XP, level or rank. Products land later — for now the screen shows
// the balance, where coins come from and the level-up bonus ladder. ──
const COIN_REASONS={GAME_COINS:'Arcade run',LEVEL_UP_BONUS:'Level-up bonus',TASK_COINS:'Mission approved',WEEKLY_CHALLENGE_WIN:'Weekly challenge'};
function coinBalance(){return Number(S.shop?.balance??S.athlete?.coin_balance??0)}
function updateTabCoinBadge(){const el=$('tabCoin');if(!el)return;const b=coinBalance();el.textContent=b>0?b.toLocaleString('en-IN'):''}
function renderShop(){
  const el=$('shopContent');if(!el)return;
  const sh=S.shop,src=sh?.sources||{},rules=sh?.rules||{};
  const n=v=>Number(v||0).toLocaleString('en-IN');
  const earned=Object.values(src).reduce((sum,v)=>sum+Number(v||0),0);
  let html=`<div class="climb-hero">
    <div class="ch-top"><span class="ch-label">Coin balance</span><span class="ch-live"><i></i>Live</span></div>
    <div class="ch-level">${n(coinBalance())}</div>
    <div class="ch-name">Coins</div>
    <div class="ch-sub">Spend them on drops in this shop. Coins never count toward XP, levels or rank.</div>
    <dl class="ch-stats">
      <div><dt>Earned</dt><dd>${sh?n(earned):'&mdash;'}</dd></div>
      <div><dt>Spent</dt><dd>${sh?n(sh.spent):'&mdash;'}</dd></div>
      <div><dt>Arcade today</dt><dd>${sh?`${n(sh.game_coins_today)}/${n(rules.game_daily_coin_cap)}`:'&mdash;'}</dd></div>
    </dl>
  </div>`;

  html+=`<div class="shop-drops">
    <div class="ladder-head"><span class="lh-title">Drops</span><span class="lh-count">Coming soon</span></div>
    <div class="shop-tiles"><div>Soon</div><div>Soon</div><div>Soon</div></div>
    <p class="shop-note">Gear and rewards land here soon. Bank your coins now so you can grab the first drop the day it opens.</p>
  </div>`;

  if(sh){
    html+=`<div class="climb-fuel">
      <div style="font-family:var(--m);font-size:7.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)">Where your coins come from</div>
      <dl class="cf-grid">
        <div><dt>Arcade</dt><dd>${n(src.games)}</dd></div>
        <div><dt>Level-ups</dt><dd>${n(src.levels)}</dd></div>
        <div><dt>Missions</dt><dd>${n(src.tasks)}</dd></div>
        <div><dt>Other</dt><dd>${n((src.challenges||0)+(src.other||0))}</dd></div>
      </dl>
      <ul>
        <li><span>Mini-game run</span><b>up to ${n(rules.game_coins_per_run_max)} coins</b></li>
        <li><span>Arcade today</span><b>${n(sh.game_coins_today)} / ${n(rules.game_daily_coin_cap)} coins</b></li>
        <li><span>New comfort level</span><b>one-time bonus</b></li>
      </ul>
    </div>`;

    const bonuses=sh.level_bonuses||[];
    if(bonuses.length){
      const nextIdx=bonuses.findIndex(b=>!b.reached);
      html+=`<div class="ladder" style="border-top:1px solid var(--line)"><div class="ladder-head"><span class="lh-title">Level-up bonus</span><span class="lh-count">paid once per level</span></div>${bonuses.map((b,i)=>{
        const state=b.reached?'cleared':i===nextIdx?'current':'locked';
        const tag=b.reached?'REACHED':i===nextIdx?'NEXT':'LOCKED';
        const tagCls=b.reached?'cleared':i===nextIdx?'you':'locked';
        return `<div class="ladder-row ${state}"><b class="ladder-num">${b.display_number??'0'}</b><div><div class="ladder-title">${esc(b.display_name)}</div><div class="ladder-meta">+${n(b.coins)} coins on promotion</div></div><span class="state ${tagCls}">${tag}</span></div>`;
      }).join('')}</div>`;
    }

    const recent=sh.recent||[];
    html+=`<div class="climb-history"><div class="chist-label">Coin activity</div>${recent.length?recent.map(e=>`<div class="history-row"><span>${new Date(e.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}</span><b>${esc(COIN_REASONS[e.reason_code]||String(e.reason_code||'').replace(/_/g,' ').toLowerCase())}</b><span>${e.amount>0?'+':''}${n(e.amount)}</span></div>`).join(''):'<div class="history-row"><span>&mdash;</span><b>No coins yet</b><span>Play a mini-game</span></div>'}</div>`;
  }
  el.innerHTML=html;
}
async function loadShop(){
  try{S.shop=await api('/shop');renderShop();updateSidebarAcct();updateTabCoinBadge()}catch(e){}
}

// Arcade runs earn XP: hand the game the session token via the URL hash (never
// sent to the server), and refresh XP + climb when the athlete comes back.
// Tiles the admin has locked (unlock flag explicitly false) render a lock
// overlay and drop their href so they cannot be opened, even by middle-click.
function linkGames(){
  const hash='#t='+encodeURIComponent(S.token||'')+'&p='+encodeURIComponent(PORTAL_SELF);
  document.querySelectorAll('#games a.gt').forEach(a=>{
    if(!a.dataset.gameUrl)a.dataset.gameUrl=a.href.split('#')[0];
    const id=a.dataset.gameId;
    const locked=!!(id&&S.unlocks&&S.unlocks[id]===false);
    a.classList.toggle('locked',locked);
    if(locked){a.removeAttribute('href');}
    else{a.href=a.dataset.gameUrl+hash;}
  });
  if(!linkGames._guard){
    linkGames._guard=true;
    $('games').addEventListener('click',e=>{
      const tile=e.target.closest('a.gt.locked');
      if(tile){e.preventDefault();toast('Game locked','Ask your admin to unlock');}
    },true);
  }
}
// Unlock state is read once per portal load; a failed fetch keeps tiles open.
async function loadUnlocks(){
  try{S.unlocks=await api('/games/unlocks')||{};}catch(e){S.unlocks=S.unlocks||{};}
  linkGames();
}
let lastXpRefresh=0;
async function refreshXp(){
  if(!S.token||Date.now()-lastXpRefresh<15000)return;
  lastXpRefresh=Date.now();
  try{
    const [progress,climb,shop]=await Promise.all([api('/progress'),api('/climb'),api('/shop').catch(()=>null)]);
    if(progress){S.athlete=progress;renderProfile()}
    if(climb){S.climb=climb;renderClimb()}
    if(shop)S.shop=shop;
    if(progress||shop){renderShop();updateSidebarAcct();updateTabCoinBadge()}
    // Back from a cabinet (games run in this tab, so the portal reloads): keep the arcade ladder honest.
    if(S.active==='games')loadArcade();
  }catch(e){}
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshXp()});

const ENDPOINTS=['/progress','/streak','/leaderboard','/climb','/ranks','/log?limit=300','/weekly-challenge','/orders','/commissions','/product-requests'];

async function attempt(path){
  try{
    const data=await api(path);
    return {path,ok:true,data};
  }catch(error){
    return {path,ok:false,error};
  }
}

function showAuthError(){
  sessionStorage.removeItem('ap_token');S.token=null;raceClose();
  $('loading').hidden=true;$('auth').hidden=false;
  $('dbgPanel').hidden=false;
  if(typeof resetOtpUI==='function')resetOtpUI();
}

async function loadPortal(){
  if($('dbgLog'))$('dbgLog').innerHTML='';
  dbg(`login start · token ${maskToken(S.token)}`);
  dbg(`API base ${API} · online: ${navigator.onLine}`);
  try{
    const results=await Promise.all(ENDPOINTS.map(attempt));
    const failed=results.filter(r=>!r.ok);
    if(failed.length){
      showAuthError();
      const okN=results.length-failed.length;
      dbg(`login failed — ${okN}/${results.length} endpoints OK · failed: ${failed.map(f=>f.path).join(', ')}`,'err');
      const netFail=failed.some(f=>f.error.network);
      const statuses=[...new Set(failed.map(f=>f.error.status).filter(Boolean))];
      const allFailed=failed.length===results.length;
      $('authError').textContent=
        netFail?'Cannot reach athlete API — check connection, server status or CORS.':
        statuses.includes(404)?'Athlete API routes missing on the server (404) — deployment issue.':
        allFailed&&statuses.includes(401)?'Token rejected — invalid, revoked or expired. Generate a new one in the admin portal.':
        `Login failed on: ${failed.map(f=>f.path).join(', ')}`;
      return;
    }
    const [progress,streak,board,climb,ranks,log,weekly,orders,commissions,productRequests]=results.map(r=>r.data);
    console.log('[Avatar] Progress data loaded:', progress?.avatar_base, progress?.avatar_head, progress?.avatar_mark, progress?.avatar_ground, progress?.avatar_frame);
    Object.assign(S,{athlete:progress,streak:streak?.current_streak||0,leaderboard:board||[],climb,ranks,log:log||[],weekly,orders:orders||[],commissions:commissions||null,productRequests:productRequests||[]});
    dbg('all endpoints OK — entering portal','ok');
    renderProfile();updateSidebarAcct();$('taskStreak').innerHTML=S.streak+'<s> days</s>';renderClimb();renderBoard();renderRanks();renderLog();renderShop();await loadTasks();enterPortal();
    // Render avatars in top bar buttons
    refreshAllAvatars();
    // Shop loads outside ENDPOINTS so a missing /shop route never blocks login.
    loadShop();
  }catch(e){
    showAuthError();
    dbg(`login crashed: ${e.message}`,'err');
    $('authError').textContent=e.message||'Login failed — see diagnostics below';
  }
}

document.addEventListener('DOMContentLoaded',()=>{
  makeField();flash();if(!reduce)setInterval(()=>flash(),3500);
  tick('taskClock',false);
  $('taskDate').textContent=new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'2-digit'}).format(new Date()).toUpperCase();
  const feed=[['@neha.runs','trained at a gym she had never been to'],['@smit.trains','asked a stranger to critique his squat'],['@dee.moves','submitted a reel'],['@kabir.lifts','reached a new comfort level'],['@the.late.lift','trained outside in the rain']];
  $('taskRail').innerHTML=[...feed,...feed].map(x=>`<span><b>${x[0]}</b> ${x[1]}</span>`).join('');
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.view)));
  $('sidebarToggle')?.addEventListener('click',()=>{$('sidebar').classList.toggle('collapsed')});
  // ── Mission dossier controls ──
  $('proofCheck').addEventListener('click',e=>{const b=e.target.closest('button[role="checkbox"]');if(b)toggleCheck(b)});
  $('briefToggle').addEventListener('click',()=>{
    const open=$('dossBrief').classList.toggle('open');
    $('briefToggle').setAttribute('aria-expanded',open?'true':'false');
    $('briefToggle').innerHTML=open?'Show less -':'Read full brief +';
  });
  $('briefCopy').addEventListener('click',async()=>{
    const t=focusTask();if(!t)return;
    toast(await copyText(briefTextFor(t))?'Brief copied':'Copy blocked — open the brief instead');
  });
  $('briefShare').addEventListener('click',async()=>{
    const t=focusTask();if(!t)return;
    const text=briefTextFor(t);
    if(navigator.share){
      try{await navigator.share({title:'OFFCOMFRT · '+(t.title||'Mission'),text});return}
      catch(e){if(e&&e.name==='AbortError')return}
    }
    toast(await copyText(text)?'Brief copied — paste it to yourself':'Sharing unavailable');
  });
  $('briefPool').addEventListener('click',()=>scrollToPool(S.focusId));
  const onLobbyClick=e=>{
    const j=e.target.closest('[data-join]');
    if(j&&!j.disabled){location.href=gameUrl('&r='+encodeURIComponent(j.dataset.join),j.dataset.game);return}
    const b=e.target.closest('[data-invite]');
    if(!b||b.disabled)return;
    const id=b.dataset.invite;
    S.invited.add(id);setTimeout(()=>{S.invited.delete(id);renderLobby()},10000);
    b.disabled=true;b.textContent='Sent \u2713';
    location.href=gameUrl('&inv='+encodeURIComponent(id));
    toast(`Race room opened — invite sent to ${b.dataset.name||'athlete'}`,'LIVE');
  };
  $('athleteList').addEventListener('click',onLobbyClick);
  $('raceLobbies').addEventListener('click',onLobbyClick);
  // ── Arcade ladder filters: a new window refetches the combined board ──
  $('arcPeriod').addEventListener('click',e=>{
    const b=e.target.closest('[data-arc]');
    if(!b||b.classList.contains('on'))return;
    document.querySelectorAll('#arcPeriod .arcchip').forEach(x=>x.classList.toggle('on',x===b));
    loadArcade(b.dataset.arc);
  });
  // ── Cabinet ladders: tap a card header to fold its top five open ──
  $('arcBoards').addEventListener('click',e=>{
    const b=e.target.closest('[data-gbtoggle]');
    if(!b)return;
    const slug=b.dataset.gbtoggle;
    if(S.gbOpen.has(slug))S.gbOpen.delete(slug);else S.gbOpen.add(slug);
    syncBoardsOpen();
  });
  $('gbExpandAll').addEventListener('click',()=>{
    const boards=S.arcade?.games||[];
    const expand=S.gbOpen.size<boards.length;
    S.gbOpen=new Set(expand?boards.map(b=>b.slug):[]);
    syncBoardsOpen();
  });
  // ── Login tab switching ──
  let otpPhone=null,otpResendTimer=null,otpExpiryTimer=null;
  $('authForm').onsubmit=e=>e.preventDefault();
  document.querySelectorAll('.login-tabs button').forEach(btn=>{
    btn.onclick=()=>{
      document.querySelectorAll('.login-tabs button').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.login-pane').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      const tab=btn.dataset.ltab;
      $(tab==='admin'?'paneAdmin':'paneAthlete').classList.add('active');
      $('authError').textContent='';
    };
  });

  // ── Athlete OTP flow ──
  function resetOtpUI(){
    $('otpStep1').style.display='block';
    $('otpStep2').style.display='none';
    $('otpTimer').textContent='';
    otpPhone=null;
    if(otpResendTimer)clearInterval(otpResendTimer);
    if(otpExpiryTimer)clearInterval(otpExpiryTimer);
  }

  $('sendOtpBtn').onclick=async()=>{
    $('authError').textContent='';
    const phone=$('athletePhone').value.trim();
    if(!phone){$('authError').textContent='Enter your mobile number';return}
    const btn=$('sendOtpBtn');
    btn.disabled=true;btn.textContent='Sending…';
    try{
      const r=await fetch(`${BASE}/api/athlete/otp/send`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({phone})
      });
      const data=await r.json();
      if(!r.ok)throw new Error(data.error||'Failed to send OTP');
      otpPhone=phone;
      dbg(`OTP sent via ${data.data?.via||'unknown'}`,'ok');
      $('otpStep1').style.display='none';
      $('otpStep2').style.display='block';
      $('otpInput').value='';$('otpInput').focus();
      // Resend cooldown timer
      let cooldown=data.data?.resendInSeconds||60;
      $('resendOtpBtn').disabled=true;
      $('resendOtpBtn').textContent=`Resend (${cooldown}s)`;
      if(otpResendTimer)clearInterval(otpResendTimer);
      otpResendTimer=setInterval(()=>{
        cooldown--;
        if(cooldown<=0){clearInterval(otpResendTimer);$('resendOtpBtn').disabled=false;$('resendOtpBtn').textContent='Resend'}
        else{$('resendOtpBtn').textContent=`Resend (${cooldown}s)`}
      },1000);
      // OTP expiry timer
      let expiry=data.data?.expiresInSeconds||300;
      const fmtTime=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
      $('otpTimer').textContent=`OTP expires in ${fmtTime(expiry)}`;
      if(otpExpiryTimer)clearInterval(otpExpiryTimer);
      otpExpiryTimer=setInterval(()=>{
        expiry--;
        if(expiry<=0){clearInterval(otpExpiryTimer);$('otpTimer').textContent='OTP expired — request a new one'}
        else{$('otpTimer').textContent=`OTP expires in ${fmtTime(expiry)}`}
      },1000);
      // Dev mode OTP display
      if(data.data?.devOtp){dbg(`[DEV] OTP code: ${data.data.devOtp}`,'ok')}
    }catch(e){
      $('authError').textContent=e.message||'Could not send OTP';
      dbg(`OTP send failed: ${e.message}`,'err');
    }finally{
      btn.disabled=false;btn.textContent='Send OTP';
    }
  };

  $('resendOtpBtn').onclick=()=>{
    $('otpStep2').style.display='none';
    $('otpStep1').style.display='block';
    $('sendOtpBtn').click();
  };

  $('verifyOtpBtn').onclick=async()=>{
    $('authError').textContent='';
    const otp=$('otpInput').value.trim();
    if(!otp||!otpPhone){$('authError').textContent='Enter the OTP first';return}
    const btn=$('verifyOtpBtn');
    btn.disabled=true;btn.textContent='Verifying…';
    try{
      const r=await fetch(`${BASE}/api/athlete/otp/verify`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({phone:otpPhone,otp})
      });
      const data=await r.json();
      if(!r.ok)throw new Error(data.error||'Verification failed');
      S.token=data.data.token;
      dbg(`OTP verified — athlete: ${data.data.athlete?.name||'unknown'}`,'ok');
      sessionStorage.setItem('ap_token',S.token);
      $('auth').hidden=true;$('loading').hidden=false;
      $('dbgPanel').hidden=false;
      loadPortal();
    }catch(e){
      $('authError').textContent=e.message||'Verification failed';
      dbg(`OTP verify failed: ${e.message}`,'err');
    }finally{
      btn.disabled=false;btn.textContent='Verify & enter portal';
    }
  };

  // ── Admin login-as-athlete ──
  $('adminLoginBtn').onclick=async()=>{
    $('authError').textContent='';
    const phone=$('adminPhone').value.trim();
    const password=$('adminPassword').value;
    if(!phone||!password){$('authError').textContent='Enter mobile number and admin password';return}
    const btn=$('adminLoginBtn');
    btn.disabled=true;btn.textContent='Logging in…';
    try{
      const r=await fetch(`${BASE}/api/athlete-admin/login-as-athlete`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({phone,password})
      });
      const data=await r.json();
      if(!r.ok)throw new Error(data.error||'Admin login failed');
      S.token=data.data.token;
      dbg(`Admin login as athlete: ${data.data.athlete?.name||'unknown'}`,'ok');
      sessionStorage.setItem('ap_token',S.token);
      $('auth').hidden=true;$('loading').hidden=false;
      $('dbgPanel').hidden=false;
      loadPortal();
    }catch(e){
      $('authError').textContent=e.message||'Admin login failed';
      dbg(`Admin login failed: ${e.message}`,'err');
    }finally{
      btn.disabled=false;btn.textContent='Login as athlete';
    }
  };
  $('dbgRetry').onclick=()=>{
    if(!S.token){$('authError').textContent='Log in first using the form above.';return}
    $('auth').hidden=true;$('loading').hidden=false;
    loadPortal();
  };
  $('dbgCopy').onclick=async()=>{
    const diag=['Athlete portal diagnostics — '+new Date().toISOString(),
      `API: ${API}`,`Token: ${maskToken(S.token||sessionStorage.getItem('ap_token')||'')}`,
      `Online: ${navigator.onLine}`,`UA: ${navigator.userAgent}`,'',...DBG.map(d=>d.line)].join('\n');
    try{await navigator.clipboard.writeText(diag);dbg('diagnostics copied to clipboard','ok')}
    catch(err){
      const ta=document.createElement('textarea');ta.value=diag;document.body.appendChild(ta);ta.select();
      try{document.execCommand('copy');dbg('diagnostics copied','ok')}catch(copyErr){dbg('copy failed — read from panel','err')}
      ta.remove();
    }
  };
  $('closeSheet').onclick=()=>$('sheet').classList.remove('open');
  $('submitProof').onclick=submitProof;
  $('proofCaption').addEventListener('input',function(){$('captionCount').textContent=Math.min(220,this.value.length)});
  $('closePrSheet').onclick=closeProductRequest;
  $('submitPr').onclick=submitProductRequest;
  $('productSearch').addEventListener('input',function(){renderProductGrid(this.value)});
  // Avatar sheet
  $('avScrim').onclick=closeAvSheet;
  $('avClose').onclick=closeAvSheet;
  document.addEventListener('click',e=>{if(e.target.closest('.avbtn'))openAvSheet()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('avSheet').classList.contains('on'))closeAvSheet()});
  // Banner click
  $('pickbanner').onclick=()=>toast('Opens the pick menu','push');
  // Register service worker for PWA
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('https://exchange-return-tracking.onrender.com/sw.js').catch(()=>{});
  }

  dbg('portal page loaded');
  const saved=sessionStorage.getItem('ap_token');
  if(saved){dbg(`saved token found · ${maskToken(saved)}`);S.token=saved;loadPortal()}
  else{$('loading').hidden=true;$('auth').hidden=false;dbg('no saved token — auth screen')}
});
