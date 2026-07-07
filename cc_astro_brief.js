/**
 * cc_astro_brief.js — CC Brief 背景生成（E 階段自 index.html 抽出，2026-07-06）
 * 每日一次：讀 astro_settings 西洋星盤 → Groq 生成今日/本月建議 → 寫 astro_cc_brief
 * 依賴（呼叫期取用）：GROQ_KEY 常數（index.html 主 script 定義）、localStorage
 * 觸發：本檔載入後 3 秒（原 index.html 的 setTimeout 一併搬入）
 */
// ── ASTRO BRIEF (background, daily) ──
async function genAstroBrief(){
  const key=localStorage.getItem(GROQ_KEY)||'';
  if(!key)return;
  let as=null;try{as=JSON.parse(localStorage.getItem('astro_settings')||'null');}catch{}
  if(!as||!as.western)return;
  const now=new Date();
  const todayStr=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  try{const ex=JSON.parse(localStorage.getItem('astro_cc_brief')||'null');if(ex&&ex.date===todayStr)return;}catch{}
  const name=as.name||'你';
  const dayN=['日','一','二','三','四','五','六'];
  const todayD=`${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日（${dayN[now.getDay()]}）`;
  const monthD=`${now.getFullYear()}年${now.getMonth()+1}月`;
  const prompt=`你是精通現代西方占星學的占星師，深刻理解行星過境（Transits）與二次推運（Progressions）。\n\n以下是 ${name} 的西洋星盤資料：\n${as.western}\n\n針對今日 ${todayD} 和 ${monthD}，各給出 3-4 條簡短建議。以純 JSON 輸出，不加任何說明：\n{"today":["面向 | 建議（8-14字）",...],"month":["面向 | 建議（8-14字）",...]}`;
  try{
    const resp=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:prompt}],max_tokens:700,temperature:.7})});
    if(!resp.ok)return;
    const result=await resp.json();
    const text=result.choices?.[0]?.message?.content||'';
    const jm=text.match(/\{[\s\S]*\}/);
    if(!jm)return;
    const p=JSON.parse(jm[0]);
    if(!Array.isArray(p.today)||!Array.isArray(p.month))return;
    localStorage.setItem('astro_cc_brief',JSON.stringify({date:todayStr,today:p.today,thisMonth:p.month,ts:Date.now()}));
  }catch(e){}
}
setTimeout(genAstroBrief,3000);
