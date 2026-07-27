/* ============================================================
   Repas Atelier — フロント制御
   アップロード → 画像圧縮 → プロキシ経由でAI解析 → 結果描画
   ============================================================ */
const CFG = window.REPAS_CONFIG || {};
const $ = (id) => document.getElementById(id);

/* ---- 解析プロキシのURL解決 ----
   localhost はローカルPythonプロキシの /api/analyze を使用。
   本番は config.js の PROXY_URL。 */
function proxyUrl() {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return '/api/analyze';
  return CFG.PROXY_URL || '/api/analyze';
}

let currentFile = null;

/* ============================================================
   セクション表示切替
   ============================================================ */
function revealStart() {
  const s = $('start');
  s.hidden = false;
  s.scrollIntoView({ behavior: 'smooth' });
}
document.querySelectorAll('.js-reveal').forEach((a) =>
  a.addEventListener('click', (e) => { e.preventDefault(); revealStart(); })
);

/* ============================================================
   アップロード（ファイル / 貼り付け / ドラッグ&ドロップ）
   ============================================================ */
const fileInput = $('file');
fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) handleFile(f);
});

$('reselect').addEventListener('click', () => fileInput.click());

window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.indexOf('image') === 0) {
      const f = it.getAsFile();
      if (f) { revealStart(); handleFile(f); }
      break;
    }
  }
});

const body = document.body;
['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); body.classList.add('drop-over'); })
);
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.relatedTarget === null) body.classList.remove('drop-over'); })
);
window.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && f.type.indexOf('image') === 0) { revealStart(); handleFile(f); }
});

function handleFile(file) {
  if (!file.type || file.type.indexOf('image') !== 0) {
    setStatus('画像ファイルを選んでください（JPEG / PNG / HEIC）。', true);
    return;
  }
  currentFile = file;
  const img = $('preview-img');
  img.src = URL.createObjectURL(file);
  $('preview').hidden = false;
  $('after-upload').hidden = false;
  setStatus('この写真でよければ「診断する」を押してください。', false);
}

function setStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}

/* ============================================================
   画像の準備（縮小 + base64）。HEIC等はrawフォールバック。
   ============================================================ */
async function prepareImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const max = 1024;
    let w = bmp.width, h = bmp.height;
    const scale = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const dataUrl = cv.toDataURL('image/jpeg', 0.85);
    return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1] };
  } catch (e) {
    const buf = await file.arrayBuffer();
    return { mimeType: file.type || 'image/jpeg', data: base64FromBuffer(buf) };
  }
}
function base64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/* ============================================================
   解析実行
   ============================================================ */
$('analyze').addEventListener('click', analyze);

async function analyze() {
  if (!currentFile) { setStatus('先に写真を選んでください。', true); return; }
  showLoading(true);
  try {
    const image = await prepareImage(currentFile);
    const res = await fetch(proxyUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`server ${res.status} ${t.slice(0, 120)}`);
    }
    const data = await res.json();
    renderResult(data);
  } catch (err) {
    console.error(err);
    showLoading(false);
    setStatus('解析に失敗しました。時間をおいて、もう一度お試しください。（' + (err.message || err) + '）', true);
    return;
  }
  showLoading(false);
}

function showLoading(on) {
  $('loading').hidden = !on;
  if (on) {
    const msgs = ['AIが食事を解析中…', '料理を認識しています…', '栄養価を計算しています…'];
    let i = 0;
    $('loading-text').textContent = msgs[0];
    clearInterval(showLoading._t);
    showLoading._t = setInterval(() => { i = (i + 1) % msgs.length; $('loading-text').textContent = msgs[i]; }, 1400);
  } else {
    clearInterval(showLoading._t);
  }
}

/* ============================================================
   結果描画
   ============================================================ */
function num(n, d = 0) { return (Math.round((Number(n) || 0) * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('ja-JP'); }

function renderResult(d) {
  const box = $('result-body');

  if (d && d.is_food === false) {
    box.innerHTML = `<div class="rz"><div class="rz-card" style="text-align:center">
      <h3 style="font-family:var(--serif);font-size:22px;margin-bottom:10px">食事の写真として認識できませんでした</h3>
      <p style="color:var(--ink-soft);font-size:14px">料理全体が明るく写った写真で、もう一度お試しください。</p>
      <div class="lx-actions"><button class="lx-btn lx-btn-green" id="restart">写真を選び直す</button></div>
    </div></div>`;
    reveal(box);
    $('restart').addEventListener('click', restart);
    return;
  }

  const t = d.total || {};
  const kcal = Number(t.kcal) || 0;
  const P = Number(t.protein_g) || 0, F = Number(t.fat_g) || 0, C = Number(t.carb_g) || 0;
  const pc = P * 4, fc = F * 9, cc = C * 4;
  const macroCal = pc + fc + cc || 1;
  const pctP = Math.round((pc / macroCal) * 100);
  const pctF = Math.round((fc / macroCal) * 100);
  const pctC = 100 - pctP - pctF;

  const target = CFG.DAILY_KCAL_TARGET || 2000;
  const dayPct = Math.round((kcal / target) * 100);

  const score = Math.max(0, Math.min(100, Math.round(Number(d.diet_score) || 0)));
  const scoreCol = score >= 70 ? 'var(--sage)' : score >= 45 ? 'var(--gold)' : 'var(--terra)';
  const verdict = d.verdict || (score >= 70 ? 'ダイエット向きの一皿' : score >= 45 ? 'バランス次第の一皿' : '食べ方に工夫を');

  const conf = (d.confidence || 'medium');
  const confLabel = { high: '認識精度：高', medium: '認識精度：中', low: '認識精度：低（目安）' }[conf] || '認識精度：中';

  const R = 60, CIRC = 2 * Math.PI * R;
  const off = CIRC * (1 - score / 100);

  const items = Array.isArray(d.items) ? d.items : [];
  const advice = Array.isArray(d.advice) ? d.advice : [];

  const hasCTA = !!CFG.CTA_URL;
  const salt = (t.salt_g != null) ? `<span>塩分 ${num(t.salt_g, 1)}g</span>` : '';
  const fiber = (t.fiber_g != null) ? `<span>食物繊維 ${num(t.fiber_g, 1)}g</span>` : '';
  const sugar = (t.sugar_g != null) ? `<span>糖質 ${num(t.sugar_g)}g</span>` : '';
  const extras = [salt, fiber, sugar].filter(Boolean).join('　');

  box.innerHTML = `
  <div class="rz">

    <div class="rz-dish">
      <h3>${esc(d.dish_name || 'あなたの食事')}</h3>
      <span class="rz-conf conf-${conf}"><span class="dot"></span>${confLabel}</span>
    </div>

    <div class="rz-kcal">
      <div class="lab">Total Energy</div>
      <div class="val">${num(kcal)}<small>kcal</small></div>
      <div class="sub">1日の目安（${num(target)}kcal）の約 <b>${dayPct}%</b>${extras ? '　/　' + extras : ''}</div>
    </div>

    <div class="rz-card">
      <div class="rz-card-h"><h4>PFCバランス</h4><span class="tag">たんぱく質・脂質・炭水化物</span></div>
      <div class="pfc">
        ${pfcRow('P', 'たんぱく質', 'Protein', P, pctP)}
        ${pfcRow('F', '脂質', 'Fat', F, pctF)}
        ${pfcRow('C', '炭水化物', 'Carbs', C, pctC)}
      </div>
      <p class="pfc-legend">※ %はカロリー換算での構成比（たんぱく質・脂質 各1gあたり4・9kcal で計算）</p>
    </div>

    <div class="rz-card rz-score">
      <div class="gauge" style="--col:${scoreCol}">
        <svg width="132" height="132" viewBox="0 0 132 132">
          <circle class="bg" cx="66" cy="66" r="${R}"></circle>
          <circle class="fg" cx="66" cy="66" r="${R}"
            stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${CIRC.toFixed(1)}" data-off="${off.toFixed(1)}"></circle>
        </svg>
        <div class="num"><b>${score}</b><span>DIET SCORE</span></div>
      </div>
      <div class="rz-score-txt">
        <div class="verdict">${esc(verdict)}</div>
        <p>ダイエット観点での一皿の評価です。高たんぱく・適正カロリー・食物繊維が多いほど高スコアになります。</p>
      </div>
    </div>

    ${items.length ? `
    <div class="rz-card">
      <div class="rz-card-h"><h4>認識した料理</h4><span class="tag">${items.length}品</span></div>
      <div class="rz-items">
        ${items.map((it) => `
          <div class="rz-item">
            <div><span class="nm">${esc(it.name || '')}</span>${it.portion ? `<span class="pt">${esc(it.portion)}</span>` : ''}</div>
            <div class="kc">${num(it.kcal)} kcal</div>
          </div>`).join('')}
      </div>
    </div>` : ''}

    ${d.comment ? `
    <div class="rz-comment">
      <div class="q">&ldquo;</div>
      <p>${esc(d.comment)}</p>
    </div>` : ''}

    ${advice.length ? `
    <div class="rz-card">
      <div class="rz-card-h"><h4>今日の一皿へのアドバイス</h4></div>
      <ul class="rz-advice">
        ${advice.map((a) => `<li><span class="ic">✓</span><span>${esc(a)}</span></li>`).join('')}
      </ul>
    </div>` : ''}

    ${hasCTA ? `
    <div class="rz-cta">
      <div class="lab">Next Step</div>
      <h4>${esc(CFG.CTA_TITLE || 'この結果を、続く習慣へ。')}</h4>
      <p>${esc(CFG.CTA_TEXT || '')}</p>
      <a class="lx-btn" href="${esc(CFG.CTA_URL)}" target="_blank" rel="noopener">${esc(CFG.CTA_LABEL || '相談する')}</a>
    </div>` : ''}

    <p class="rz-notice">表示された栄養価は写真から推定した目安値です。食材量・調理法で実際の値は変動します。</p>

    <div class="lx-actions">
      ${navigator.share ? `<button class="lx-btn lx-btn-ghost" id="share">結果をシェア</button>` : ''}
      <button class="lx-btn lx-btn-green" id="restart">別の食事を診断する</button>
    </div>

  </div>`;

  reveal(box);

  // ゲージ・アニメーション
  requestAnimationFrame(() => {
    const fg = box.querySelector('.gauge .fg');
    if (fg) fg.style.strokeDashoffset = fg.getAttribute('data-off');
    box.querySelectorAll('.pfc-bar span').forEach((el) => { el.style.width = el.getAttribute('data-w'); });
  });

  $('restart').addEventListener('click', restart);
  const sh = $('share');
  if (sh) sh.addEventListener('click', () => shareResult(d));
}

function pfcRow(k, jp, en, grams, pct) {
  return `<div class="pfc-row pfc-${k}">
    <div class="pfc-name">${jp}<small>${en}</small></div>
    <div class="pfc-bar"><span data-w="${Math.max(3, pct)}%"></span></div>
    <div class="pfc-val">${num(grams, 1)}<small>g</small> · ${pct}%</div>
  </div>`;
}

function reveal(box) {
  const sec = $('result');
  sec.hidden = false;
  sec.scrollIntoView({ behavior: 'smooth' });
}

function restart() {
  currentFile = null;
  $('result').hidden = true;
  $('result-body').innerHTML = '';
  $('preview').hidden = true;
  $('after-upload').hidden = true;
  fileInput.value = '';
  setStatus('JPEG / PNG / HEIC（iPhone写真）に対応しています。', false);
  $('start').scrollIntoView({ behavior: 'smooth' });
}

function shareResult(d) {
  const t = d.total || {};
  const txt = `【${d.dish_name || '食事診断'}】約${num(t.kcal)}kcal / P${num(t.protein_g)}・F${num(t.fat_g)}・C${num(t.carb_g)}g（AI食事栄養診断 Repas Atelier）`;
  navigator.share({ title: 'Repas Atelier 食事診断', text: txt, url: location.href }).catch(() => {});
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================================================
   デモモード: URLに ?demo を付けると、APIキーなしで
   サンプル結果を描画（デザイン確認用）。本番では無害。
   例: http://localhost:5060/?demo=1
   ============================================================ */
if (new URLSearchParams(location.search).has('demo')) {
  renderResult({
    is_food: true,
    dish_name: '鶏むね肉のグリル定食',
    confidence: 'high',
    items: [
      { name: '鶏むね肉のグリル', portion: '約120g', kcal: 165, protein_g: 26, fat_g: 5, carb_g: 1 },
      { name: '白ごはん', portion: '茶碗1杯(150g)', kcal: 234, protein_g: 4, fat_g: 0.5, carb_g: 52 },
      { name: 'ブロッコリーとトマトのサラダ', portion: '小鉢1つ', kcal: 45, protein_g: 3, fat_g: 1.5, carb_g: 6 },
      { name: 'みそ汁', portion: 'お椀1杯', kcal: 40, protein_g: 3, fat_g: 1, carb_g: 5 },
    ],
    total: { kcal: 484, protein_g: 36, fat_g: 8, carb_g: 64, salt_g: 2.8, fiber_g: 6, sugar_g: 8 },
    diet_score: 82,
    verdict: '高たんぱくで優秀な一皿',
    comment: '鶏むね肉と野菜でたんぱく質と食物繊維がしっかり摂れており、脂質も控えめ。ダイエット中の食事として非常にバランスの良い一皿です。ごはんの量だけ調整すれば、さらに理想的になります。',
    advice: [
      'ごはんを120gに減らすと糖質を約40kcalカットできます',
      'サラダのドレッシングはノンオイルを選ぶとさらに脂質を抑えられます',
      '食べる順番は「サラダ→みそ汁→主菜→ごはん」で血糖値の上昇がゆるやかに',
    ],
  });
}
