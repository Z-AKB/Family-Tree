const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let tok=localStorage.getItem('tok'),S=null,viewId=0;const $=s=>document.querySelector(s),open=new Set();
const live=el=>!!(el&&el.isConnected),setText=(el,v)=>{if(live(el))el.textContent=v};
async function api(path,method='GET',body){
  const h={};if(tok)h.Authorization='Bearer '+tok;
  if(typeof body==='string')h['Content-Type']='text/plain';else if(body&&!(body instanceof FormData)){h['Content-Type']='application/json';body=JSON.stringify(body)}
  const r=await fetch('/api'+path,{method,headers:h,body}),d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||'Something went wrong. Please try again.');return d}
const byId=id=>S.people.find(p=>p.id==id),margs=id=>S.marriages.filter(m=>m.a_id==id||m.b_id==id);
const mate=(m,id)=>byId(m.a_id==id?m.b_id:m.a_id),kidsOfM=m=>S.people.filter(p=>p.parent_marriage_id==m.id),kidsOf=id=>margs(id).flatMap(kidsOfM);
const KL={married:'Married',partner:'Partners',divorced:'Divorced',separated:'Separated'};
const mlabel=m=>m.kind==='divorced'?(m.year?`Married ${m.year}, divorced${m.end_year?' '+m.end_year:''}`:`Divorced${m.end_year?' '+m.end_year:''}`):(KL[m.kind||'married']||'Married')+(m.year?' '+m.year:'');
const ksub=k=>life(k)+(k.parent_kind&&k.parent_kind!=='biological'?', '+k.parent_kind:'');
const sel=(n,opts,v)=>`<select name="${n}">${opts.map(([k,t])=>`<option value="${k}" ${(v||opts[0][0])===k?'selected':''}>${t}</option>`).join('')}</select>`;
const recURL=p=>{const w=p.name.trim().split(/\s+/),sur=w.length>1?w.pop():'',y=(p.dob||'').slice(0,4),u=new URLSearchParams({'q.givenName':w.join(' '),'q.surname':sur});if(/^\d{4}$/.test(y)){u.set('q.birthLikeDate.from',y);u.set('q.birthLikeDate.to',y)}return 'https://www.familysearch.org/search/record/results?'+u};
const COL=['#FFD9A8','#C9ECD9','#CFE3FF','#FFD0CC','#E3D9FF','#FFF0A8'];
const av=(p,s)=>`<div class="av ${p.dod?'gone':''}" style="--s:${s}px;${p.photo?`background-image:url(${esc(p.photo)})`:`background-color:${COL[p.id%6]}`}">${p.photo?'':esc(p.name.split(' ').map(w=>w[0]).join('').slice(0,3))}</div>`;
const life=p=>p.dod?`${p.dob?yr(p.dob,p.dob_q):'?'} to ${p.dod==='unknown'?'?':yr(p.dod,p.dod_q)}`:(p.dob?`Born ${yr(p.dob,p.dob_q)}`:'Birth date not known');
const Q={about:'About ',before:'Before ',after:'After '},MN=['January','February','March','April','May','June','July','August','September','October','November','December'];
const mon=m=>new Date(Date.UTC(2000,m-1,1)).toLocaleString(document.documentElement.lang||'en',{month:'long',timeZone:'UTC'});
const fmt=(d,q)=>{if(!d)return 'Not known';if(d==='unknown')return 'Date not known';const[y,m,dd]=d.split('-');return (Q[q]||'')+(dd?+dd+' ':'')+(m?mon(m)+' ':'')+y};
const yr=(d,q)=>(Q[q]?Q[q].toLowerCase():'')+d.slice(0,4);
const ageTxt=p=>p.age==null?'Not known':(p.dob_q||p.dod_q?'About ':'')+p.age;
const qsel=(n,v)=>`<select name="${n}" aria-label="How exact is this date">${[['','Exact'],['about','About'],['before','Before'],['after','After']].map(([k,t])=>`<option value="${k}" ${(v||'')===k?'selected':''}>${t}</option>`).join('')}</select>`;
const card=(p,sub)=>`<a class="person" href="#/t/${S.tree.id}/p/${p.id}">${av(p,76)}<b>${esc(p.name)}</b><small>${esc(sub)}</small></a>`;
const nav=(items)=>{$('#nav').innerHTML=items.map(([h,t,c])=>h?`<a href="${h}" ${c?'aria-current="page"':''}>${t}</a>`:`<button id="out">${t}</button>`).join('');
  const o=$('#out');if(o)o.onclick=()=>{localStorage.removeItem('tok');tok=null;location.hash='#/'}
  const c=$('#nav [aria-current="page"]');if(c)c.scrollIntoView({inline:'center',block:'nearest'})};

function authView(mode='login'){
  $('#app').innerHTML=`<div class="intro"><h2>${mode==='login'?'Welcome back':'Start your family tree'}</h2><p>Try the demo: demo@family.test and demo1234.</p></div>
  <form class="f" id="af">${mode==='register'?'<label>Your name<input name="name" required></label>':''}<label>Email<input name="email" type="email" required></label>
  <label>Password<input name="password" type="password" minlength="8" required></label><div class="err" id="err"></div>
  <button class="btn pri">${mode==='login'?'Log in':'Create account'}</button><a href="#/${mode==='login'?'register':''}" class="more" style="text-align:center">${mode==='login'?'Create an account':'I already have an account'}</a>${mode==='login'?'<a href="#/forgot" class="more" style="text-align:center">Forgot your password?</a>':''}</form>`;
  $('#af').onsubmit=async e=>{e.preventDefault();const err=$('#err');try{const d=await api('/auth/'+mode,'POST',Object.fromEntries(new FormData(e.target)));tok=d.token;localStorage.setItem('tok',tok);location.hash='#/'}catch(x){setText(err,x.message)}}}

async function home(){
  if(!tok)return authView(location.hash==='#/register'?'register':'login');
  const vid=viewId,ts=await api('/trees');
  if(vid!==viewId)return;
  $('#app').innerHTML=`<div class="page-header">
    <div class="page-title-group">
      <h2 class="page-title">My Family Trees</h2>
      <p class="page-subtitle">Manage and explore your family histories in one place.</p>
    </div>
    <div class="page-actions">
      <a class="btn pri" href="#/">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Create family tree
      </a>
    </div>
  </div>
  ${ts.length?`<div class="tree-grid">
    ${ts.map(t=>`<a class="tree-card" href="#/t/${t.id}">
      <div class="tree-card-header">
        <div class="tree-card-title">${esc(t.name)}</div>
      </div>
      <div class="tree-card-meta">
        ${t.role!=='owner'?`<span>Shared as ${esc(t.role)}</span>`:`<span>Owner</span>`}
      </div>
      <div class="tree-card-footer">
        <span>Open tree</span>
        <span class="tree-card-link">
          View
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </span>
      </div>
    </a>`).join('')}
  </div>`:`<div class="form-card" style="margin-top:12px">
    <div class="form-card-header">
      <div class="form-card-title">No family trees yet</div>
      <div class="form-card-sub">Start preserving your family history by creating your first family tree.</div>
    </div>
  </div>`}
  <div style="margin-top:32px">
    <div class="page-header" style="margin-bottom:16px">
      <div class="page-title-group">
        <h3 style="font-size:22px">Create a family tree</h3>
        <p class="page-subtitle">Add your first person to get started.</p>
      </div>
    </div>
    <div class="form-card">
      <form class="form-card-body" id="nf">
        <div class="form-section">
          <div class="form-section-title">Tree details</div>
          <div class="field">
            <label class="field-label" for="nf-name">Tree name</label>
            <input id="nf-name" name="name" required placeholder="The Okafor Family">
          </div>
        </div>
        <div class="form-section">
          <div class="form-section-title">Start with a person</div>
          <div class="field">
            <label class="field-label" for="nf-rname">Full name</label>
            <input id="nf-rname" name="rname" required>
          </div>
          <div class="form-grid">
            <div class="field">
              <label class="field-label" for="nf-rgender">Gender</label>
              <select id="nf-rgender" name="rgender"><option>Male</option><option>Female</option><option>Other</option></select>
            </div>
            <div class="field">
              <label class="field-label" for="nf-rdob">Date of birth</label>
              <input id="nf-rdob" name="rdob" type="date" required>
            </div>
            <div class="field">
              <label class="field-label" for="nf-rdod">Date of death (leave empty if alive)</label>
              <input id="nf-rdod" name="rdod" type="date">
            </div>
          </div>
        </div>
        <div class="row">
          <button class="btn pri">Create family tree</button>
        </div>
        <div class="err" id="err"></div>
      </form>
    </div>
  </div>
  <div style="margin-top:32px">
    <div class="page-header" style="margin-bottom:16px">
      <div class="page-title-group">
        <h3 style="font-size:22px">Import from another app</h3>
        <p class="page-subtitle">Bring a GEDCOM file into a new tree.</p>
      </div>
    </div>
    <div class="form-card">
      <form class="form-card-body" id="gf">
        <div class="field">
          <label class="field-label" for="gf-name">Tree name</label>
          <input id="gf-name" name="name" required>
        </div>
        <div class="field">
          <label class="field-label" for="gf-file">GEDCOM file (.ged)</label>
          <input id="gf-file" name="file" type="file" accept=".ged,text/plain" required>
          <div class="field-hint">Supports standard GEDCOM exports.</div>
        </div>
        <div class="row">
          <button class="btn">Import tree</button>
        </div>
        <div class="err" id="eg"></div>
      </form>
    </div>
  </div>`;
  $('#gf').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),err=$('#eg'),vid=viewId;try{const d=await api('/trees/import?name='+encodeURIComponent(f.get('name')),'POST',await f.get('file').text());if(vid===viewId)location.hash='#/t/'+d.id}catch(x){setText(err,x.message)}};
  $('#nf').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),err=$('#err'),vid=viewId;
    try{const d=await api('/trees','POST',{name:f.name,root:{name:f.rname,gender:f.rgender,dob:f.rdob,dod:f.rdod}});if(vid===viewId)location.hash='#/t/'+d.id}catch(x){setText(err,x.message)}}}

const tabs=(id,cur)=>[['#/','My trees'],['#/t/'+id,'Family tree',cur==='t'],['#/t/'+id+'/chart','Chart',cur==='chart'],['#/t/'+id+'/gc','Grandchildren',cur==='gc'],['#/t/'+id+'/insights','Insights',cur==='insights']];
function treeView(){
  const root=byId(S.tree.root_id),bs=margs(root.id);
  $('#title').textContent=S.tree.name;
  $('#app').innerHTML=`<div class="intro"><h2>Where our family begins</h2><p>Tap anyone to see their story. Open a branch to meet the children.</p>
  ${S.canEdit?`<button class="btn" id="rn">Rename tree</button> <a class="btn" href="#/t/${S.tree.id}/new?s=${root.id}">Add a spouse</a>`:''}</div>
  <div class="tree">${card(root,life(root))}<div class="stem"></div><div class="branches">${bs.map(m=>{const sp=mate(m,root.id),ks=kidsOfM(m),o=open.has(m.id);
  return `<section class="branch"><span class="heart">♥ ${mlabel(m)}</span>${card(sp,life(sp))}
  <button class="more" data-t="${m.id}" aria-expanded="${o}">${ks.length?`${o?'Hide':'Meet'} ${ks.length} ${ks.length>1?'children':'child'}`:'No children yet'}</button>
  <div class="kids" ${o?'':'hidden'}>${ks.map(k=>card(k,ksub(k))).join('')}</div>
  ${S.canEdit?`<a class="btn" href="#/t/${S.tree.id}/new?m=${m.id}">Add a child</a>`:''}</section>`}).join('')}</div></div>`;
  document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{const k=+b.dataset.t;open.has(k)?open.delete(k):open.add(k);treeView()});
  const rn=$('#rn');if(rn)rn.onclick=async()=>{const n=prompt('New name for this tree',S.tree.name),vid=viewId;if(n)try{await api('/trees/'+S.tree.id,'PATCH',{name:n});if(vid!==viewId)return;await load(S.tree.id);if(vid===viewId)treeView()}catch(x){alert(x.message)}}}

function grandView(){
  const root=byId(S.tree.root_id),kids=kidsOf(root.id).filter(k=>kidsOf(k.id).length);
  $('#app').innerHTML=`<div class="intro"><h2>The grandchildren</h2><p>Grouped by their parents. Tap a card to open their page.</p></div>`+
  (kids.map(p=>`<section class="group"><h3>Children of ${esc(p.name)}</h3><div class="grid">${kidsOf(p.id).map(k=>card(k,(k.age==null?'Age not known':'Age '+k.age))).join('')}</div></section>`).join('')||'<p class="intro">No grandchildren have been added yet.</p>')}

function personView(id){
  const p=byId(id);if(!p)return $('#app').innerHTML='<div class="page"><p>We could not find that person.</p></div>';
  const f=(a,b)=>`<div class="fact"><span>${a}</span><b>${esc(b)}</b></div>`,ms=margs(p.id),ks=kidsOf(p.id),tid=S.tree.id,pm=S.marriages.find(x=>x.id==p.parent_marriage_id),pars=pm?[byId(pm.a_id),byId(pm.b_id)].filter(Boolean):[];
  $('#app').innerHTML=`<div class="page"><a class="back" href="#/" data-back>Back</a><div class="hero">${av(p,128)}<h2>${esc(p.name)}</h2>
  <span class="tag ${p.dod?'gone':''}">${p.status}</span>${S.canEdit?`<div class="row" style="justify-content:center"><label class="btn pri" style="margin-top:14px">Add a photo<input type="file" accept="image/*" id="ph" hidden></label></div>`:''}</div>
  <div class="facts">${f('Gender',p.gender||'Not set')}${f('Age',ageTxt(p)+(p.dod&&p.age!=null?' when they passed':''))}${f('Born',fmt(p.dob,p.dob_q))}${f('Passed away',p.dod?fmt(p.dod,p.dod_q):'Not applicable')}${f('Married',ms.length?'Yes':'No')}${f('Spouses',ms.length)}${f('Children',ks.length)}${p.birth_place?f('Born in',p.birth_place):''}${p.death_place?f('Place of death',p.death_place):''}</div>${p.notes?`<h3>About ${esc(p.name.split(' ')[0])}</h3><p class="notes">${esc(p.notes)}</p>`:''}
  ${pars.length?`<h3>Parents</h3><div class="grid">${pars.map(x=>card(x,life(x))).join('')}</div>`:''}
  ${ms.length?`<h3>Spouse${ms.length>1?'s':''}</h3><div class="grid">${ms.map(m=>card(mate(m,p.id),mlabel(m))).join('')}</div>`:''}
  ${ks.length?`<h3>Children</h3><div class="grid">${ks.map(k=>card(k,ksub(k))).join('')}</div>`:''}
  <div class="row" style="margin-top:20px"><a class="btn" href="#/t/${tid}/ped/${p.id}">See ancestors</a><a class="btn" href="${esc(recURL(p))}" target="_blank" rel="noopener">Search records on FamilySearch</a><button class="btn" data-print>Print</button></div>
  <h3>How are we related?</h3><div class="relbox"><input id="rq" type="search" autocomplete="off" placeholder="Type a name to compare with ${esc(p.name.split(' ')[0])}" aria-label="Find a person to compare"><div id="rres"></div><p id="rtxt" class="hint" aria-live="polite"></p></div>
  ${S.canEdit?`<div class="row" style="margin-top:20px"><a class="btn" href="#/t/${tid}/edit/${p.id}">Edit details</a>${p.parent_marriage_id?'':`<a class="btn" href="#/t/${tid}/new?parents=${p.id}">Add parents</a>`}${S.role==='owner'&&S.tree.root_id!=p.id?'<button class="btn" id="mkroot">Start the tree from here</button>':''}<a class="btn" href="#/t/${tid}/new?s=${p.id}">Add a spouse</a>${ms.map(m=>`<a class="btn" href="#/t/${tid}/marriage/${m.id}">Edit relationship with ${esc(mate(m,p.id).name)}</a>`).join('')}
  ${ms.map(m=>`<a class="btn" href="#/t/${tid}/new?m=${m.id}">Add a child with ${esc(mate(m,p.id).name)}</a>`).join('')}<button class="btn del" id="rm">Remove</button></div>`:''}<div id="att"></div><div id="rel"></div></div>`;
  const relEl=$('#rel');
  api('/people/'+p.id+'/relatives').then(r=>{const g=a=>Math.max(...a.map(x=>x.gen)),A=r.ancestors,D=r.descendants;
    if(live(relEl)&&(A.length||D.length))relEl.innerHTML='<h3>Family line</h3><p>'+(A.length?`${A.length} ancestor${A.length>1?'s':''} going back ${g(A)} generation${g(A)>1?'s':''}. `:'')+(D.length?`${D.length} descendant${D.length>1?'s':''} across ${g(D)} generation${g(D)>1?'s':''}.`:'')+'</p>'}).catch(()=>{});
  let rt;const rbox=$('#rres'),rtxt=$('#rtxt');
  $('#rq').oninput=e=>{clearTimeout(rt);const v=e.target.value.trim();if(v.length<2){rbox.innerHTML='';return}
    rt=setTimeout(async()=>{try{const r=(await api(`/trees/${tid}/search?q=${encodeURIComponent(v)}`)).filter(x=>x.id!==p.id);if(live(rbox))rbox.innerHTML=r.map(x=>`<button class="btn" data-rel="${x.id}">${esc(x.name)}</button>`).join('')||'<p>No one found.</p>'}catch{}},250)};
  rbox.onclick=async e=>{const b=e.target.closest('[data-rel]');if(!b)return;try{const t=(await api(`/people/${p.id}/related/${b.dataset.rel}`)).text;setText(rtxt,t);if(live(rbox))rbox.innerHTML=''}catch(x){setText(rtxt,x.message)}};
  const mk=$('#mkroot');if(mk)mk.onclick=async()=>{const vid=viewId;try{await api('/trees/'+tid,'PATCH',{root_id:p.id});if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash='#/t/'+tid}catch(x){alert(x.message)}};
  const attEl=$('#att');
  api(`/people/${p.id}/attachments`).then(list=>{const el=attEl;if(!live(el))return;const photos=list.filter(a=>a.kind==='photo'),docs=list.filter(a=>a.kind!=='photo'),del=a=>S.canEdit?`<button class="btn del" data-att="${a.id}">Remove</button>`:'';
    const furl=a=>a.file?`/api/attachments/${a.id}/file`:(a.url||'#');
    el.innerHTML=(photos.length?`<h3>Photo album</h3><div class="album">${photos.map(a=>`<figure><a href="${esc(furl(a))}" target="_blank" rel="noopener"><img src="${esc(furl(a))}" alt="${esc(a.title)}" loading="lazy"></a><figcaption>${esc(a.title)}${a.description?`<small>${esc(a.description)}</small>`:''}</figcaption>${del(a)}</figure>`).join('')}</div>`:'')
    +(docs.length?`<h3>Sources and documents</h3><ul class="srcs">${docs.map(a=>`<li><b>${esc(a.title)}</b> <small>${a.kind}</small>${a.description?`<p>${esc(a.description)}</p>`:''}${a.url?`<a href="${esc(a.url)}" target="_blank" rel="noopener">Open the web link</a>`:''}${a.file?`<a href="${esc(furl(a))}" target="_blank" rel="noopener">Open the file</a>`:''}${del(a)}</li>`).join('')}</ul>`:'')
    +(S.canEdit?`<details class="addatt"><summary class="btn">Add a photo, source or document</summary><form class="f" id="af"><label>Type${sel('kind',[['photo','Photo'],['source','Source'],['document','Document']])}</label><label>Title<input name="title" required maxlength="160"></label><label>Description<textarea name="description" rows="3" maxlength="2000"></textarea></label><label>Web link (optional)<input name="url" type="url" placeholder="https://"></label><label>File (image or PDF, up to 5 MB)<input name="file" type="file" accept="image/*,application/pdf"></label><div class="err" id="eatt"></div><button class="btn pri">Add</button></form></details>`:'');
    el.querySelectorAll('[data-att]').forEach(b=>b.onclick=async()=>{if(!confirm('Remove this item?'))return;const vid=viewId;try{await api('/attachments/'+b.dataset.att,'DELETE');if(vid===viewId)personView(id)}catch(x){alert(x.message)}});
    const af=$('#af');if(af)af.onsubmit=async e=>{e.preventDefault();const fd=new FormData(af),err=$('#eatt'),vid=viewId;if(!fd.get('file').size)fd.delete('file');try{await api(`/people/${p.id}/attachments`,'POST',fd);if(vid===viewId)personView(id)}catch(x){setText(err,x.message)}}}).catch(()=>{});
  const ph=$('#ph');if(ph)ph.onchange=async()=>{const fd=new FormData(),vid=viewId;fd.append('photo',ph.files[0]);try{await api('/people/'+p.id+'/photo','POST',fd);if(vid!==viewId)return;await load(tid);if(vid===viewId)personView(id)}catch(x){alert(x.message)}};
  const rm=$('#rm');if(rm)rm.onclick=async()=>{if(confirm('Remove '+p.name+' from the tree?')){const vid=viewId;try{await api('/people/'+p.id,'DELETE');if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash='#/t/'+tid}catch(x){alert(x.message)}}}}

function parentsForm(pid){
  const p=byId(pid),tid=S.tree.id;
  const one=(k,t)=>`<fieldset><legend>${t}</legend><label>Name<input name="${k}_name" required></label><label>Born (optional)<input name="${k}_dob" pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" placeholder="1932-03-04 or 1932"></label><label>Died (optional)<input name="${k}_dod" pattern="(\\d{4}(-\\d{2}(-\\d{2})?)?|unknown)" placeholder="2011-09-17 or 2011"></label></fieldset>`;
  $('#app').innerHTML=`<div class="page"><a class="back" href="#/" data-back>Cancel</a><form class="f" id="pf"><h2>Add the parents of ${esc(p.name)}</h2>${one('father','Father')}${one('mother','Mother')}
  <label>Year they married (optional)<input name="year" type="number" min="1600" max="2100"></label><div class="err" id="err"></div><button class="btn pri">Save</button></form></div>`;
  $('#pf').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),err=$('#err'),vid=viewId;
    try{await api('/people/'+pid+'/parents','POST',{father:{name:f.father_name,dob:f.father_dob,dod:f.father_dod},mother:{name:f.mother_name,dob:f.mother_dob,dod:f.mother_dod},year:f.year});if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash=`#/t/${tid}/p/${pid}`}catch(x){setText(err,x.message)}}}
function formView(q,pid){
  if(q.get('parents'))return parentsForm(+q.get('parents'));
  const tid=S.tree.id,p=pid?byId(pid):{},spouse=q.get('s'),m=q.get('m');
  $('#app').innerHTML=`<div class="page"><a class="back" href="#/" data-back>Cancel</a><form class="f" id="pf">
  <h2>${pid?'Edit '+esc(p.name):spouse?'Add a spouse':'Add a child'}</h2><label>Name<input name="name" required value="${esc(p.name)}"></label>
  <label>Gender<select name="gender">${['Male','Female','Other'].map(g=>`<option ${p.gender===g?'selected':''}>${g}</option>`).join('')}</select></label>
  <label>Date of birth<span class="row"><input name="dob" ${pid?'':'required'} pattern="\\d{4}(-\\d{2}(-\\d{2})?)?" placeholder="1932-03-04 or 1932" value="${esc(p.dob||'')}">${qsel('dob_q',p.dob_q)}</span></label>
  <label>Date of death (leave empty if alive)<span class="row"><input name="dod" pattern="(\\d{4}(-\\d{2}(-\\d{2})?)?|unknown)" placeholder="2011-09-17 or 2011" value="${esc(p.dod||'')}">${qsel('dod_q',p.dod_q)}</span></label>
  <div class="hint">You can enter a full date, a month (1932-03) or just a year.</div>
  <label>Born in (place)<input name="birth_place" maxlength="120" value="${esc(p.birth_place||'')}"></label><label>Place of death (if they have passed)<input name="death_place" maxlength="120" value="${esc(p.death_place||'')}"></label>
  <label>About this person<textarea name="notes" rows="4" maxlength="4000" placeholder="Stories, work, where they lived">${esc(p.notes||'')}</textarea></label>
  ${spouse?`<label>Relationship${sel('kind',[['married','Married'],['partner','Partners'],['divorced','Divorced'],['separated','Separated']],'married')}</label><label>Year it began<input name="year" type="number" min="1000" max="2200"></label><label>Year it ended (if it did)<input name="end_year" type="number" min="1000" max="2200"></label>`:''}${(m&&!pid)||(pid&&p.parent_marriage_id)?`<label>Relationship to the parents${sel('parent_kind',[['biological','Biological'],['adopted','Adopted'],['step','Step'],['foster','Foster']],p.parent_kind)}</label>`:''}<div class="hint" id="hint"></div><div class="err" id="err"></div><button class="btn pri">Save</button></form></div>`;
  const hint=()=>$('#hint').textContent='Status will be '+(pf.dod.value?'Deceased':'Alive'),pf=$('#pf');pf.oninput=hint;hint();
  pf.onsubmit=async e=>{e.preventDefault();const b=Object.fromEntries(new FormData(pf)),err=$('#err'),vid=viewId;
    try{if(pid)await api('/people/'+pid,'PUT',b);else await api(`/trees/${tid}/people`,'POST',{...b,spouse_of:spouse,parent_marriage_id:m});
      if(vid!==viewId)return;await load(tid);if(vid===viewId)location.hash=pid?`#/t/${tid}/p/${pid}`:'#/t/'+tid}catch(x){setText(err,x.message)}}}

async function shareView(){
  if(S.role!=='owner')return $('#app').innerHTML='<div class="intro"><h2>Only the owner can share this tree</h2></div>';
  const vid=viewId,t=S.tree,id=t.id,ms=await api(`/trees/${id}/members`);
  if(vid!==viewId)return;
  $('#app').innerHTML=`<div class="page"><h2 class="fun" style="margin-bottom:14px">Share and export</h2>
  <form class="f" id="vf"><label>Who can open the link<select name="visibility"><option value="private" ${t.visibility==='private'?'selected':''}>Only me and people I invite</option><option value="link" ${t.visibility==='link'?'selected':''}>Anyone with the link</option></select></label>
  <label class="row"><input type="checkbox" name="hide_living" ${t.hide_living?'checked':''}> Hide full birth dates and photos of living people from visitors</label><div class="err" id="e1"></div><button class="btn pri">Save settings</button></form>
  <h3>People you invited</h3>${ms.map(m=>`<div class="row"><b>${esc(m.name||m.email)}</b> <span>${m.role}</span> <button class="btn del" data-rm="${m.id}">Remove</button></div>`).join('')||'<p>No one yet.</p>'}
  <form class="f" id="mf" style="margin-top:14px"><label>Invite by email<input name="email" type="email" required></label><label>Role<select name="role"><option value="editor">Editor: can change the tree</option><option value="viewer">Viewer: can see everything</option></select></label><div class="err" id="e2"></div><button class="btn pri">Invite</button></form>
  <h3>Import</h3><p>Merge a GEDCOM file into this tree. It is safe to repeat: people already here are left as they are.</p><label class="btn">Choose a .ged file<input type="file" accept=".ged,text/plain" hidden id="imp"></label><div class="hint" id="impmsg"></div>
  <h3>Export</h3><div class="row"><button class="btn" data-ged="0">Download GEDCOM</button><button class="btn" data-ged="1">GEDCOM without living people's details</button><button class="btn" data-json>Full backup (JSON)</button></div></div>`;
  $('[data-json]').onclick=async()=>{const r=await fetch(`/api/trees/${id}/export.json`,{headers:{Authorization:'Bearer '+tok}});if(!r.ok)return alert('The backup did not work. Please try again.');const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=t.name.replace(/\W+/g,'-')+'.json';a.click()};
  const done=async vid=>{if(vid!==viewId)return;await load(id,vid);if(vid===viewId)await shareView()};
  $('#imp').onchange=async e=>{const f=e.target.files[0];if(!f)return;const vid=viewId,msg=$('#impmsg');try{const r=await api(`/trees/${id}/import`,'POST',await f.text());if(vid!==viewId)return;await load(id,vid);if(vid!==viewId)return;await shareView();if(vid!==viewId)return;
    setText($('#impmsg'),`Added ${r.added} new people and ${r.families} families. ${r.existing} were already in the tree.`+(r.notes.length?' '+r.notes.join(' '):''))}catch(x){setText(msg,x.message)}};
  $('#vf').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),err=$('#e1'),vid=viewId;try{await api('/trees/'+id,'PATCH',{visibility:f.get('visibility'),hide_living:f.get('hide_living')?1:0});await done(vid)}catch(x){setText(err,x.message)}};
  $('#mf').onsubmit=async e=>{e.preventDefault();const err=$('#e2'),vid=viewId;try{await api(`/trees/${id}/members`,'POST',Object.fromEntries(new FormData(e.target)));await done(vid)}catch(x){setText(err,x.message)}};
  document.querySelectorAll('[data-rm]').forEach(b=>b.onclick=async()=>{const vid=viewId;await api(`/trees/${id}/members/${b.dataset.rm}`,'DELETE');await done(vid)});
  document.querySelectorAll('[data-ged]').forEach(b=>b.onclick=async()=>{const r=await fetch(`/api/trees/${id}/export.ged?hideLiving=${b.dataset.ged}`,{headers:{Authorization:'Bearer '+tok}});
    if(!r.ok)return alert('The export did not work. Please try again.');const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=t.name.replace(/\W+/g,'-')+'.ged';a.click()})}
async function historyView(){
  if(!S.canEdit)return $('#app').innerHTML='<div class="intro"><h2>Only editors can see the history</h2></div>';
  const vid=viewId,h=await api(`/trees/${S.tree.id}/history`);
  if(vid!==viewId)return;
  $('#app').innerHTML=`<div class="page"><h2 class="fun" style="margin-bottom:14px">Recent changes</h2>${h.map(x=>`<div class="fact" style="margin-bottom:10px"><b>${esc(x.name||x.email||'Someone')} ${esc(x.action)}</b>${x.detail?': '+esc(x.detail):''}<span>${esc(x.at)} UTC</span></div>`).join('')||'<p>Nothing has changed yet.</p>'}</div>`}
// ---- Charts: drawn as SVG with the same data as the rest of the app ----
const NW=132,NH=84,HG=44,GAP=24,VG=64,ini=p=>p.name.split(' ').map(w=>w[0]).join('').slice(0,3);
const nlines=n=>{if(n.length<=14)return[n];const i=n.lastIndexOf(' ',14);return i>0?[n.slice(0,i),n.slice(i+1,i+17)]:[n.slice(0,14),n.slice(14,30)]};
const cnode=(p,cx,y,tid)=>{const L=nlines(p.name);return `<a href="#/t/${tid}/p/${p.id}"><g class="cnode"><rect class="cn${p.dod?' gone':''}" x="${cx-NW/2}" y="${y}" width="${NW}" height="${NH}" rx="14"/><circle cx="${cx}" cy="${y+21}" r="15" fill="${COL[p.id%6]}"/><text class="cin" x="${cx}" y="${y+26}" text-anchor="middle">${esc(ini(p))}</text>`+
  L.map((t,i)=>`<text class="cname" x="${cx}" y="${y+(L.length>1?47:52)+i*14}" text-anchor="middle">${esc(t)}</text>`).join('')+`<text class="cdates" x="${cx}" y="${y+NH-7}" text-anchor="middle">${esc(life(p))}</text></g></a>`};
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
  place(rootId,20,20);return{svg:lines+nodes,W:w(rootId)+40,H:maxY+NH+40}}
function pedChart(d,tid,rootId){
  const byI=Object.fromEntries(d.people.map(p=>[p.id,p])),M=Object.fromEntries(d.marriages.map(m=>[m.id,m]));let nodes='',lines='';
  const par=id=>{const m=M[byI[id]&&byI[id].parent_marriage_id];return m?[byI[m.a_id],byI[m.b_id]].filter(Boolean).sort((a,b)=>(b.gender==='Male')-(a.gender==='Male')):[]};
  const dep=id=>{const k=par(id);return k.length?1+Math.max(...k.map(x=>dep(x.id))):0},G=dep(rootId);
  const w=id=>{const k=par(id);return k.length?k.reduce((s,x)=>s+w(x.id),0)+GAP*(k.length-1):NW};
  const place=(id,left,g)=>{const y=(G-g)*(NH+VG)+20,k=par(id),W=w(id);
    if(!k.length){nodes+=cnode(byI[id],left+W/2,y,tid);return left+W/2}
    let x=left;const kc=k.map(p=>{const c=place(p.id,x,g+1);x+=w(p.id)+GAP;return c}),cx=(kc[0]+kc[kc.length-1])/2,busY=y-VG/2;
    lines+=`<path class="cl" d="M${cx} ${y}V${busY}M${kc[0]} ${busY}H${kc[kc.length-1]}${kc.map(q=>`M${q} ${busY}V${y-VG}`).join('')}"/>`;nodes+=cnode(byI[id],cx,y,tid);return cx};
  place(rootId,20,0);return{svg:lines+nodes,W:w(rootId)+40,H:G*(NH+VG)+NH+40,G}}
let zoom=1;
function chartShell(title,body,W,H,extra=''){
  $('#app').innerHTML=`<div class="intro"><h2>${title}</h2><p>Drag or scroll to move around. Tap anyone to open their page.</p></div><div class="chartbar">${extra}<button class="btn" data-z="-" aria-label="Zoom out">Zoom out</button><button class="btn" data-z="+" aria-label="Zoom in">Zoom in</button><button class="btn" data-z="fit">Fit</button><button class="btn" data-print>Print</button></div><div class="chartwrap" id="cw" tabindex="0"></div>`;
  const cw=$('#cw'),fit=()=>Math.min(1,(cw.clientWidth-16)/W),draw=()=>{cw.innerHTML=`<svg class="chart" width="${W*zoom}" height="${H*zoom}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${body}</svg>`};
  zoom=cw.clientWidth<700?.8:Math.max(.55,fit());draw();cw.scrollLeft=(W*zoom-cw.clientWidth)/2;
  document.querySelectorAll('[data-z]').forEach(b=>b.onclick=()=>{const k=b.dataset.z;zoom=k==='fit'?fit():Math.max(.3,Math.min(2,zoom*(k==='+'?1.25:.8)));draw();if(k==='fit')cw.scrollLeft=0});
  let drag=null;cw.onpointerdown=e=>{if(e.pointerType!=='mouse'||e.target.closest('a'))return;drag=[e.clientX,e.clientY,cw.scrollLeft,cw.scrollTop];cw.setPointerCapture(e.pointerId)};
  cw.onpointermove=e=>{if(drag){cw.scrollLeft=drag[2]-(e.clientX-drag[0]);cw.scrollTop=drag[3]-(e.clientY-drag[1])}};cw.onpointerup=()=>drag=null}
async function chartView(q){const vid=viewId,g=Math.min(6,Math.max(1,+q.get('g')||3)),tid=S.tree.id,d=await api(`/trees/${tid}?depth=${g}`);if(vid!==viewId)return;const r=descChart(d,tid,d.tree.root_id);
  chartShell('Family chart',r.svg,r.W,r.H,`<label class="gsel">Generations <select id="gsel">${[2,3,4,5,6].map(n=>`<option ${n===g?'selected':''}>${n}</option>`).join('')}</select></label>`);
  $('#gsel').onchange=e=>location.hash=`#/t/${tid}/chart?g=${e.target.value}`}
async function pedView(pid){const vid=viewId,tid=S.tree.id,d=await api(`/people/${pid}/pedigree?depth=4`);if(vid!==viewId)return;const r=pedChart(d,tid,pid),p=d.people.find(x=>x.id===pid);
  chartShell('Ancestors of '+esc(p?p.name:''),r.svg,r.W,r.H);if(!r.G)$('#app').insertAdjacentHTML('beforeend','<p class="intro">No parents have been added yet.</p>')}
async function insightsView(){const vid=viewId,tid=S.tree.id,i=await api(`/trees/${tid}/insights`);if(vid!==viewId)return;const lk=p=>p?`<a href="#/t/${tid}/p/${p.id}">${esc(p.name)}</a>`:'Not known',f=(a,b)=>`<div class="fact"><span>${a}</span><b>${esc(b)}</b></div>`;
  $('#app').innerHTML=`<div class="page" style="max-width:760px"><div class="intro"><h2>Family insights</h2><p>A quick look at ${esc(S.tree.name)}.</p></div>
  <div class="facts">${f('People',i.people)}${f('Living',i.living)}${f('Passed away',i.deceased)}${f('Marriages',i.marriages)}${f('Generations',i.generations)}${f('Average lifespan',i.averageLifespan==null?'Not known':i.averageLifespan+' years')}</div>
  <h3>Lived the longest</h3><p>${i.longestLived?`${lk(i.longestLived)}, ${i.longestLived.age} years`:'Not known'}</p>
  <h3>Oldest living</h3><p>${i.oldestLiving?`${lk(i.oldestLiving)}, ${i.oldestLiving.age} years`:'Not shown'}</p>
  <h3>Most common first names</h3><p>${i.commonNames.map(n=>`${esc(n.name)} (${n.count})`).join(', ')}</p>
  <h3>Gender mix</h3><p>${Object.entries(i.gender).map(([k,v])=>`${esc(k)}: ${v}`).join(', ')}</p>
  <h3>Upcoming birthdays</h3>${i.birthdays.length?i.birthdays.map(b=>`<div class="fact" style="margin-bottom:10px"><b>${lk(b)}</b> turns ${b.turns}<span>${b.inDays===0?'Today':'In '+b.inDays+' days'}, ${b.date}</span></div>`).join(''):'<p>No birthdays in the next 60 days.'+(S.role?'':' Birthdays are shown to people who have access to the tree.')+'</p>'}</div>`}
function forgotView(){
  $('#app').innerHTML=`<div class="intro"><h2>Forgot your password?</h2><p>Enter your email and we will send you a link to choose a new one.</p></div><form class="f" id="ff"><label>Email<input name="email" type="email" required></label><div class="err" id="err"></div><div class="hint" id="ok" role="status"></div><button class="btn pri">Send the link</button><a href="#/" class="more" style="text-align:center">Back to log in</a></form>`;
  $('#ff').onsubmit=async e=>{e.preventDefault();const err=$('#err'),ok=$('#ok');try{await api('/auth/forgot','POST',Object.fromEntries(new FormData(e.target)));setText(err,'');setText(ok,'If that email has an account, a link is on its way. It works for one hour.')}catch(x){setText(err,x.message)}}}
function resetView(q){
  $('#app').innerHTML=`<div class="intro"><h2>Choose a new password</h2></div><form class="f" id="rf"><label>New password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><div class="err" id="err"></div><div class="hint" id="ok" role="status"></div><button class="btn pri">Save password</button></form>`;
  $('#rf').onsubmit=async e=>{e.preventDefault();const err=$('#err'),ok=$('#ok'),vid=viewId;try{await api('/auth/reset','POST',{token:q.get('token')||'',password:e.target.password.value});setText(err,'');setText(ok,'Your password is changed. You can log in now.');setTimeout(()=>{if(vid===viewId)location.hash='#/'},1800)}catch(x){setText(err,x.message)}}}
async function accountView(){
  if(!tok){location.hash='#/';return}
  const vid=viewId,me=await api('/me');
  if(vid!==viewId)return;
  $('#app').innerHTML=`<div class="intro"><h2>Your account</h2><p>${esc(me.email)}</p></div>
  <form class="f" id="nf2"><label>Your name<input name="name" value="${esc(me.name||'')}" maxlength="80"></label><div class="hint" id="o1" role="status"></div><button class="btn pri">Save</button></form>
  <h3 class="fun" style="text-align:center;margin:26px 0 12px">Change your password</h3>
  <form class="f" id="pw"><label>Current password<input name="current" type="password" required autocomplete="current-password"></label><label>New password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><div class="err" id="e2"></div><div class="hint" id="o2" role="status"></div><button class="btn pri">Change password</button></form>
  <h3 class="fun" style="text-align:center;margin:26px 0 12px">Delete your account</h3>
  <form class="f" id="del"><p style="margin:0">This removes your account and every tree you own. It cannot be undone.</p><label>Your password<input name="password" type="password" required autocomplete="current-password"></label><div class="err" id="e3"></div><button class="btn del">Delete my account</button></form>`;
  $('#nf2').onsubmit=async e=>{e.preventDefault();const out=$('#o1');try{await api('/me','PATCH',{name:e.target.name.value});setText(out,'Saved.')}catch(x){setText(out,x.message)}};
  $('#pw').onsubmit=async e=>{e.preventDefault();const err=$('#e2'),out=$('#o2');try{const d=await api('/me/password','POST',Object.fromEntries(new FormData(e.target)));tok=d.token;localStorage.setItem('tok',tok);e.target.reset();setText(err,'');setText(out,'Your password has been changed. Other devices were signed out.')}catch(x){setText(err,x.message)}};
  $('#del').onsubmit=async e=>{e.preventDefault();if(!confirm('Delete your account and every tree you own? This cannot be undone.'))return;
    const err=$('#e3');try{await api('/me','DELETE',{password:e.target.password.value});localStorage.removeItem('tok');tok=null;location.hash='#/'}catch(x){setText(err,x.message)}}}
async function marriageView(mid){
  const vid=viewId,tid=S.tree.id;let m=S.marriages.find(x=>x.id===mid);
  if(!m){const d=await api('/trees/'+tid);if(vid!==viewId)return;d.people.forEach(p=>{if(!byId(p.id))S.people.push(p)});d.marriages.forEach(x=>{if(!S.marriages.some(y=>y.id===x.id))S.marriages.push(x)});m=S.marriages.find(x=>x.id===mid)}
  if(!m||!S.canEdit)return $('#app').innerHTML='<div class="intro"><h2>We could not open that relationship</h2></div>';
  const a=byId(m.a_id),b=byId(m.b_id);
  $('#app').innerHTML=`<div class="page"><a class="back" href="#/" data-back>Cancel</a><form class="f" id="mf2"><h2>${esc(a.name)} and ${esc(b.name)}</h2><label>Relationship${sel('kind',[['married','Married'],['partner','Partners'],['divorced','Divorced'],['separated','Separated']],m.kind)}</label><label>Year it began<input name="year" type="number" min="1000" max="2200" value="${m.year||''}"></label><label>Year it ended (if it did)<input name="end_year" type="number" min="1000" max="2200" value="${m.end_year||''}"></label><div class="err" id="err"></div><button class="btn pri">Save</button></form></div>`;
  $('#mf2').onsubmit=async e=>{e.preventDefault();const err=$('#err'),vid=viewId;try{await api('/marriages/'+mid,'PUT',Object.fromEntries(new FormData(e.target)));if(vid!==viewId)return;await load(tid);if(vid===viewId)history.length>1?history.back():location.hash='#/t/'+tid}catch(x){setText(err,x.message)}}}
async function tidyView(){
  const vid=viewId,tid=S.tree.id;if(!S.canEdit)return $('#app').innerHTML='<div class="intro"><h2>Only editors can tidy the tree</h2></div>';
  const [c,d]=await Promise.all([api(`/trees/${tid}/checks`),api(`/trees/${tid}/duplicates`)]);if(vid!==viewId)return;const lk=p=>`<a href="#/t/${tid}/p/${p.id}">${esc(p.name)}</a>`;
  $('#app').innerHTML=`<div class="page" style="max-width:760px"><div class="intro"><h2>Tidy up your tree</h2><p>Things that look wrong, and people who may be recorded twice.</p></div>
  <h3>Possible duplicates</h3>${d.length?d.map(x=>`<div class="fact dup"><b>${lk(x.a)}</b> (${esc(life(x.a))}) and <b>${lk(x.b)}</b> (${esc(life(x.b))})<span>${esc(x.reason)}</span><div class="row"><button class="btn" data-merge="${x.b.id}:${x.a.id}" data-names="${esc(x.a.name)}">Keep the first</button><button class="btn" data-merge="${x.a.id}:${x.b.id}" data-names="${esc(x.b.name)}">Keep the second</button></div></div>`).join(''):'<p>No duplicates found.</p>'}
  <h3>Checks</h3>${c.issues.length?c.issues.map(i=>`<div class="fact iss ${i.level==='warning'?'warn':''}">${i.person?`<b>${lk(i.person)}</b>`:''}<span>${esc(i.text)}</span></div>`).join(''):'<p>No problems found.</p>'}</div>`;
  document.querySelectorAll('[data-merge]').forEach(b=>b.onclick=async()=>{const[drop,keep]=b.dataset.merge.split(':').map(Number);
    if(!confirm(`Merge into ${b.dataset.names}? The repeat is removed and its details are added to the one you keep. This cannot be undone.`))return;
    const vid=viewId;try{await api(`/people/${drop}/merge`,'POST',{into:keep});if(vid!==viewId)return;await load(tid);if(vid===viewId)tidyView()}catch(x){alert(x.message)}})}
async function load(id,vid=viewId){const r=await api('/trees/'+id+'?depth=2');if(vid!==viewId)return;S=r;S.loaded=new Set()}
async function ensure(pid){ // fetch one person's spouses and children when they were not in the first load
  if(S.loaded.has(pid))return;const vid=viewId,r=await api('/people/'+pid+'/branch');if(vid!==viewId)return;
  r.people.forEach(p=>{const i=S.people.findIndex(x=>x.id===p.id);i<0?S.people.push(p):S.people[i]=p});
  r.marriages.forEach(m=>{if(!S.marriages.some(x=>x.id===m.id))S.marriages.push(m)});S.loaded.add(pid)}
async function route(){
  const rid=++viewId,[path,qs]=(location.hash||'#/').slice(1).split('?'),q=new URLSearchParams(qs||''),m=path.match(/^\/t\/(\d+)(?:\/(gc|share|history|chart|insights|tidy|p\/(\d+)|new|edit\/(\d+)|ped\/(\d+)|marriage\/(\d+)))?$/);
  try{
    $('#sf').hidden=!m;
    if(!m){$('#title').textContent='Family Tree';const pg=path==='/account'?'account':path==='/forgot'?'forgot':path==='/reset'?'reset':'';
      nav(tok?[['#/','My trees',!pg],['#/account','Account',pg==='account'],[0,'Log out']]:[['#/','Log in',!pg]]);
      return await (pg==='account'?accountView():pg==='forgot'?forgotView():pg==='reset'?resetView(q):home())}
    if(!S||S.tree.id!=m[1])await load(m[1],rid);
    if(rid!==viewId)return;
    const sub=m[2]||'';nav([...tabs(S.tree.id,sub==='gc'?'gc':sub==='chart'?'chart':sub==='insights'?'insights':sub?'':'t'),...(S.canEdit?[['#/t/'+S.tree.id+'/tidy','Tidy up',sub==='tidy'],['#/t/'+S.tree.id+'/history','History',sub==='history']]:[]),...(S.role==='owner'?[['#/t/'+S.tree.id+'/share','Share and export',sub==='share']]:[]),...(tok?[['#/account','Account'],[0,'Log out']]:[])]);$('#title').textContent=S.tree.name;
    if(sub==='gc')grandView();else if(sub==='share')await shareView();else if(sub==='history')await historyView();else if(sub==='chart')await chartView(q);else if(sub==='insights')await insightsView();else if(m[5])await pedView(+m[5]);else if(sub==='tidy')await tidyView();else if(m[6])await marriageView(+m[6]);else if(m[3]){await ensure(+m[3]);if(rid!==viewId)return;personView(+m[3])}else if(sub==='new'){if(q.get('parents')){await ensure(+q.get('parents'));if(rid!==viewId)return}formView(q)}else if(m[4]){await ensure(+m[4]);if(rid!==viewId)return;formView(q,+m[4])}else treeView();
    if(rid!==viewId)return;
    scrollTo(0,0)
  }catch(x){if(rid!==viewId)return;console.error('Route failed:',x);const app=$('#app'),html=`<div class="intro"><h2>That didn't work</h2><p>${esc(x.message)}</p></div>`;if(app)app.innerHTML=html;else document.body.insertAdjacentHTML('afterbegin',html)}}
document.addEventListener('click',e=>{if(e.target.closest('[data-back]')){e.preventDefault();history.length>1?history.back():location.hash='#/'}});
document.addEventListener('click',e=>{if(e.target.closest('[data-print]'))print()});
if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
const THEMES=[['sunny','Sunny','Bright and playful',['#EAF5FB','#2E9D6A','#FFC53D']],['heritage','Heritage','A classic family record',['#F2EBDC','#2F6B4F','#D4A83A']],
  ['midnight','Midnight','Easy on the eyes at night',['#121B2B','#4CC38A','#FFC53D']],['blossom','Blossom','Soft and bubbly',['#FDEFF6','#8A4FD0','#FF8FC0']],['clean','Clean','High contrast, no frills',['#FFFFFF','#0B5FFF','#FFD400']]];
$('#tp').innerHTML=THEMES.map(([k,n,d,c])=>`<button class="topt" data-theme="${k}" aria-pressed="false"><span class="sws">${c.map(x=>`<i style="background:${x}"></i>`).join('')}</span><span><b>${n}</b><small>${d}</small></span></button>`).join('');
function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('theme',t)}catch{}
  document.querySelector('meta[name=theme-color]').content=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('.topt').forEach(b=>b.setAttribute('aria-pressed',b.dataset.theme===t))}
const tpOpen=o=>{$('#tp').hidden=!o;$('#tb').setAttribute('aria-expanded',o)};
$('#tb').onclick=()=>tpOpen($('#tp').hidden);
$('#tp').onclick=e=>{const b=e.target.closest('.topt');if(b){setTheme(b.dataset.theme);tpOpen(false);$('#tb').focus()}};
document.addEventListener('click',e=>{if(!e.target.closest('.tw'))tpOpen(false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')tpOpen(false)});
setTheme(document.documentElement.dataset.theme||'sunny');
let st;$('#q').addEventListener('input',e=>{clearTimeout(st);const v=e.target.value.trim(),box=$('#res');if(v.length<2||!S){box.innerHTML='';return}
  st=setTimeout(async()=>{try{const r=await api(`/trees/${S.tree.id}/search?q=${encodeURIComponent(v)}`);
    box.innerHTML=r.length?r.map(p=>`<a href="#/t/${S.tree.id}/p/${p.id}"><b>${esc(p.name)}</b> <small>${esc(life(p))}</small></a>`).join(''):'<p>No one found with that name.</p>'}catch{box.innerHTML=''}},250)});
$('#sf').addEventListener('click',e=>{if(e.target.closest('a')){$('#q').value='';$('#res').innerHTML=''}});
$('#q').addEventListener('keydown',e=>{if(e.key==='Escape'){e.target.value='';$('#res').innerHTML=''}});
$('#sf').onsubmit=e=>e.preventDefault();
addEventListener('hashchange',route);route();
