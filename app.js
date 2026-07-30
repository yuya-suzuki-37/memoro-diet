/* ============================================================
   Memoro — フロント制御
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
let lastResultData = null;   // 元の解析結果（不変）
let editState = null;        // 料理ごとの量調整状態
let editMode = false;        // 量調整モードON/OFF

/* ============================================================
   成分表フードDB（クライアント側・食品の手入力差し替え用）
   Geminiを使わず、日本食品標準成分表2020年版(八訂)の値でその場計算する。
   初回に seibunhyo.json + aliases.json を遅延ロード（本番は同一オリジン配信）。
   ============================================================ */
let FOOD_DB = null;          // { foods, byId:Map, aliases:[[kw,id]] }
let foodDbLoading = null;

function normJa(s) {
  s = String(s == null ? '' : s).normalize('NFKC')
    .replace(/[\s\[\]（）()「」、,．.\/・\-－]/g, '').toLowerCase();
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += (c >= 0x30A1 && c <= 0x30F6) ? String.fromCharCode(c - 0x60) : ch; // カナ→ひらがな
  }
  return out;
}
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (!set.size && s) set.add(s);
  return set;
}
async function loadFoodDB() {
  if (FOOD_DB) return FOOD_DB;
  if (foodDbLoading) return foodDbLoading;
  foodDbLoading = (async () => {
    const [foods, al, dishes] = await Promise.all([
      fetch('seibunhyo.json').then((r) => r.json()),
      fetch('aliases.json').then((r) => r.json()).catch(() => ({ aliases: [] })),
      fetch('dishes.json').then((r) => r.json()).catch(() => []),   // 定番料理(成分表レシピ)
    ]);
    const aliases = [];
    for (const d of dishes) {                    // 料理を先頭に混ぜ、キーワードをエイリアス化
      d._dish = true;
      foods.unshift(d);
      for (const kw of (d.kw || [])) aliases.push([normJa(kw), d.i]);
    }
    foods.forEach((f) => { f._n = normJa(f.n); f._b = bigrams(f._n); });
    const byId = new Map(foods.map((f) => [f.i, f]));
    for (const a of (al.aliases || [])) for (const kw of a.kw) aliases.push([normJa(kw), a.id]);
    aliases.sort((x, y) => y[0].length - x[0].length);
    FOOD_DB = { foods, byId, aliases };
    return FOOD_DB;
  })();
  return foodDbLoading;
}
/* クエリ→候補food配列（上位limit件）。最終的にユーザーが選ぶので"上位に出す"のが目的 */
function searchFoods(query, limit = 12) {
  if (!FOOD_DB) return [];
  const q = normJa(query);
  if (!q) return [];
  const qb = bigrams(q);
  const aliasIds = new Set();
  for (const [kw, id] of FOOD_DB.aliases) {
    if (kw && (q.includes(kw) || kw.includes(q))) aliasIds.add(id);
  }
  const scored = [];
  for (const f of FOOD_DB.foods) {
    let inter = 0;
    for (const b of qb) if (f._b.has(b)) inter++;
    let sc = inter / (qb.size + f._b.size - inter || 1);
    if (f._n.includes(q) || q.includes(f._n)) sc += 0.4;   // 部分一致ボーナス
    if (aliasIds.has(f.i)) sc += 0.5;                      // エイリアス一致ボーナス
    if (sc > 0.02) scored.push([sc, f]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map((x) => x[1]);
}
/* 成分表food(per100g) + grams → 栄養 */
function foodNutrition(rec, grams) {
  const k = (Number(grams) || 0) / 100;
  return {
    kcal: (Number(rec.kcal) || 0) * k, p: (Number(rec.p) || 0) * k,
    f: (Number(rec.f) || 0) * k, c: (Number(rec.c) || 0) * k,
    fib: (Number(rec.fib) || 0) * k, salt: (Number(rec.na) || 0) * 2.54 / 1000 * k,
  };
}
/* 成分表名を表示用に簡潔化（<類>や[分類]の括弧を除去） */
function shortFoodName(n) {
  return String(n || '').replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '')
    .replace(/（[^）]*）/g, '').replace(/\s+/g, ' ').trim();
}

/* ============================================================
   プロフィール（任意）とパーソナル栄養目標
   端末内(localStorage)にのみ保存。外部送信しない＝完全クライアント側。
   ============================================================ */
const PROFILE_KEY = 'repas_profile_v1';
const ACTIVITY = {
  '1': { label: 'ほとんど運動しない（デスクワーク中心）', factor: 1.2 },
  '2': { label: '軽い運動（週1〜2回）', factor: 1.375 },
  '3': { label: '中程度（週3〜5回の運動）', factor: 1.55 },
  '4': { label: '激しい（週6〜7回の運動）', factor: 1.725 },
  '5': { label: '非常に激しい（毎日ハード／肉体労働）', factor: 1.9 },
};
const GOALS = {
  lose:     { label: '減量（ダイエット）', kcalFactor: 0.80, proteinPerKg: 2.0 },
  maintain: { label: '体型維持',           kcalFactor: 1.00, proteinPerKg: 1.6 },
  gain:     { label: '増量（筋肉づくり）',   kcalFactor: 1.10, proteinPerKg: 2.0 },
};

function loadProfile() { try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; } catch (e) { return null; } }
function saveProfileObj(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {} }
function clearProfileObj() { try { localStorage.removeItem(PROFILE_KEY); } catch (e) {} }

/* Mifflin-St Jeor で BMR→TDEE→目標カロリー→PFC目標 を算出 */
function computeTargets(p) {
  if (!p) return null;
  const w = +p.weight, h = +p.height, a = +p.age;
  if (!(w > 0) || !(h > 0) || !(a > 0) || !p.sex || !p.activity || !p.goal) return null;
  const bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === 'male' ? 5 : -161);
  const act = (ACTIVITY[p.activity] || ACTIVITY['1']).factor;
  const tdee = bmr * act;
  const g = GOALS[p.goal] || GOALS.maintain;
  let kcal = tdee * g.kcalFactor;
  kcal = Math.max(kcal, p.sex === 'male' ? 1500 : 1200); // 安全下限
  kcal = Math.round(kcal / 10) * 10;
  const protein = Math.round(w * g.proteinPerKg);
  const fat = Math.round((kcal * 0.25) / 9);
  const carb = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { tdee: Math.round(tdee), kcal, protein, fat, carb, goal: p.goal, goalLabel: g.label };
}
function getTargets() { return window.__demoTargets || computeTargets(loadProfile()); }

/* プロフィール入力パネルを #profile-mount に描画 */
function renderProfilePanel() {
  const mount = $('profile-mount');
  if (!mount) return;
  const p = loadProfile() || {};
  const t = computeTargets(p);
  const opt = (v, cur, label) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
  const actOpts = Object.entries(ACTIVITY).map(([k, v]) => opt(k, p.activity, v.label)).join('');
  const goalOpts = Object.entries(GOALS).map(([k, v]) => opt(k, p.goal, v.label)).join('');
  mount.innerHTML = `
    <div class="profile-panel">
      <button class="profile-toggle" id="pf-toggle">
        <span>👤 ${t ? 'プロフィール設定済み（タップで編集）' : 'プロフィールを入力して「あなた専用診断」にする（任意）'}</span>
        <span class="pf-tog-ic">${t ? '✓' : '＋'}</span>
      </button>
      <div class="profile-form" id="pf-form" ${t ? 'hidden' : ''}>
        <div class="pf-grid">
          <label class="pf-field"><span>性別</span><select id="pf-sex"><option value="">選択</option>${opt('male', p.sex, '男性')}${opt('female', p.sex, '女性')}</select></label>
          <label class="pf-field"><span>年齢</span><input id="pf-age" type="number" inputmode="numeric" value="${p.age || ''}" placeholder="30"></label>
          <label class="pf-field"><span>身長 (cm)</span><input id="pf-height" type="number" inputmode="numeric" value="${p.height || ''}" placeholder="165"></label>
          <label class="pf-field"><span>体重 (kg)</span><input id="pf-weight" type="number" inputmode="numeric" value="${p.weight || ''}" placeholder="60"></label>
          <label class="pf-field pf-wide"><span>活動量</span><select id="pf-activity"><option value="">選択</option>${actOpts}</select></label>
          <label class="pf-field pf-wide"><span>目標</span><select id="pf-goal"><option value="">選択</option>${goalOpts}</select></label>
        </div>
        <div class="pf-actions">
          <button class="lx-btn lx-btn-green" id="pf-save">保存して専用診断にする</button>
          ${t ? '<button class="lx-btn lx-btn-ghost" id="pf-clear">クリア</button>' : ''}
        </div>
        <p class="pf-note">🔒 入力はこの端末内にのみ保存され、外部には送信されません（栄養目標の計算にのみ使用）。目標値は標準式による目安です。</p>
      </div>
      ${t ? `<div class="pf-summary"><span class="pf-sum-goal">${esc(t.goalLabel)}</span><span>1日の目標 <b>${num(t.kcal)}</b>kcal</span><span class="pf-sum-pfc">P${t.protein}・F${t.fat}・C${t.carb}g</span></div>` : ''}
    </div>`;
  const tog = $('pf-toggle'), form = $('pf-form');
  if (tog) tog.addEventListener('click', () => { form.hidden = !form.hidden; });
  const save = $('pf-save');
  if (save) save.addEventListener('click', () => {
    const np = { sex: $('pf-sex').value, age: $('pf-age').value, height: $('pf-height').value, weight: $('pf-weight').value, activity: $('pf-activity').value, goal: $('pf-goal').value };
    if (!computeTargets(np)) { alert('すべての項目を入力してください（性別・年齢・身長・体重・活動量・目標）。'); return; }
    saveProfileObj(np);
    renderProfilePanel();
    if (lastResultData) drawResult(false);
  });
  const clr = $('pf-clear');
  if (clr) clr.addEventListener('click', () => { clearProfileObj(); renderProfilePanel(); if (lastResultData) renderResult(lastResultData); });
}

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

async function analyze(hint) {
  if (!currentFile) { setStatus('先に写真を選んでください。', true); return; }
  // ボタンのclickイベント経由だと第1引数がEventになるので文字列だけ採用
  const hintText = (typeof hint === 'string') ? hint.trim() : '';
  showLoading(true, hintText ? 'reanalyze' : 'analyze');
  try {
    const image = await prepareImage(currentFile);
    const body = hintText ? { image, hint: hintText } : { image };
    const res = await fetch(proxyUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

function showLoading(on, mode) {
  $('loading').hidden = !on;
  if (on) {
    const msgs = mode === 'reanalyze'
      ? ['ヒントをもとに再解析中…', '料理を認識し直しています…', '栄養価を計算しています…']
      : ['AIが食事を解析中…', '料理を認識しています…', '栄養価を計算しています…'];
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

/* 新しい解析結果を表示（編集状態をリセット） */
function renderResult(dNew) {
  lastResultData = dNew;
  editState = freshEdit(dNew);
  editMode = false;
  drawResult(true);
}

/* 量調整の初期状態を作る */
function parseGrams(portion) {
  const m = String(portion == null ? '' : portion).match(/(\d+(?:\.\d+)?)\s*g/);
  return m ? parseFloat(m[1]) : 0;
}
function freshEdit(d) {
  if (!d || !Array.isArray(d.items)) return null;
  const totalK = d.items.reduce((s, it) => s + (Number(it.kcal) || 0), 0) || 1;
  const totSalt = Number((d.total || {}).salt_g) || 0;
  const totFib = Number((d.total || {}).fiber_g) || 0;
  return d.items.map((it) => {
    const g = parseGrams(it.portion);
    const kc = Number(it.kcal) || 0;
    // 料理ごとの塩分・繊維（新backendはper-item提供。無い旧データはkcal比で按分）
    const salt = (it.salt_g != null) ? Number(it.salt_g) : totSalt * (kc / totalK);
    const fib = (it.fiber_g != null) ? Number(it.fiber_g) : totFib * (kc / totalK);
    return { g0: g, g: g, removed: false, name: it.name || '', src: it.source || '',
      base: { kcal: kc, p: Number(it.protein_g) || 0, f: Number(it.fat_g) || 0, c: Number(it.carb_g) || 0, salt: salt, fib: fib } };
  });
}
/* 元データ + 編集状態 → 表示用データ（量調整・差し替え・追加を反映して再計算） */
function computeView(orig, edit) {
  if (!orig || orig.is_food === false || !edit) return orig;
  const r1 = (x) => Math.round(x * 10) / 10;
  const items = [];
  let tk = 0, tp = 0, tf = 0, tc = 0, tsalt = 0, tfib = 0, edited = false;
  edit.forEach((e, i) => {                      // 追加分も含むので editState を基準に走査
    const orItem = (orig.items && orig.items[i]) || {};
    if (!e) { items.push(orItem); tk += Number(orItem.kcal) || 0; tp += Number(orItem.protein_g) || 0; tf += Number(orItem.fat_g) || 0; tc += Number(orItem.carb_g) || 0; return; }
    if (e.removed) { items.push({ ...orItem, name: e.name || orItem.name, removed: true }); edited = true; return; }
    const fct = e.g0 > 0 ? e.g / e.g0 : 1;
    if (e.swapped || e.added || Math.abs(e.g - e.g0) > 0.5) edited = true;
    const kc = e.base.kcal * fct;
    items.push({ name: e.name || orItem.name || '', portion: e.g0 > 0 ? `約${Math.round(e.g)}g` : (orItem.portion || ''),
      kcal: Math.round(kc), protein_g: r1(e.base.p * fct), fat_g: r1(e.base.f * fct), carb_g: r1(e.base.c * fct),
      source: (e.swapped || e.added) ? 'seibun' : e.src, swapped: !!e.swapped, added: !!e.added });
    tk += kc; tp += e.base.p * fct; tf += e.base.f * fct; tc += e.base.c * fct;
    tsalt += (e.base.salt || 0) * fct; tfib += (e.base.fib || 0) * fct;
  });
  return { ...orig, items, _edited: edited,
    total: { kcal: Math.round(tk), protein_g: r1(tp), fat_g: r1(tf), carb_g: r1(tc), salt_g: r1(tsalt), fiber_g: r1(tfib) } };
}
/* ---- 食品差し替え / 追加（成分表ピッカー）---- */
let pickerFor = null;   // null | 数値(item index=差し替え) | 'add'(追加)
async function openPicker(target) {
  pickerFor = target;
  if (!FOOD_DB) { drawResult(false); try { await loadFoodDB(); } catch (e) { console.error(e); } }
  drawResult(false);
  const inp = $('pick-input'); if (inp) setTimeout(() => inp.focus(), 50);
}
function closePicker() { pickerFor = null; drawResult(false); }
function renderPickResults(q) {
  const wrap = $('pick-results'); if (!wrap) return;
  if (!FOOD_DB) { wrap.innerHTML = '<div class="pick-note">読み込み中…</div>'; return; }
  if (!q.trim()) { wrap.innerHTML = '<div class="pick-note">食品名を入力すると候補が出ます。</div>'; return; }
  const list = searchFoods(q, 12);
  if (!list.length) { wrap.innerHTML = '<div class="pick-note">見つかりませんでした。別の言い方でお試しください（例：からあげ→唐揚げ）。</div>'; return; }
  wrap.innerHTML = list.map((f) => {
    const badge = f._dish ? '<span class="pick-badge">料理</span>' : '';
    const serv = (f._dish && f.serv) ? `　/　1人前 約${f.serv}g` : '';
    return `<button type="button" class="pick-item" data-id="${f.i}">
      <span class="pick-nm">${badge}${esc(shortFoodName(f.n))}</span>
      <span class="pick-mac">100gあたり ${Math.round(f.kcal)}kcal・P${num(f.p, 1)} F${num(f.f, 1)} C${num(f.c, 1)}${serv}</span>
    </button>`;
  }).join('');
}
function applyPick(id) {
  const rec = FOOD_DB && FOOD_DB.byId.get(id); if (!rec) return;
  const gInput = $('pick-grams');
  let grams = gInput ? parseFloat(gInput.value) : 0;
  if (!(grams > 0)) grams = 100;
  // 定番料理を「追加」する時、量を触っていなければ1人前(serv)を既定量にする
  if (pickerFor === 'add' && rec._dish && rec.serv && gInput && parseFloat(gInput.value) === Number(gInput.defaultValue)) {
    grams = rec.serv;
  }
  const n = foodNutrition(rec, grams);
  const entry = { g0: grams, g: grams, removed: false, name: shortFoodName(rec.n), src: 'seibun',
    base: { kcal: n.kcal, p: n.p, f: n.f, c: n.c, salt: n.salt, fib: n.fib } };
  if (pickerFor === 'add') { entry.added = true; editState.push(entry); }
  else if (typeof pickerFor === 'number' && editState[pickerFor]) { entry.swapped = true; editState[pickerFor] = entry; }
  pickerFor = null;
  drawResult(false);
}
function pickerPanel() {
  if (pickerFor === null) return '';
  const isAdd = pickerFor === 'add';
  const cur = (typeof pickerFor === 'number' && editState[pickerFor]) ? editState[pickerFor] : null;
  const defG = cur && cur.g0 > 0 ? Math.round(cur.g) : 100;
  const title = isAdd ? '食品を追加する' : `「${esc(cur ? cur.name : '')}」を別の食品に変更`;
  return `<div class="rz-picker">
    <div class="rz-picker-h">${title}<button type="button" class="rz-picker-x" id="pick-cancel" title="閉じる">×</button></div>
    ${!FOOD_DB ? '<div class="pick-note">成分表を読み込み中…</div>' : `
    <input id="pick-input" class="rz-picker-input" type="text" autocomplete="off" enterkeyhint="search" placeholder="食品名を入力（例：さば・木綿豆腐・キムチ）">
    <label class="rz-picker-g">量 <input id="pick-grams" type="number" min="5" step="5" value="${defG}"> g</label>
    <div id="pick-results" class="rz-picker-results"><div class="pick-note">食品名を入力すると、成分表の候補が出ます。</div></div>
    <p class="rz-picker-note">「料理」バッジ付きは定番料理（成分表レシピで計算・1人前量が自動で入る）。素材・単品も検索できます。無ければ近い食品を選んでください。</p>`}
  </div>`;
}

function drawResult(scroll) {
  const box = $('result-body');
  const d = computeView(lastResultData, editState);
  if (!d) return;

  if (d && d.is_food === false) {
    box.innerHTML = `<div class="rz"><div class="rz-card" style="text-align:center">
      <h3 style="font-family:var(--serif);font-size:22px;margin-bottom:10px">食事の写真として認識できませんでした</h3>
      <p style="color:var(--ink-soft);font-size:14px">料理全体が明るく写った写真で、もう一度お試しください。</p>
      <div class="lx-actions"><button class="lx-btn lx-btn-green" id="restart">写真を選び直す</button></div>
    </div></div>`;
    if (scroll) reveal(box);
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
  const basis = d.basis || '';
  const gratio = Math.round((Number(d.grounded_ratio) || 0) * 100);
  const isAi = d.source_mode === 'holistic';

  // パーソナル診断（プロフィールがあれば専用カード、なければ入力を促すカード）
  const targets = getTargets();
  const personalHtml = targets ? personalCardHtml(targets, kcal, P, F, C) : personalPromptHtml();
  // PFCバランス診断（痩せやすさの観点で評価。プロフィール有無どちらでも）
  const bal = pfcBalance(P, F, C, targets);

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
      <div class="lab">Total Energy${d._edited ? ' <span class="rz-edited">✏️ 調整済み</span>' : ''}</div>
      <div class="val">${num(kcal)}<small>kcal</small></div>
      <div class="sub">1日の目安（${num(target)}kcal）の約 <b>${dayPct}%</b>${extras ? '　/　' + extras : ''}</div>
    </div>

    ${basis ? `
    <div class="rz-basis ${isAi ? 'is-ai' : ''}">
      <span class="rz-basis-ic">${isAi ? '🤖' : '📗'}</span>
      <div class="rz-basis-body">
        <div class="rz-basis-h">
          <b>${isAi ? 'AIによる推定値' : '日本食品標準成分表 2020年版（八訂）に基づく算出'}</b>
          ${isAi ? '' : `<span class="rz-basis-ratio">成分表準拠 ${gratio}%</span>`}
        </div>
        <p>${esc(basis)}</p>
      </div>
    </div>` : ''}

    ${personalHtml}

    <div class="rz-card">
      <div class="rz-card-h"><h4>PFCバランス診断</h4><span class="tag">${targets ? 'あなたの目標比' : 'ダイエット目安比'}</span></div>
      <p class="pfc-lead">同じカロリーでも、<b>PFCバランス</b>で痩せやすさは変わります。</p>
      <div class="pfc-verdict v-${bal.overall.cls}"><span class="pfc-v-ic">${bal.overall.icon}</span><span>${esc(bal.overall.text)}</span></div>
      <div class="pfc">
        ${pfcRow('P', 'たんぱく質', 'Protein', P, pctP, bal.P)}
        ${pfcRow('F', '脂質', 'Fat', F, pctF, bal.F)}
        ${pfcRow('C', '炭水化物', 'Carbs', C, pctC, bal.C)}
      </div>
      <p class="pfc-legend">※ 構成比（P・F 各1gあたり4・9kcal）を、理想比 <b>P${bal.ideal.p}%・F${bal.ideal.f}%・C${bal.ideal.c}%</b>（${targets ? 'あなたの目標' : 'ダイエット向けの一般的な目安'}）と比べて評価しています。</p>
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
      <div class="rz-card-h"><h4>認識した料理</h4><span class="tag">${items.filter((it) => !it.removed).length}品</span></div>
      ${editMode ? `<p class="rz-edit-note">量は「−／＋」、違う料理は「🔁」で別の食品に変更、余分は「×」で除外、抜けは「＋ 食品を追加」。すべて成分表の値で自動再計算されます（AI再解析なし・無料）。</p>` : ''}
      <div class="rz-items">
        ${items.map((it, i) => itemRow(it, i)).join('')}
      </div>
      ${editMode ? pickerPanel() : ''}
      <div class="rz-edit-bar">
        ${editMode
          ? `<button class="lx-btn lx-btn-ghost" id="ed-add">＋ 食品を追加</button><button class="lx-btn lx-btn-ghost" id="ed-reset">リセット</button><button class="lx-btn lx-btn-green" id="ed-done">完了</button>`
          : `<button class="lx-btn lx-btn-ghost" id="ed-start">✏️ 料理・量を修正する</button>`}
      </div>
      ${basis && !isAi && !editMode ? `<p class="rz-src-note">📗＝日本食品標準成分表の公式値で計算／🤖＝写真から判別しづらくAIが推定</p>` : ''}
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

    ${sourcesHtml()}

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

  if (scroll) reveal(box);

  // ゲージ・バーのアニメーション
  requestAnimationFrame(() => {
    const fg = box.querySelector('.gauge .fg');
    if (fg) fg.style.strokeDashoffset = fg.getAttribute('data-off');
    box.querySelectorAll('.pfc-bar span, .rzp-m-bar span').forEach((el) => { el.style.width = el.getAttribute('data-w'); });
  });

  $('restart').addEventListener('click', restart);
  const sh = $('share');
  if (sh) sh.addEventListener('click', () => shareResult(d));

  // 食品ピッカー（差し替え・追加）の配線
  const edAdd = $('ed-add'); if (edAdd) edAdd.addEventListener('click', () => openPicker('add'));
  const pinp = $('pick-input');
  if (pinp) pinp.addEventListener('input', () => { clearTimeout(pinp._t); pinp._t = setTimeout(() => renderPickResults(pinp.value), 120); });
  const presults = $('pick-results');
  if (presults) presults.addEventListener('click', (ev) => { const b = ev.target.closest('.pick-item'); if (b) applyPick(+b.getAttribute('data-id')); });
  const pcancel = $('pick-cancel'); if (pcancel) pcancel.addEventListener('click', closePicker);
  const openP = $('rzp-open');
  if (openP) openP.addEventListener('click', () => {
    revealStart();
    const form = $('pf-form');
    if (form) form.hidden = false;
    const panel = $('profile-mount');
    if (panel) setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  });

  // 量調整モードの配線
  const edStart = $('ed-start'); if (edStart) edStart.addEventListener('click', () => { editMode = true; drawResult(false); });
  const edDone = $('ed-done'); if (edDone) edDone.addEventListener('click', () => { editMode = false; drawResult(false); });
  const edReset = $('ed-reset'); if (edReset) edReset.addEventListener('click', () => { editState = freshEdit(lastResultData); drawResult(false); });
  const itemsWrap = box.querySelector('.rz-items');
  if (itemsWrap && editMode) {
    itemsWrap.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const i = +btn.getAttribute('data-i'); const e = editState && editState[i];
      if (!e) return;
      const act = btn.getAttribute('data-act');
      if (act === 'swap') { openPicker(i); return; }
      if (act === 'inc' || act === 'dec') {
        const step = Math.max(5, Math.round(e.g0 * 0.1 / 5) * 5);
        e.g = Math.max(5, e.g + (act === 'inc' ? step : -step));
      } else if (act === 'rm') { e.removed = true; }
      else if (act === 'restore') { e.removed = false; }
      drawResult(false);
    });
  }
}

/* 量調整モードの料理行 */
function itemRow(it, i) {
  const e = (editState && editState[i]) || {};
  if (editMode) {
    if (it.removed) {
      return `<div class="rz-item is-removed"><div class="rz-item-l"><span class="nm">${esc(it.name || '')}</span><span class="pt">除外中</span></div><button class="ed-restore" data-act="restore" data-i="${i}">戻す</button></div>`;
    }
    const canScale = e.g0 > 0;
    const tag = it.swapped ? '<span class="rz-tag-sw">変更</span>' : it.added ? '<span class="rz-tag-sw is-add">追加</span>' : '';
    return `<div class="rz-item is-editing">
      <div class="rz-item-l"><span class="nm">${esc(it.name || '')}</span>${tag}</div>
      <div class="rz-edit-ctl">
        ${canScale ? `<button class="ed-btn" data-act="dec" data-i="${i}" aria-label="減らす">−</button><span class="ed-g">${Math.round(e.g)}g</span><button class="ed-btn" data-act="inc" data-i="${i}" aria-label="増やす">＋</button>` : ''}
        <button class="ed-swap" data-act="swap" data-i="${i}" title="別の食品に変更">🔁</button>
        <button class="ed-rm" data-act="rm" data-i="${i}" title="この料理を除く">×</button>
      </div>
      <div class="kc">${num(it.kcal)} kcal</div>
    </div>`;
  }
  if (it.removed) return '';
  const sb = { seibun: ['📗', '成分表で計算'], mixed: ['📗', '一部AI推定'], ai: ['🤖', 'AI推定'] }[it.source] || ['', ''];
  return `
    <div class="rz-item">
      <div class="rz-item-l">
        <span class="nm">${esc(it.name || '')}</span>${it.portion ? `<span class="pt">${esc(it.portion)}</span>` : ''}
        ${it.swapped ? '<span class="rz-tag-sw">変更</span>' : it.added ? '<span class="rz-tag-sw is-add">追加</span>' : ''}
        ${sb[0] ? `<span class="rz-src src-${it.source}" title="${sb[1]}">${sb[0]} ${sb[1]}</span>` : ''}
      </div>
      <div class="kc">${num(it.kcal)} kcal</div>
    </div>`;
}

function pfcRow(k, jp, en, grams, pct, judge) {
  const j = judge ? `<div class="pfc-judge j-${judge.cls}">${judge.icon} ${judge.label}</div>` : '';
  return `<div class="pfc-row pfc-${k}">
    <div class="pfc-name">${jp}<small>${en}</small></div>
    <div class="pfc-bar"><span data-w="${Math.max(3, pct)}%"></span></div>
    <div class="pfc-val-wrap">
      <div class="pfc-val">${num(grams, 1)}<small>g</small> · ${pct}%</div>
      ${j}
    </div>
  </div>`;
}

/* この食事のPFCバランスを「痩せやすさ」の観点で評価
   理想比: プロフィールがあればその目標比、なければダイエット向け一般値(P30/F25/C45) */
function pfcBalance(P, F, C, targets) {
  const pP = P * 4, pF = F * 9, pC = C * 4, tot = (pP + pF + pC) || 1;
  const mr = { p: pP / tot, f: pF / tot, c: pC / tot };
  let ideal;
  if (targets) {
    const tt = (targets.protein * 4 + targets.fat * 9 + targets.carb * 4) || 1;
    ideal = { p: targets.protein * 4 / tt, f: targets.fat * 9 / tt, c: targets.carb * 4 / tt };
  } else {
    ideal = { p: 0.30, f: 0.25, c: 0.45 };
  }
  const rp = mr.p / ideal.p, rf = mr.f / ideal.f, rc = mr.c / ideal.c;
  const Pj = rp >= 0.95 ? { cls: 'good', icon: '◎', label: '十分' } : rp >= 0.70 ? { cls: 'ok', icon: '○', label: 'まずまず' } : { cls: 'low', icon: '△', label: '不足ぎみ' };
  const Fj = rf <= 1.25 ? { cls: 'good', icon: '◎', label: '適正' } : rf <= 1.70 ? { cls: 'warn', icon: '△', label: 'やや多め' } : { cls: 'bad', icon: '✕', label: '多め' };
  const Cj = rc <= 1.15 ? { cls: 'good', icon: '◎', label: '適正' } : rc <= 1.40 ? { cls: 'warn', icon: '△', label: 'やや多め' } : { cls: 'bad', icon: '✕', label: '多め' };
  const msgs = [];
  if (Pj.cls === 'low') msgs.push('たんぱく質が不足ぎみ。同じカロリーでも、たんぱく質を増やすと筋肉を保ちながら痩せやすくなります');
  if (Cj.cls !== 'good') msgs.push('炭水化物に偏りぎみ。ごはん・麺を少し減らしてたんぱく質に置き換えると痩せやすく');
  if (Fj.cls === 'bad') msgs.push('脂質が多め。揚げ物・油を控えると脂肪になりにくいです');
  let overall;
  if (msgs.length === 0) {
    overall = { cls: 'good', icon: '◎', text: '痩せやすいバランスです。高たんぱくで脂質・糖質も適正。この調子で！' };
  } else {
    const bad = (Pj.cls === 'low' || Cj.cls === 'bad' || Fj.cls === 'bad');
    overall = { cls: bad ? 'warn' : 'ok', icon: bad ? '△' : '○', text: msgs.slice(0, 2).join('。') + '。' };
  }
  return { overall, P: Pj, F: Fj, C: Cj, ideal: { p: Math.round(ideal.p * 100), f: Math.round(ideal.f * 100), c: Math.round(ideal.c * 100) } };
}

/* 診断の根拠・出典（信頼性の可視化） */
function sourcesHtml() {
  return `
  <details class="rz-sources">
    <summary>📚 この診断の根拠・出典</summary>
    <ul>
      <li><b>食事の栄養価</b>：日本食品標準成分表 2020年版（八訂）／文部科学省</li>
      <li><b>カロリー目標</b>：Mifflin-St Jeor式 — 安静時代謝の推定式として最も正確と実証（米国栄養士会誌, 2005 系統的レビュー）</li>
      <li><b>たんぱく質目標</b>：国際スポーツ栄養学会（ISSN）公式指針 2017 — 減量期の筋肉維持に高たんぱく（1.6〜2.0g/kg以上）を推奨</li>
      <li><b>高たんぱくの効果</b>：メタ分析で、減量時の高たんぱく食は体脂肪の減少と除脂肪量（筋肉）の維持に有効と報告（Am J Clin Nutr ほか）</li>
      <li><b>PFCバランス</b>：米国IOMのAMDR（たんぱく質10–35%／脂質20–35%／炭水化物45–65%）を基準に、ダイエット向けへ最適化</li>
      <li><b>減量ペース</b>：NHS／CDC — 週に体重の0.5〜1%（約 −500kcal/日）が安全</li>
    </ul>
    <p class="rz-src-disc">※ 目標値・理想比は上記に基づく「目安」です。医療・栄養指導を代替するものではありません。</p>
  </details>`;
}

/* ---- パーソナル診断カード ---- */
function personalCardHtml(t, kcal, P, F, C) {
  const pctKcal = t.kcal > 0 ? Math.round(kcal / t.kcal * 100) : 0;
  const remK = t.kcal - kcal, remP = t.protein - P, remF = t.fat - F, remC = t.carb - C;
  const v = personalVerdict(t.goal, pctKcal, P, t.protein);
  const rem = (val, unit) => (val >= 0
    ? `あと <b>${num(Math.round(val))}</b>${unit}`
    : `<b class="over">${num(Math.abs(Math.round(val)))}${unit} 超過</b>`);
  return `
  <div class="rz-personal">
    <div class="rzp-head">
      <span class="rzp-badge">あなた専用診断</span>
      <span class="rzp-goal">目標：${esc(t.goalLabel)}　/　1日 ${num(t.kcal)}kcal</span>
    </div>
    <div class="rzp-verdict v-${v.cls}"><span class="rzp-v-ic">${v.icon}</span><span>${esc(v.text)}</span></div>
    <div class="rzp-body">
      <div class="rzp-ring" style="--pct:${Math.min(100, pctKcal)}"><b>${pctKcal}<i>%</i></b><span>1日の目標比</span></div>
      <div class="rzp-side">
        <p class="rzp-line">この一食は、1日の目標 <b>${num(t.kcal)}kcal</b> の <b>${pctKcal}%</b>（${num(kcal)}kcal）</p>
        <p class="rzp-rem">1日の残り目安：${rem(remK, 'kcal')}　<span class="rzp-rem-pfc">P ${rem(remP, 'g')}・F ${rem(remF, 'g')}・C ${rem(remC, 'g')}</span></p>
      </div>
    </div>
    <div class="rzp-macros">
      ${personalMacroRow('たんぱく質', P, t.protein, 'P')}
      ${personalMacroRow('脂質', F, t.fat, 'F')}
      ${personalMacroRow('炭水化物', C, t.carb, 'C')}
    </div>
    <p class="rzp-note">※ 目標値は標準式（Mifflin-St Jeor）による目安です。医療・栄養指導を代替するものではありません。持病・妊娠中・治療中の方は専門家にご相談ください。</p>
  </div>`;
}

function personalMacroRow(jp, meal, target, k) {
  const pct = target > 0 ? Math.round(meal / target * 100) : 0;
  return `<div class="rzp-macro pfc-${k}">
    <div class="rzp-m-name">${jp}</div>
    <div class="rzp-m-bar"><span data-w="${Math.min(100, Math.max(2, pct))}%"></span></div>
    <div class="rzp-m-val">${num(meal, 1)} / ${num(target)}g<small> ・${pct}%</small></div>
  </div>`;
}

function personalVerdict(goal, pctKcal, mealP, targetP) {
  const proteinGood = mealP >= targetP * 0.28;
  if (goal === 'gain') {
    if (pctKcal >= 30 && proteinGood) return { icon: '◎', cls: 'good', text: '増量にgood。カロリーもたんぱく質もしっかり摂れています。' };
    if (pctKcal < 25) return { icon: '○', cls: 'ok', text: '増量目標にはやや軽め。もう少し量を足しても◎。' };
    return { icon: '○', cls: 'ok', text: 'バランス良好。たんぱく質を意識して増量を進めましょう。' };
  }
  if (goal === 'maintain') {
    if (pctKcal >= 28 && pctKcal <= 42) return { icon: '◎', cls: 'good', text: '維持にちょうど良い一食です。' };
    if (pctKcal > 47) return { icon: '△', cls: 'warn', text: '1食としてはやや多め。他の食事で調整を。' };
    return { icon: '○', cls: 'ok', text: 'バランス良好。この調子で維持していきましょう。' };
  }
  // lose（減量）
  if (pctKcal <= 40 && proteinGood) return { icon: '◎', cls: 'good', text: '減量に理想的な一食です。カロリー適量＆たんぱく質しっかり。' };
  if (pctKcal <= 40) return { icon: '○', cls: 'ok', text: 'カロリーは適量。たんぱく質をもう少し足すとさらに◎。' };
  if (pctKcal <= 50) return { icon: '△', cls: 'warn', text: '1食としてはやや多め。次の食事は軽めに調整を。' };
  return { icon: '⚠', cls: 'bad', text: 'この一食で1日目標の半分超。残りはかなり軽めに。' };
}

function personalPromptHtml() {
  return `
  <div class="rz-personal is-prompt">
    <div class="rzp-prompt">
      <div>
        <b>👤 あなた専用の診断にできます</b>
        <p>年齢・体格・目標を入れると、この一食が「あなたの1日の目標に対してどうか」まで診断します（任意・端末内にのみ保存）。</p>
      </div>
      <button class="lx-btn lx-btn-green" id="rzp-open">プロフィールを入力する</button>
    </div>
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
  const txt = `【${d.dish_name || '食事診断'}】約${num(t.kcal)}kcal / P${num(t.protein_g)}・F${num(t.fat_g)}・C${num(t.carb_g)}g（Memoro AI食事栄養診断）`;
  navigator.share({ title: 'Memoro 食事診断', text: txt, url: location.href }).catch(() => {});
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================================================
   デモモード: URLに ?demo を付けると、APIキーなしで
   サンプル結果を描画（デザイン確認用）。本番では無害。
   例: http://localhost:5060/?demo=1
   ============================================================ */
renderProfilePanel(); // 起動時にプロフィールパネルを描画

if (new URLSearchParams(location.search).has('demo')) {
  window.__demoTargets = { tdee: 1980, kcal: 1600, protein: 108, fat: 44, carb: 188, goal: 'lose', goalLabel: '減量（ダイエット）' };
  renderResult({
    is_food: true,
    dish_name: '鶏むね肉のグリル定食',
    confidence: 'high',
    basis: '日本食品標準成分表2020年版（八訂）に基づき算出。照合できない食材はAIが推定。',
    grounded_ratio: 0.86,
    source_mode: 'grounded',
    items: [
      { name: '鶏むね肉のグリル', portion: '約120g', kcal: 165, protein_g: 26, fat_g: 5, carb_g: 1, source: 'seibun' },
      { name: '白ごはん', portion: '約150g', kcal: 234, protein_g: 4, fat_g: 0.5, carb_g: 52, source: 'seibun' },
      { name: 'ブロッコリーとトマトのサラダ', portion: '約80g', kcal: 45, protein_g: 3, fat_g: 1.5, carb_g: 6, source: 'mixed' },
      { name: 'みそ汁', portion: '約165g', kcal: 40, protein_g: 3, fat_g: 1, carb_g: 5, source: 'mixed' },
    ],
    total: { kcal: 484, protein_g: 36, fat_g: 8, carb_g: 64, salt_g: 2.8, fiber_g: 6 },
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
