/* 오늘한컷 — 가족 사진 하루 한 장, 다음 날 정오까지 투표, 주간 1위는 오일파스텔 그림으로.
   Supabase(익명 로그인 + 가족 코드)로 동작합니다. 모든 시간은 한국 시간 기준입니다. */
(function(){
"use strict";
const TZ = "Asia/Seoul";
const VOTE_CLOSE_HOUR = 12;
const WD = ["일","월","화","수","목","금","토"];
const BUCKET = "family";
const CODE_KEY = "todayshot.joinCode";
/* 화면에 보이는 4개 이름 자리 (schema.sql 의 members 와 같아야 함) */
const SLOTS = [
  {id:"jjangtori", nickname:"짱토리"},
  {id:"ssu", nickname:"쑤"},
  {id:"inijjang", nickname:"이니짱"},
  {id:"torioppa", nickname:"토리오빠"}
];

const S = {
  sb:null, me:null, members:{}, photos:[], votes:[], paintings:{},
  urls:{}, talk:{q:[],a:[],count:0,err:"",loaded:false}, qDraft:"", aDraft:"", sugShift:0, editQ:false, status:"loading", busy:false, err:"", errDetail:"", captionDraft:"", joinCode:null, renaming:false, slow:false
};

/* ---------- 시간 (항상 한국 시간) ---------- */
function kst(d){
  const f = new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"});
  const p = {}; for (const x of f.formatToParts(d||new Date())) p[x.type]=x.value;
  return {date:p.year+"-"+p.month+"-"+p.day, hour:(+p.hour)%24};
}
function addDays(ds,n){ const [y,m,d]=ds.split("-").map(Number); return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10); }
function weekday(ds){ const [y,m,d]=ds.split("-").map(Number); return new Date(Date.UTC(y,m-1,d)).getUTCDay(); }
function weekStart(ds){ return addDays(ds, -((weekday(ds)+6)%7)); }
function fmt(ds){ const [,m,d]=ds.split("-").map(Number); return m+"월 "+d+"일 ("+WD[weekday(ds)]+")"; }
function fmtWeek(ws){ return fmt(ws)+" ~ "+fmt(addDays(ws,6)); }
/* 그날 사진의 투표는 다음 날 낮 12시에 마감 */
function dayClosed(ds, now){ const t=now.date; return t>addDays(ds,1) || (t===addDays(ds,1) && now.hour>=VOTE_CLOSE_HOUR); }
function latestClosedDay(now){ return now.hour>=VOTE_CLOSE_HOUR ? addDays(now.date,-1) : addDays(now.date,-2); }

/* ---------- 작은 DOM 도우미 (값은 항상 글자로만 넣음) ---------- */
function h(tag, attrs, ...kids){
  const e=document.createElement(tag);
  for (const [k,v] of Object.entries(attrs||{})){
    if (v==null || v===false) continue;
    if (k==="class") e.className=v;
    else if (k.slice(0,2)==="on") e.addEventListener(k.slice(2),v);
    else if (v===true) e.setAttribute(k,"");
    else e.setAttribute(k,String(v));
  }
  for (const k of kids.flat()){ if(k==null||k===false) continue; e.append(k instanceof Node?k:document.createTextNode(String(k))); }
  return e;
}
function store(fn){ try{ return fn(); }catch(e){ return null; } }

/* ---------- 데이터 도우미 ---------- */
function nick(id){ return (S.members[id] && S.members[id].nickname) || (SLOTS.find(s=>s.id===id)||{}).nickname || "가족"; }
function isPainter(){ return !!(S.me && S.members[S.me] && S.members[S.me].is_painter); }
function photoOf(id, ds){ return S.photos.find(p=>p.member_id===id && p.day===ds) || null; }
/* 사람마다 다른 순서로 섞되, 같은 날에는 순서가 바뀌지 않게 (올린 순서로 누군지 짐작하지 못하게) */
function shuffled(list, seed){
  let x=2166136261; for (const ch of seed) x=Math.imul(x^ch.charCodeAt(0),16777619)>>>0;
  const rnd=()=>{ x^=x<<13; x>>>=0; x^=x>>>17; x^=x<<5; x>>>=0; return x/4294967296; };
  const a=list.slice(); for (let i=a.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function photosOn(ds){ return S.photos.filter(p=>p.day===ds).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))); }
function myVote(ds){ const v=S.votes.find(v=>v.day===ds && v.voter===S.me); return v ? v.target : null; }
function tally(ds){
  const t={};
  for (const v of S.votes){ if (v.day===ds && v.target!==v.voter && photoOf(v.target,ds)) t[v.target]=(t[v.target]||0)+1; }
  return t;
}

/* ---------- 비공개 사진 주소 (1시간짜리 서명 링크, 55분 보관) ---------- */
let urlQueue=new Set(), urlTimer=null;
function urlFor(path){
  const c=S.urls[path];
  if (c && (c.url==="" || c.exp>Date.now())) return c.url;
  if (!c || !c.pending){ S.urls[path]={pending:true}; urlQueue.add(path); clearTimeout(urlTimer); urlTimer=setTimeout(flushUrls,0); }
  return null;
}
async function flushUrls(){
  const paths=[...urlQueue]; urlQueue.clear(); if(!paths.length) return;
  try{
    const {data,error}=await S.sb.storage.from(BUCKET).createSignedUrls(paths,3600);
    if (error) throw error;
    const got={}; for (const r of data||[]) if (r && r.path) got[r.path]=r;
    for (const p of paths){ const r=got[p]; S.urls[p]= r && r.signedUrl ? {url:r.signedUrl, exp:Date.now()+55*60000} : {url:"", exp:0}; }
  }catch(e){ for (const p of paths) delete S.urls[p]; S.slow=true; }
  render();
}
function img(path, alt){
  if (!path) return h("div",{class:"photo msg"},"사진 없음");
  const u=urlFor(path);
  if (u===null) return h("div",{class:"photo msg"},"불러오는 중…");
  if (u==="") return h("div",{class:"photo msg"},"사진을 불러오지 못했어요");
  const box=h("div",{class:"photo"});
  const i=h("img",{src:u, alt:alt||"가족 사진", loading:"lazy"});
  i.addEventListener("error",()=>{ delete S.urls[path]; box.replaceChildren(h("div",{class:"photo msg"},"사진을 불러오지 못했어요")); });
  box.append(i); return box;
}

/* ---------- 사진 줄이기·다시 저장 (위치 정보도 함께 지워짐) ---------- */
async function compress(file){
  let src;
  try { src = await createImageBitmap(file,{imageOrientation:"from-image"}); }
  catch(e){
    src = await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error("decode")); i.src=URL.createObjectURL(file); });
  }
  const w=src.width, hh=src.height, s=Math.min(1,1600/Math.max(w,hh));
  const c=document.createElement("canvas"); c.width=Math.max(1,Math.round(w*s)); c.height=Math.max(1,Math.round(hh*s));
  c.getContext("2d").drawImage(src,0,0,c.width,c.height);
  return await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error("encode")),"image/jpeg",0.85));
}
function rand(){ const a=new Uint8Array(6); crypto.getRandomValues(a); return [...a].map(x=>x.toString(16).padStart(2,"0")).join(""); }
function detail(e){ if (!e) return ""; return [e.code, e.status, e.message||e.error_description||e.error].filter(Boolean).join(" · ").slice(0,200); }
function friendly(e, fallback){
  const m=String((e && (e.message||e.error_description||e.error)) || "");
  if (e && e.friendly) return e.friendly;
  if (/row-level security|violates/i.test(m)) return "지금은 저장할 수 없는 시간이에요. 화면을 새로 고친 뒤 다시 해주세요.";
  if (/exceed|too large|payload/i.test(m)) return "사진이 너무 커요. 다른 사진을 골라주세요.";
  if (/fetch|network/i.test(m)) return "인터넷 연결을 확인한 뒤 다시 해주세요.";
  return fallback;
}

/* ---------- 쓰기 ---------- */
async function uploadToday(file){
  if (!file || S.busy) return;
  S.busy=true; S.err=""; render();
  const today=kst().date; const prev=photoOf(S.me,today); let newPath=null;
  try{
    let blob;
    try { blob=await compress(file); } catch(e){ throw {friendly:"이 사진은 열 수 없어요. 다른 사진을 골라주세요."}; }
    newPath="photos/"+S.me+"/"+today+"-"+rand()+".jpg";
    const up=await S.sb.storage.from(BUCKET).upload(newPath, blob, {contentType:"image/jpeg", upsert:false});
    if (up.error) throw up.error;
    const row={day:today, member_id:S.me, path:newPath, caption:(S.captionDraft||"").slice(0,40)};
    const r=await S.sb.from("photos").upsert(row,{onConflict:"day,member_id"});
    if (r.error){ await S.sb.storage.from(BUCKET).remove([newPath]); throw r.error; }
    if (prev && prev.path && prev.path!==newPath) await S.sb.storage.from(BUCKET).remove([prev.path]);
    await loadData(); confetti(70);
  }catch(e){ S.err=friendly(e,"사진을 올리지 못했어요. 잠시 후 다시 해주세요."); }
  S.busy=false; render();
}
async function saveCaption(){
  const today=kst().date; const p=photoOf(S.me,today); if(!p||S.busy) return;
  S.busy=true; S.err=""; render();
  try{
    const r=await S.sb.from("photos").update({caption:(S.captionDraft||"").slice(0,40)}).eq("day",today).eq("member_id",S.me);
    if (r.error) throw r.error;
    await loadData();
  }catch(e){ S.err=friendly(e,"한 줄 설명을 저장하지 못했어요."); }
  S.busy=false; render();
}
async function castVote(ds, target){
  if (S.busy) return; S.busy=true; S.err=""; render();
  try{
    const r=await S.sb.from("votes").upsert({day:ds, voter:S.me, target, updated_at:new Date().toISOString()},{onConflict:"day,voter"});
    if (r.error) throw r.error;
    await loadData(); confetti(36);
  }catch(e){ S.err=friendly(e,"투표를 저장하지 못했어요. 잠시 후 다시 해주세요."); }
  S.busy=false; render();
}
async function uploadPainting(ws, file){
  if (!file || S.busy) return; S.busy=true; S.err=""; render();
  const old=S.paintings[ws]; let newPath=null;
  try{
    let blob;
    try { blob=await compress(file); } catch(e){ throw {friendly:"이 사진은 열 수 없어요. 다른 사진을 골라주세요."}; }
    newPath="paintings/"+ws+"-"+rand()+".jpg";
    const up=await S.sb.storage.from(BUCKET).upload(newPath, blob, {contentType:"image/jpeg", upsert:false});
    if (up.error) throw up.error;
    const r=await S.sb.from("paintings").upsert({week_start:ws, path:newPath},{onConflict:"week_start"});
    if (r.error){ await S.sb.storage.from(BUCKET).remove([newPath]); throw r.error; }
    if (old && old.path && old.path!==newPath) await S.sb.storage.from(BUCKET).remove([old.path]);
    await loadData(); confetti(90);
  }catch(e){ S.err=friendly(e,"그림을 올리지 못했어요. 잠시 후 다시 해주세요."); }
  S.busy=false; render();
}
async function pickName(id){
  if (S.busy) return;
  const code=S.joinCode;
  if (!code){ S.status="noinvite"; render(); return; }
  S.busy=true; S.err=""; render();
  try{
    const r=await S.sb.rpc("join_family",{p_code:code, p_member:id});
    if (r.error) throw r.error;
    S.renaming=false;
    await refresh();
  }catch(e){
    const m=String(e && e.message || "");
    S.err = /bad_code/.test(m) ? "초대 링크의 가족 코드가 맞지 않아요. 보스님께 링크를 다시 받아주세요."
      : /bad_member/.test(m) ? "없는 이름이에요. 화면을 새로 고쳐주세요."
      : friendly(e,"이름을 저장하지 못했어요. 잠시 후 다시 해주세요.");
  }
  S.busy=false; render();
}

/* ---------- 화면들 ---------- */
function captionInput(){
  const cap=h("input",{type:"text",id:"caption",maxlength:"40",placeholder:"한 줄 설명 (선택)","aria-label":"한 줄 설명",value:S.captionDraft});
  cap.addEventListener("input",e=>{S.captionDraft=e.target.value;});
  return cap;
}
function fileLabel(text,id,onfile,primary){
  const disabled = S.busy;
  const input=h("input",{type:"file",accept:"image/*",id:id,class:"visually-hidden",disabled:disabled});
  input.addEventListener("change",e=>{ const f=e.target.files&&e.target.files[0]; e.target.value=""; onfile(f); });
  const lab=h("label",{for:id,class:"btn"+(primary?" primary":""),role:"button",tabindex:"0","aria-disabled":disabled?"true":null},text);
  lab.addEventListener("keydown",e=>{ if((e.key==="Enter"||e.key===" ")&&!disabled){ e.preventDefault(); input.click(); } });
  return h("div",{},lab,input);
}
function errLine(){ return S.err ? h("p",{class:"err",role:"alert"},S.err) : null; }

function viewToday(now){
  const today=now.date; const mine=photoOf(S.me,today);
  const out=[h("section",{},h("div",{},h("h2",{},"오늘의 한 컷"),h("p",{class:"sub"},fmt(today)+" · 밤 12시까지 1장만 올릴 수 있어요")))];

  const chips=h("div",{class:"chips","aria-label":"오늘 올린 가족"});
  for (const s of SLOTS){
    const m=S.members[s.id]; if (!m || !m.joined_at) continue;
    const done=!!photoOf(s.id,today);
    chips.append(h("span",{class:"chip"+(done?" done":"")},h("span",{class:"dot"}),nick(s.id)+(done?" 올림":" 아직")));
  }
  out.push(chips);

  const card=h("div",{class:"card"});
  if (mine){
    card.append(img(mine.path,"내가 올린 오늘 사진"), captionInput(),
      h("div",{class:"pair"},
        h("button",{class:"btn",onclick:saveCaption,disabled:S.busy||(S.captionDraft===(mine.caption||""))},"설명 저장"),
        fileLabel(S.busy?"올리는 중…":"다른 사진으로","swapFile",f=>uploadToday(f),false)));
  } else {
    card.append(h("p",{class:"sub"},"오늘 찍은 사진 중 제일 마음에 드는 한 장을 골라주세요. 사진 속 위치 정보는 올릴 때 지워져요."),
      captionInput(), fileLabel(S.busy?"올리는 중…":"오늘의 사진 고르기","pickFile",f=>uploadToday(f),true));
  }
  const e=errLine(); if (e) card.append(e);
  out.push(card);

  const others=shuffled(photosOn(today).filter(p=>p.member_id!==S.me), today+"|"+S.me);
  if (others.length){
    const g=h("div",{class:"grid"});
    others.forEach((p,i)=>{
      const c=h("div",{class:"card"});
      c.append(mine ? img(p.path,"가족 사진 "+(i+1)) : h("div",{class:"photo msg"},"내 사진을 올리면 보여요"));
      c.append(h("div",{class:"who"},h("b",{class:"anon"},"🎭 누구의 사진일까요?")));
      if (mine && p.caption) c.append(h("div",{class:"cap"},p.caption));
      g.append(c);
    });
    out.push(h("section",{},h("div",{},h("h2",{},"가족의 오늘"),h("p",{class:"sub"},"누가 올렸는지는 내일 낮 12시 결과 발표 때 공개돼요.")),g));
  }
  out.push(howTo(true));
  return out;
}
function viewVote(now){
  const ds=addDays(now.date,-1); const open=now.hour<VOTE_CLOSE_HOUR;
  const out=[h("section",{},h("div",{},h("h2",{},"어제의 한 컷 투표"),
    h("p",{class:"sub"},fmt(ds)+" 사진 · "+(open?"오늘 낮 12시에 마감돼요. 내 사진에는 투표할 수 없어요.":"투표가 오늘 낮 12시에 마감됐어요."))))];
  if (!open){ out.push(h("p",{class:"notice"},"결과 탭에서 1위를 확인하세요. 오늘 올린 사진의 투표는 내일 0시에 열려요.")); return out; }
  const list=shuffled(photosOn(ds), ds+"|"+S.me);
  if (!list.length){ out.push(h("div",{class:"empty"},"어제 올라온 사진이 없어요.")); return out; }
  out.push(h("p",{class:"notice"},"🎭 누가 올린 사진인지 모르게 섞어서 보여줘요. 이름은 낮 12시 결과 발표 때 공개돼요."));
  const mv=myVote(ds); const g=h("div",{class:"grid"});
  for (const p of list){
    const own=p.member_id===S.me; const chosen=mv===p.member_id;
    g.append(h("div",{class:"card"},img(p.path,own?"내 사진":"가족 사진"),
      h("div",{class:"who"},h("b",{class:own?"":"anon"},own?"내 사진":"🎭 누구의 사진일까요?")), p.caption?h("div",{class:"cap"},p.caption):null,
      h("button",{class:"btn"+(chosen?" on":""),disabled:own||S.busy,onclick:()=>castVote(ds,p.member_id),"aria-pressed":chosen?"true":"false"},
        own?"내 사진":chosen?"💖 내가 고른 사진":"이 사진에 투표")));
  }
  out.push(g, h("p",{class:"sub"},mv?"마감 전까지 다른 사진으로 바꿀 수 있어요.":"하루에 1표예요."));
  const e=errLine(); if (e) out.push(e);
  return out;
}
function winnersOf(entries){ let max=0; for(const e of entries) max=Math.max(max,e.n); return max>0?entries.filter(e=>e.n===max):[]; }
function weekEntries(ws, now){
  const out=[];
  for (let i=0;i<7;i++){ const ds=addDays(ws,i); if(!dayClosed(ds,now)) continue; const t=tally(ds); for(const p of photosOn(ds)) out.push({...p,n:t[p.member_id]||0}); }
  return out;
}
function sparkles(){
  const spots=[[8,10,1],[86,6,1.3],[92,52,.9],[4,62,1.1],[60,3,.8]];
  return h("div",{class:"sparkles","aria-hidden":"true"},spots.map(([x,y,s],i)=>h("i",{style:"left:"+x+"%;top:"+y+"%;font-size:"+s+"rem;animation-delay:"+(i*.45)+"s"},"✦")));
}
/* 축하 꽃가루 (움직임 줄이기 설정이면 CSS에서 숨김) */
function confetti(n){
  const colors=["#5B7CFA","#9B6CFF","#FF7EB6","#FFC83D","#4ED6B8"];
  const box=h("div",{class:"confetti","aria-hidden":"true"});
  for (let i=0;i<(n||60);i++){
    const d=(1.2+Math.random()*1.3).toFixed(2);
    box.append(h("i",{style:"left:"+(Math.random()*100)+"%;background:"+colors[i%colors.length]+";--x:"+((Math.random()-.5)*40)+"vw;--r:"+(360+Math.random()*720)+"deg;--d:"+d+"s;animation-delay:"+(Math.random()*.25).toFixed(2)+"s"}));
  }
  document.body.append(box); setTimeout(()=>box.remove(),3000);
}
function winnerCard(e, label){
  return h("div",{class:"card winner"},sparkles(),h("span",{class:"badge"},"👑 "+label),img(e.path,nick(e.member_id)+"의 1위 사진"),
    h("div",{class:"who"},h("b",{},nick(e.member_id)),h("span",{class:"votes"},e.n+"표")), e.caption?h("div",{class:"cap"},e.caption):null,
    h("div",{class:"sub"},fmt(e.day)));
}
function viewResult(now){
  const ds=latestClosedDay(now); const t=tally(ds);
  const entries=photosOn(ds).map(p=>({...p,n:t[p.member_id]||0}));
  const out=[h("section",{},h("div",{},h("h2",{},fmt(ds)+"의 1위"),h("p",{class:"sub"},"투표는 다음 날 낮 12시에 마감되고 바로 순위가 공개돼요.")))];
  const w=winnersOf(entries);
  if (!entries.length) out.push(h("div",{class:"empty"},"이날 올라온 사진이 없어요."));
  else if (!w.length) out.push(h("div",{class:"empty"},"이날은 투표가 없었어요."));
  else {
    const g=h("div",{class:w.length>1?"grid":""}); for(const e of w) g.append(winnerCard(e,w.length>1?"공동 1위":"1위")); out.push(g);
    if (S.celebrated!==ds){ S.celebrated=ds; setTimeout(()=>confetti(80),350); }
  }

  if (entries.length) out.push(rankingCard("🏅 "+fmt(ds)+" 전체 순위", entries.map(e=>({id:e.member_id,n:e.n,path:e.path,caption:e.caption})), true));

  const ws=weekStart(ds); const we=weekEntries(ws,now); const ww=winnersOf(we);
  /* 이번 주 누적: 사람별 받은 표 합계 */
  const sum={}, cnt={}; for (const e of we){ sum[e.member_id]=(sum[e.member_id]||0)+e.n; cnt[e.member_id]=(cnt[e.member_id]||0)+1; }
  const weekRows=Object.keys(sum).map(id=>({id,n:sum[id],note:"사진 "+cnt[id]+"장"}));
  const sec=h("section",{},h("div",{},h("h2",{},"이번 주 최다 득표"),h("p",{class:"sub"},fmtWeek(ws)+" · 일요일 사진 투표가 끝나는 월요일 낮 12시에 이번 주의 그림이 정해져요.")));
  if (!ww.length) sec.append(h("div",{class:"empty"},"아직 표를 받은 사진이 없어요."));
  else { const g=h("div",{class:"grid"}); for(const e of ww) g.append(winnerCard(e,"이번 주 선두")); sec.append(g); }
  if (weekRows.length) sec.append(rankingCard("📊 이번 주 누적 득표 순위", weekRows, false));
  out.push(sec);
  return out;
}
/* 4명 모두의 순위. 표가 같으면 같은 순위(1,1,3). 사진을 안 올린 가족은 맨 아래 */
function rankingCard(title, rows, withPhoto){
  rows=rows.slice().sort((a,b)=>b.n-a.n || nick(a.id).localeCompare(nick(b.id),"ko"));
  let rank=0, prev=null;
  rows.forEach((r,i)=>{ if (r.n!==prev){ rank=i+1; prev=r.n; } r.rank=rank; });
  const have=new Set(rows.map(r=>r.id));
  const missing=SLOTS.filter(s=>!have.has(s.id) && S.members[s.id] && S.members[s.id].joined_at);
  const medal=r=>r.n>0 && r.rank===1?"🥇":r.n>0 && r.rank===2?"🥈":r.n>0 && r.rank===3?"🥉":r.rank+"위";
  const list=h("ol",{class:"rank"},
    rows.map(r=>h("li",{class:r.n>0&&r.rank===1?"top":""},
      h("span",{class:"pos"},medal(r)),
      withPhoto&&r.path?h("span",{class:"thumb"},img(r.path,nick(r.id)+"의 사진")):null,
      h("span",{class:"nm"},h("b",{},nick(r.id)), r.caption?h("small",{},r.caption):r.note?h("small",{},r.note):null),
      h("span",{class:"n"},r.n+"표"))),
    missing.map(m=>h("li",{class:"none"},h("span",{class:"pos"},"–"),withPhoto?h("span",{class:"thumb empty-thumb"}):null,
      h("span",{class:"nm"},h("b",{},m.nickname),h("small",{},withPhoto?"이날은 사진을 안 올렸어요":"이번 주 사진 없음")),h("span",{class:"n"},""))));
  return h("div",{class:"card"},h("h3",{class:"rank-title"},title),list);
}
function viewGallery(now){
  const weeks=new Set(S.photos.map(p=>weekStart(p.day)));
  const closed=[...weeks].filter(ws=>dayClosed(addDays(ws,6),now)).sort().reverse();
  const out=[h("section",{},h("div",{},h("h2",{},"이번 주의 그림"),h("p",{class:"sub"},"매주 가장 많은 표를 받은 사진을 짱토리가 A5 오일파스텔로 그려요.")))];
  if (!closed.length){ out.push(h("div",{class:"empty"},"첫 주가 끝나면 여기에 1위 사진과 그림이 나란히 걸려요.")); return out; }
  for (const ws of closed){
    const ww=winnersOf(weekEntries(ws,now)); const pt=S.paintings[ws];
    const card=h("div",{class:"card"},h("div",{class:"who"},h("b",{},fmtWeek(ws))));
    if (!ww.length){ card.append(h("div",{class:"sub"},"이 주에는 표를 받은 사진이 없어요.")); out.push(card); continue; }
    card.append(h("div",{class:"pair"},
      h("div",{},h("div",{class:"lbl"},"사진 · "+[...new Set(ww.map(e=>nick(e.member_id)))].join(", ")),img(ww[0].path,"1위 사진")),
      h("div",{},h("div",{class:"lbl"},"오일파스텔 그림"), pt&&pt.path?img(pt.path,"오일파스텔 그림"):h("div",{class:"photo msg"},"그림 준비 중"))));
    if (ww.length>1) card.append(h("div",{class:"sub"},"공동 1위 "+ww.length+"장 · 짱토리가 한 장을 골라 그려요."));
    if (isPainter()) card.append(fileLabel(pt?"그림 사진 바꾸기":"완성한 그림 올리기","paint-"+ws,f=>uploadPainting(ws,f),false));
    out.push(card);
  }
  const e=errLine(); if (e) out.push(e);
  return out;
}
function viewPick(){
  const grid=h("div",{class:"names"});
  for (const s of SLOTS) grid.append(h("button",{class:"btn"+(s.id===S.me?" on":""),disabled:S.busy,onclick:()=>pickName(s.id)},s.nickname));
  return [h("section",{},
    h("div",{},h("h2",{},"나는 누구인가요?"),h("p",{class:"sub"},"가족 안에서 쓸 이름을 골라주세요.")),
    h("div",{class:"card"},grid,
      S.renaming?h("button",{class:"btn",onclick:()=>{S.renaming=false;S.err="";render();}},"취소"):null,
      errLine()),
    howTo())];
}
/* 이용 방법과 투표 규칙 */
function howTo(folded){
  const steps=[
    ["📸","오늘의 한 컷","하루에 딱 1장, 밤 12시까지 올려요. 마감 전엔 바꿀 수 있어요."],
    ["🗳️","다음 날 익명 투표","누가 올렸는지 모르는 채로, 낮 12시까지 가장 마음에 드는 사진에 1표! 내 사진엔 못 찍어요."],
    ["👑","낮 12시 순위 공개","누구 사진인지와 4명의 순위가 함께 공개돼요. 표가 같으면 같은 순위예요."],
    ["🎨","이번 주의 그림","한 주 동안 가장 많은 표를 받은 사진을 짱토리가 오일파스텔로 그려줘요."],
    ["💬","오늘톡","하루씩 돌아가며 한 명이 질문하고, 나머지는 한 줄로 답해요. 내가 답해야 가족 답이 보여요."]
  ];
  const list=h("ol",{class:"steps"},steps.map(([ic,t,d])=>h("li",{},h("span",{class:"ic","aria-hidden":"true"},ic),h("div",{},h("b",{},t),h("p",{},d)))));
  const foot=h("p",{class:"sub"},"내 사진을 올려야 가족의 오늘 사진이 보여요. 모든 시간은 한국 시간이에요.");
  if (!folded) return h("div",{class:"card howto"},h("h3",{},"오늘한컷은 이렇게 해요"),list,foot);
  /* 오늘 탭: 접었다 펼 수 있게. 처음(내 사진이 하나도 없을 때)은 펼친 채로 */
  const open = S.howOpen!=null ? S.howOpen : !S.photos.some(p=>p.member_id===S.me);
  const d=h("details",{class:"card howto",open:open},h("summary",{},h("span",{},"📖 이용 방법과 투표 규칙")),list,foot);
  d.addEventListener("toggle",()=>{ S.howOpen=d.open; });
  return d;
}
function viewMessage(title, body){ return [h("section",{},h("h2",{},title),h("p",{class:"notice warn"},body))]; }

/* ---------- 오늘톡: 하루 한 명이 묻고, 모두 한 줄로 답하기 ---------- */
const ASK_ORDER=["jjangtori","ssu","inijjang","torioppa"];   /* talk.sql 의 talk_asker 와 같은 순서 */
const ASK_ANCHOR="2026-11-27";                                  /* 이날이 짱토리 차례 */
function askerOf(ds){ const [y1,m1,d1]=ASK_ANCHOR.split("-").map(Number), [y,m,d]=ds.split("-").map(Number);
  const diff=Math.round((Date.UTC(y,m-1,d)-Date.UTC(y1,m1-1,d1))/86400000); return ASK_ORDER[((diff%4)+4)%4]; }
const QUESTION_BANK=[
  "오늘 제일 웃겼던 순간은?","오늘 먹은 것 중 최고의 한 입은?","오늘 나를 칭찬한다면 한마디로?","요즘 자꾸 생각나는 노래는?",
  "오늘 하늘 색깔을 한 단어로 표현하면?","지금 당장 순간이동 할 수 있다면 어디로?","오늘 들은 말 중 기억에 남는 말은?","이번 주말에 꼭 하고 싶은 것 하나는?",
  "오늘 나를 힘들게 한 것 하나만 털어놓기","가족에게 고마웠던 순간 하나는?","어릴 때 가장 좋아했던 간식은?","오늘의 나를 동물로 표현하면?",
  "요즘 빠져 있는 것 하나는?","10년 뒤 우리 가족은 뭐 하고 있을까?","오늘 길에서 본 것 중 신기했던 것은?","지금 제일 먹고 싶은 음식은?",
  "올해 가장 잘한 일 하나는?","오늘 하루 점수를 매긴다면 몇 점? 이유는?","가족 여행 가고 싶은 곳 한 곳은?","요즘 나만 아는 작은 행복은?",
  "오늘 가장 많이 쓴 앱은?","내일의 나에게 한마디","최근에 새로 배운 것 하나는?","오늘 들었던 생각 중 엉뚱한 것 하나는?",
  "가족 중 한 명에게 몰래 해주고 싶은 것은?","오늘 아침 기분을 날씨로 말하면?","내가 만든 요리 중 최고는?","요즘 고민 하나, 한 줄로!",
  "오늘 찍은 사진 중 아쉽게 탈락한 장면은?","우리 가족 별명을 새로 지어준다면?"
];
function suggestions(ds){
  let x=0; for (const ch of ds) x=(x*31+ch.charCodeAt(0))>>>0;
  const start=(x+S.sugShift*3)%QUESTION_BANK.length;
  return [0,1,2].map(i=>QUESTION_BANK[(start+i)%QUESTION_BANK.length]);
}
function talkQ(ds){ return S.talk.q.find(q=>q.day===ds)||null; }
function talkAnswers(ds){ return S.talk.a.filter(a=>a.day===ds).sort((a,b)=>String(a.updated_at).localeCompare(String(b.updated_at))); }
async function loadTalk(){
  try{
    const today=kst().date;
    const [q,a,c]=await Promise.all([
      S.sb.from("talk_questions").select("day,asker,question").order("day",{ascending:false}).limit(60),
      S.sb.from("talk_answers").select("day,member_id,answer,updated_at"),
      S.sb.rpc("talk_answer_count",{d:today})
    ]);
    const err=q.error||a.error||c.error; if (err) throw err;
    S.talk={q:q.data, a:a.data, count:c.data||0, err:"", loaded:true};
    const mine=S.talk.a.find(x=>x.day===today && x.member_id===S.me);
    if (document.activeElement?.id!=="talkA") S.aDraft = mine ? mine.answer : (S.aDraft||"");
  }catch(e){
    const m=String((e&&(e.code||""))+" "+(e&&e.message||""));
    S.talk.err = /PGRST20[25]|42P01|does not exist|Could not find/i.test(m) ? "setup" : "load";
    S.talk.errDetail=detail(e);
  }
}
async function askQuestion(text){
  text=(text||"").trim().slice(0,80); if (!text || S.busy) return;
  S.busy=true; S.err=""; render();
  try{
    const today=kst().date;
    const r=await S.sb.from("talk_questions").upsert({day:today, asker:S.me, question:text},{onConflict:"day"});
    if (r.error) throw r.error;
    S.qDraft=""; S.editQ=false; await loadTalk(); confetti(30);
  }catch(e){ S.err=friendly(e,"질문을 올리지 못했어요. 오늘 질문 담당인지 확인해주세요."); }
  S.busy=false; render();
}
async function sendAnswer(){
  const text=(S.aDraft||"").trim().slice(0,100); if (!text || S.busy) return;
  S.busy=true; S.err=""; render();
  try{
    const r=await S.sb.from("talk_answers").upsert({day:kst().date, member_id:S.me, answer:text, updated_at:new Date().toISOString()},{onConflict:"day,member_id"});
    if (r.error) throw r.error;
    const first=!S.talk.a.some(x=>x.day===kst().date && x.member_id===S.me);
    await loadTalk(); if (first) confetti(30);
  }catch(e){ S.err=friendly(e,"답을 저장하지 못했어요. 잠시 후 다시 해주세요."); }
  S.busy=false; render();
}
function put(el,...kids){ for (const k of kids.flat()) if (k!=null && k!==false) el.append(k); return el; }
function bubble(a){
  return h("li",{class:"bubble"+(a.member_id===S.me?" mine":"")},h("b",{},nick(a.member_id)),h("span",{},a.answer));
}
function viewTalk(now){
  const today=now.date; const asker=askerOf(today); const q=talkQ(today);
  const out=[h("section",{},h("div",{},h("h2",{},"💬 오늘톡"),h("p",{class:"sub"},fmt(today)+" · 하루 한 명이 묻고, 모두 한 줄로 답해요")))];
  if (S.talk.err==="setup"){ out.push(h("p",{class:"notice warn"},"오늘톡을 쓰려면 짱토리가 Supabase에서 talk.sql 을 한 번 실행해야 해요.")); return out; }
  if (S.talk.err==="load" && !S.talk.loaded){ out.push(h("p",{class:"notice warn"},"오늘톡을 불러오지 못했어요. 잠시 후 다시 열어주세요."), S.talk.errDetail?h("p",{class:"sub"},"자세한 내용: "+S.talk.errDetail):null); return out; }

  /* 질문 담당 순서 */
  const strip=h("div",{class:"chips","aria-label":"질문 담당 순서"});
  for (let i=0;i<4;i++){ const d=addDays(today,i); const who=askerOf(d);
    strip.append(h("span",{class:"chip"+(i===0?" done":"")},(i===0?"오늘 🎤 ":i===1?"내일 ":fmt(d).replace(/^\d+월 /,"")+" ")+nick(who))); }
  out.push(strip);

  /* 질문 카드 */
  const canAsk = asker===S.me || (!q && now.hour>=12);
  const qc=h("div",{class:"card talkq"});
  if (q && !(S.editQ && q.asker===S.me)){
    put(qc,h("p",{class:"qtext"},"“"+q.question+"”"), h("div",{class:"who"},h("span",{class:"sub"},"— "+nick(q.asker)+"의 질문"),
      q.asker===S.me?h("button",{class:"linkbtn",onclick:()=>{S.editQ=true;S.qDraft=q.question;render();}},"질문 바꾸기"):null));
  } else if (canAsk){
    qc.append(h("b",{},asker===S.me?"🎤 오늘은 내가 질문 담당이에요!":"🎤 낮 12시가 지나서 누구나 질문을 올릴 수 있어요"));
    const inp=h("input",{type:"text",id:"talkQ",maxlength:"80",placeholder:"가족에게 물어볼 질문 (80자까지)","aria-label":"오늘의 질문",value:S.qDraft});
    const qbtn=h("button",{class:"btn primary",disabled:S.busy||!S.qDraft.trim(),onclick:()=>askQuestion(S.qDraft)},S.busy?"올리는 중…":"질문 올리기");
    inp.addEventListener("input",e=>{S.qDraft=e.target.value; qbtn.disabled=S.busy||!S.qDraft.trim();});
    const sug=h("div",{class:"sugs"},suggestions(today).map(t=>h("button",{class:"sug",onclick:()=>{S.qDraft=t;render();}},t)),
      h("button",{class:"sug more",onclick:()=>{S.sugShift++;render();}},"🔄 다른 추천"));
    put(qc,h("p",{class:"sub"},"추천 질문을 눌러 고르거나 직접 써도 돼요."), sug, inp, qbtn,
      S.editQ?h("button",{class:"btn",onclick:()=>{S.editQ=false;render();}},"취소"):null);
  } else {
    qc.append(h("p",{class:"qtext wait"},"🎤 "+nick(asker)+"님이 오늘의 질문을 고르는 중이에요"),
      h("p",{class:"sub"},"낮 12시까지 질문이 없으면 누구나 추천 질문을 올릴 수 있어요."));
  }
  const e1=errLine(); if (e1) qc.append(e1);
  out.push(qc);

  /* 답 */
  if (q){
    const answers=talkAnswers(today); const mine=answers.find(a=>a.member_id===S.me);
    const unlocked = !!mine || q.asker===S.me;
    const ac=h("div",{class:"card"});
    const inp=h("input",{type:"text",id:"talkA",maxlength:"100",placeholder:"한 줄로 답하기 (100자까지)","aria-label":"내 답",value:S.aDraft});
    const off=()=>S.busy||!S.aDraft.trim()||!!(mine&&S.aDraft.trim()===mine.answer);
    const abtn=h("button",{class:"btn"+(mine?"":" primary"),disabled:off(),onclick:sendAnswer},mine?"답 고치기":"답하기");
    inp.addEventListener("input",e=>{S.aDraft=e.target.value; abtn.disabled=off();});
    inp.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.isComposing&&!off()) sendAnswer(); });
    put(ac,h("b",{},mine?"✍️ 내 답 (밤 12시까지 고칠 수 있어요)":"✍️ 내 답"), inp, abtn);
    out.push(ac);
    const others=answers.filter(a=>a.member_id!==S.me);
    const lc=h("div",{class:"card"},h("b",{},"💬 가족의 답"));
    if (!unlocked){
      const n=Math.max(0,(S.talk.count||0));
      lc.append(h("div",{class:"locked"},h("span",{class:"lock"},"🔒"),h("span",{},n?("답 "+n+"개가 기다리고 있어요. 내가 답하면 보여요!"):"아직 아무도 답하지 않았어요. 첫 번째로 답해보세요!")));
    } else if (!others.length){
      lc.append(h("p",{class:"sub"},"아직 다른 가족의 답이 없어요."));
    } else lc.append(h("ul",{class:"bubbles"},others.map(bubble)));
    out.push(lc);
  }

  /* 지난 오늘톡 */
  const past=S.talk.q.filter(x=>x.day<today).slice(0,30);
  if (past.length){
    const sec=h("section",{},h("h2",{},"📚 지난 오늘톡"));
    for (const pq of past){
      const ans=talkAnswers(pq.day);
      sec.append(h("details",{class:"card past"},
        h("summary",{},h("span",{class:"sub"},fmt(pq.day)+" · "+nick(pq.asker)),h("b",{},pq.question)),
        ans.length?h("ul",{class:"bubbles"},ans.map(bubble)):h("p",{class:"sub"},"답이 없었어요.")));
    }
    out.push(sec);
  }
  return out;
}

/* ---------- 그리기 ---------- */
let lastStamp="";
const SHOT_VIEWS=["today","vote","result","gallery"];
function currentView(){ const v=(location.hash||"").slice(1); return [...SHOT_VIEWS,"talk"].includes(v)?v:"today"; }
/* 한컷 안의 작은 탭 (오늘·투표·결과·그림) */
function shotTabs(v){
  const items=[["today","📸 오늘"],["vote","🗳️ 투표"],["result","🏅 결과"],["gallery","🎨 그림"]];
  return h("nav",{class:"seg","aria-label":"한컷 메뉴"},items.map(([k,t])=>h("a",{href:"#"+k,"aria-current":k===v?"page":null},t)));
}
function render(){
  const now=kst(); lastStamp=now.date+"|"+(now.hour>=VOTE_CLOSE_HOUR);
  const v=currentView();
  document.getElementById("todayLabel").textContent=fmt(now.date)+" · 우리 가족의 하루 한 장";
  const ready = S.status==="ready" && !S.renaming;
  const tabs=document.getElementById("tabs"); tabs.hidden=!ready;
  const group = v==="talk" ? "talk" : "shot";
  for (const a of tabs.querySelectorAll("a")){ if (a.dataset.v===group) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current"); }

  const meBox=document.getElementById("meBox"); meBox.replaceChildren();
  if (S.status==="ready" && S.me){
    meBox.append(h("div",{},"나: ",h("b",{},nick(S.me))));
    if (S.joinCode) meBox.append(h("button",{class:"linkbtn",onclick:()=>{S.renaming=true;S.err="";render();}},"이름 바꾸기"));
  }

  const view=document.getElementById("view");
  const active=document.activeElement && document.activeElement.id;
  let nodes;
  if (S.status==="loading") nodes=[h("div",{class:"empty"},"가족 사진을 불러오는 중이에요…")];
  else if (S.status==="config") nodes=viewMessage("설정이 아직 안 됐어요","config.js 에 Supabase 주소와 공개 키를 넣어주세요.");
  else if (S.status==="noinvite") nodes=viewMessage("초대 링크로 열어주세요","가족에게 받은 초대 링크(#join= 이 붙은 주소)로 한 번만 열면, 다음부터는 그냥 열려요.");
  else if (S.status==="offline"){ nodes=viewMessage("연결이 안 돼요", S.err||"인터넷 연결을 확인한 뒤 화면을 새로 고쳐주세요."); if (S.errDetail) nodes.push(h("p",{class:"sub"},"자세한 내용: "+S.errDetail)); nodes.push(h("button",{class:"btn",onclick:()=>location.reload()},"다시 시도")); }
  else if (S.status==="pick" || S.renaming) nodes=viewPick();
  else if (v==="talk") nodes=viewTalk(now);
  else { nodes = v==="vote"?viewVote(now): v==="result"?viewResult(now): v==="gallery"?viewGallery(now): viewToday(now); nodes.unshift(shotTabs(v)); }
  if (S.slow && S.status==="ready") nodes.unshift(h("p",{class:"notice"},"일부 사진을 불러오지 못했어요. 인터넷 연결을 확인해주세요."));
  view.replaceChildren(h("div",{class:"wrap"},nodes));
  if (["caption","talkQ","talkA"].includes(active)){ const c=document.getElementById(active); if(c){ c.focus(); const l=c.value.length; try{c.setSelectionRange(l,l);}catch(e){} } }
}

/* ---------- 불러오기 ---------- */
async function loadData(){
  const [m,p,v,pt]=await Promise.all([
    S.sb.from("members").select("id,nickname,is_painter,joined_at"),
    S.sb.from("photos").select("day,member_id,path,caption,created_at"),
    S.sb.from("votes").select("day,voter,target"),
    S.sb.from("paintings").select("week_start,path")
  ]);
  const err=m.error||p.error||v.error||pt.error; if (err) throw err;
  S.members={}; for (const r of m.data) S.members[r.id]=r;
  S.photos=p.data; S.votes=v.data;
  S.paintings={}; for (const r of pt.data) S.paintings[r.week_start]=r;
  const mine=photoOf(S.me,kst().date);
  if (document.activeElement?.id!=="caption") S.captionDraft = mine ? (mine.caption||"") : (S.captionDraft||"");
  S.slow=false;
}
async function refresh(){
  try{
    const r=await S.sb.rpc("my_member_id"); if (r.error) throw r.error;
    S.me=r.data||null;
    if (!S.me){ S.status = S.joinCode ? "pick" : "noinvite"; render(); return; }
    await loadData();
    await loadTalk();
    S.status="ready";
  }catch(e){
    if (S.status==="ready") S.slow=true;
    else { S.status="offline"; S.err=friendly(e,"가족 정보를 불러오지 못했어요. 잠시 후 화면을 새로 고쳐주세요."); S.errDetail=detail(e); }
  }
  render();
}
function readJoinCode(){
  const m=(location.hash||"").match(/^#join=([^&]+)/);
  if (m){
    const code=decodeURIComponent(m[1]).trim();
    if (code) store(()=>localStorage.setItem(CODE_KEY,code));
    history.replaceState(null,"",location.pathname+location.search+"#today");
    if (code) return code;
  }
  return store(()=>localStorage.getItem(CODE_KEY)) || null;
}
async function boot(){
  render();
  const cfg=window.TODAY_SHOT_CONFIG||{};
  if (!cfg.supabaseUrl || /YOUR-/.test(cfg.supabaseUrl+cfg.supabaseAnonKey) || !window.supabase){ S.status="config"; render(); return; }
  S.joinCode=readJoinCode();
  S.sb=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,storageKey:"todayshot.auth",lock:async (name,timeout,fn)=>await fn()}});
  try{
    let {data}=await S.sb.auth.getSession();
    if (!data.session){
      if (!S.joinCode){ S.status="noinvite"; render(); return; }
      const r=await S.sb.auth.signInAnonymously(); if (r.error) throw r.error;
    }
  }catch(e){ S.status="offline"; S.err=friendly(e,"로그인하지 못했어요. 잠시 후 화면을 새로 고쳐주세요."); S.errDetail=detail(e); render(); return; }
  await refresh();
}

/* 맨 위 "오늘한컷" 글씨 = 홈 버튼 (이미 오늘 탭이면 맨 위로 올리고 새로 불러옴) */
document.getElementById("homeLink").addEventListener("click",e=>{
  e.preventDefault(); S.renaming=false; S.err="";
  if (location.hash!=="#today") history.pushState(null,"","#today");
  window.scrollTo({top:0,behavior:"smooth"}); render();
  if (S.status==="ready" && !S.busy) refresh();
});
window.addEventListener("hashchange",()=>{ if (/^#join=/.test(location.hash)){ location.reload(); return; } S.err=""; render(); window.scrollTo(0,0); });
document.addEventListener("visibilitychange",()=>{ if (document.visibilityState==="visible" && S.status==="ready" && !S.busy) refresh(); });
setInterval(()=>{
  if (document.visibilityState!=="visible") return;
  const n=kst();
  if (S.status==="ready" && !S.busy && document.activeElement?.tagName!=="INPUT") refresh();
  else if (n.date+"|"+(n.hour>=VOTE_CLOSE_HOUR)!==lastStamp) render();
},60000);
if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();
})();
