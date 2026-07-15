/**
 * cc_tooltip.js — Dock hover tooltip（E 階段自 index.html 抽出，2026-07-06）
 * 依賴（呼叫期才取用）：LIVE、rfToday()、localStorage、#tooltip 元素
 * 對外提供：esc()（Lab 分析結果與 Dev Dashboard 於事件期使用）
 * 依需求移除：english（English Sandbox）圖示不提供 hover 提示，buildTT 無此 case，交由 default 回傳空字串
 */
// ── LEAN TOOLTIP ──
const ttp=document.getElementById('tooltip');
let ttT;
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function row(k,v,c=''){return`<div class="tt-row"><span class="tt-k">${k}</span><span class="tt-v${c?' '+c:''}">${v}</span></div>`;}
function advRow(k,v){return`<div class="tt-adv"><span class="tt-adv-k">${k}</span><span class="tt-adv-v">${v}</span></div>`;}
function sub(t){return`<div class="tt-sub">${t}</div>`;}
function hr(){return`<div class="tt-hr"></div>`;}
function spark(vals){
  const B='▁▂▃▄▅▆▇█';
  if(!vals||!vals.length)return'';
  const mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||1;
  return vals.map(v=>B[Math.round((v-mn)/rng*7)]).join('');
}
function buildTT(id){
  const h=(t)=>`<div class="tt-head">${t}</div>`;
  const rf=rfToday();
  switch(id){
    case 'sas-hub':{
      const cp=LIVE.sleep?.combatPower??LIVE.optimizer?.combatPower??'—';
      const pace=LIVE.sleep?.pace??'請先訪問 SAS Hub';
      const sleepCp=parseInt(localStorage.getItem('sas_combat')||'0')||null;
      const endTime=sleepCp?`${String(Math.floor(8+sleepCp/100*14)).padStart(2,'0')}:00`:null;
      const endColor=sleepCp?(sleepCp>=70?'g':sleepCp>=40?'a':'r'):'';
      const enduranceHtml=endTime?hr()+row('體能續航至',endTime,endColor):'';
      // 上週回顧摘要（週一顯示，或當週有資料時顯示）
      let recapHtml='';
      try{
        const rc=JSON.parse(localStorage.getItem('sas_weekly_recap')||'null');
        const isMonday=new Date().getDay()===1;
        if(rc&&rc.text&&(isMonday||Date.now()-rc.ts<7*86400000)){
          recapHtml=hr()+`<div style="padding:3px 0;">${sub('📋 上週回顧')}<div style="font-size:10.5px;color:var(--ink);line-height:1.55;">${rc.text}</div></div>`;
        }
      }catch(e){}
      const cpSingle=LIVE.sleep?.combatSingle??null;
      const cpWeighted=LIVE.sleep?.combatWeighted??sleepCp;
      let combatRows='';
      if(cpSingle!=null&&cpWeighted!=null){
        const diff=cpSingle-cpWeighted;
        const diffStr=diff>0?`+${diff}`:String(diff);
        const diffColor=Math.abs(diff)<5?'var(--ok)':diff>0?'var(--warn)':'var(--danger)';
        let trendIcon,trendLabel,trendText,trendClr;
        if(Math.abs(diff)<5){trendIcon='→';trendLabel='持平';trendClr='var(--ok)';trendText='近期睡眠穩定，兩值均可作今日依據';}
        else if(diff>15){trendIcon='↗';trendLabel='單夜急彈';trendClr='var(--danger)';trendText='昨晚異常佳，前幾天虧損仍在 → 今日以加權為準，勿透支';}
        else if(diff>0){trendIcon='↗';trendLabel='昨晚回彈';trendClr='var(--warn)';trendText='睡眠往好的方向走，身體仍在追回前幾天虧損';}
        else if(diff<-10){trendIcon='↘';trendLabel='明顯下滑';trendClr='var(--danger)';trendText='睡眠品質下滑 → 今日以加權為準，今晚務必補眠';}
        else{trendIcon='↘';trendLabel='小幅下滑';trendClr='#5c7a96';trendText='近期底子仍在，今晚優先恢復';}
        combatRows=row('單夜戰力',String(cpSingle),cpSingle>=75?'g':cpSingle>=50?'a':'r')
          +row('3夜加權',String(cpWeighted),cpWeighted>=75?'g':cpWeighted>=50?'a':'r')
          +`<div class="tt-row"><span class="tt-k">差距</span><span style="font-size:11px;color:${diffColor};font-weight:600;">${diffStr}</span></div>`
          +`<div class="tt-row" style="flex-direction:column;align-items:flex-start;gap:2px;padding:3px 0;">`
          +`<span style="font-size:11px;font-weight:700;color:${trendClr};">${trendIcon} ${trendLabel}</span>`
          +`<span style="font-size:10.5px;color:var(--faint);line-height:1.45;">${trendText}</span></div>`;
      } else {
        combatRows=row('今日戰力（3夜加權）',cp,cp==='—'?'':(+cp>=75?'g':+cp>=50?'a':'r'));
      }
      const enduranceHtmlFinal=endTime?hr()+row('體能續航至',endTime+'　·　加權基準',endColor):'';
      return h('SAS Hub')+combatRows+enduranceHtmlFinal+hr()+`<div style="padding:3px 0;">${sub('配速建議')}<div style="font-size:11.5px;color:var(--ink);font-weight:500;">${pace}</div></div>`+recapHtml;
    }
    case 'sleep':{
      if(!LIVE.sleep)return h('最新睡眠')+`<div style="font-size:11px;color:var(--faint);text-align:center;padding:4px 0;">請先訪問 Sleep Dashboard 以更新資料</div>`;
      const s=LIVE.sleep;
      const dot=(c)=>`<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${c};margin-right:4px;vertical-align:middle;opacity:.85;"></span>`;
      let out=h('睡眠紀錄 · '+s.date);
      // 時長 + 起止
      if(s.totalMin){
        const durH=Math.floor(s.totalMin/60),durM=s.totalMin%60;
        const durStr=durH+'h'+(durM?durM+'m':'');
        out+=row('時長',durStr,durH>=7?'g':durH>=6?'a':'r');
      }
      if(s.bedtime&&s.wake) out+=row('起止',s.bedtime+' → '+s.wake);
      out+=hr();
      // 睡眠分期
      out+=row(dot('#8aabcc')+'Deep', s.deepP+'%', s.deepP>=18?'g':s.deepP>=12?'a':'r')
         +row(dot('#a898b8')+'REM',   s.remP+'%',  s.remP>=18?'g':s.remP>=12?'a':'r')
         +row(dot('#8fac94')+'Core',  s.coreP+'%')
         +row(dot('#c4aa7c')+'Awake', s.awakeP+'%',s.awakeP<=8?'g':s.awakeP<=15?'a':'r');
      // 近7日趨勢
      if(s.trend7&&s.trend7.length>2){
        const deepVals=s.trend7.map(n=>n.deepP);
        const remVals=s.trend7.map(n=>n.remP);
        const latestDeep=deepVals[deepVals.length-1],prevDeep=deepVals[deepVals.length-2];
        const latestRem=remVals[remVals.length-1],prevRem=remVals[remVals.length-2];
        const dArr=latestDeep>prevDeep?'↑':latestDeep<prevDeep?'↓':'→';
        const rArr=latestRem>prevRem?'↑':latestRem<prevRem?'↓':'→';
        out+=hr()
          +sub(`近${s.trend7.length}日趨勢`)
          +`<div class="tt-row"><span class="tt-k">${dot('#8aabcc')}Deep</span><span class="tt-v tt-spark" style="color:#8aabcc;">${spark(deepVals)}</span><span class="tt-v ${latestDeep>=18?'g':latestDeep>=12?'a':'r'}" style="font-size:10px;margin-left:4px;">${dArr}</span></div>`
          +`<div class="tt-row"><span class="tt-k">${dot('#a898b8')}REM</span><span class="tt-v tt-spark" style="color:#a898b8;">${spark(remVals)}</span><span class="tt-v ${latestRem>=18?'g':latestRem>=12?'a':'r'}" style="font-size:10px;margin-left:4px;">${rArr}</span></div>`;
      }
      return out;
    }
    case 'mental':{
      const mes=LIVE.mental?.entries||[];
      if(!mes.length)return h('今日 Mental')+`<div style="font-size:11px;color:var(--faint);padding:4px 0;">今日尚無記錄</div>`;
      let out=h('今日 Mental');
      mes.forEach((m,i)=>{
        if(i>0)out+=hr();
        out+=row(m.time||`#${i+1}`,m.score+'/10',m.score>=7?'g':m.score>=5?'a':'r');
        if(m.factors.length){
          out+=m.factors.map(f=>`<div style="font-size:10.5px;color:var(--sub);padding:1px 0 1px 4px;line-height:1.5;">· ${f}</div>`).join('');
        }
      });
      return out;
    }
    case 'optimizer':{
      loadOptimizerData();
      const o=LIVE.optimizer;
      if(!o)return h('優化器')+`<div style="font-size:11px;color:var(--faint);">讀取中…</div>`;
      const status=o.rest?'🌿 休假中':'工作中';
      let out=h('優化器')+row('狀態',status,o.rest?'a':'g')+row('任務',o.done+'/'+o.total,o.done===o.total?'g':'a')+hr();
      if(o.tasks&&o.tasks.length){
        out+=`<div style="display:grid;grid-template-columns:14px 1fr;row-gap:5px;column-gap:7px;padding:2px 0;">`;
        for(const t of o.tasks){
          const dn=t.done||false;
          const lbl=(t.text||t.title||t.label||t.content||t.name||'').slice(0,24)||'—';
          out+=`<span style="font-size:10px;color:${dn?'#7d9e85':'#bbb'};text-align:center;line-height:1.5;">${dn?'✓':'○'}</span>`
             +`<span style="font-size:10.5px;color:${dn?'var(--faint)':'var(--ink)'};text-decoration:${dn?'line-through':''};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5;">${lbl}</span>`;
        }
        out+=`</div>`;
      }
      return out;
    }
    case 'refueler':
      return h('今日攝取')+row('☕ 咖啡',rf.coffee+'杯',rf.coffee<=3?'g':rf.coffee<=4?'a':'r')+row('💧 水分',rf.water+'ml',rf.water>=2000?'g':rf.water>=1000?'a':'r');
    case 'report':
      return h('綜觀分析')+`<div style="font-size:11px;color:var(--faint);padding:4px 0;">點擊進行 AI 整合分析</div>`;
    case 'aitracker':{
      const ai=LIVE.aitracker;
      if(!ai)return'';
      if(!ai.hasNote)return h('AI 追蹤')+`<div style="font-size:11.5px;color:var(--warn);padding:3px 0;font-weight:500;">📝 今天還沒寫新聞筆記！</div>`;
      return h('AI 追蹤')+`<div style="font-size:11px;color:var(--ok);padding:3px 0;">✅ 今日筆記已記錄</div>`;
    }
    case 'linkedin':{
      loadLinkedInData();
      fetchNotionLinkedIn();
      const li=LIVE.linkedin||{saved:0,applied:0,declined:0,contacted:0,interviewed:0,interviewed_titles:[],to_interviewed:0,to_interviewed_titles:[],abandoned:0};
      const hasData=li.saved||li.applied||li.declined||li.contacted||li.interviewed||li.to_interviewed||li.abandoned;
      const itvDone=(li.interviewed_titles||[]);
      const itvPending=(li.to_interviewed_titles||[]);
      return h('LinkedIn 求職進度')
        +row('⭐ Saved',li.saved+'個')
        +row('📨 Applied',li.applied+'個',li.applied>0?'g':'')
        +row('💬 Contacted',li.contacted+'個',li.contacted>0?'g':'')
        +row('🗓 To Be Interviewed',li.to_interviewed+'個',li.to_interviewed>0?'g':'')
        +(itvPending.length?itvPending.map(t=>`<div style="font-size:11px;color:var(--ok);padding:1px 0 1px 10px;line-height:1.55;">· ${t.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`).join(''):'')
        +row('✅ Interviewed',li.interviewed+'個',li.interviewed>0?'g':'')
        +(itvDone.length?itvDone.map(t=>`<div style="font-size:11px;color:var(--ink);padding:1px 0 1px 10px;line-height:1.55;">· ${t.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`).join(''):'')
        +row('🚫 Declined',li.declined+'個',li.declined>0?'a':'')
        +row('💨 Abandoned',li.abandoned+'個',li.abandoned>0?'a':'')
        +(hasData?'':hr()+`<div style="font-size:10px;color:var(--faint);text-align:center;padding:2px 0;">正在從 Notion 同步…</div>`);
    }
    case 'oasis':{
      let saved=[];
      try{saved=JSON.parse(localStorage.getItem('oasis_saved')||'[]');}catch{}
      if(!saved.length)return h('🌿 Oasis')+`<div style="font-size:11px;color:var(--faint);padding:4px 0;">收藏夾是空的</div>`;
      const item=saved[Math.floor(Math.random()*saved.length)];
      const isZh=(item.lang==='zh');
      const quote=(item.quote||'').replace(/\n/g,' ').slice(0,80)+(item.quote&&item.quote.replace(/\n/g,' ').length>80?'…':'');
      const trans=(!isZh&&item.translation)?(item.translation||'').replace(/\n/g,' ').slice(0,60)+(item.translation&&item.translation.replace(/\n/g,' ').length>60?'…':''):'';
      const metaOrig=[item.title?`《${item.title}》`:'',item.author||''].filter(Boolean).join('　');
      const metaZh=!isZh?[item.title_zh?`《${item.title_zh}》`:'',item.author_zh||''].filter(Boolean).join('　'):'';
      const country=item.country||'';
      return h('🌿 Oasis')+
        (country?`<div style="font-size:10px;padding:2px 7px;border-radius:8px;background:var(--card);display:inline-block;margin-bottom:7px;color:var(--sub);">${country}</div>`+hr():'')+
        `<div style="font-size:12px;line-height:1.7;color:var(--ink);margin-bottom:6px;">${quote}</div>`+
        (trans?`<div style="font-size:11px;line-height:1.6;color:var(--sub);margin-bottom:6px;">${trans}</div>`:'')+
        hr()+
        `<div style="font-size:10.5px;color:var(--faint);">${metaOrig}</div>`+
        (metaZh?`<div style="font-size:10px;color:var(--faint);opacity:.75;">${metaZh}</div>`:'')+
        ((item.tags&&item.tags.length)?hr()+`<div style="font-size:10px;color:var(--faint);">${item.tags.map(t=>'#'+t).join('　')}</div>`:'');
    }
    case 'worship':{
      let wl=null;try{wl=JSON.parse(localStorage.getItem('worship_last')||'null');}catch{}
      if(!wl)return h('⛩️ Worship')+`<div style="font-size:11px;color:var(--faint);padding:4px 0;">尚無參拜紀錄，點擊新增</div>`;
      return h('⛩️ Worship')+row('最近參拜',esc(wl.temple))+row('日期',esc(wl.date)+(wl.time?' '+esc(wl.time):''),'g');
    }
    case 'astro':{
      // 命盤圖片本體已搬到 IndexedDB（cc_store.js），這裡只讀 astro.html 順手維護的輕量計數索引
      // astro_vedic_images_count，不需要整包讀圖片內容（hover 卡片不需要同步跨 IndexedDB）
      let as=null;try{as=JSON.parse(localStorage.getItem('astro_settings')||'null');}catch{}
      const hasW=!!(as&&as.western);
      const vCount=parseInt(localStorage.getItem('astro_vedic_images_count')||'0',10)||0;
      const hasV=vCount>0;
      if(!as||(!hasW&&!hasV))return h('⭐ Astro Bot')+`<div style="font-size:11px;color:var(--faint);padding:4px 0;">尚未設定星盤資料，點擊進入</div>`;
      // Try today's brief
      let brief=null;
      try{
        const b=JSON.parse(localStorage.getItem('astro_cc_brief')||'null');
        if(b){
          const _t=new Date();
          const ds=`${_t.getFullYear()}-${String(_t.getMonth()+1).padStart(2,'0')}-${String(_t.getDate()).padStart(2,'0')}`;
          if(b.date===ds)brief=b;
        }
      }catch{}
      if(!brief){
        return h('⭐ Astro Bot')+
          row('西洋星盤',hasW?'已設定':'未設定',hasW?'g':'')+
          row('印度星盤',hasV?`${vCount} 張`:'未設定',hasV?'g':'')+
          (as.name?row('對象',esc(as.name)):'')+
          hr()+
          `<div style="font-size:11px;color:var(--faint);padding:2px 0;">前往 Astro Bot 生成今日建議</div>`;
      }
      const _n=new Date();
      const dateLbl=`${_n.getMonth()+1}/${_n.getDate()}`;
      const monthLbl=`${_n.getMonth()+1}月`;
      let out=h(`⭐ Astro  ${monthLbl} & ${dateLbl}`);
      out+=sub('本月');
      (brief.thisMonth||[]).forEach(l=>{const p=l.split('|');out+=advRow(esc((p[0]||l).trim()),esc((p[1]||'').trim()));});
      out+=hr();
      out+=sub(dateLbl);
      (brief.today||[]).forEach(l=>{const p=l.split('|');const k=esc((p[0]||l).trim().replace(/^本日\s*/,dateLbl+' '));out+=advRow(k,esc((p[1]||'').trim()));});
      return out;
    }
    case 'scratch':{
      // Scratchpad inbox：分 /To Do、/Notes 兩區塊顯示（cc_scratch_v1，零 history 設計故不顯示已轉入項）
      let sc=null;try{sc=JSON.parse(localStorage.getItem('cc_scratch_v1')||'null');}catch{}
      const items=(sc&&Array.isArray(sc.items))?sc.items:[];
      if(!items.length)return h('🗂 Scratchpad')+`<div style="font-size:11px;color:var(--faint);padding:4px 0;">Inbox 已清空 ✓</div>`;
      const fd=ts=>{const d=new Date(ts);return`${d.getMonth()+1}/${d.getDate()}`;};
      // 存在天數＝建立日之後至今的工作天數（不含週末），供 To Do 逾期紅字判斷
      const workdays=ts=>{
        const start=new Date(ts);start.setHours(0,0,0,0);
        const end=new Date();end.setHours(0,0,0,0);
        const days=Math.round((end-start)/86400000);
        if(days<=0)return 0;
        let wd=0;
        for(let i=1;i<=days;i++){if([0,6].indexOf(new Date(start.getTime()+i*86400000).getDay())<0)wd++;}
        return wd;
      };
      const MAX=8;
      const shown=items.slice(0,MAX);
      const todos=shown.filter(it=>it.type==='todo');
      const notes=shown.filter(it=>it.type!=='todo');
      const rowHtml=(it,redRule)=>{
        const raw=(it.text||'').replace(/\n/g,' ');
        const txt=esc(raw.slice(0,26))+(raw.length>26?'…':'');
        const wd=workdays(it.ts);
        const cls=(redRule&&wd>7)?' r':'';
        return `<div class="tt-row"><span class="tt-k" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">- ${txt}</span><span class="tt-v${cls}" style="flex-shrink:0;margin-left:8px;">${fd(it.ts)}${wd>=1?`・${wd}wd`:''}</span></div>`;
      };
      let out=h(`🗂 Scratchpad · Inbox ${items.length} 則`);
      if(todos.length){
        out+=sub('/To Do');
        todos.forEach(it=>out+=rowHtml(it,true));
      }
      if(notes.length){
        out+=sub('/Notes');
        notes.forEach(it=>out+=rowHtml(it,false));
      }
      if(items.length>MAX)out+=hr()+`<div style="font-size:10px;color:var(--faint);text-align:center;padding:2px 0;">…還有 ${items.length-MAX} 則</div>`;
      return out;
    }
    default:return'';
  }
}
document.addEventListener('mouseover',e=>{
  const ic=e.target.closest('.d-icon');
  if(!ic)return;
  clearTimeout(ttT);
  const c=buildTT(ic.dataset.id);
  if(!c){ttp.classList.add('tt-hide');return;}
  ttp.innerHTML=c;ttp.style.display='block';ttp.classList.remove('tt-hide');
  // Width = clock element's rendered width
  const clockRow=document.querySelector('#header > div:first-child');
  const cw=clockRow?Math.round(clockRow.getBoundingClientRect().width):200;
  ttp.style.width=cw+'px';
  // Center under clock
  const tw=ttp.offsetWidth||cw,th=ttp.offsetHeight||110;
  ttp.style.left=Math.round(window.innerWidth/2-tw/2)+'px';
  ttp.style.top=Math.round(window.innerHeight/2-th/2-40)+'px';
});
document.addEventListener('mouseout',e=>{
  if(!e.target.closest('.d-icon'))return;
  ttT=setTimeout(()=>{ttp.classList.add('tt-hide');setTimeout(()=>ttp.style.display='none',130);},70);
});
