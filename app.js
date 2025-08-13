// ===== ユーティリティ =====
const $ = (s) => document.querySelector(s);
const fmtTime = (sec) => `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(Math.floor(sec%60)).padStart(2,'0')}`;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS) $('#browserWarn').hidden = false;

// ===== PDF読み込み＆正規化（縦書き対応） =====
let refRaw = '';
let refNorm = '';

document.addEventListener('DOMContentLoaded', () => {
  if (window['pdfjsLib']) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
});

$('#pdfInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const array = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: array }).promise;
  const page = await pdf.getPage(1);
  const textContent = await page.getTextContent();
  let items = textContent.items || [];

  // ルビなどの小さい文字を除去（高さの下位25%を目安にカット）
  const heights = items.map(i => i.height || Math.hypot(i.transform?.[2]||0, i.transform?.[3]||0) || 0.0);
  const sortedH = [...heights].sort((a,b)=>a-b);
  const q3 = sortedH[Math.floor(sortedH.length * 0.25)] || 0; // 下位25%
  items = items.filter((it, idx) => (heights[idx] || 0) >= q3 * 0.9);

  // 自動で縦/横を推定（文字の回転から）
  const isAutoVertical = detectVertical(items);
  $('#autoDir').textContent = `自動判定：${isAutoVertical ? '縦書き' : '横書き'}（チェックで上書き可）`;

  const useVertical = $('#verticalMode').checked ? true : isAutoVertical;
  // 縦書きに応じた並べ替えで読み順を再構成
  const raw = reconstruct(items, useVertical);

  refRaw = raw;
  renderPreview(raw);
  applyNormalization();
});

$('#verticalMode').addEventListener('change', () => {
  // 再正規化だけ行う（プレビューは次回PDF読み込み時に反映）
  applyNormalization();
});

function getXY(it){ const m = it.transform || [1,0,0,1,0,0]; return {x:m[4]||0, y:m[5]||0}; }
function getAngleDeg(it){ const m = it.transform || [1,0,0,1,0,0]; const deg = Math.abs(Math.atan2(m[1]||0, m[0]||1) * 180 / Math.PI); return (deg+360)%360; }

function detectVertical(items){
  let v=0,h=0;
  for(const it of items){
    const d = getAngleDeg(it)%180;
    if (d>45 && d<135) v++; else h++;
  }
  // 90度回転が多数なら縦書き
  return v > h;
}

function reconstruct(items, vertical){
  // 粗いヒューリスティック：
  // 横書き：行を上→下（y大→小）、同じ行内で左→右（x小→大）
  // 縦書き：列を右→左（x大→小）、同じ列内で上→下（y小→大）
  const EPS = 3;
  const arr = [...items].sort((a,b)=>{
    const A = getXY(a), B = getXY(b);
    if (!vertical){
      if (Math.abs(A.y - B.y) > EPS) return B.y - A.y; // 上(大)→下(小)
      if (Math.abs(A.x - B.x) > EPS) return A.x - B.x; // 左→右
    }else{
      if (Math.abs(A.x - B.x) > EPS) return B.x - A.x; // 右(大)→左(小)
      if (Math.abs(A.y - B.y) > EPS) return A.y - B.y; // 上→下
    }
    return 0;
  });
  return arr.map(i=>i.str).join('');
}

function renderPreview(raw){
  $('#pdfPreview').textContent = raw || '(テキストが抽出できませんでした。画像のみのPDFかもしれません)';
}

// 縦組用の縦中横・縦書き用約物の正規化マップ
const VERT_MAP = {
  '︑':'、','︒':'。','︙':'…','︰':'：','︕':'！','︖':'？',
  '﹑':'、','﹒':'。','﹔':'；','﹕':'：','﹖':'？','﹗':'！',
  '﹘':'ー','︵':'（','︶':'）','︷':'{','︸':'}'
};

function normalize(text){
  const keepPunct = $('#keepPunct').checked;
  const keepSpaces = $('#keepSpaces').checked;

  // 縦用の記号を標準に寄せる
  let t = text.replace(/[\uFE10-\uFE1F\uFE30-\uFE4F]/g, ch => VERT_MAP[ch] || '');

  // ルビ/注記らしき括弧の簡易除去
  t = t.replace(/[（(][^（）()]{1,20}[）)]/g, '');

  if (!keepSpaces) t = t.replace(/\s+/g, '');
  if (!keepPunct)  t = t.replace(/[、。,.，．!！?？:;"'「」『』（）()［］\[\]…・：；]/g, '');

  t = t.toLowerCase();
  return t;
}

function applyNormalization(){
  refNorm = normalize(refRaw);
  $('#refText').textContent = refRaw || '(本文なし)';
}

$('#keepPunct').addEventListener('change', applyNormalization);
$('#keepSpaces').addEventListener('change', applyNormalization);

// ===== 採点（重み付き編集距離） =====
function scoreByLevel(level){
  return [
    { D:0.8, S:1.0, I:0.3 },
    { D:1.0, S:1.2, I:0.5 },
    { D:1.3, S:1.6, I:0.7 },
  ][level] || { D:1.0, S:1.2, I:0.5 };
}
function editDistanceWeighted(ref, hyp, w){
  const R = ref.length, H = hyp.length;
  const dp = Array(R+1).fill(null).map(()=>Array(H+1).fill(0));
  for (let i=0;i<=R;i++) dp[i][0] = i * w.D;
  for (let j=0;j<=H;j++) dp[0][j] = j * w.I;
  for (let i=1;i<=R;i++){
    for (let j=1;j<=H;j++){
      const cost = ref[i-1]===hyp[j-1] ? 0 : w.S;
      dp[i][j] = Math.min(
        dp[i-1][j] + w.D,
        dp[i][j-1] + w.I,
        dp[i-1][j-1] + cost
      );
    }
  }
  return dp[R][H];
}
function calcScore(ref, hyp, level){
  const w = scoreByLevel(level);
  const N = Math.max(1, ref.length);
  const err = editDistanceWeighted(ref, hyp, w);
  const score = Math.max(0, Math.round(100 * (1 - err / N)));
  return { score, errRate: Math.max(0, (err / N)) };
}
function describeSpeed(cps){
  if (!isFinite(cps)) return '—';
  if (cps < 2.0) return 'ゆったり（丁寧）';
  if (cps > 4.0) return 'はやめ（元気）';
  return 'ちょうどよい（聞き取りやすい）';
}
function describeAccuracy(acc){
  if (!isFinite(acc)) return '—';
  if (acc >= 0.98) return `${Math.round(acc*100)}%（とても正確）`;
  if (acc >= 0.95) return `${Math.round(acc*100)}%（正確）`;
  if (acc >= 0.90) return `${Math.round(acc*100)}%（まずまず）`;
  return `${Math.round(acc*100)}%（がんばろう）`;
}
function makeAdvice(ref, hyp){
  const r = ref.length, h = hyp.length;
  if (h < r * 0.9) return '行の切れ目で指さし確認をして、読み飛ばしを防ごう。';
  if (h > r * 1.1) return '句読点で小休止して、言い直しや言い足しを減らそう。';
  return 'むずかしい語の前で一呼吸おいて、落ち着いて発音しよう。';
}

// ===== 音声認識 =====
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recEnabled = !!SR;
let startAt = 0;
let timerId = null;
let liveFinal = '';

function updateLevelLabel(){
  const map = ['やさしい','ふつう','きびしい'];
  $('#levelLabel').textContent = map[$('#level').value] || 'ふつう';
}
updateLevelLabel();
$('#level').addEventListener('input', updateLevelLabel);

function startTimer(){
  startAt = Date.now();
  timerId = setInterval(()=>$('#timer').textContent=fmtTime((Date.now()-startAt)/1000), 250);
}
function stopTimer(){ clearInterval(timerId); timerId=null; }

$('#startBtn').addEventListener('click', () => {
  if (!recEnabled){ alert('このブラウザでは音声認識が使えません。PCのChrome/Edgeをお試しください。'); return; }
  if (!refNorm){ alert('まずPDFを読み込んでください。'); return; }
  $('#startBtn').disabled = true;
  $('#stopBtn').disabled = false;
  $('#liveText').textContent = '';
  liveFinal = '';
  startTimer();

  rec = new SR();
  rec.lang = 'ja-JP';
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (e)=>{
    let interim='';
    for (let i=e.resultIndex;i<e.results.length;i++){
      const r = e.results[i];
      if (r.isFinal) liveFinal += r[0].transcript;
      else interim += r[0].transcript;
    }
    $('#liveText').textContent = liveFinal + (interim ? ` (${interim})` : '');
  };
  rec.onerror = (e)=>console.warn('ASR error:', e.error);
  rec.onend = ()=>{ if (!$('#stopBtn').disabled){ try{ rec.start(); }catch{} } };

  try { rec.start(); } catch (e) {
    console.error(e);
    alert('音声認識を開始できませんでした。マイク権限を確認してください。');
    $('#startBtn').disabled = false;
    $('#stopBtn').disabled = true;
  }
});

$('#stopBtn').addEventListener('click', () => {
  $('#stopBtn').disabled = true;
  try{ rec && rec.stop && rec.stop(); }catch{}
  stopTimer();

  const hypRaw = liveFinal;
  const hypNorm = normalize(hypRaw);
  const level = Number($('#level').value);

  const { score, errRate } = calcScore(refNorm, hypNorm, level);
  const sec = Math.max(0.1, (Date.now()-startAt)/1000);
  const cps = hypNorm.length / sec;
  const acc = Math.max(0, 1 - errRate);

  $('#score').textContent = String(score);
  const good = [`速度：${describeSpeed(cps)}`, `正確さ：${describeAccuracy(acc)}`];
  $('#goodList').innerHTML = good.map(x=>`<li>${x}</li>`).join('');
  $('#advice').textContent = makeAdvice(refNorm, hypNorm);

  if (score === 100){ try{ confetti({ particleCount: 180, spread: 90, startVelocity: 45, origin:{y:0.7} }); $('#fanfare')?.play?.(); }catch{} }

  $('#startBtn').disabled = false;
});

$('#retryBtn').addEventListener('click', () => {
  $('#liveText').textContent=''; liveFinal=''; $('#score').textContent='--';
  $('#goodList').innerHTML='<li>速度：--</li><li>正確さ：--</li>'; $('#advice').textContent='--'; $('#timer').textContent='00:00';
});

$('#saveBtn').addEventListener('click', () => {
  const row = {
    t: new Date().toISOString(),
    score: $('#score').textContent,
    speed: $('#goodList').querySelectorAll('li')[0]?.textContent || '',
    acc: $('#goodList').querySelectorAll('li')[1]?.textContent || ''
  };
  const key = 'ondoku_history_v1';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  list.unshift(row);
  localStorage.setItem(key, JSON.stringify(list));
  renderHistory();
  alert('保存しました（この端末のみ）');
});

function renderHistory(){
  const key = 'ondoku_history_v1';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  $('#histBody').innerHTML = list.map(r=>{
    const dt = new Date(r.t);
    const ymd = `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
    return `<tr><td>${ymd}</td><td>${r.score}</td><td>${r.speed.replace('速度：','')}</td><td>${r.acc.replace('正確さ：','')}</td></tr>`;
  }).join('');
}
renderHistory();
