const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// User-supplied text (names, notes, places) is marked so the interface language never rewrites it.
const uc=v=>`<span data-i18n-skip>${esc(v)}</span>`;
let tok=localStorage.getItem('tok'),S=null,viewId=0,demoEnabled=false;const $=s=>document.querySelector(s),open=new Set();
const configReady=fetch('/api/config').then(r=>r.ok?r.json():null).then(c=>{demoEnabled=!!(c&&c.demoEnabled===true)}).catch(()=>{demoEnabled=false});
const live=el=>!!(el&&el.isConnected),setText=(el,v)=>{if(live(el))el.textContent=v};
async function api(path,method='GET',body){
  const used=tok,h={};if(used)h.Authorization='Bearer '+used;
  if(typeof body==='string')h['Content-Type']='text/plain';else if(body&&!(body instanceof FormData)){h['Content-Type']='application/json';body=JSON.stringify(body)}
  const r=await fetch('/api'+path,{method,headers:h,body}),d=await r.json().catch(()=>({}));
  if(!r.ok){
    if(r.status===401&&d.code==='unauthenticated'){if(tok===used)endSession();throw new Error('Your session has ended. Please log in again.')}
    throw new Error(d.error||'Something went wrong. Please try again.');
  }
  return d}
async function apiPage(path,method='GET',body){
  const used=tok,h={};if(used)h.Authorization='Bearer '+used;
  if(body&&!(body instanceof FormData)){h['Content-Type']='application/json';body=JSON.stringify(body)}
  const r=await fetch('/api'+path,{method,headers:h,body}),d=await r.json().catch(()=>({}));
  if(!r.ok){
    if(r.status===401&&d.code==='unauthenticated'){if(tok===used)endSession();throw new Error('Your session has ended. Please log in again.')}
    throw new Error(d.error||'Something went wrong. Please try again.');
  }
  return {data:d,total:Number(r.headers.get('X-Total-Count'))||0};}
const mediaCache=new Map(),mediaBlobs=new Set();
function clearMedia(){for(const u of mediaBlobs)URL.revokeObjectURL(u);mediaBlobs.clear();mediaCache.clear()}
function clearPrivateUI(){
  S=null;viewId++;clearMedia();open.clear();
  const q=$('#q'),res=$('#res');if(q)q.value='';if(res)res.innerHTML='';
  const title=$('#title');if(title)title.textContent='Family Tree';
}
function goHome(){if((location.hash||'#/')==='#/')route();else location.hash='#/'}
function endSession(){tok=null;try{localStorage.removeItem('tok')}catch{}clearPrivateUI();goHome()}
function signedIn(d){
  tok=d.token;try{localStorage.setItem('tok',tok)}catch{}clearPrivateUI();
  // If someone followed an invitation while signed out, finish that journey instead of dropping the link.
  let inv=null;try{inv=sessionStorage.getItem('inviteToken')}catch{}
  const want=inv?'#/invite?token='+encodeURIComponent(inv):'#/';
  if((location.hash||'#/')===want)route();else location.hash=want;
}
function mediaURL(path){
  const used=tok;
  if(!mediaCache.has(path))mediaCache.set(path,fetch(path,{headers:used?{Authorization:'Bearer '+used}:{}}).then(r=>{
    if(r.status===401&&tok===used)endSession();
    if(!r.ok)throw new Error('Media not available.');
    return r.blob();
  }).then(b=>{const u=URL.createObjectURL(b);mediaBlobs.add(u);return u}).catch(e=>{mediaCache.delete(path);throw e}));
  return mediaCache.get(path);
}
const hydrateEl=async el=>{
  if(!el||el.nodeType!==1||el.dataset.hydrated)return;
  const path=el.dataset.photo||el.dataset.media||el.dataset.mediaLink;
  if(!path)return;
  el.dataset.hydrated='1';
  try{const u=await mediaURL(path);if(!live(el))return;if(el.dataset.photo)el.style.backgroundImage=`url("${u}")`;else if(el.dataset.media)el.src=u;else el.href=u}catch{}
};
const hydrateMedia=root=>{if(!root||root.nodeType!==1)return;hydrateEl(root);root.querySelectorAll&&root.querySelectorAll('[data-photo],[data-media],[data-media-link]').forEach(hydrateEl)};
new MutationObserver(ms=>{for(const m of ms)for(const n of m.addedNodes)if(n.nodeType===1)hydrateMedia(n)}).observe(document.body,{childList:true,subtree:true});
const byId=id=>S.people.find(p=>p.id==id),margs=id=>S.marriages.filter(m=>m.a_id==id||m.b_id==id);
const mate=(m,id)=>byId(m.a_id==id?m.b_id:m.a_id),kidsOfM=m=>S.people.filter(p=>p.parent_marriage_id==m.id),kidsOf=id=>margs(id).flatMap(kidsOfM);
const KL={married:'Married',partner:'Partners',divorced:'Divorced',separated:'Separated',single:'Single parent'};
const mlabel=m=>{const k=m.kind||'married';
  if(k==='divorced')return m.year?`Married ${m.year}, divorced${m.end_year?' '+m.end_year:''}`:`Divorced${m.end_year?' '+m.end_year:''}`;
  if(k==='single')return 'Single parent'+(m.year?' '+m.year:'');
  return (KL[k]||'Married')+(m.year?' '+m.year:'');};
const ksub=k=>life(k)+(k.parent_kind&&k.parent_kind!=='biological'?', '+k.parent_kind:'');
const unionEvent=(m,id)=>{const other=mate(m,id),n=other?uc(other.name):'',k=m.kind||'married',when=m.year?' '+m.year:'';
  if(k==='single')return 'Single parent family'+when;
  if(k==='divorced')return 'Divorced from '+n+when+(m.end_year?' ('+m.end_year+')':'');
  if(k==='separated')return 'Separated from '+n+when;
  if(k==='partner')return 'Partners with '+n+when;
  return 'Married '+n+when;};
const sel=(n,opts,v)=>`<select name="${n}">${opts.map(([k,t])=>`<option value="${k}" ${(v||opts[0][0])===k?'selected':''}>${t}</option>`).join('')}</select>`;
const recURL=p=>{const w=p.name.trim().split(/\s+/),sur=w.length>1?w.pop():'',y=(p.dob||'').slice(0,4),u=new URLSearchParams({'q.givenName':w.join(' '),'q.surname':sur});if(/^\d{4}$/.test(y)){u.set('q.birthLikeDate.from',y);u.set('q.birthLikeDate.to',y)}return 'https://www.familysearch.org/search/record/results?'+u};

// Icons are inline so the interface stays crisp and dependency-free.
const ICONS={
  tree:'<path d="M12 21v-6"/><path d="M12 15c-3.3 0-6-2.2-6-5 0-2 1.3-3.7 3.2-4.5C9.6 3.9 10.7 3 12 3s2.4.9 2.8 2.5C16.7 6.3 18 8 18 10c0 2.8-2.7 5-6 5z"/>',
  trees:'<path d="M12 4v16"/><path d="M8.5 7.5C9.6 6.4 10.7 6 12 6s2.4.4 3.5 1.5"/><path d="M8.5 12c1.1-1.1 2.2-1.5 3.5-1.5s2.4.4 3.5 1.5"/><path d="M8.5 16.5c1.1-1.1 2.2-1.5 3.5-1.5s2.4.4 3.5 1.5"/>',
  chart:'<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M5 16v-2h14v2"/>',
  gc:'<circle cx="9" cy="7" r="3"/><circle cx="17" cy="9" r="2.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M15.5 20c0-2.3 1.3-4.3 3.3-5"/>',
  insights:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  history:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  tidy:'<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  share:'<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.3 10.8l7.4-3.6M8.3 13.2l7.4 3.6"/>',
  account:'<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c0-3.6 3.4-6.5 7.5-6.5s7.5 2.9 7.5 6.5"/>',
  logout:'<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  login:'<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  chevron:'<path d="M9 6l6 6-6 6"/>',
  down:'<path d="M6 9l6 6 6-6"/>',
  camera:'<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  book:'<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v18H6.5A2.5 2.5 0 0 1 4 18.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v18h4.5A2.5 2.5 0 0 0 20 18.5z"/>',
  shield:'<path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  edit:'<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  print:'<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="1"/><path d="M6 17h12v4H6z"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  download:'<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  upload:'<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M4 4h16"/>',
  heart:'<path d="M12 20s-7-4.5-7-9.5A3.5 3.5 0 0 1 12 8a3.5 3.5 0 0 1 7 2.5C19 15.5 12 20 12 20z"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  location:'<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 20c0-2.6-1.2-4.9-3-6.3"/>',
  person:'<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/>',
  check:'<path d="M5 12l5 5L20 7"/>',
  alert:'<path d="M12 3l9 17H3z"/><path d="M12 9v5M12 17h.01"/>',
  relation:'<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.5 6h7M7.5 8.2l3.2 7.3M16.5 8.2l-3.2 7.3"/>'
};
const ico=(n,cls='')=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${cls?` class="${cls}"`:''}>${ICONS[n]||''}</svg>`;
const LOGO=`<span class="logo" aria-hidden="true">${ico('tree')}</span>`;

const setCrumbs=items=>{const el=$('#crumbs');if(!el)return;const list=(items||[]).filter(Boolean);
  el.innerHTML=list.map((it,i)=>i===list.length-1?`<span class="current" aria-current="page">${esc(it[1])}</span>`:`<a href="${it[0]}">${esc(it[1])}</a><span class="sep" aria-hidden="true">/</span>`).join('')};
const treeCrumbs=leaf=>{if(!S)return setCrumbs([['#/','My trees']]);
  setCrumbs([['#/','Family Tree'],['#/t/'+S.tree.id,S.tree.name],...(leaf?[[null,leaf]]:[])].filter(Boolean))};
const setAuthMode=on=>{document.body.classList.toggle('auth-mode',!!on);if(on)setCrumbs([])};

const COL=['#EADFCF','#DCE6DB','#DCE3EC','#E9D9D5','#E3DDEB','#EDE6CE'];
const av=(p,s)=>`<div class="av ${p.dod?'gone':''}" data-i18n-skip style="--s:${s}px;${p.photo?'':`background-color:${COL[p.id%6]}`}"${p.photo?` data-photo="/api/people/${p.id}/photo"`:''}>${p.photo?'':esc(p.name.split(' ').map(w=>w[0]).join('').slice(0,3))}</div>`;
const life=p=>p.dod?`${p.dob?yr(p.dob,p.dob_q):'?'} to ${p.dod==='unknown'?'?':yr(p.dod,p.dod_q)}`:(p.dob?`Born ${yr(p.dob,p.dob_q)}`:'Birth date not known');
const Q={about:'About ',before:'Before ',after:'After '},MN=['January','February','March','April','May','June','July','August','September','October','November','December'];
const mon=m=>new Date(Date.UTC(2000,m-1,1)).toLocaleString(document.documentElement.lang||'en',{month:'long',timeZone:'UTC'});
const fmt=(d,q)=>{if(!d)return 'Not known';if(d==='unknown')return 'Date not known';const[y,m,dd]=d.split('-');return (Q[q]||'')+(dd?+dd+' ':'')+(m?mon(m)+' ':'')+y};
const yr=(d,q)=>(Q[q]?Q[q].toLowerCase():'')+d.slice(0,4);
const ageTxt=p=>p.age==null?'Not known':(p.dob_q||p.dod_q?'About ':'')+p.age;
const qsel=(n,v)=>`<select name="${n}" aria-label="How exact is this date">${[['','Exact'],['about','About'],['before','Before'],['after','After']].map(([k,t])=>`<option value="${k}" ${(v||'')===k?'selected':''}>${t}</option>`).join('')}</select>`;
const card=(p,sub)=>`<a class="person" href="#/t/${S.tree.id}/p/${p.id}">${av(p,44)}<span class="person-info" data-i18n-skip><b>${esc(p.name)}</b><small>${esc(sub)}</small></span>${ico('chevron','person-chevron')}</a>`;

const nav=items=>{
  const el=$('#nav');if(!el)return;
  el.innerHTML=items.map(it=>{
    if(it[0]==='sep')return '<div class="nav-sep" role="separator"></div>';
    const[h,t,c,ic]=it;
    return h?`<a class="nav-item${c?' is-active':''}" href="${h}"${c?' aria-current="page"':''}>${ico(ic||'tree')}<span>${esc(t)}</span></a>`
      :`<button class="nav-item nav-logout" id="out" type="button">${ico(ic||'logout')}<span>${esc(t)}</span></button>`;
  }).join('');
  const o=$('#out');if(o)o.onclick=()=>endSession();
  const c=el.querySelector('[aria-current="page"]');if(c&&c.scrollIntoView)c.scrollIntoView({block:'nearest'});
};

// ---- Signed-out screens ----
function authShell(title,lead,inner,links=''){
  return `<div class="auth-page">
    <section class="auth-visual">
      <a class="auth-brand" href="#/">${LOGO}<b>Family Tree</b></a>
      <div class="auth-copy">
        <span class="eyebrow">A private family archive</span>
        <h1>Every family has a story worth keeping.</h1>
        <p>Record the people, relationships and memories that shaped your family — together, in one calm and private place.</p>
      </div>
      <ul class="auth-points">
        <li>${ico('shield')}<span>Private by default. Your family's data stays yours.</span></li>
        <li>${ico('trees')}<span>Build a tree that grows in every direction.</span></li>
        <li>${ico('book')}<span>Keep photos, documents and stories beside each person.</span></li>
      </ul>
    </section>
    <section class="auth-form-wrap">
      <div class="auth-card">
        <div class="auth-card-head"><h2>${title}</h2><p>${lead}</p></div>
        ${inner}
        ${links?`<div class="auth-links">${links}</div>`:''}
        <div class="auth-foot">Family Tree · A private family history workspace</div>
      </div>
    </section>
  </div>`;
}
function authView(mode='login'){
  const demo=demoEnabled?'<p class="auth-demo">Try the demo: demo@family.test and demo1234.</p>':'';
  const form=mode==='login'?`${demo}
    <form id="af" novalidate>
      <div class="field"><label class="field-label" for="af-email">Email</label><input id="af-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
      <div class="field"><label class="field-label" for="af-password">Password</label><input id="af-password" name="password" type="password" minlength="8" required autocomplete="current-password"></div>
      <div class="err" id="err"></div>
      <button class="btn pri btn-block">Log in</button>
    </form>`
    :`<form id="af" novalidate>
      <div class="field"><label class="field-label" for="af-name">Your name</label><input id="af-name" name="name" required autocomplete="name"></div>
      <div class="field"><label class="field-label" for="af-email">Email</label><input id="af-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
      <div class="field"><label class="field-label" for="af-password">Password</label><input id="af-password" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <div class="err" id="err"></div>
      <button class="btn pri btn-block">Create account</button>
    </form>`;
  const links=mode==='login'?'<a href="#/register">Create an account</a><a href="#/forgot">Forgot your password?</a>':'<a href="#/">I already have an account</a>';
  $('#app').innerHTML=authShell(mode==='login'?'Welcome back':'Start your family tree',mode==='login'?'Log in to open your family trees.':'Create a free account and add your first person.',form,links);
  $('#af').onsubmit=async e=>{e.preventDefault();const err=$('#err');try{const d=await api('/auth/'+mode,'POST',Object.fromEntries(new FormData(e.target)));signedIn(d)}catch(x){setText(err,x.message)}};
}

// ---- Home ----
async function home(){
  if(!tok)return authView(location.hash==='#/register'?'register':'login');
  const vid=viewId,ts=await api('/trees');
  if(vid!==viewId)return;
  setCrumbs([['#/','My trees']]);
  const initial=name=>{const n=(name||'?').trim();return esc(n.charAt(0).toUpperCase()||'?')};
  const count=t=>typeof t.people==='number'?`<span>${t.people} ${t.people===1?'person':'people'}</span>`:'';
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group">
      <span class="eyebrow">Workspace</span>
      <h2 class="page-title">My Family Trees</h2>
      <p class="page-subtitle">Manage and explore your family histories in one place.</p>
    </div>
    <div class="page-actions">
      <button class="btn pri" id="newtree" type="button">${ico('plus')}Create family tree</button>
    </div>
  </div>
  ${ts.length?`<div class="tree-grid">
    ${ts.map(t=>`<a class="tree-card" href="#/t/${t.id}">
      <span class="tree-monogram" aria-hidden="true">${initial(t.name)}</span>
      <span class="tree-card-main">
        <span class="tree-card-title" data-i18n-skip>${esc(t.name)}</span>
        <span class="tree-card-meta">${t.role==='owner'?'<span class="badge owner">Owner</span>':`<span class="badge editor">${esc(t.role)}</span><span>Shared with you as ${esc(t.role)}</span>`}${count(t)}</span>
      </span>
      <span class="tree-card-link">View ${ico('chevron')}</span>
    </a>`).join('')}
  </div>`:`<div class="empty-state">
    <span class="empty-icon">${ico('trees')}</span>
    <h3>No family trees yet</h3>
    <p>Start preserving your family history by creating your first family tree below.</p>
  </div>`}
  <div class="home-tools">
    <section class="form-card">
      <div class="form-card-header"><h3 class="form-card-title">Create a family tree</h3><div class="form-card-sub">Name the tree and add the first person in it.</div></div>
      <form class="form-card-body" id="nf">
        <div class="form-section">
          <div class="form-section-title">Tree details</div>
          <div class="field"><label class="field-label" for="nf-name">Tree name</label><input id="nf-name" name="name" required placeholder="The Okafor Family"></div>
        </div>
        <div class="form-section">
          <div class="form-section-title">Start with a person</div>
          <div class="field"><label class="field-label" for="nf-rname">Full name</label><input id="nf-rname" name="rname" required></div>
          <div class="form-grid">
            <div class="field"><label class="field-label" for="nf-rgender">Gender</label><select id="nf-rgender" name="rgender"><option>Male</option><option>Female</option><option>Other</option></select></div>
            <div class="field"><label class="field-label" for="nf-rdob">Date of birth</label><input id="nf-rdob" name="rdob" required pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" placeholder="1932-03-04 or 1932"></div>
            <div class="field"><label class="field-label" for="nf-rdod">Date of death (leave empty if alive)</label><input id="nf-rdod" name="rdod" pattern="(\\d{4}(-\\d{2}(-\\d{2})?)?|unknown)" placeholder="2011-09-17 or 2011"></div>
          </div>
        </div>
        <div class="form-actions"><button class="btn pri">Create family tree</button></div>
        <div class="err" id="err"></div>
      </form>
    </section>
    <section class="form-card">
      <div class="form-card-header"><h3 class="form-card-title">Import from another app</h3><div class="form-card-sub">Bring a GEDCOM file into a new tree.</div></div>
      <form class="form-card-body" id="gf">
        <div class="field"><label class="field-label" for="gf-name">Tree name</label><input id="gf-name" name="name" required></div>
        <div class="field"><label class="field-label" for="gf-file">GEDCOM file (.ged)</label><input id="gf-file" name="file" type="file" accept=".ged,text/plain" required><div class="field-hint">Supports standard GEDCOM exports.</div></div>
        <div class="form-actions"><button class="btn">Import tree</button></div>
        <div class="err" id="eg"></div>
      </form>
    </section>
  </div>`;
  const nt=$('#newtree');if(nt)nt.onclick=()=>{const f=$('#nf-name');if(f){f.scrollIntoView({behavior:'smooth',block:'center'});f.focus({preventScroll:true})}};
  $('#gf').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),err=$('#eg'),vid=viewId;try{const d=await api('/trees/import?name='+encodeURIComponent(f.get('name')),'POST',await f.get('file').text());if(vid===viewId)location.hash='#/t/'+d.id}catch(x){setText(err,x.message)}};
  $('#nf').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),err=$('#err'),vid=viewId;
    try{const d=await api('/trees','POST',{name:f.name,root:{name:f.rname,gender:f.rgender,dob:f.rdob,dod:f.rdod}});if(vid===viewId)location.hash='#/t/'+d.id}catch(x){setText(err,x.message)}}}


// ---- Tree views ----
const tabs=(id,cur)=>[
  ['#/','My trees',cur==='home','trees'],
  ['#/t/'+id,'Family tree',cur==='t','tree'],
  ['#/t/'+id+'/chart','Chart',cur==='chart','chart'],
  ['#/t/'+id+'/gc','Grandchildren',cur==='gc','gc'],
  ['#/t/'+id+'/insights','Insights',cur==='insights','insights']
];

function treeView(){
  const root=byId(S.tree.root_id),bs=margs(root.id),tid=S.tree.id;
  $('#title').textContent=S.tree.name;
  treeCrumbs('Family tree');
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group">
      <span class="eyebrow" data-i18n-skip>${esc(S.tree.name)}</span>
      <h2>Where our family begins</h2>
      <p class="page-subtitle">Tap anyone to see their story. Open a branch to meet the children.</p>
    </div>
    ${S.canEdit?`<div class="page-actions">
      ${S.role==='owner'?`<button class="btn" id="rn" type="button">${ico('edit')}Rename tree</button>`:''}
      <a class="btn pri" href="#/t/${tid}/new?s=${root.id}">${ico('plus')}Add a spouse</a>
    </div>`:''}
  </div>
  <div class="tree-toolbar">
    <div class="legend"><span><i class="alive"></i>Living</span><span><i class="gone"></i>Deceased</span></div>
    <span>${S.total} ${S.total===1?'person':'people'} in this tree</span>
  </div>
  <div class="tree-canvas">
    <div class="tree">
      <span class="generation-label">Generation one</span>
      <div class="tree-focus">${card(root,life(root))}</div>
      <div class="tree-stem"></div>
      ${bs.length?`<div class="branches">
        ${bs.map(m=>{
          const sp=mate(m,root.id),ks=kidsOfM(m),o=open.has(m.id);
          return `<section class="branch">
            <span class="heart">♥ ${mlabel(m)}</span>
            <div class="branch-person">${sp?card(sp,life(sp)):'<span class="empty-note">Single parent</span>'}</div>
            <div class="branch-actions">
              ${ks.length?`<button class="more" data-t="${m.id}" aria-expanded="${o}" type="button">${o?'Hide':'Meet'} ${ks.length} ${ks.length>1?'children':'child'}${ico('down')}</button>`:`<span class="empty-note">No children yet</span>`}
              ${S.canEdit?`<a class="btn btn-sm" href="#/t/${tid}/new?m=${m.id}">${ico('plus')}Add a child</a>`:''}
            </div>
            ${ks.length?`<div class="kids" ${o?'':'hidden'}>${ks.map(k=>card(k,ksub(k))).join('')}</div>`:''}
          </section>`;
        }).join('')}
      </div>`:`<div class="empty-state" style="width:100%;margin-top:6px">
        <span class="empty-icon">${ico('relation')}</span>
        <h3>No branches yet</h3>
        <p>Add a spouse to begin the next generation of this family tree.</p>
      </div>`}
    </div>
  </div>`;
  document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{const k=+b.dataset.t;open.has(k)?open.delete(k):open.add(k);treeView()});
  const rn=$('#rn');
  if(rn)rn.onclick=async()=>{
    const n=prompt('New name for this tree',S.tree.name),vid=viewId;
    if(n)try{await api('/trees/'+S.tree.id,'PATCH',{name:n});if(vid!==viewId)return;await load(S.tree.id);if(vid===viewId)treeView()}catch(x){alert(x.message)}
  };
}

function grandView(){
  const root=byId(S.tree.root_id),kids=kidsOf(root.id).filter(k=>kidsOf(k.id).length);
  treeCrumbs('Grandchildren');
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group">
      <span class="eyebrow" data-i18n-skip>${esc(S.tree.name)}</span>
      <h2>The grandchildren</h2>
      <p class="page-subtitle">Grouped by their parents. Tap a card to open their page.</p>
    </div>
  </div>`+
  (kids.length?kids.map(p=>`<section class="group">
    <div class="group-head"><h3>Children of ${uc(p.name)}</h3><span class="badge editor">${kidsOf(p.id).length} ${kidsOf(p.id).length===1?'grandchild':'grandchildren'}</span></div>
    <div class="person-grid">${kidsOf(p.id).map(k=>card(k,(k.age==null?'Age not known':'Age '+k.age))).join('')}</div>
  </section>`).join(''):`<div class="empty-state">
    <span class="empty-icon">${ico('gc')}</span>
    <h3>No grandchildren have been added yet.</h3>
    <p>Add children and then add their children to see the next generation here.</p>
  </div>`);
}

function personView(id){
  const p=byId(id);if(!p)return $('#app').innerHTML='<div class="page"><div class="empty-state"><h2>We could not find that person.</h2><p>They may have been removed from this tree.</p></div></div>';
  const f=(a,b)=>`<div class="fact"><span>${a}</span><b data-i18n-skip>${esc(b)}</b></div>`;
  const ms=margs(p.id),ks=kidsOf(p.id),tid=S.tree.id,pm=S.marriages.find(x=>x.id==p.parent_marriage_id),pars=pm?[byId(pm.a_id),byId(pm.b_id)].filter(Boolean):[];
  const first=p.name.trim().split(/\s+/)[0];
  treeCrumbs(p.name);

  const events=[];
  if(p.dob)events.push([ico('calendar'),'Born',esc(fmt(p.dob,p.dob_q))+(p.birth_place?` in ${uc(p.birth_place)}`:''),'']);
  ms.forEach(m=>events.push([ico('heart'),unionEvent(m,p.id),m.end_year?', ended '+m.end_year:'','']));
  if(p.dod)events.push([ico('book'),'Passed away',esc(fmt(p.dod,p.dod_q))+(p.death_place?` in ${uc(p.death_place)}`:''),'']);
  const timeline=events.length?`<ol class="timeline">${events.map(e=>`<li class="timeline-item"><span class="timeline-dot">${e[0]}</span><div class="timeline-body"><b>${e[1]}</b><p>${e[2]}</p>${e[3]?`<span class="timeline-meta">${e[3]}</span>`:''}</div></li>`).join('')}</ol>`:'<p class="hint">No dates have been recorded yet.</p>';

  $('#app').innerHTML=`<div class="page">
    <div class="profile-topbar"><a class="back" href="#/t/${tid}" data-back>Back</a><span class="profile-ref" data-i18n-skip>${esc(S.tree.name)}</span></div>
    <section class="hero profile-hero">
      <div class="profile-avatar">
        ${av(p,116)}
        ${S.canEdit?`<label class="photo-label" title="Add a photo">${ico('camera')}<span>Add a photo</span><input type="file" accept="image/*" id="ph" hidden></label>`:''}
      </div>
      <div class="profile-identity">
        <span class="eyebrow">Person profile</span>
        <h2>${uc(p.name)}</h2>
        <p class="profile-lifespan" data-i18n-skip>${esc(life(p))}</p>
        <div class="profile-tags"><span class="tag ${p.dod?'gone':''}">${p.status}</span>${p.gender?`<span class="tag neutral">${esc(p.gender)}</span>`:''}${ms.length?`<span class="tag neutral">${ms.length} ${ms.length===1?'spouse':'spouses'}</span>`:''}${ks.length?`<span class="tag neutral">${ks.length} ${ks.length===1?'child':'children'}</span>`:''}</div>
      </div>
      <div class="profile-quick-actions">
        <a class="btn" href="#/t/${tid}/ped/${p.id}">See ancestors</a>
        <button class="btn" data-print type="button">Print</button>
        ${S.canEdit&&p.photo?'<button class="btn" id="rmphoto" type="button">Remove photo</button>':''}
        ${S.canEdit?`<a class="btn pri" href="#/t/${tid}/edit/${p.id}">Edit details</a>`:''}
      </div>
    </section>
    <div class="profile-grid">
      <div class="profile-main">
        <section class="panel profile-section">
          <div class="panel-head"><h3 class="section-title">Life details</h3></div>
          <div class="panel-body">
            <div class="facts">
              ${f('Gender',p.gender||'Not set')}
              ${f('Age',ageTxt(p)+(p.dod&&p.age!=null?' when they passed':''))}
              ${f('Born',fmt(p.dob,p.dob_q))}
              ${f('Passed away',p.dod?fmt(p.dod,p.dod_q):'Not applicable')}
              ${f('Married',ms.length?'Yes':'No')}
              ${f('Spouses',ms.length)}
              ${f('Children',ks.length)}
              ${p.birth_place?f('Born in',p.birth_place):''}
              ${p.death_place?f('Place of death',p.death_place):''}
            </div>
          </div>
        </section>
        ${p.notes?`<section class="panel profile-section"><div class="panel-head"><h3 class="section-title">About ${uc(first)}</h3></div><div class="panel-body"><p class="notes" data-i18n-skip>${esc(p.notes)}</p></div></section>`:''}
        ${pars.length?`<section class="panel profile-section"><div class="panel-head"><h3 class="section-title">Parents</h3></div><div class="panel-body"><div class="relation-grid">${pars.map(x=>card(x,life(x))).join('')}</div></div></section>`:''}
        ${ms.filter(m=>mate(m,p.id)).length?`<section class="panel profile-section"><div class="panel-head"><h3 class="section-title">Spouse${ms.filter(m=>mate(m,p.id)).length>1?'s':''}</h3></div><div class="panel-body"><div class="relation-grid">${ms.filter(m=>mate(m,p.id)).map(m=>card(mate(m,p.id),mlabel(m))).join('')}</div></div></section>`:''}
        ${ks.length?`<section class="panel profile-section"><div class="panel-head"><h3 class="section-title">Children</h3></div><div class="panel-body"><div class="relation-grid">${ks.map(k=>card(k,ksub(k))).join('')}</div></div></section>`:''}
        <section class="panel profile-section">
          <div class="panel-head"><h3 class="section-title">How are we related?</h3></div>
          <div class="panel-body">
            <div class="relbox">
              <input id="rq" type="search" autocomplete="off" placeholder="Type a name to compare with ${esc(first)}" aria-label="Find a person to compare">
              <div id="rres"></div>
              <p id="rtxt" class="hint" aria-live="polite"></p>
            </div>
          </div>
        </section>
        <div id="att"></div>
        <div id="rel"></div>
      </div>
      <aside class="profile-side">
        <section class="panel profile-section">
          <div class="panel-head"><h3 class="section-title">Timeline</h3></div>
          <div class="panel-body">${timeline}</div>
        </section>
        <section class="panel profile-section">
          <div class="panel-head"><h3 class="section-title">Actions</h3></div>
          <div class="panel-body">
            <div class="action-list">
              <a class="btn" href="${esc(recURL(p))}" target="_blank" rel="noopener">Search records on FamilySearch</a>
              ${S.canEdit&&!p.parent_marriage_id?`<a class="btn" href="#/t/${tid}/new?parents=${p.id}">Add parents</a>`:''}
              ${S.canEdit&&p.parent_marriage_id?`<a class="btn" href="#/t/${tid}/new?parents=${p.id}">Change or remove parents</a>`:''}
              ${S.role==='owner'&&S.tree.root_id!=p.id?'<button class="btn" id="mkroot" type="button">Start the tree from here</button>':''}
              ${S.canEdit?`<a class="btn" href="#/t/${tid}/new?s=${p.id}">Add a spouse</a>`:''}
              ${S.canEdit?ms.filter(m=>mate(m,p.id)).map(m=>`<a class="btn" href="#/t/${tid}/marriage/${m.id}">Edit relationship with ${uc(mate(m,p.id).name)}</a>`).join(''):''}
              ${S.canEdit?ms.map(m=>`<a class="btn" href="#/t/${tid}/new?m=${m.id}">${mate(m,p.id)?`Add a child with ${uc(mate(m,p.id).name)}`:'Add a child'}</a>`).join(''):''}
              ${S.canEdit?'<button class="btn del" id="rm" type="button">Remove</button>':''}
            </div>
          </div>
        </section>
      </aside>
    </div>
  </div>`;

  const relEl=$('#rel');
  api('/people/'+p.id+'/relatives').then(r=>{const g=a=>Math.max(...a.map(x=>x.gen)),A=r.ancestors,D=r.descendants;
    if(live(relEl)&&(A.length||D.length))relEl.innerHTML=`<section class="panel profile-section"><div class="panel-head"><h3 class="section-title">Family line</h3></div><div class="panel-body"><p class="insight-copy">${A.length?`${A.length} ancestor${A.length>1?'s':''} going back ${g(A)} generation${g(A)>1?'s':''}. `:''}${D.length?`${D.length} descendant${D.length>1?'s':''} across ${g(D)} generation${g(D)>1?'s':''}.`:''}</p></div></section>`}).catch(()=>{});

  let rt;const rbox=$('#rres'),rtxt=$('#rtxt');
  $('#rq').oninput=e=>{clearTimeout(rt);const v=e.target.value.trim();if(v.length<2){rbox.innerHTML='';return}
    rt=setTimeout(async()=>{try{const r=(await api(`/trees/${tid}/search?q=${encodeURIComponent(v)}`)).filter(x=>x.id!==p.id);if(live(rbox))rbox.innerHTML=r.map(x=>`<button class="btn btn-sm" data-rel="${x.id}" type="button">${uc(x.name)}</button>`).join('')||'<p>No one found.</p>'}catch{}},250)};
  rbox.onclick=async e=>{const b=e.target.closest('[data-rel]');if(!b)return;try{const t=(await api(`/people/${p.id}/related/${b.dataset.rel}`)).text;setText(rtxt,t);if(live(rbox))rbox.innerHTML=''}catch(x){setText(rtxt,x.message)}};
  const mk=$('#mkroot');if(mk)mk.onclick=async()=>{const vid=viewId;try{await api('/trees/'+tid,'PATCH',{root_id:p.id});if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash='#/t/'+tid}catch(x){alert(x.message)}};

  const attEl=$('#att');
  api(`/people/${p.id}/attachments`).then(list=>{const el=attEl;if(!live(el))return;const photos=list.filter(a=>a.kind==='photo'),docs=list.filter(a=>a.kind!=='photo'),del=a=>S.canEdit?`<button class="btn btn-sm del" data-att="${a.id}" type="button">Remove</button>`:'';
    const furl=a=>a.file?`/api/attachments/${a.id}/file`:(a.url||'#');
    const album=photos.length?`<section class="panel profile-section"><div class="panel-head"><h3 class="section-title">Photo album</h3></div><div class="panel-body"><div class="album">${photos.map(a=>`<figure><a href="#" data-media-link="${esc(furl(a))}" target="_blank" rel="noopener"><img data-media="${esc(furl(a))}" alt="${esc(a.title)}" loading="lazy"></a><figcaption data-i18n-skip>${esc(a.title)}${a.description?`<small>${esc(a.description)}</small>`:''}</figcaption>${del(a)}</figure>`).join('')}</div></div></section>`:'';
    const sources=docs.length?`<section class="panel profile-section"><div class="panel-head"><h3 class="section-title">Sources and documents</h3></div><div class="panel-body"><ul class="srcs">${docs.map(a=>`<li><b data-i18n-skip>${esc(a.title)}</b> <small data-i18n-skip>${esc(a.kind)}</small>${a.description?`<p data-i18n-skip>${esc(a.description)}</p>`:''}${a.url?`<a href="${esc(a.url)}" target="_blank" rel="noopener">Open the web link</a>`:''}${a.file?`<a href="#" data-media-link="${esc(furl(a))}" target="_blank" rel="noopener">Open the file</a>`:''}${del(a)}</li>`).join('')}</ul></div></section>`:'';
    const add=S.canEdit?`<section class="panel profile-section"><div class="panel-head"><h3 class="section-title">Add a record</h3></div><div class="panel-body"><details class="addatt"><summary class="btn">Add a photo, source or document</summary><form class="f" id="af"><label>Type${sel('kind',[['photo','Photo'],['source','Source'],['document','Document']])}</label><label>Title<input name="title" required maxlength="160"></label><label>Description<textarea name="description" rows="3" maxlength="2000"></textarea></label><label>Web link (optional)<input name="url" type="url" placeholder="https://"></label><label>File (image or PDF, up to 5 MB)<input name="file" type="file" accept="image/*,application/pdf"></label><div class="err" id="eatt"></div><button class="btn pri">Add</button></form></details></div></section>`:'';
    el.innerHTML=album+sources+add;
    el.querySelectorAll('[data-att]').forEach(b=>b.onclick=async()=>{if(!confirm('Remove this item?'))return;const vid=viewId;try{await api('/attachments/'+b.dataset.att,'DELETE');if(vid===viewId){clearMedia();personView(id)}}catch(x){alert(x.message)}});
    const af=$('#af');if(af)af.onsubmit=async e=>{e.preventDefault();const fd=new FormData(af),err=$('#eatt'),vid=viewId;if(!fd.get('file').size)fd.delete('file');try{await api(`/people/${p.id}/attachments`,'POST',fd);if(vid===viewId){clearMedia();personView(id)}}catch(x){setText(err,x.message)}}
  }).catch(()=>{});

  const ph=$('#ph');if(ph)ph.onchange=async()=>{const fd=new FormData(),vid=viewId;fd.append('photo',ph.files[0]);try{await api('/people/'+p.id+'/photo','POST',fd);if(vid!==viewId)return;clearMedia();await load(tid);if(vid!==viewId)return;await ensure(id);if(vid===viewId)personView(id)}catch(x){alert(x.message)}};
  const rp=$('#rmphoto');if(rp)rp.onclick=async()=>{if(!confirm('Remove the profile photo?'))return;const vid=viewId;try{await api('/people/'+p.id+'/photo','DELETE');if(vid!==viewId)return;clearMedia();await load(tid);if(vid!==viewId)return;await ensure(id);if(vid===viewId)personView(id)}catch(x){alert(x.message)}};
  const rm=$('#rm');if(rm)rm.onclick=async()=>{if(confirm('Remove '+p.name+' from the tree?')){const vid=viewId;try{await api('/people/'+p.id,'DELETE');if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash='#/t/'+tid}catch(x){alert(x.message)}}};
}


// ---- Add / edit forms ----
const field=(id,label,inner)=>`<div class="field"><label class="field-label" for="${id}">${label}</label>${inner}</div>`;

function parentsForm(pid){
  const p=byId(pid),tid=S.tree.id,pm=S.marriages.find(m=>m.id==p.parent_marriage_id);
  const current=pm?[pm.a_id,pm.b_id].filter(x=>x!=null).map(x=>byId(x)).filter(Boolean):[];
  treeCrumbs(pm?'Change parents':'Add parents');
  const one=(k,t)=>`<fieldset><legend>${t}</legend>
    ${field('pf-'+k+'-name','Name',`<input id="pf-${k}-name" name="${k}_name" placeholder="Leave empty if not known">`)}
    ${field('pf-'+k+'-dob','Born (optional)',`<input id="pf-${k}-dob" name="${k}_dob" pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" placeholder="1932-03-04 or 1932">`)}
    ${field('pf-'+k+'-dod','Died (optional)',`<input id="pf-${k}-dod" name="${k}_dod" pattern="(\\d{4}(-\\d{2}(-\\d{2})?)?|unknown)" placeholder="2011-09-17 or 2011">`)}
  </fieldset>`;
  $('#app').innerHTML=`<div class="form-page">
    <div class="profile-topbar"><a class="back" href="#/t/${tid}/p/${pid}" data-back>Cancel</a></div>
    <div class="form-shell">
      <div class="form-shell-head"><span class="eyebrow">Family</span><h2>${pm?'Change':'Add'} the parents of ${uc(p.name)}</h2><p>${pm?'Add a new set of parents, or remove the current ones. The people already recorded are never deleted.':'Record one or both parents together. You can add more detail after they are saved.'}</p></div>
      <form class="form-shell-body" id="pf">
        ${current.length?`<p class="hint">Current parents: ${current.map(x=>uc(x.name)).join(' and ')}</p>`:''}
        <div class="split-fields">${one('father','Father')}${one('mother','Mother')}</div>
        ${field('pf-year','Year they married (optional)',`<input id="pf-year" name="year" type="number" min="1600" max="2100">`)}
        <div class="hint">Leave either parent empty for a single-parent family.</div>
        <div class="err" id="err"></div>
        <div class="form-actions"><button class="btn pri">Save</button>${pm?`<button class="btn del" id="rmpar" type="button">Remove parents</button>`:''}</div>
      </form>
    </div>
  </div>`;
  const rm=$('#rmpar');
  if(rm)rm.onclick=async()=>{if(!confirm('Remove the parents of '+p.name+'? The parent people stay in the tree.'))return;const vid=viewId;try{await api('/people/'+pid+'/parents','DELETE');if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash=`#/t/${tid}/p/${pid}`}catch(x){alert(x.message)}};
  $('#pf').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),err=$('#err'),vid=viewId;
    const father=f.father_name?{name:f.father_name,dob:f.father_dob,dod:f.father_dod}:null,mother=f.mother_name?{name:f.mother_name,dob:f.mother_dob,dod:f.mother_dod}:null;
    if(!father&&!mother)return setText(err,'Enter at least one parent.');
    try{await api('/people/'+pid+'/parents',pm?'PUT':'POST',{father,mother,year:f.year});if(vid!==viewId)return;await load(tid);if(vid!==viewId)return;await ensure(pid);if(vid===viewId)location.hash=`#/t/${tid}/p/${pid}`}catch(x){setText(err,x.message)}};
}

function formView(q,pid){
  if(q.get('parents'))return parentsForm(+q.get('parents'));
  const tid=S.tree.id,p=pid?byId(pid):{},spouse=q.get('s'),m=q.get('m');
  treeCrumbs(pid?'Edit person':spouse?'Add a spouse':'Add a child');
  const title=pid?'Edit '+uc(p.name):spouse?'Add a spouse':'Add a child';
  $('#app').innerHTML=`<div class="form-page">
    <div class="profile-topbar"><a class="back" href="${pid?`#/t/${tid}/p/${pid}`:'#/t/'+tid}" data-back>Cancel</a></div>
    <div class="form-shell">
      <div class="form-shell-head"><span class="eyebrow">${pid?'Person':'New person'}</span><h2>${title}</h2><p>${pid?'Update the details recorded for this person.':'Add the details you know now. Everything can be changed later.'}</p></div>
      <form class="form-shell-body" id="pf">
        ${field('pf-name','Name',`<input id="pf-name" name="name" required value="${esc(p.name||'')}">`)}
        ${field('pf-gender','Gender',`<select id="pf-gender" name="gender">${['Male','Female','Other'].map(g=>`<option ${p.gender===g?'selected':''}>${g}</option>`).join('')}</select>`)}
        <div class="split-fields">
          <div class="field"><label class="field-label" for="pf-dob">Date of birth</label><div class="row"><input id="pf-dob" name="dob" ${pid?'':'required'} pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" placeholder="1932-03-04 or 1932" value="${esc(p.dob||'')}">${qsel('dob_q',p.dob_q)}</div></div>
          <div class="field"><label class="field-label" for="pf-dod">Date of death (leave empty if alive)</label><div class="row"><input id="pf-dod" name="dod" pattern="(\\d{4}(-\\d{2}(-\\d{2})?)?|unknown)" placeholder="2011-09-17 or 2011" value="${esc(p.dod||'')}">${qsel('dod_q',p.dod_q)}</div></div>
        </div>
        <div class="hint">You can enter a full date, a month (1932-03) or just a year.</div>
        <div class="split-fields">
          ${field('pf-birth-place','Born in (place)',`<input id="pf-birth-place" name="birth_place" maxlength="120" value="${esc(p.birth_place||'')}">`)}
          ${field('pf-death-place','Place of death (if they have passed)',`<input id="pf-death-place" name="death_place" maxlength="120" value="${esc(p.death_place||'')}">`)}
        </div>
        <div class="field"><label class="field-label" for="pf-notes">About this person</label><textarea id="pf-notes" name="notes" rows="4" maxlength="4000" placeholder="Stories, work, where they lived">${esc(p.notes||'')}</textarea></div>
        ${spouse?`<div class="form-grid">
          ${field('pf-kind','Relationship',`<select id="pf-kind" name="kind">${[['married','Married'],['partner','Partners'],['divorced','Divorced'],['separated','Separated']].map(([k,t])=>`<option value="${k}" ${(p.kind||'married')===k?'selected':''}>${t}</option>`).join('')}</select>`)}
          ${field('pf-year','Year it began',`<input id="pf-year" name="year" type="number" min="1000" max="2200">`)}
          ${field('pf-end-year','Year it ended (if it did)',`<input id="pf-end-year" name="end_year" type="number" min="1000" max="2200">`)}
        </div>`:''}
        ${(m&&!pid)||(pid&&p.parent_marriage_id)?`<div class="form-grid">${field('pf-parent-kind','Relationship to the parents',`<select id="pf-parent-kind" name="parent_kind">${[['biological','Biological'],['adopted','Adopted'],['step','Step'],['foster','Foster']].map(([k,t])=>`<option value="${k}" ${((p.parent_kind||'biological'))===k?'selected':''}>${t}</option>`).join('')}</select>`)}</div>`:''}
        <div class="hint" id="hint"></div>
        <div class="err" id="err"></div>
        <div class="form-actions"><button class="btn pri">Save</button></div>
      </form>
    </div>
  </div>`;
  const hint=()=>$('#hint').textContent='Status will be '+(pf.dod.value?'Deceased':'Alive'),pf=$('#pf');pf.oninput=hint;hint();
  pf.onsubmit=async e=>{e.preventDefault();const b=Object.fromEntries(new FormData(pf)),err=$('#err'),vid=viewId;
    try{if(pid)await api('/people/'+pid,'PUT',b);else await api(`/trees/${tid}/people`,'POST',{...b,spouse_of:spouse,parent_marriage_id:m});
      if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash=pid?`#/t/${tid}/p/${pid}`:'#/t/'+tid}catch(x){setText(err,x.message)}};
}

async function shareView(){
  if(S.role!=='owner')return $('#app').innerHTML='<div class="page"><div class="empty-state"><span class="empty-icon">'+ico('shield')+'</span><h2>Only the owner can share this tree</h2><p>Ask the tree owner for access if you need to invite someone.</p></div></div>';
  const vid=viewId,t=S.tree,id=t.id,[ms,inv]=await Promise.all([api(`/trees/${id}/members`),api(`/trees/${id}/invites`)]);
  if(vid!==viewId)return;
  treeCrumbs('Share and export');
  const initials=n=>(n||'?').trim().charAt(0).toUpperCase();
  const shareURL=location.origin+location.pathname+'#/t/'+id;
  const pending=inv.filter(i=>i.pending),expired=inv.filter(i=>!i.pending&&!i.accepted_at&&!i.declined_at);
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group"><span class="eyebrow" data-i18n-skip>${esc(t.name)}</span><h2>Share and export</h2><p class="page-subtitle">Choose who can see this tree, and take a copy with you when you need one.</p></div>
  </div>
  <div class="settings-grid">
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Link to this tree</div><div class="panel-sub">${t.visibility==='link'?'Anyone with this link can open the tree.':'This tree is private. Invited people can still use the link after signing in.'}</div></div></div>
      <div class="panel-body"><div class="row"><input id="shareurl" readonly value="${esc(shareURL)}" aria-label="Share link"><button class="btn" id="copyurl" type="button">Copy link</button></div></div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Who can open the link</div><div class="panel-sub">Control the audience for this family tree.</div></div></div>
      <div class="panel-body">
        <form id="vf" class="stack">
          <div class="field"><label class="field-label" for="vf-visibility">Visibility</label><select id="vf-visibility" name="visibility"><option value="private" ${t.visibility==='private'?'selected':''}>Only me and people I invite</option><option value="link" ${t.visibility==='link'?'selected':''}>Anyone with the link</option></select></div>
          <label class="check-row"><input type="checkbox" name="hide_living" ${t.hide_living?'checked':''}><span>Hide full birth dates and photos of living people from visitors</span></label>
          <div class="err" id="e1"></div>
          <div class="form-actions"><button class="btn pri">Save settings</button></div>
        </form>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">People you invited</div><div class="panel-sub">Editors can change the tree. Viewers can see everything.</div></div><span class="badge">${ms.length}</span></div>
      <div class="panel-body">
        <div class="member-list">
          ${ms.map(m=>`<div class="member"><span class="member-avatar">${esc(initials(m.name||m.email))}</span><span class="member-info" data-i18n-skip><b>${esc(m.name||m.email)}</b><span>${esc(m.email||'')}</span></span><select data-role="${m.id}" aria-label="Role for ${esc(m.name||m.email)}"><option value="editor" ${m.role==='editor'?'selected':''}>Editor</option><option value="viewer" ${m.role==='viewer'?'selected':''}>Viewer</option></select><button class="btn btn-sm del" data-rm="${m.id}" type="button">Remove</button></div>`).join('')||'<p class="hint">No one else has access yet.</p>'}
        </div>
        <form id="mf" class="stack" style="margin-top:14px">
          <div class="form-grid">
            ${field('mf-email','Invite by email',`<input id="mf-email" name="email" type="email" required placeholder="name@example.com">`)}
            ${field('mf-role','Role',`<select id="mf-role" name="role"><option value="editor">Editor: can change the tree</option><option value="viewer">Viewer: can see everything</option></select>`)}
          </div>
          <p class="hint">If they already have an account they are added now. Otherwise they get an invitation link that works for 14 days.</p>
          <div class="err" id="e2"></div>
          <div class="form-actions"><button class="btn pri">Invite</button></div>
        </form>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Pending invitations</div><div class="panel-sub">Waiting for the person to accept. Expired invitations cannot be used.</div></div><span class="badge">${pending.length}</span></div>
      <div class="panel-body"><div class="member-list">
        ${pending.length?pending.map(i=>`<div class="member"><span class="member-avatar">${esc(initials(i.email))}</span><span class="member-info"><b>${esc(i.email)}</b><span>${esc(i.role)} · expires ${esc(new Date(i.expires_at).toLocaleDateString())}</span></span><button class="btn btn-sm del" data-inv="${i.id}" type="button">Cancel</button></div>`).join(''):'<p class="hint">No invitations are waiting.</p>'}
        ${expired.length?`<p class="hint">${expired.length} expired invitation${expired.length===1?'':'s'} can be sent again by inviting the same email.</p>`:''}
      </div></div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Ownership</div><div class="panel-sub">Hand this tree to another person who already has access. You will stay as an editor.</div></div></div>
      <div class="panel-body">${ms.length?`<form id="ow" class="stack"><div class="form-grid"><div class="field"><label class="field-label" for="ow-user">New owner</label><select id="ow-user" name="user_id" required>${ms.map(m=>`<option value="${m.id}" data-i18n-skip>${esc(m.name||m.email)} (${esc(m.email)})</option>`).join('')}</select></div></div><div class="err" id="eow"></div><div class="form-actions"><button class="btn">Transfer ownership</button></div></form>`:'<p class="hint">Invite someone first before you transfer ownership.</p>'}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Import</div><div class="panel-sub">Merge a GEDCOM file into this tree.</div></div></div>
      <div class="panel-body">
        <p class="hint">It is safe to repeat: people already here are left as they are.</p>
        <div class="form-actions"><label class="btn">${ico('upload')}Choose a .ged file<input type="file" accept=".ged,text/plain" hidden id="imp"></label></div>
        <div class="hint" id="impmsg" role="status"></div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Export</div><div class="panel-sub">Keep a backup or move your tree to another app.</div></div></div>
      <div class="panel-body">
        <div class="export-actions"><button class="btn" data-ged="0" type="button">${ico('download')}Download GEDCOM</button><button class="btn" data-ged="1" type="button">GEDCOM without living people's details</button><button class="btn" data-json type="button">Full backup (JSON)</button></div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Restore a backup</div><div class="panel-sub">A full JSON backup opens as a new tree. Your current tree is never overwritten.</div></div></div>
      <div class="panel-body">
        <div class="form-actions"><label class="btn">${ico('upload')}Choose a backup file<input type="file" accept=".json,application/json" hidden id="rst"></label></div>
        <div id="rstout" class="stack" style="margin-top:12px"></div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Rename this tree</div><div class="panel-sub">Change the name shown across your workspace.</div></div></div>
      <div class="panel-body">
        <form id="renametree" class="form-inline">
          <div class="field"><label class="field-label" for="rn-name">New name</label><input id="rn-name" name="name" required value="${esc(t.name)}" maxlength="120"></div>
          <div class="form-actions"><button class="btn pri" type="submit">${ico('edit')}Rename</button></div>
          <div class="err" id="erename"></div>
        </form>
      </div>
    </section>
    <section class="panel panel-danger danger-zone">
      <div class="panel-head"><div><div class="panel-title">Delete this tree</div><div class="panel-sub">This removes everyone in the tree and its files. It cannot be undone.</div></div></div>
      <div class="panel-body"><button class="btn del" id="deltree" type="button">${ico('trash')}Delete this tree</button><div class="err" id="edel"></div></div>
    </section>
  </div>`;
  $('#copyurl').onclick=async()=>{try{await navigator.clipboard.writeText(shareURL);setText($('#copyurl'),'Copied')}catch{prompt('Copy this link',shareURL)}};
  $('[data-json]').onclick=async()=>{const r=await fetch(`/api/trees/${id}/export.json`,{headers:{Authorization:'Bearer '+tok}});if(!r.ok)return alert('The backup did not work. Please try again.');const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=t.name.replace(/\W+/g,'-')+'.json';a.click()};
  const done=async vid=>{if(vid!==viewId)return;await load(id,vid);if(vid===viewId)await shareView()};
  $('#imp').onchange=async e=>{const f=e.target.files[0];if(!f)return;const vid=viewId,msg=$('#impmsg');try{const r=await api(`/trees/${id}/import`,'POST',await f.text());if(vid!==viewId)return;await load(id,vid);if(vid!==viewId)return;await shareView();if(vid!==viewId)return;
    setText($('#impmsg'),`Added ${r.added} new people and ${r.families} families. ${r.existing} were already in the tree.`+(r.notes.length?' '+r.notes.join(' '):''))}catch(x){setText(msg,x.message)}};
  let restoreFile=null;
  $('#rst').onchange=async e=>{const f=e.target.files[0],out=$('#rstout');if(!f)return;restoreFile=f;out.innerHTML='<p class="hint">Checking the backup…</p>';const fd=new FormData();fd.append('file',f);
    try{const p=await api('/trees/restore?preview=1','POST',fd);if(!live(out))return;
      out.innerHTML=`<div class="stack"><p><b>${esc(p.tree||'Backup')}</b> is ready to restore as a new tree.</p><p class="hint">${p.counts.people} people · ${p.counts.marriages} relationships · ${p.counts.media} media files · ${p.counts.members} members${p.warnings.length?' · '+p.warnings.length+' warning'+(p.warnings.length===1?'':'s'):''}</p>${p.warnings.length?`<ul class="hint">${p.warnings.slice(0,12).map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:''}<div class="form-actions"><button class="btn pri" id="rstgo" type="button">Restore as a new tree</button></div></div>`;
      $('#rstgo').onclick=async()=>{const vid=viewId,fd2=new FormData();fd2.append('file',restoreFile);try{const r=await api('/trees/restore','POST',fd2);if(vid!==viewId)return;location.hash='#/t/'+r.id}catch(x){if(live(out))out.insertAdjacentHTML('beforeend',`<div class="err">${esc(x.message)}</div>`)}};
    }catch(x){if(live(out))out.innerHTML=`<div class="err">${esc(x.message)}</div>`}};
  $('#vf').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),err=$('#e1'),vid=viewId;try{await api('/trees/'+id,'PATCH',{visibility:f.get('visibility'),hide_living:f.get('hide_living')?1:0});await done(vid)}catch(x){setText(err,x.message)}};
  $('#mf').onsubmit=async e=>{e.preventDefault();const err=$('#e2'),vid=viewId;try{await api(`/trees/${id}/invites`,'POST',Object.fromEntries(new FormData(e.target)));await done(vid)}catch(x){setText(err,x.message)}};
  document.querySelectorAll('[data-rm]').forEach(b=>b.onclick=async()=>{if(!confirm('Remove this person from the tree?'))return;const vid=viewId;try{await api(`/trees/${id}/members/${b.dataset.rm}`,'DELETE');await done(vid)}catch(x){alert(x.message)}});
  document.querySelectorAll('[data-role]').forEach(s=>s.onchange=async()=>{const vid=viewId;try{await api(`/trees/${id}/members/${s.dataset.role}`,'PATCH',{role:s.value});await done(vid)}catch(x){alert(x.message)}});
  document.querySelectorAll('[data-inv]').forEach(b=>b.onclick=async()=>{const vid=viewId;try{await api(`/trees/${id}/invites/${b.dataset.inv}`,'DELETE');await done(vid)}catch(x){alert(x.message)}});
  const ow=$('#ow');if(ow)ow.onsubmit=async e=>{e.preventDefault();if(!confirm('Make this person the owner? You will become an editor.'))return;const vid=viewId;try{await api(`/trees/${id}/owner`,'POST',{user_id:+new FormData(ow).get('user_id')});await done(vid)}catch(x){setText($('#eow'),x.message)}};
  $('#renametree').onsubmit=async e=>{e.preventDefault();const err=$('#erename'),vid=viewId;const name=$('#rn-name').value.trim();if(!name){setText(err,'Give your family tree a name.');return}try{await api('/trees/'+id,'PATCH',{name});if(vid!==viewId)return;await load(id,vid);if(vid===viewId){$('#title').textContent=name;shareView()}}catch(x){setText(err,x.message)}};
  $('#deltree').onclick=async()=>{if(!confirm(`Delete “${t.name}” and everyone in it? This cannot be undone.`))return;const vid=viewId;try{await api('/trees/'+id,'DELETE');if(vid!==viewId)return;S=null;clearPrivateUI();location.hash='#/';if((location.hash||'#/')==='#/')route()}catch(x){setText($('#edel'),x.message)}};
  document.querySelectorAll('[data-ged]').forEach(b=>b.onclick=async()=>{const r=await fetch(`/api/trees/${id}/export.ged?hideLiving=${b.dataset.ged}`,{headers:{Authorization:'Bearer '+tok}});
    if(!r.ok)return alert('The export did not work. Please try again.');const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=t.name.replace(/\W+/g,'-')+'.ged';a.click()});
}

async function searchView(q){
  const tid=S.tree.id,term=(q.get('q')||'').trim(),limit=25,offset=Math.max(0,Number(q.get('offset'))||0);
  const formHTML=`<form id="qsf" class="filter-bar">
    <div class="field"><label class="field-label" for="qsf-q">Name</label><input id="qsf-q" name="q" type="search" value="${esc(term)}" placeholder="At least two letters" autocomplete="off" required minlength="2"></div>
    <div class="field"><label class="field-label" for="qsf-gender">Gender</label><select id="qsf-gender" name="gender"><option value="">Any</option>${['Male','Female','Other'].map(g=>`<option ${q.get('gender')===g?'selected':''}>${g}</option>`).join('')}</select></div>
    <div class="field"><label class="field-label" for="qsf-status">Status</label><select id="qsf-status" name="status"><option value="">Any</option><option value="living" ${q.get('status')==='living'?'selected':''}>Living</option><option value="deceased" ${q.get('status')==='deceased'?'selected':''}>Deceased</option></select></div>
    <div class="field"><label class="field-label" for="qsf-from">Born from</label><input id="qsf-from" name="from" inputmode="numeric" pattern="\\d{4}" maxlength="4" value="${esc(q.get('from')||'')}" placeholder="1900"></div>
    <div class="field"><label class="field-label" for="qsf-to">Born to</label><input id="qsf-to" name="to" inputmode="numeric" pattern="\\d{4}" maxlength="4" value="${esc(q.get('to')||'')}" placeholder="1999"></div>
    <div class="field"><label class="field-label" for="qsf-sort">Sort</label><select id="qsf-sort" name="sort"><option value="name" ${q.get('sort')==='name'?'selected':''}>Name A–Z</option><option value="born" ${q.get('sort')==='born'?'selected':''}>Oldest first</option><option value="born_desc" ${q.get('sort')==='born_desc'?'selected':''}>Youngest first</option></select></div>
    <div class="form-actions"><button class="btn pri">Search</button><a class="btn" href="#/t/${tid}/search">Clear</a></div>
  </form>`;
  treeCrumbs('Search');
  if(term.length<2){
    $('#app').innerHTML=`<div class="page-header"><div class="page-title-group"><span class="eyebrow" data-i18n-skip>${esc(S.tree.name)}</span><h2>Find a person</h2><p class="page-subtitle">Search by name, then narrow the results by gender, status or birth year.</p></div></div>
    <div class="panel"><div class="panel-body"><p class="hint">Type at least two letters to begin.</p>${formHTML}</div></div>`;
    bindSearchForm(tid);
    return;
  }
  const params=new URLSearchParams({q:term,limit:String(limit),offset:String(offset)});
  for(const k of ['gender','status','from','to','sort'])if(q.get(k))params.set(k,q.get(k));
  const vid=viewId,page=await apiPage(`/trees/${tid}/search?${params}`);
  if(vid!==viewId)return;
  const rows=page.data,pages=Math.max(1,Math.ceil(page.total/limit)),current=Math.floor(offset/limit)+1;
  const pageLink=n=>`#/t/${tid}/search?${new URLSearchParams({...Object.fromEntries(params),offset:String(Math.max(0,n))})}`;
  $('#app').innerHTML=`<div class="page-header"><div class="page-title-group"><span class="eyebrow" data-i18n-skip>${esc(S.tree.name)}</span><h2>Search results</h2><p class="page-subtitle">${page.total} ${page.total===1?'person matches':'people match'} “${esc(term)}”.</p></div></div>
  <div class="panel"><div class="panel-body">${formHTML}
    ${rows.length?`<div class="person-grid search-results">${rows.map(p=>card(p,life(p))).join('')}</div>`:`<div class="empty-state"><span class="empty-icon">${ico('search')}</span><h3>No one matches.</h3><p>Try a shorter name, or loosen the filters.</p></div>`}
    <div class="form-actions" style="justify-content:space-between"><a class="btn ${offset<=0?'disabled':''}" ${offset<=0?'aria-disabled="true"':'href="'+pageLink(offset-limit)+'"'}>Previous</a><span class="hint">Page ${current} of ${pages}</span><a class="btn ${current>=pages?'disabled':''}" ${current>=pages?'aria-disabled="true"':'href="'+pageLink(offset+limit)+'"'}>Next</a></div>
  </div></div>`;
  bindSearchForm(tid);
}
function bindSearchForm(tid){
  const f=$('#qsf');if(!f)return;
  f.onsubmit=e=>{e.preventDefault();const d=new FormData(f),p=new URLSearchParams();
    for(const k of ['q','gender','status','from','to','sort']){const v=String(d.get(k)||'').trim();if(v&&!(k==='sort'&&v==='name'))p.set(k,v)}
    location.hash=`#/t/${tid}/search?${p}`;
  };
}

async function historyView(q){
  if(!S.canEdit)return $('#app').innerHTML='<div class="page"><div class="empty-state"><span class="empty-icon">'+ico('history')+'</span><h2>Only editors can see the history</h2></div></div>';
  const tid=S.tree.id,limit=25,offset=Math.max(0,Number(q.get('offset'))||0);
  const params=new URLSearchParams({limit:String(limit),offset:String(offset)});
  for(const k of ['action','user','from','to'])if(q.get(k))params.set(k,q.get(k));
  const vid=viewId,page=await apiPage(`/trees/${tid}/history?${params}`),h=page.data;
  if(vid!==viewId)return;
  const pageLink=n=>`#/t/${tid}/history?${new URLSearchParams({...Object.fromEntries(params),offset:String(Math.max(0,n))})}`;
  const pages=Math.max(1,Math.ceil(page.total/limit)),current=Math.floor(offset/limit)+1;
  treeCrumbs('History');
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group"><span class="eyebrow" data-i18n-skip>${esc(S.tree.name)}</span><h2>Recent changes</h2><p class="page-subtitle">A record of edits made to this family tree, newest first.</p></div>
  </div>
  <div class="panel"><div class="panel-body">
    <form id="hf" class="filter-bar">
      <div class="field"><label class="field-label" for="hf-action">Action contains</label><input id="hf-action" name="action" value="${esc(q.get('action')||'')}" placeholder="edited, merged…"></div>
      <div class="field"><label class="field-label" for="hf-user">Person</label><input id="hf-user" name="user" value="${esc(q.get('user')||'')}" placeholder="Name or email"></div>
      <div class="field"><label class="field-label" for="hf-from">From</label><input id="hf-from" name="from" type="date" value="${esc(q.get('from')||'')}"></div>
      <div class="field"><label class="field-label" for="hf-to">To</label><input id="hf-to" name="to" type="date" value="${esc(q.get('to')||'')}"></div>
      <div class="form-actions"><button class="btn pri">Filter</button><a class="btn" href="#/t/${tid}/history">Clear</a></div>
    </form>
    ${h.length?`<ol class="timeline">${h.map(x=>`<li class="timeline-item"><span class="timeline-dot">${ico('history')}</span><div class="timeline-body"><b>${uc(x.name||x.email||'Someone')} ${esc(x.action)}</b>${x.detail?`<p data-i18n-skip>${esc(x.detail)}</p>`:''}<span class="timeline-meta">${esc(x.at)} UTC</span></div></li>`).join('')}</ol>`:`<div class="empty-state"><span class="empty-icon">${ico('history')}</span><h3>Nothing matches.</h3><p>Try a different filter, or make an edit and come back.</p></div>`}
    <div class="form-actions" style="justify-content:space-between"><a class="btn ${offset<=0?'disabled':''}" ${offset<=0?'aria-disabled="true"':'href="'+pageLink(offset-limit)+'"'}>Previous</a><span class="hint">Page ${current} of ${pages} · ${page.total} change${page.total===1?'':'s'}</span><a class="btn ${current>=pages?'disabled':''}" ${current>=pages?'aria-disabled="true"':'href="'+pageLink(offset+limit)+'"'}>Next</a></div>
  </div></div>`;
  $('#hf').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),p=new URLSearchParams();for(const k of ['action','user','from','to'])if(String(f.get(k)||'').trim())p.set(k,String(f.get(k)).trim());location.hash=`#/t/${tid}/history${p.toString()?'?'+p:''}`};
}


// ---- Charts: drawn as SVG with the same data as the rest of the app ----
const NW=152,NH=78,HG=44,GAP=22,VG=58,ini=p=>p.name.split(' ').map(w=>w[0]).join('').slice(0,3);
const nlines=n=>{if(n.length<=16)return[n];const i=n.lastIndexOf(' ',16);return i>0?[n.slice(0,i),n.slice(i+1,i+19)]:[n.slice(0,16),n.slice(16,32)]};
const cnode=(p,cx,y,tid)=>{const L=nlines(p.name);return `<a href="#/t/${tid}/p/${p.id}"><g class="cnode"><rect class="cn${p.dod?' gone':''}" x="${cx-NW/2}" y="${y}" width="${NW}" height="${NH}" rx="7"/><circle cx="${cx}" cy="${y+20}" r="14" fill="${COL[p.id%6]}"/><text class="cin" x="${cx}" y="${y+25}" text-anchor="middle">${esc(ini(p))}</text>`+
  L.map((t,i)=>`<text class="cname" x="${cx}" y="${y+(L.length>1?45:51)+i*14}" text-anchor="middle">${esc(t)}</text>`).join('')+`<text class="cdates" x="${cx}" y="${y+NH-7}" text-anchor="middle">${esc(life(p))}</text></g></a>`};

function descChart(d,tid,rootId){
  const byI=Object.fromEntries(d.people.map(p=>[p.id,p])),ms=id=>d.marriages.filter(m=>m.a_id==id||m.b_id==id),kids=m=>d.people.filter(p=>p.parent_marriage_id==m.id);
  const memo={},seen=new Set(),dd=(NW+HG)/2;let maxY=0,nodes='',lines='';
  const kw=m=>{const k=kids(m);return k.length?k.reduce((s,x)=>s+w(x.id),0)+GAP*(k.length-1):0},bw=m=>Math.max(2*NW+HG,kw(m));
  const w=id=>memo[id]??=(()=>{const k=ms(id);return k.length?k.reduce((s,m)=>s+bw(m),0)+GAP*(k.length-1):NW})();
  const place=(id,left,y)=>{if(seen.has(id)||!byI[id])return;seen.add(id);maxY=Math.max(maxY,y);const k=ms(id),W=w(id),cy=y+NH/2;
    if(!k.length){nodes+=cnode(byI[id],left+W/2,y,tid);return}
    let x=left;const cs=k.map(m=>{const b=bw(m),c=x+b/2;x+=b+GAP;return c}),pcx=k.length===1?cs[0]-dd:(cs[0]+cs[k.length-1])/2;
    nodes+=cnode(byI[id],pcx,y,tid);
    k.forEach((m,i)=>{const c=cs[i],sp=byI[m.a_id==id?m.b_id:m.a_id],scx=i===0&&k.length>1?c-dd:c+dd;
      lines+=`<path class="cl" d="M${pcx} ${cy}H${scx}"/>`;if(sp)nodes+=cnode(sp,scx,y,tid);nodes+=`<text class="cheart" x="${c}" y="${cy+6}" text-anchor="middle">♥</text>`;
      const ks=kids(m);if(!ks.length)return;const busY=y+NH+VG/2;let sx=c-kw(m)/2;const kc=[];
      ks.forEach(kd=>{kc.push(sx+w(kd.id)/2);place(kd.id,sx,y+NH+VG);sx+=w(kd.id)+GAP});
      lines+=`<path class="cl" d="M${c} ${cy+12}V${busY}M${Math.min(c,...kc)} ${busY}H${Math.max(c,...kc)}${kc.map(q=>`M${q} ${busY}V${y+NH+VG}`).join('')}"/>`})};
  place(rootId,20,20);return{svg:lines+nodes,W:w(rootId)+40,H:maxY+NH+40}
}

function pedChart(d,tid,rootId){
  const byI=Object.fromEntries(d.people.map(p=>[p.id,p])),M=Object.fromEntries(d.marriages.map(m=>[m.id,m]));let nodes='',lines='';
  const par=id=>{const m=M[byI[id]&&byI[id].parent_marriage_id];return m?[byI[m.a_id],byI[m.b_id]].filter(Boolean).sort((a,b)=>(b.gender==='Male')-(a.gender==='Male')):[]};
  const dep=id=>{const k=par(id);return k.length?1+Math.max(...k.map(x=>dep(x.id))):0},G=dep(rootId);
  const w=id=>{const k=par(id);return k.length?k.reduce((s,x)=>s+w(x.id),0)+GAP*(k.length-1):NW};
  const place=(id,left,g)=>{const y=(G-g)*(NH+VG)+20,k=par(id),W=w(id);
    if(!k.length){nodes+=cnode(byI[id],left+W/2,y,tid);return left+W/2}
    let x=left;const kc=k.map(p=>{const c=place(p.id,x,g+1);x+=w(p.id)+GAP;return c}),cx=(kc[0]+kc[kc.length-1])/2,busY=y-VG/2;
    lines+=`<path class="cl" d="M${cx} ${y}V${busY}M${kc[0]} ${busY}H${kc[kc.length-1]}${kc.map(q=>`M${q} ${busY}V${y-VG}`).join('')}"/>`;nodes+=cnode(byI[id],cx,y,tid);return cx};
  place(rootId,20,0);return{svg:lines+nodes,W:w(rootId)+40,H:G*(NH+VG)+NH+40,G}
}

let zoom=1;
function chartShell(title,body,W,H,extra=''){
  const safe=esc(title);
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group"><span class="eyebrow" data-i18n-skip>${esc(S.tree.name)}</span><h2>${safe}</h2><p class="page-subtitle">Drag or scroll to move around. Tap anyone to open their page.</p></div>
  </div>
  <div class="chart-frame">
    <div class="chartbar">${extra}<button class="btn" data-z="-" aria-label="Zoom out" type="button">Zoom out</button><button class="btn" data-z="+" aria-label="Zoom in" type="button">Zoom in</button><button class="btn" data-z="fit" type="button">Fit</button><button class="btn" data-print type="button">Print</button></div>
    <div class="chartwrap" id="cw" tabindex="0"></div>
  </div>`;
  const cw=$('#cw'),fit=()=>Math.min(1,(cw.clientWidth-16)/W),draw=()=>{cw.innerHTML=`<svg class="chart" width="${W*zoom}" height="${H*zoom}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${safe}">${body}</svg>`};
  zoom=cw.clientWidth<700?.8:Math.max(.57,fit());draw();cw.scrollLeft=(W*zoom-cw.clientWidth)/2; // .57 keeps 78px chart nodes >=44px touch targets
  document.querySelectorAll('[data-z]').forEach(b=>b.onclick=()=>{const k=b.dataset.z;zoom=k==='fit'?fit():Math.max(.3,Math.min(2,zoom*(k==='+'?1.25:.8)));draw();if(k==='fit')cw.scrollLeft=0});
  let drag=null;cw.onpointerdown=e=>{if(e.pointerType!=='mouse'||e.target.closest('a'))return;drag=[e.clientX,e.clientY,cw.scrollLeft,cw.scrollTop];cw.setPointerCapture(e.pointerId)};
  cw.onpointermove=e=>{if(drag){cw.scrollLeft=drag[2]-(e.clientX-drag[0]);cw.scrollTop=drag[3]-(e.clientY-drag[1])}};cw.onpointerup=()=>drag=null;
}

async function chartView(q){
  const vid=viewId,g=Math.min(6,Math.max(1,+q.get('g')||3)),tid=S.tree.id,d=await api(`/trees/${tid}?depth=${g}`);
  if(vid!==viewId)return;
  treeCrumbs('Family chart');
  const r=descChart(d,tid,d.tree.root_id);
  chartShell('Family chart',r.svg,r.W,r.H,`<label class="gsel">Generations <select id="gsel">${[2,3,4,5,6].map(n=>`<option ${n===g?'selected':''}>${n}</option>`).join('')}</select></label>`);
  $('#gsel').onchange=e=>location.hash=`#/t/${tid}/chart?g=${e.target.value}`;
}

async function pedView(pid){
  const vid=viewId,tid=S.tree.id,d=await api(`/people/${pid}/pedigree?depth=4`);
  if(vid!==viewId)return;
  const r=pedChart(d,tid,pid),p=d.people.find(x=>x.id===pid);
  treeCrumbs('Ancestors');
  chartShell('Ancestors of '+(p?p.name:''),r.svg,r.W,r.H);
  if(!r.G)$('#app').insertAdjacentHTML('beforeend','<p class="hint" style="margin-top:12px">No parents have been added yet.</p>');
}

async function insightsView(){
  const vid=viewId,tid=S.tree.id,i=await api(`/trees/${tid}/insights`);
  if(vid!==viewId)return;
  treeCrumbs('Family insights');
  const lk=p=>p?`<a href="#/t/${tid}/p/${p.id}">${uc(p.name)}</a>`:'Not known';
  const stat=(label,value,note='')=>`<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note?`<span class="stat-note">${note}</span>`:''}</div>`;
  const maxName=Math.max(1,...i.commonNames.map(n=>n.count));
  const genders=Object.entries(i.gender),maxGender=Math.max(1,...genders.map(x=>x[1]));
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group"><span class="eyebrow" data-i18n-skip>${esc(S.tree.name)}</span><h2>Family insights</h2><p class="page-subtitle">A quick look at the shape of your family tree.</p></div>
  </div>
  <div class="stat-grid">
    ${stat('People',i.people)}
    ${stat('Living',i.living)}
    ${stat('Passed away',i.deceased)}
    ${stat('Marriages',i.marriages)}
    ${stat('Generations',i.generations)}
    ${stat('Average lifespan',i.averageLifespan==null?'Not known':i.averageLifespan+' years')}
  </div>
  <div class="insight-grid">
    <section class="panel"><div class="panel-head"><h3 class="panel-title">Lived the longest</h3></div><div class="panel-body"><p class="insight-copy">${i.longestLived?`${lk(i.longestLived)}, ${i.longestLived.age} years`:'Not known'}</p></div></section>
    <section class="panel"><div class="panel-head"><h3 class="panel-title">Oldest living</h3></div><div class="panel-body"><p class="insight-copy">${i.oldestLiving?`${lk(i.oldestLiving)}, ${i.oldestLiving.age} years`:'Not shown'}</p></div></section>
    <section class="panel"><div class="panel-head"><h3 class="panel-title">Most common first names</h3></div><div class="panel-body">${i.commonNames.length?`<div class="bar-list">${i.commonNames.map(n=>`<div class="bar-row"><span class="bar-label" data-i18n-skip>${esc(n.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.round(n.count/maxName*100)}%"></span></span><span class="bar-value">${n.count}</span></div>`).join('')}</div>`:'<p class="hint">No names recorded yet.</p>'}</div></section>
    <section class="panel"><div class="panel-head"><h3 class="panel-title">Gender mix</h3></div><div class="panel-body">${genders.length?`<div class="bar-list">${genders.map(([k,v])=>`<div class="bar-row"><span class="bar-label">${esc(k)}</span><span class="bar-track"><span class="bar-fill accent" style="width:${Math.round(v/maxGender*100)}%"></span></span><span class="bar-value">${v}</span></div>`).join('')}</div>`:'<p class="hint">No gender details recorded yet.</p>'}</div></section>
    <section class="panel" style="grid-column:1/-1"><div class="panel-head"><h3 class="panel-title">Upcoming birthdays</h3></div><div class="panel-body">${i.birthdays.length?`<div class="birthday-list">${i.birthdays.map(b=>`<div class="birthday-item"><span><b>${lk(b)}</b> turns ${b.turns}</span><span class="when">${b.inDays===0?'Today':'In '+b.inDays+' days'}, ${b.date}</span></div>`).join('')}</div>`:'<p class="hint">No birthdays in the next 60 days.'+(S.role?'':' Birthdays are shown to people who have access to the tree.')+'</p>'}</div></section>
  </div>`;
}

// ---- Authentication recovery and account ----
function forgotView(){
  $('#app').innerHTML=authShell('Forgot your password?','Enter your email and we will send you a link to choose a new one.',
    `<form id="ff" novalidate>
      <div class="field"><label class="field-label" for="ff-email">Email</label><input id="ff-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
      <div class="err" id="err"></div>
      <div class="hint" id="ok" role="status"></div>
      <button class="btn pri btn-block">Send the link</button>
    </form>`,
    '<a href="#/">Back to log in</a>');
  $('#ff').onsubmit=async e=>{e.preventDefault();const err=$('#err'),ok=$('#ok');try{await api('/auth/forgot','POST',Object.fromEntries(new FormData(e.target)));setText(err,'');setText(ok,'If that email has an account, a link is on its way. It works for one hour.')}catch(x){setText(err,x.message)}};
}

function resetView(q){
  $('#app').innerHTML=authShell('Choose a new password','Choose a strong password you have not used before.',
    `<form id="rf" novalidate>
      <div class="field"><label class="field-label" for="rf-password">New password</label><input id="rf-password" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <div class="err" id="err"></div>
      <div class="hint" id="ok" role="status"></div>
      <button class="btn pri btn-block">Save password</button>
    </form>`,
    '<a href="#/">Back to log in</a>');
  $('#rf').onsubmit=async e=>{e.preventDefault();const err=$('#err'),ok=$('#ok'),vid=viewId;try{await api('/auth/reset','POST',{token:q.get('token')||'',password:e.target.password.value});setText(err,'');setText(ok,'Your password is changed. You can log in now.');setTimeout(()=>{if(vid===viewId)location.hash='#/'},1800)}catch(x){setText(err,x.message)}};
}

async function inviteView(q){
  const token=q.get('token')||'';
  const show=(title,lead,inner,links='')=>{
    if(tok){
      setCrumbs([['#/','My trees'],['#/invite','Invitation']]);
      $('#app').innerHTML=`<div class="page"><div class="page-header"><div class="page-title-group"><span class="eyebrow">Invitation</span><h2>${esc(title)}</h2><p class="page-subtitle">${esc(lead)}</p></div></div>
        <div class="panel"><div class="panel-body stack">${inner}${links?`<div class="form-actions">${links}</div>`:''}</div></div></div>`;
    } else {
      $('#app').innerHTML=authShell(esc(title),esc(lead),inner,links);
    }
  };
  if(!token)return show('Invitation not found','This invitation link is missing its token. Ask the tree owner to send it again.','','<a href="#/">Go to log in</a>');
  let info;
  try{info=await api('/invites/'+encodeURIComponent(token))}catch(x){return show('Invitation not found',x.message,'','<a href="#/">Go to log in</a>')}
  const treeName=info.tree&&info.tree.name||'this family tree';
  if(info.status==='accepted'){
    try{sessionStorage.removeItem('inviteToken')}catch{}
    return show('Invitation already accepted',`You have already joined “${treeName}”.`,`<div class="fact"><span>Your role</span><b>${esc(info.role)}</b></div>`,`<a class="btn pri" href="#/t/${info.tree.id}">Open ${esc(treeName)}</a>`);
  }
  if(info.status==='declined')return show('Invitation declined',`You declined the invitation to “${treeName}”.`,'','<a href="#/">Go to your trees</a>');
  if(info.status==='expired')return show('Invitation expired',`The invitation to “${treeName}” has expired. Ask the owner to send a new one.`,'','<a href="#/">Go to your trees</a>');
  try{sessionStorage.setItem('inviteToken',token)}catch{}
  const details=`<div class="fact"><span>Tree</span><b data-i18n-skip>${esc(treeName)}</b></div><div class="fact"><span>Your role</span><b data-i18n-skip>${esc(info.role)}</b></div><div class="fact"><span>Sent to</span><b data-i18n-skip>${esc(info.email||'')}</b></div><div class="fact"><span>Expires</span><b data-i18n-skip>${esc(new Date(info.expires_at).toLocaleDateString())}</b></div>`;
  if(!tok){
    return show('You are invited',`Join “${treeName}” as ${info.role}.`,
      `<div class="stack">${details}</div><p class="hint">Log in with the email address this invitation was sent to. If you do not have an account yet, create one first.</p>`,
      '<a class="btn pri" href="#/">Log in to accept</a><a class="btn" href="#/register">Create an account</a>');
  }
  show('You are invited',`Join “${treeName}” as ${info.role}.`,`<div class="stack">${details}</div><div class="err" id="ie"></div>`,
    '<button class="btn pri" id="iaccept" type="button">Accept invitation</button><button class="btn" id="idecline" type="button">Decline</button><a class="btn" href="#/">Not now</a>');
  $('#iaccept').onclick=async()=>{
    const vid=viewId,err=$('#ie');try{const r=await api('/invites/accept','POST',{token});try{sessionStorage.removeItem('inviteToken')}catch{}
      if(vid!==viewId)return;location.hash='#/t/'+r.tree.id}catch(x){setText(err,x.message)}
  };
  $('#idecline').onclick=async()=>{
    if(!confirm('Decline this invitation?'))return;
    const vid=viewId,err=$('#ie');try{await api('/invites/decline','POST',{token});try{sessionStorage.removeItem('inviteToken')}catch{}
      if(vid===viewId)show('Invitation declined',`You declined the invitation to “${treeName}”.`,'','<a href="#/">Go to your trees</a>')}catch(x){setText(err,x.message)}
  };
}

async function accountView(){
  if(!tok){location.hash='#/';return}
  const vid=viewId,[me,acts]=await Promise.all([api('/me'),api('/me/activity')]);
  if(vid!==viewId)return;
  setAuthMode(false);
  setCrumbs([['#/','My trees'],['#/account','Account']]);
  const initial=(me.name||me.email||'?').trim().charAt(0).toUpperCase();
  $('#app').innerHTML=`<div class="account-head"><span class="member-avatar">${esc(initial)}</span><div><h2>Your account</h2><p id="acct-who" data-i18n-skip>${esc(me.email)}${me.name?' · '+esc(me.name):''}</p></div></div>
  <div class="account-grid">
    <section class="panel">
      <div class="panel-head"><h3 class="panel-title">Profile</h3></div>
      <div class="panel-body"><form id="nf2" class="stack">
        <div class="field"><label class="field-label" for="nf2-name">Your name</label><input id="nf2-name" name="name" value="${esc(me.name||'')}" maxlength="80" autocomplete="name"></div>
        <div class="hint" id="o1" role="status"></div>
        <div class="form-actions"><button class="btn pri">Save</button></div>
      </form></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3 class="panel-title">Email address</h3></div>
      <div class="panel-body"><form id="em" class="stack">
        <div class="field"><label class="field-label" for="em-email">New email address</label><input id="em-email" name="email" type="email" required autocomplete="email" value="${esc(me.email)}"></div>
        <div class="field"><label class="field-label" for="em-password">Your password</label><input id="em-password" name="password" type="password" required autocomplete="current-password"></div>
        <div class="hint">Changing your email signs out your other devices.</div>
        <div class="err" id="e4"></div><div class="hint" id="o4" role="status"></div>
        <div class="form-actions"><button class="btn pri">Change email</button></div>
      </form></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3 class="panel-title">Change your password</h3></div>
      <div class="panel-body"><form id="pw" class="stack">
        <div class="field"><label class="field-label" for="pw-current">Current password</label><input id="pw-current" name="current" type="password" required autocomplete="current-password"></div>
        <div class="field"><label class="field-label" for="pw-password">New password</label><input id="pw-password" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
        <div class="err" id="e2"></div><div class="hint" id="o2" role="status"></div>
        <div class="form-actions"><button class="btn pri">Change password</button></div>
      </form></div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h3 class="panel-title">Account activity</h3><div class="panel-sub">Recent sign-in and security changes on your account.</div></div></div>
      <div class="panel-body">${acts.length?`<ol class="timeline">${acts.map(a=>`<li class="timeline-item"><span class="timeline-dot">${ico('shield')}</span><div class="timeline-body"><b>${esc(a.action)}</b>${a.detail?`<p data-i18n-skip>${esc(a.detail)}</p>`:''}<span class="timeline-meta">${esc(a.at)} UTC</span></div></li>`).join('')}</ol>`:'<p class="hint">No account activity has been recorded yet.</p>'}</div>
    </section>
    <section class="panel panel-danger danger-zone">
      <div class="panel-head"><h3 class="panel-title">Delete your account</h3></div>
      <div class="panel-body"><form id="del" class="stack">
        <p class="hint">This removes your account and every tree you own. It cannot be undone.</p>
        <div class="field"><label class="field-label" for="del-password">Your password</label><input id="del-password" name="password" type="password" required autocomplete="current-password"></div>
        <div class="err" id="e3"></div>
        <div class="form-actions"><button class="btn del">Delete my account</button></div>
      </form></div>
    </section>
  </div>`;
  $('#nf2').onsubmit=async e=>{e.preventDefault();const out=$('#o1');try{await api('/me','PATCH',{name:e.target.name.value});setText(out,'Saved.')}catch(x){setText(out,x.message)}};
  $('#em').onsubmit=async e=>{e.preventDefault();const err=$('#e4'),out=$('#o4');try{const d=await api('/me/email','POST',Object.fromEntries(new FormData(e.target)));tok=d.token;localStorage.setItem('tok',tok);clearMedia();e.target.password.value='';setText(err,'');setText(out,'Your email address has been changed.');const who=$('#acct-who');if(who)who.textContent=d.email}catch(x){setText(err,x.message)}};
  $('#pw').onsubmit=async e=>{e.preventDefault();const err=$('#e2'),out=$('#o2');try{const d=await api('/me/password','POST',Object.fromEntries(new FormData(e.target)));tok=d.token;localStorage.setItem('tok',tok);clearMedia();e.target.reset();setText(err,'');setText(out,'Your password has been changed. Other devices were signed out.')}catch(x){setText(err,x.message)}};
  $('#del').onsubmit=async e=>{e.preventDefault();if(!confirm('Delete your account and every tree you own? This cannot be undone.'))return;
    const err=$('#e3');try{await api('/me','DELETE',{password:e.target.password.value});endSession()}catch(x){setText(err,x.message)}};
}


// ---- Relationships, tidy-up and data loading ----
async function marriageView(mid){
  const vid=viewId,tid=S.tree.id;let m=S.marriages.find(x=>x.id===mid);
  if(!m){const d=await api('/trees/'+tid);if(vid!==viewId)return;d.people.forEach(p=>{if(!byId(p.id))S.people.push(p)});d.marriages.forEach(x=>{if(!S.marriages.some(y=>y.id===x.id))S.marriages.push(x)});m=S.marriages.find(x=>x.id===mid)}
  if(!m||!S.canEdit)return $('#app').innerHTML='<div class="page"><div class="empty-state"><span class="empty-icon">'+ico('alert')+'</span><h2>We could not open that relationship</h2></div></div>';
  const a=byId(m.a_id),b=byId(m.b_id),names=[a,b].filter(Boolean).map(x=>uc(x.name)).join(' and ');
  treeCrumbs('Relationship');
  $('#app').innerHTML=`<div class="form-page">
    <div class="profile-topbar"><a class="back" href="#/t/${tid}/p/${(a||b).id}" data-back>Cancel</a></div>
    <div class="form-shell">
      <div class="form-shell-head"><span class="eyebrow">Relationship</span><h2>${names||'Single parent family'}</h2><p>Record how these people are connected.</p></div>
      <form class="form-shell-body" id="mf2">
        <div class="form-grid">
          ${field('mf2-kind','Relationship',`<select id="mf2-kind" name="kind">${(m.kind==='single'?[['single','Single parent']]:[]).concat([['married','Married'],['partner','Partners'],['divorced','Divorced'],['separated','Separated']]).map(([k,t])=>`<option value="${k}" ${(m.kind||'married')===k?'selected':''}>${t}</option>`).join('')}</select>`)}
          ${field('mf2-year','Year it began',`<input id="mf2-year" name="year" type="number" min="1000" max="2200" value="${m.year||''}">`)}
          ${field('mf2-end-year','Year it ended (if it did)',`<input id="mf2-end-year" name="end_year" type="number" min="1000" max="2200" value="${m.end_year||''}">`)}
        </div>
        <div class="err" id="err"></div>
        <div class="form-actions"><button class="btn pri">Save</button><button class="btn del" id="rmm" type="button">Remove relationship</button></div>
      </form>
    </div>
  </div>`;
  $('#mf2').onsubmit=async e=>{e.preventDefault();const err=$('#err'),vid=viewId;try{await api('/marriages/'+mid,'PUT',Object.fromEntries(new FormData(e.target)));if(vid!==viewId)return;await load(tid);if(vid===viewId)history.length>1?history.back():location.hash='#/t/'+tid}catch(x){setText(err,x.message)}};
  $('#rmm').onclick=async()=>{if(!confirm('Remove this relationship? The people themselves stay in the tree.'))return;const vid=viewId;try{await api('/marriages/'+mid,'DELETE');if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash='#/t/'+tid}catch(x){alert(x.message)}};
}

async function tidyView(){
  const vid=viewId,tid=S.tree.id;
  if(!S.canEdit)return $('#app').innerHTML='<div class="page"><div class="empty-state"><span class="empty-icon">'+ico('tidy')+'</span><h2>Only editors can tidy the tree</h2></div></div>';
  const [c,d]=await Promise.all([api(`/trees/${tid}/checks`),api(`/trees/${tid}/duplicates`)]);
  if(vid!==viewId)return;
  treeCrumbs('Tidy up');
  const lk=p=>`<a href="#/t/${tid}/p/${p.id}">${uc(p.name)}</a>`;
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group"><span class="eyebrow" data-i18n-skip>${esc(S.tree.name)}</span><h2>Tidy up your tree</h2><p class="page-subtitle">Things that look wrong, and people who may be recorded twice.</p></div>
  </div>
  <div class="section-stack">
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Possible duplicates</div><div class="panel-sub">Check these pairs before merging. A merge cannot be undone.</div></div><span class="badge">${d.length}</span></div>
      <div class="panel-body">${d.length?`<div class="duplicate-list">${d.map(x=>`<div class="duplicate"><div class="dup-pair"><span class="dup-side"><b>${lk(x.a)}</b><span>${esc(life(x.a))}</span></span><span class="dup-vs">and</span><span class="dup-side"><b>${lk(x.b)}</b><span>${esc(life(x.b))}</span></span></div><p data-i18n-skip>${esc(x.reason)}</p><div class="dup-actions"><button class="btn btn-sm" data-merge="${x.b.id}:${x.a.id}" data-names="${esc(x.a.name)}" type="button">Keep the first</button><button class="btn btn-sm" data-merge="${x.a.id}:${x.b.id}" data-names="${esc(x.b.name)}" type="button">Keep the second</button></div></div>`).join('')}</div>`:'<div class="empty-state"><span class="empty-icon">'+ico('check')+'</span><h3>No duplicates found.</h3><p>Everyone in this tree looks distinct.</p></div>'}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><div class="panel-title">Checks</div><div class="panel-sub">Dates and relationships that may need another look.</div></div><span class="badge">${c.issues.length}</span></div>
      <div class="panel-body">${c.issues.length?`<div class="issue-list">${c.issues.map(i=>`<div class="issue ${i.level==='warning'?'warn':''}">${i.person?`<div class="issue-person"><b>${lk(i.person)}</b></div>`:''}<p>${esc(i.text)}</p></div>`).join('')}</div>`:'<div class="empty-state"><span class="empty-icon">'+ico('shield')+'</span><h3>No problems found.</h3><p>Dates, parents and relationships look consistent.</p></div>'}</div>
    </section>
  </div>`;
  document.querySelectorAll('[data-merge]').forEach(b=>b.onclick=async()=>{const[drop,keep]=b.dataset.merge.split(':').map(Number);
    if(!confirm(`Merge into ${b.dataset.names}? The repeat is removed and its details are added to the one you keep. This cannot be undone.`))return;
    const vid=viewId;try{await api(`/people/${drop}/merge`,'POST',{into:keep});if(vid!==viewId)return;await load(tid);if(vid===viewId)tidyView()}catch(x){alert(x.message)}});
}

async function load(id,vid=viewId){try{const r=await api('/trees/'+id+'?depth=2');if(vid!==viewId)return;S=r;S.loaded=new Set()}catch(e){if(vid===viewId)S=null;throw e}}
async function ensure(pid){ // fetch one person's spouses and children when they were not in the first load
  if(S.loaded.has(pid))return;const vid=viewId,r=await api('/people/'+pid+'/branch');if(vid!==viewId)return;
  r.people.forEach(p=>{const i=S.people.findIndex(x=>x.id===p.id);i<0?S.people.push(p):S.people[i]=p});
  r.marriages.forEach(m=>{if(!S.marriages.some(x=>x.id===m.id))S.marriages.push(m)});S.loaded.add(pid);
}

// ---- Routing ----
async function route(){
  await configReady;
  const rid=++viewId,[path,qs]=(location.hash||'#/').slice(1).split('?'),q=new URLSearchParams(qs||''),m=path.match(/^\/t\/(\d+)(?:\/(gc|share|history|chart|insights|tidy|search|p\/(\d+)|new|edit\/(\d+)|ped\/(\d+)|marriage\/(\d+)))?$/);
  setDrawer(false);
  try{
    const sf=$('#sf');if(sf)sf.hidden=!m;
    if(!m){
      $('#title').textContent='Family Tree';
      if(path==='/invite'){
        setAuthMode(!tok);
        setCrumbs(tok?[['#/','My trees'],['#/invite','Invitation']]:[]);
        nav(tok?[['#/','My trees',false,'trees'],[0,'Log out',false,'logout']]:[['#/','Log in',false,'login']]);
        return await inviteView(q);
      }
      const pg=path==='/account'?'account':path==='/forgot'?'forgot':path==='/reset'?'reset':path==='/register'?'register':'';
      const signedOut=!tok||pg==='forgot'||pg==='reset';
      setAuthMode(signedOut);
      if(!signedOut)setCrumbs(pg==='account'?[['#/','My trees'],['#/account','Account']]:[['#/','My trees']]);
      nav(tok?[['#/','My trees',pg==='','trees'],['#/account','Account',pg==='account','account'],[0,'Log out',false,'logout']]:[['#/','Log in',!pg,'login']]);
      return await (pg==='account'?accountView():pg==='forgot'?forgotView():pg==='reset'?resetView(q):home());
    }
    setAuthMode(false);
    if(!S||S.tree.id!=m[1])await load(m[1],rid);
    if(rid!==viewId)return;
    const sub=m[2]||'';
    const active=sub==='gc'?'gc':sub==='chart'?'chart':sub==='insights'?'insights':sub==='tidy'?'tidy':sub==='history'?'history':sub==='share'?'share':'t';
    const manage=[];
    if(S.canEdit)manage.push(['#/t/'+S.tree.id+'/tidy','Tidy up',active==='tidy','tidy'],['#/t/'+S.tree.id+'/history','History',active==='history','history']);
    if(S.role==='owner')manage.push(['#/t/'+S.tree.id+'/share','Share and export',active==='share','share']);
    nav([...tabs(S.tree.id,active),...(manage.length?[['sep'],...manage]:[['sep']]),...(tok?[['#/account','Account',false,'account'],[0,'Log out',false,'logout']]:[['#/','Log in',false,'login']])]);
    $('#title').textContent=S.tree.name;
    if(sub==='gc')grandView();
    else if(sub==='share')await shareView();
    else if(sub==='history')await historyView(q);
    else if(sub==='search')await searchView(q);
    else if(sub==='chart')await chartView(q);
    else if(sub==='insights')await insightsView();
    else if(m[5])await pedView(+m[5]);
    else if(sub==='tidy')await tidyView();
    else if(m[6])await marriageView(+m[6]);
    else if(m[3]){await ensure(+m[3]);if(rid!==viewId)return;personView(+m[3])}
    else if(sub==='new'){if(q.get('parents')){await ensure(+q.get('parents'));if(rid!==viewId)return}formView(q)}
    else if(m[4]){await ensure(+m[4]);if(rid!==viewId)return;formView(q,+m[4])}
    else treeView();
    if(rid!==viewId)return;
    scrollTo(0,0);
  }catch(x){
    if(rid!==viewId)return;
    console.error('Route failed:',x);
    const app=$('#app'),html=`<div class="route-error"><h2>That didn't work</h2><p>${esc(x.message)}</p></div>`;
    if(app)app.innerHTML=html;else document.body.insertAdjacentHTML('afterbegin',html);
  }
}

// ---- App chrome: drawer, theme, search ----
const sidebar=$('#sidebar'),scrim=$('#scrim'),menuBtn=$('#menu'),navClose=$('#navclose');
function setDrawer(on,restore){
  const open=!!on;
  document.body.classList.toggle('nav-open',open);
  if(menuBtn)menuBtn.setAttribute('aria-expanded',String(open));
  if(scrim)scrim.hidden=!open;
  if(open){if(navClose)navClose.focus()}else if(restore&&menuBtn)menuBtn.focus();
}
if(menuBtn)menuBtn.onclick=()=>setDrawer(!document.body.classList.contains('nav-open'));
if(navClose)navClose.onclick=()=>setDrawer(false,true);
if(scrim)scrim.onclick=()=>setDrawer(false,true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('nav-open'))setDrawer(false,true)});
const navEl=$('#nav');if(navEl)navEl.addEventListener('click',e=>{if(e.target.closest('a'))setDrawer(false)});

const THEMES=[
  ['sunny','Sunny','Warm neutrals and forest green',['#F3F0E9','#2F5A46','#9A7838']],
  ['heritage','Heritage','A classic archival record',['#F4EFE5','#3B6047','#A17C3C']],
  ['midnight','Midnight','A quiet low-light workspace',['#101316','#6EAF8B','#C9AE76']],
  ['blossom','Blossom','Soft plum and aged brass',['#F5F2F5','#5F4A83','#9C7B42']],
  ['clean','Clean','Crisp, high-contrast clarity',['#F4F4F4','#245E8A','#5E5E5E']]
];
const tpEl=$('#tp');if(tpEl)tpEl.innerHTML=THEMES.map(([k,n,d,c])=>`<button class="topt" data-theme="${k}" aria-pressed="false" type="button"><span class="sws">${c.map(x=>`<i style="background:${x}"></i>`).join('')}</span><span><b>${n}</b><small>${d}</small></span></button>`).join('');
function setTheme(t){
  document.documentElement.dataset.theme=t;
  try{localStorage.setItem('theme',t)}catch{}
  const meta=document.querySelector('meta[name=theme-color]');
  if(meta)meta.content=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('.topt').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.theme===t)));
}
const tpOpen=o=>{if(!tpEl)return;tpEl.hidden=!o;const tb=$('#tb');if(tb)tb.setAttribute('aria-expanded',String(!!o))};
const tbEl=$('#tb');if(tbEl)tbEl.onclick=()=>tpOpen(tpEl&&tpEl.hidden);
if(tpEl)tpEl.onclick=e=>{const b=e.target.closest('.topt');if(b){setTheme(b.dataset.theme);tpOpen(false);if(tbEl)tbEl.focus()}};
document.addEventListener('click',e=>{if(!e.target.closest('.tw'))tpOpen(false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')tpOpen(false)});
setTheme(document.documentElement.dataset.theme||'sunny');

let st;
const qEl=$('#q'),resEl=$('#res'),sfEl=$('#sf');
if(qEl)qEl.addEventListener('input',e=>{clearTimeout(st);const v=e.target.value.trim();if(v.length<2||!S){if(resEl)resEl.innerHTML='';return}
  st=setTimeout(async()=>{if(!S)return;const tid=S.tree.id;try{const r=await api(`/trees/${tid}/search?q=${encodeURIComponent(v)}&limit=8`);
    if(!S||S.tree.id!==tid)return;
    if(resEl)resEl.innerHTML=r.length?r.map(p=>`<a href="#/t/${tid}/p/${p.id}"><b data-i18n-skip>${esc(p.name)}</b> <small>${esc(life(p))}</small></a>`).join('')+`<a class="search-all" href="#/t/${tid}/search?q=${encodeURIComponent(v)}">See all results ${ico('chevron')}</a>`:'<p>No one found with that name.</p>'}catch{if(resEl)resEl.innerHTML=''}},250)});
if(sfEl)sfEl.addEventListener('click',e=>{if(e.target.closest('a')){if(qEl)qEl.value='';if(resEl)resEl.innerHTML=''}});
if(qEl)qEl.addEventListener('keydown',e=>{if(e.key==='Escape'){e.target.value='';if(resEl)resEl.innerHTML=''}});
if(sfEl)sfEl.onsubmit=e=>{e.preventDefault();const v=qEl?qEl.value.trim():'';if(!S||v.length<2)return;if(resEl)resEl.innerHTML='';location.hash=`#/t/${S.tree.id}/search?q=${encodeURIComponent(v)}`};

document.addEventListener('click',e=>{if(e.target.closest('[data-back]')){e.preventDefault();history.length>1?history.back():location.hash='#/'}});
document.addEventListener('click',e=>{if(e.target.closest('[data-print]'))print()});
if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));

addEventListener('hashchange',route);
route();
