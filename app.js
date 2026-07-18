// 앵그리 테니스 클럽 대진표 — UI v2 (실명 명단·설정 튜닝·버전 히스토리)
import { generateSchedule, validateSchedule, SchedulerError } from './engine/scheduler.js';
import { buildPlan } from './engine/planner.js';
import { pairKey } from './engine/validate.js';

const K_ROSTER = 'angry-roster-v2';
const K_SETTINGS = 'angry-settings-v2';
const K_ATTEND = 'angry-attend-v2';
const K_HISTORY = 'angry-history-v2';
const K_KEY = 'angry-key-v2'; // 관리자 비밀번호에서 파생한 키 (SHA-256, base64url)
const PUBLIC_URL = 'https://lakeastern.github.io/angry/';

const state = {
  roster: { men: [], women: [] }, // {id, name, prefs:{gamePriority,newMember,mixedPreferred}, presetExclude:[], guest}
  settings: {
    meetingType: 'regular',
    rounds: 5,
    gamesPerPerson: 4,
    maxDiff: null,
    maxMeet: 2,
    tightRounds: [1, 2, 3],
    mixedRounds: [1, 3],
    allowConsecutiveSit: false,
    allowPartnerRepeat: false,
    ignoreGender: false,
  },
  attend: { selectedIds: [], excludeOverrides: {} },
  history: [], // [{ts, seed, config, rounds, summary}] 최신이 앞
  currentIdx: -1,
  result: null,
  swapSel: null, // {round, loc, id}
  editingId: null,
  dragId: null,
  ui: { roster: null, adv: null, exclude: null }, // details 접힘 상태 (null = 자동)
  share: null, // 공유 링크로 열었을 때의 페이로드
  viewerMode: false, // 'b'(대진표 보기) | 'r'(명단 수신 대기) | false
  shareUnlocked: false, // 공유 링크를 관리자 키로 자동 해독했는지
  undoStack: [], // 수동 스왑 되돌리기용 rounds 스냅샷 (현재 버전 한정)
  redoStack: [],
};

// ─── 유틸 ───
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const deepClone = (o) => JSON.parse(JSON.stringify(o));

function memberOf(id) {
  return state.roster.men.find((m) => m.id === id) || state.roster.women.find((m) => m.id === id) || null;
}
function genderOf(id) {
  return state.roster.men.some((m) => m.id === id) ? 'M' : 'W';
}
function nameOf(id) {
  const m = memberOf(id);
  return m ? m.name : id;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 무시 */ }
}
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function persistAll() {
  save(K_ROSTER, state.roster);
  save(K_SETTINGS, state.settings);
  save(K_ATTEND, state.attend);
  save(K_HISTORY, state.history);
}

// ─── 공유 링크: 압축 + 관리자 비밀번호 암호화 ───
// 대진표(라운드+참가자 이름)는 평문으로 담아 누구나 볼 수 있고,
// 명단·설정·재생성용 구성은 AES-GCM으로 잠가 비밀번호를 아는 사람만 복원한다.
const te = new TextEncoder();
const td = new TextDecoder();

function b64uEncode(bytes) {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function compressBytes(bytes) {
  if (typeof CompressionStream === 'undefined') return { c: 0, bytes };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return { c: 1, bytes: new Uint8Array(await new Response(stream).arrayBuffer()) };
}
async function decompressBytes(bytes, c) {
  if (!c) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function digestOfPassword(pw) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode('angry-v2:' + pw)));
}
async function keyFromDigest(digB64) {
  return crypto.subtle.importKey('raw', b64uDecode(digB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encryptJson(obj, digB64) {
  const key = await keyFromDigest(digB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // 암호문은 압축이 안 되므로 평문을 먼저 압축한 뒤 암호화한다 (링크 길이 절감)
  const { c, bytes } = await compressBytes(te.encode(JSON.stringify(obj)));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { i: b64uEncode(iv), d: b64uEncode(data), c };
}
async function decryptJson(e, digB64) {
  const key = await keyFromDigest(digB64);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uDecode(e.i) }, key, b64uDecode(e.d)));
  return JSON.parse(td.decode(await decompressBytes(plain, e.c)));
}

async function makeShareLink(kind) {
  if (!window.isSecureContext || !crypto.subtle) {
    toast('이 환경에서는 공유 링크 암호화를 사용할 수 없습니다.');
    return null;
  }
  const dig = localStorage.getItem(K_KEY);
  if (!dig) {
    toast('먼저 고급 설정에서 관리자 비밀번호를 설정하세요.');
    state.ui.adv = true;
    render();
    return null;
  }
  const secret = { roster: state.roster, settings: state.settings };
  const payload = { v: 1, k: kind === 'bracket' ? 'b' : 'r', date: new Date().toLocaleDateString('ko-KR') };
  if (kind === 'bracket') {
    const entry = state.history[state.currentIdx];
    if (!entry || !state.result || state.result.fatal) {
      toast('먼저 대진표를 생성하세요.');
      return null;
    }
    const names = {};
    entry.config.players.forEach((p) => (names[p.id] = [p.name, p.gender]));
    payload.b = { type: entry.config.type, rounds: state.result.rounds, names };
    secret.config = entry.config;
    secret.seed = entry.seed;
  }
  payload.e = await encryptJson(secret, dig);
  const { c, bytes } = await compressBytes(te.encode(JSON.stringify(payload)));
  const base = location.protocol === 'file:' ? PUBLIC_URL : location.href.split('#')[0];
  const link = `${base}#d=${c}${b64uEncode(bytes)}`;
  const finalLink = await shortenLink(link);
  window.__lastShareLink = finalLink;
  const label = kind === 'bracket' ? '대진표 공유 링크' : '명단 공유 링크';
  try {
    await navigator.clipboard.writeText(finalLink);
    toast(`${label}가 복사되었습니다${finalLink === link ? ' (단축 실패 — 긴 주소로 복사됨)' : ''}. 카톡에 붙여넣으세요!`);
  } catch (e) {
    prompt('아래 링크를 복사하세요:', finalLink);
  }
  return finalLink;
}

// TinyURL로 단축 (실패 시 원본 링크 그대로 사용) — 명단·설정은 암호화된 채로 담겨 있어 경유해도 안전
async function shortenLink(link) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(link), { signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.ok) {
      const short = (await resp.text()).trim();
      if (/^https:\/\/tinyurl\.com\/[\w-]+$/.test(short)) return short;
    }
  } catch (e) { /* 오프라인·차단 — 원본 사용 */ }
  return link;
}

// 공유 데이터(복호화된 명단·설정·대진표 구성)를 내 기기에 저장
function importShared(dec, payload) {
  if (dec.roster) state.roster = dec.roster;
  if (dec.settings) state.settings = Object.assign({}, state.settings, dec.settings);
  state.attend.selectedIds = state.attend.selectedIds.filter((id) => memberOf(id));
  if (dec.config && payload.b) {
    const exists = state.history.some((h) => h.seed === dec.seed && JSON.stringify(h.rounds) === JSON.stringify(payload.b.rounds));
    if (!exists) {
      state.history.unshift({
        ts: payload.date || '공유됨',
        seed: dec.seed,
        config: dec.config,
        rounds: deepClone(payload.b.rounds),
        edited: false,
        summary: { avgDiff: '-', maxMeet: '-', partnerRepeats: '-' },
      });
      if (state.history.length > 10) state.history.length = 10;
    }
  }
  persistAll();
}

async function handleShareHash() {
  const m = location.hash.match(/^#d=([01])([A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    const bytes = await decompressBytes(b64uDecode(m[2]), +m[1]);
    const payload = JSON.parse(td.decode(bytes));
    history.replaceState(null, '', location.pathname + location.search);
    state.share = payload;
    state.viewerMode = payload.k === 'b' ? 'b' : 'r';
    const dig = localStorage.getItem(K_KEY);
    if (dig) {
      try {
        const dec = await decryptJson(payload.e, dig);
        importShared(dec, payload);
        state.shareUnlocked = true;
        if (payload.k === 'r') {
          state.viewerMode = false;
          state.share = null;
          setTimeout(() => toast('공유받은 명단·설정을 불러왔습니다.'), 300);
        }
      } catch (e) { /* 키가 달라 해독 실패 — 뷰어로만 표시 */ }
    }
  } catch (e) {
    setTimeout(() => toast('공유 링크를 읽을 수 없습니다.'), 300);
  }
}

async function tryUnlock(pw) {
  if (!pw) return;
  try {
    const dig = b64uEncode(await digestOfPassword(pw));
    const dec = await decryptJson(state.share.e, dig);
    localStorage.setItem(K_KEY, dig);
    importShared(dec, state.share);
    state.viewerMode = false;
    state.share = null;
    state.shareUnlocked = false;
    render();
    toast('관리자 모드로 전환되었습니다. 명단·설정을 불러왔습니다.');
  } catch (e) {
    toast('비밀번호가 올바르지 않습니다.');
  }
}

function estimatedRounds() {
  const s = state.settings;
  if (s.meetingType === 'regular') return Math.max(1, Math.min(12, s.rounds));
  const N = state.attend.selectedIds.length || 12;
  const T = Math.ceil((N * s.gamesPerPerson) / 4);
  return Math.ceil(T / (N >= 12 ? 3 : N >= 8 ? 2 : 1));
}

function effectiveExclude(id) {
  if (state.attend.excludeOverrides[id]) return state.attend.excludeOverrides[id];
  const m = memberOf(id);
  return m && m.presetExclude ? m.presetExclude : [];
}

// ─── 렌더링 ───
function render() {
  if (state.viewerMode) {
    $('#app').innerHTML = renderViewer();
    bindViewer();
    return;
  }
  $('#app').innerHTML = `
    <h1>🎾 앵그리 테니스 클럽 대진표</h1>
    ${renderRoster()}
    ${renderSettings()}
    ${renderAttendance()}
    ${renderActions()}
    ${renderResult()}
  `;
  bindAll();
}

// 공유 링크로 열었을 때의 보기 전용 화면
function renderViewer() {
  const p = state.share;
  if (state.viewerMode === 'r') {
    return `
    <h1>🎾 앵그리 테니스 클럽 대진표</h1>
    <section class="card">
      <h2>👥 명단 공유를 받았습니다 ${p.date ? `<span class="hint-inline">(${esc(p.date)})</span>` : ''}</h2>
      <p style="font-size:0.92rem">클럽 명단·설정이 담긴 링크입니다. 관리자 비밀번호를 입력하면 이 기기에 저장됩니다.</p>
      <div class="row">
        <input type="password" id="unlock-pw" placeholder="관리자 비밀번호" style="padding:8px;border:1px solid var(--border);border-radius:6px">
        <button class="primary" id="unlock-btn">불러오기</button>
      </div>
    </section>`;
  }
  const b = p.b;
  const nameV = (id) => (b.names[id] ? b.names[id][0] : id);
  const tokV = (id) => `<span class="tok" style="cursor:default">${esc(nameV(id))}</span>`;
  const isReg = b.type === 'regular';
  const maxCourts = Math.max(...b.rounds.map((rd) => rd.games.length));
  const courtHeads = Array.from({ length: maxCourts }, (_, i) => `<th>${'abc'[i]}코트</th>`).join('');
  const rows = b.rounds
    .map((rd, r) => {
      const cells = rd.games
        .map((g) => `<td class="gamecell"><div class="tline">${g.teams[0].map(tokV).join('')}</div><div class="tline"><span class="vs">vs</span>${g.teams[1].map(tokV).join('')}</div></td>`)
        .join('') + '<td class="emptycourt">—</td>'.repeat(maxCourts - rd.games.length);
      const lesson = rd.lesson.map(tokV).join('') + (rd.excluded || []).map(tokV).join('') || '<span class="lessonlabel">—</span>';
      return `<tr><td class="roundcell">${r + 1}R</td>${cells}<td><div class="lessonbox">${lesson}</div></td></tr>`;
    })
    .join('');
  return `
  <section class="card">
    <h1 class="vtitle">🎾 앵그리 테니스 클럽 대진표</h1>
    <div class="bracket-scroll" style="text-align:center"><div style="display:inline-block">
      <table class="bracket">
        <tr><th></th>${courtHeads}<th>${isReg ? 'c코트 레슨' : '대기'}</th></tr>
        ${rows}
      </table>
      ${p.date ? `<div class="vdate">${esc(p.date)} 작성함</div>` : ''}
    </div></div>
  </section>
  <div class="row no-print viewer-actions">
    <button class="ghost" id="v-print">🖨 인쇄</button>
    ${state.shareUnlocked
      ? '<button class="ghost" id="v-admin">⚙ 관리자 화면 열기</button>'
      : '<button class="ghost" id="v-unlock">🔑 관리자 모드</button>'}
  </div>`;
}

function bindViewer() {
  const pr = $('#v-print');
  if (pr) pr.addEventListener('click', () => window.print());
  const adm = $('#v-admin');
  if (adm) adm.addEventListener('click', () => {
    state.viewerMode = false;
    state.share = null;
    if (state.history.length) viewVersion(0);
    else render();
  });
  const unl = $('#v-unlock');
  if (unl) unl.addEventListener('click', () => {
    const pw = prompt('관리자 비밀번호를 입력하세요:');
    if (pw != null) tryUnlock(pw);
  });
  const btn = $('#unlock-btn');
  if (btn) btn.addEventListener('click', () => tryUnlock($('#unlock-pw').value));
  const pwIn = $('#unlock-pw');
  if (pwIn) pwIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(pwIn.value); });
}

function renderRoster() {
  const totalCount = state.roster.men.length + state.roster.women.length;
  const col = (key, title, cls) => {
    const list = state.roster[key];
    const rows = list
      .map((m, i) => {
        const editing = state.editingId === m.id;
        const nameHtml = editing
          ? `<input type="text" class="name-edit" data-nameedit="${m.id}" value="${esc(m.name)}" maxlength="12">`
          : `<span class="rname" data-namebtn="${m.id}" title="클릭해서 이름 수정">${esc(m.name)}</span>`;
        const t = m.prefs || {};
        return `<div class="rrow" draggable="true" data-mrow="${m.id}">
          <span class="dragh" title="끌어서 순서 변경">≡</span>
          <span class="rank">${i + 1}</span>
          ${nameHtml}
          ${m.guest ? '<span class="guestb">게스트</span>' : ''}
          <span class="traits">
            <span class="tbtn ${t.gamePriority ? 'on' : ''}" data-trait="${m.id}:gamePriority" title="게임선호: 레슨/대기 최소화">⚡</span>
            <span class="tbtn ${t.newMember ? 'on' : ''}" data-trait="${m.id}:newMember" title="신규회원: 레슨 우선 + 상위 실력자와 매칭">🔰</span>
            <span class="tbtn ${t.mixedPreferred ? 'on' : ''}" data-trait="${m.id}:mixedPreferred" title="혼복선호 (정기모임)">💞</span>
          </span>
          <span class="updown">
            <button class="mini" data-up="${key}:${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="mini" data-down="${key}:${i}" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
          </span>
          <button class="mini del" data-del="${m.id}" title="명단에서 삭제">×</button>
        </div>`;
      })
      .join('');
    return `<div class="rcol ${cls}">
      <div class="rcol-head">${title} <span class="cnt">${list.length}명</span></div>
      <div class="rlist" data-rlist="${key}">${rows || '<div class="hint" style="padding:6px">아직 없음</div>'}</div>
      <div class="addrow">
        <input type="text" placeholder="이름" maxlength="12" data-addname="${key}">
        <label class="gchk"><input type="checkbox" data-addguest="${key}"> 게스트</label>
        <button class="ghost mini2" data-addbtn="${key}">+ 추가</button>
      </div>
    </div>`;
  };
  const rosterOpen = state.ui.roster === null ? totalCount === 0 : state.ui.roster;
  return `
  <section class="card no-print">
    <details data-uikey="roster" ${rosterOpen ? 'open' : ''}>
      <summary class="secsum"><b>① 클럽 명단 관리</b> <span class="hint-inline">— 위에서부터 실력순 (드래그 또는 ▲▼로 순서 변경, 이름 클릭으로 수정)</span></summary>
      <div class="rwrap">
        ${col('men', '남자', 'mcol')}
        ${col('women', '여자', 'wcol')}
      </div>
      <div class="hint">⚡게임선호 · 🔰신규회원 · 💞혼복선호 — 아이콘을 눌러 켜고 끕니다. 탈퇴/게스트 정리는 × 버튼.</div>
    </details>
  </section>`;
}

function renderSettings() {
  const s = state.settings;
  const diffOpts = [['', '제한 없음'], ['1', '1점'], ['2', '2점'], ['3', '3점'], ['4', '4점'], ['5', '5점']]
    .map(([v, t]) => `<option value="${v}" ${String(s.maxDiff ?? '') === v ? 'selected' : ''}>${t}</option>`).join('');
  const meetOpts = [['', '제한 없음'], ['1', '1번'], ['2', '2번'], ['3', '3번'], ['4', '4번']]
    .map(([v, t]) => `<option value="${v}" ${String(s.maxMeet ?? '') === v ? 'selected' : ''}>${t}</option>`).join('');
  const roundNums = Array.from({ length: Math.max(1, Math.min(12, s.rounds)) }, (_, i) => i + 1);
  const mixedChips = roundNums
    .map((n) => `<span class="xr ${(s.mixedRounds || []).includes(n) ? 'on' : ''}" data-mxr="${n}">${n}</span>`)
    .join('');
  const tightChips = roundNums
    .map((n) => `<span class="xr ${(s.tightRounds || []).includes(n) ? 'on' : ''}" data-tgr="${n}">${n}</span>`)
    .join('');
  return `
  <section class="card no-print">
    <h2>② 모임 설정</h2>
    <div class="row">
      <label class="radio"><input type="radio" name="mtype" value="regular" ${s.meetingType === 'regular' ? 'checked' : ''}> 정기모임 (a·b 게임 + c 레슨)</label>
      <label class="radio"><input type="radio" name="mtype" value="monthly" ${s.meetingType === 'monthly' ? 'checked' : ''}> 월례대회 (3코트 게임)</label>
    </div>
    <div class="row" style="margin-top:8px">
      ${s.meetingType === 'regular'
        ? `<label>총 라운드 수 <input type="number" id="rounds" min="1" max="12" value="${s.rounds}"></label>`
        : `<label>인당 게임 수 <input type="number" id="gpp" min="1" max="10" value="${s.gamesPerPerson}"></label>`}
    </div>
    <details data-uikey="adv" ${state.ui.adv ? 'open' : ''} style="margin-top:10px">
      <summary class="secsum">고급 설정 (제약 튜닝)</summary>
      <div class="advgrid">
        <label>게임 점수차 상한 <select id="opt-maxdiff">${diffOpts}</select></label>
        <span class="hint">한 게임의 두 팀 합산 점수 차이를 이 값 이하로 제한</span>
        <label>같은 상대 상한 <select id="opt-maxmeet">${meetOpts}</select></label>
        <span class="hint">같은 상대와 만나는 횟수를 이 값 이하로 제한 (기본 2번)</span>
        <label>혼복 선호 라운드 <span style="display:inline-block;vertical-align:middle">${mixedChips}</span></label>
        <span class="hint">선택한 라운드는 혼복 위주, 나머지는 남복/여복 위주 (정기모임 전용, 기본 1·3)</span>
        <label>빡겜 라운드 <span style="display:inline-block;vertical-align:middle">${tightChips}</span></label>
        <span class="hint">선택한 라운드는 비슷한 실력끼리 한 게임에 배정 (팀은 균형 분할, 기본 1·2·3). 특히 2라운드는 남복/여복 상위 랭커(1~4위)끼리 우선 편성됩니다</span>
        <label><input type="checkbox" id="opt-consec" ${s.allowConsecutiveSit ? 'checked' : ''}> 연속 결장(레슨/대기) 허용</label>
        <span class="hint">인원이 많아 연속 결장이 불가피할 때 수동으로 허용</span>
        <label><input type="checkbox" id="opt-partner" ${s.allowPartnerRepeat ? 'checked' : ''}> 파트너 중복 허용</label>
        <span class="hint">라운드가 많거나 인원이 적어 같은 파트너가 불가피할 때</span>
        <label><input type="checkbox" id="opt-nogender" ${s.ignoreGender ? 'checked' : ''}> 성별 구분 없이 편성 (잡복 허용)</label>
        <span class="hint">남녀 상관없이 실력 순위만으로 팀 구성 — 극단적 성비일 때 사용</span>
        <label>관리자 비밀번호 <input type="password" id="opt-pw" placeholder="${localStorage.getItem(K_KEY) ? '설정됨 · 변경하려면 입력' : '미설정'}" style="width:150px"> <button class="ghost mini2" id="pw-save">저장</button></label>
        <span class="hint">공유 링크 속 명단·설정이 이 비밀번호로 잠깁니다. 명단 수정 권한을 줄 사람(예: 회장)에게만 알려주세요. 변경하면 이전 링크로는 명단을 더 못 불러옵니다.</span>
      </div>
    </details>
  </section>`;
}

function renderAttendance() {
  const sel = state.attend.selectedIds;
  const chip = (m, g) => `<span class="chip ${g} ${sel.includes(m.id) ? 'on' : ''}" data-att="${m.id}">${esc(m.name)}</span>`;
  const menChips = state.roster.men.map((m) => chip(m, 'm')).join('');
  const womenChips = state.roster.women.map((m) => chip(m, 'w')).join('');
  const selM = sel.filter((id) => genderOf(id) === 'M').length;

  let detail = '';
  if (sel.length) {
    const R = estimatedRounds();
    const orderedSel = [...state.roster.men, ...state.roster.women].filter((m) => sel.includes(m.id));
    const rows = orderedSel
      .map((m) => {
        const ex = effectiveExclude(m.id);
        const xr = Array.from({ length: R }, (_, i) => i + 1)
          .map((r) => `<span class="xr ${ex.includes(r) ? 'on' : ''}" data-xr="${m.id}:${r}">${r}</span>`)
          .join('');
        return `<tr><td style="color:${genderOf(m.id) === 'M' ? 'var(--men)' : 'var(--women)'};font-weight:700">${esc(m.name)}</td><td style="text-align:left">${xr}</td></tr>`;
      })
      .join('');
    const exclOpen = state.ui.exclude === null
      ? Object.keys(state.attend.excludeOverrides).length > 0 || orderedSel.some((m) => (m.presetExclude || []).length > 0)
      : state.ui.exclude;
    detail = `<details data-uikey="exclude" ${exclOpen ? 'open' : ''}>
      <summary class="secsum">오늘 라운드 제외 설정 (지각/조퇴)</summary>
      <table class="detail-table" style="margin-top:8px;max-width:480px">
        <tr><th>선수</th><th style="text-align:left">제외 라운드</th></tr>${rows}
      </table>
    </details>`;
  }

  return `
  <section class="card no-print">
    <h2>③ 오늘 참석자 <span class="hint-inline">— 남 ${selM}명, 여 ${sel.length - selM}명, 총 ${sel.length}명</span></h2>
    ${state.roster.men.length + state.roster.women.length === 0
      ? '<div class="hint">먼저 ① 클럽 명단에 멤버를 추가하세요.</div>'
      : `<div class="chips">${menChips}</div><div class="chips">${womenChips}</div>${detail}`}
  </section>`;
}

function renderActions() {
  const versions = state.history
    .map((h, i) => `<span class="vchip ${i === state.currentIdx ? 'on' : ''}" data-ver="${i}" title="점수차 평균 ${h.summary.avgDiff} · 재대면 최대 ${h.summary.maxMeet}">V${state.history.length - i} · ${h.ts}${h.edited ? ' ✏' : ''}</span>`)
    .join('');
  return `
  <section class="card no-print">
    <div class="row">
      <button class="primary" id="gen">대진표 생성</button>
      ${state.result && !state.result.fatal ? '<button class="ghost" id="print">🖨 인쇄</button>' : ''}
      ${state.result && !state.result.fatal ? '<button class="ghost" id="share-b">📤 대진표 공유 링크</button>' : ''}
      ${state.result && !state.result.fatal
        ? `<button class="ghost" id="undo" ${state.undoStack.length ? '' : 'disabled'} title="스왑 되돌리기 (Ctrl+Z)">↩ 되돌리기</button>
           <button class="ghost" id="redo" ${state.redoStack.length ? '' : 'disabled'} title="되돌린 스왑 다시 실행 (Ctrl+Y)">↪ 다시 실행</button>`
        : ''}
    </div>
    ${state.history.length > 1 ? `<div class="vrow"><span class="hint-inline">버전 비교:</span> ${versions}</div>` : ''}
  </section>`;
}

function renderResult() {
  const res = state.result;
  if (!res) return '';
  if (res.fatal) {
    return `<section class="card"><div class="banner error"><b>대진표를 만들 수 없습니다.</b><br>${esc(res.fatal.message)}
      ${res.fatal.suggestions && res.fatal.suggestions.length ? `<ul>${res.fatal.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    </div></section>`;
  }

  // 위반·완화 배너는 대진표 아래, 참고 배너는 넓은 화면에서 대진표 오른쪽(좁으면 아래)
  const errHtml = res.errors.length
    ? `<div class="banner error"><b>규칙 위반 ${res.errors.length}건</b><ul>${res.errors.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul></div>`
    : '';
  const relaxHtml = res.relaxationsApplied.length
    ? `<div class="banner info"><b>자동 완화 적용</b><ul>${res.relaxationsApplied.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`
    : '';
  const warnHtml = res.warnings.length
    ? `<div class="banner warn"><b>참고</b><ul>${res.warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></div>`
    : '';

  const isReg = res.type === 'regular';
  const maxCourtsAll = Math.max(...res.rounds.map((rd) => rd.games.length));

  // 관리자 화면 전용: 규칙 위반을 셀·선수 단위 표시 (경기이사 수동 조정용)
  // 잡복은 vs 색(핫핑크), 파트너 중복은 해당 팀 이름 색으로 표시하고 아이콘 뱃지는 나머지 유형만 사용
  const st = res.stats;
  const maxDiffOpt = res.plan.options ? res.plan.options.maxDiff : null;
  const maxMeetOpt = res.plan.options ? res.plan.options.maxMeet : null;
  const meetThreshold = maxMeetOpt != null ? maxMeetOpt + 1 : 3;
  const usedIcons = new Set();
  state._pBadges = new Map(); // `${round}:${id}` → 아이콘 문자열
  const addPBadge = (r, id, icon) => {
    const k = r + ':' + id;
    const cur = state._pBadges.get(k) || '';
    if (!cur.includes(icon)) state._pBadges.set(k, cur + icon);
    usedIcons.add(icon);
  };
  st.consecutiveSitList.forEach((cs) => {
    addPBadge(cs.rounds[0], cs.id, '💤');
    addPBadge(cs.rounds[1], cs.id, '💤');
  });
  const badGames = new Set(); // `${round}:${court}` — 게임 구성 오류(4인 미충족 등)
  st.structural.forEach((s) => {
    if (s.code === 'E_DUP_ASSIGN' && s.players) s.players.forEach((id) => addPBadge(s.round, id, '⚠️'));
    if (s.code === 'E_EXCLUDED_ASSIGNED' && s.players) s.players.forEach((id) => addPBadge(s.round, id, '⛔'));
    if (s.code === 'E_BAD_GAME') {
      badGames.add(s.round + ':' + s.court);
      if (s.players) s.players.forEach((id) => addPBadge(s.round, id, '⚠️'));
    }
  });
  // 파트너 중복 팀 강조: 해당 라운드에서 그 두 사람에게 성별 색 부여
  state._dupTeam = new Set(); // `${round}:${id}`
  res.rounds.forEach((rd, r) => {
    rd.games.forEach((g) => {
      g.teams.forEach((t) => {
        if ((st.partnerCount.get(pairKey(t[0], t[1])) || 0) > 1) {
          state._dupTeam.add(r + ':' + t[0]);
          state._dupTeam.add(r + ':' + t[1]);
        }
      });
    });
  });

  const roundsHtml = res.rounds
    .map((rd, r) => {
      const gameCells = rd.games
        .map((g, gi) => {
          const team = (ti) => g.teams[ti].map((id, si) => tok(id, r, `g:${gi}:${ti}:${si}`)).join('');
          const known = (id) => res.plan.byId.has(id);
          const all = [...g.teams[0], ...g.teams[1]];
          // vs 색으로 게임 유형 표시: 검정=남복/여복, 파랑=혼복, 핫핑크=잡복
          let vsClass = 'same';
          const icons = [];
          if (badGames.has(r + ':' + g.court)) icons.push('⚠️'); // 게임 구성 오류 (4인 미충족 등)
          if (all.every(known)) {
            const gtype = (t) => t.map((id) => res.plan.byId.get(id).gender).sort().join('');
            const t1 = gtype(g.teams[0]);
            const t2 = gtype(g.teams[1]);
            if (t1 !== t2) vsClass = 'japbok';
            else if (t1 === 'MW') vsClass = 'mx';
            let freq = false;
            for (const x of g.teams[0]) for (const y of g.teams[1]) {
              if ((st.meetCount.get(pairKey(x, y)) || 0) >= meetThreshold) freq = true;
            }
            if (freq) icons.push('⚔️');
            if (maxDiffOpt != null) {
              const sum = (t) => t.reduce((a, id) => a + res.plan.byId.get(id).score, 0);
              if (Math.abs(sum(g.teams[0]) - sum(g.teams[1])) > maxDiffOpt) icons.push('📏');
            }
          }
          icons.forEach((ic) => usedIcons.add(ic));
          const badgeHtml = icons.length ? `<span class="cellbadges" title="규칙 위반 — 아래 범례 참고">${icons.join('')}</span>` : '';
          return `<td class="gamecell">${badgeHtml}<div class="tline">${team(0)}</div><div class="tline"><span class="vs ${vsClass}">vs</span>${team(1)}</div></td>`;
        })
        .join('') + '<td class="emptycourt">—</td>'.repeat(maxCourtsAll - rd.games.length);
      // 제외(지각/조퇴) 인원도 구분 없이 일반 이름으로 표기 (스왑 대상은 아님)
      const excludedToks = rd.excluded.map((id) => `<span class="tok" style="cursor:default">${esc(nameOf(id))}</span>`).join('');
      const lessonToks = rd.lesson.map((id, li) => tok(id, r, `l:${li}`)).join('') + excludedToks || '<span class="lessonlabel">—</span>';
      return `<tr>
        <td class="roundcell">${r + 1}R</td>
        ${gameCells}
        <td><div class="lessonbox">${lessonToks}</div></td>
      </tr>`;
    })
    .join('');

  const maxCourts = Math.max(...res.rounds.map((rd) => rd.games.length));
  const courtHeads = Array.from({ length: maxCourts }, (_, i) => `<th>${'abc'[i]}코트</th>`).join('');

  const statRows = [...res.stats.perPlayer.entries()]
    .filter(([, s]) => s.games + s.sits > 0)
    .map(([id, s]) => {
      const m = memberOf(id) || { prefs: {} };
      const p = m.prefs || {};
      const icons = `${p.gamePriority ? '⚡' : ''}${p.newMember ? '🔰' : ''}${p.mixedPreferred ? '💞' : ''}`;
      return `<tr><td style="color:${genderOf(id) === 'M' ? 'var(--men)' : 'var(--women)'}">${esc(nameOf(id))} <span class="preficon">${icons}</span></td><td>${s.games}</td><td>${s.mixed}</td><td>${s.sits}</td></tr>`;
    })
    .join('');

  const verLabel = state.currentIdx >= 0 ? `V${state.history.length - state.currentIdx}` : '';

  // 범례: 실제 표시된 아이콘 뱃지만 설명
  const ICON_DESC = {
    '⚔️': `⚔️ 같은 상대 ${meetThreshold}번 이상`,
    '📏': '📏 점수차 상한 초과',
    '💤': '💤 연속 결장',
    '⚠️': '⚠️ 중복 배정·게임 구성 오류',
    '⛔': '⛔ 제외 인원 배정',
  };
  const legendItems = Object.keys(ICON_DESC).filter((ic) => usedIcons.has(ic)).map((ic) => ICON_DESC[ic]);
  const legendHtml = legendItems.length ? `<div class="badge-legend">위반 표시: ${legendItems.join(' · ')}</div>` : '';

  return `
  <section class="card">
    <h2>${isReg ? '정기모임' : '월례대회'} 대진표 ${verLabel} <span class="hint-inline">(시드 ${res.seed}${res.edited ? ' · 수동 수정됨' : ''})</span></h2>
    <div class="result-cols">
      <div class="bracket-col">
        <div class="bracket-scroll"><table class="bracket">
          <tr><th></th>${courtHeads}<th>${isReg ? 'c코트 레슨' : '대기'}</th></tr>
          ${roundsHtml}
        </table></div>
        ${legendHtml}
      </div>
      ${warnHtml ? `<div class="note-side">${warnHtml}</div>` : ''}
    </div>
    ${errHtml}${relaxHtml}
    <div class="hint no-print">선수 이름 두 개를 차례로 누르면 자리를 맞바꿉니다 (라운드·성별 제한 없음 — 규칙에 어긋나면 경고로 알려드립니다).</div>
    <div class="statline">
      파트너 중복 <b>${res.stats.partnerRepeats}</b>회 ·
      같은 상대 최대 <b>${res.stats.maxMeet}</b>번 ·
      게임 점수차 평균 <b>${res.stats.scoreDiffAvg.toFixed(1)}</b> / 최대 <b>${res.stats.scoreDiffMax}</b>
    </div>
    <table class="detail-table" style="max-width:360px">
      <tr><th>선수</th><th>게임</th><th>혼복</th><th>${isReg ? '레슨' : '대기'}</th></tr>
      ${statRows}
    </table>
  </section>`;
}

function tok(id, round, loc) {
  // 기본은 무채색(검정) — 파트너 중복 팀만 성별 색으로 강조
  const dup = state._dupTeam && state._dupTeam.has(round + ':' + id) && loc.startsWith('g');
  const g = dup ? (genderOf(id) === 'M' ? 'm' : 'w') : '';
  const sel = state.swapSel && state.swapSel.round === round && state.swapSel.loc === loc;
  const swapped = state._justSwapped && state._justSwapped.has(round + ':' + id);
  const pb = state._pBadges && state._pBadges.get(round + ':' + id);
  return `<span class="tok ${g} ${sel ? 'sel' : ''} ${swapped ? 'swapped' : ''}" data-tok="${id}" data-round="${round}" data-loc="${loc}">${esc(nameOf(id))}${pb ? `<sup class="vbadge">${pb}</sup>` : ''}</span>`;
}

// ─── 이벤트 바인딩 ───
function bindAll() {
  // details 접힘 상태 기억 (재렌더링 시 유지)
  document.querySelectorAll('details[data-uikey]').forEach((el) =>
    el.addEventListener('toggle', () => { state.ui[el.dataset.uikey] = el.open; })
  );
  bindRoster();
  bindSettings();
  bindAttendance();
  bindActions();
  bindResult();
}

function bindRoster() {
  // 이름 편집
  document.querySelectorAll('[data-namebtn]').forEach((el) =>
    el.addEventListener('click', () => {
      state.editingId = el.dataset.namebtn;
      render();
      const input = document.querySelector(`[data-nameedit="${state.editingId}"]`);
      if (input) { input.focus(); input.select(); }
    })
  );
  document.querySelectorAll('[data-nameedit]').forEach((el) => {
    const commit = () => {
      const m = memberOf(el.dataset.nameedit);
      const v = el.value.trim();
      if (m && v) m.name = v;
      state.editingId = null;
      persistAll();
      render();
    };
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); if (e.key === 'Escape') { state.editingId = null; render(); } });
  });

  // 특성 토글
  document.querySelectorAll('[data-trait]').forEach((el) =>
    el.addEventListener('click', () => {
      const [id, key] = el.dataset.trait.split(':');
      const m = memberOf(id);
      if (!m) return;
      m.prefs = m.prefs || {};
      m.prefs[key] = !m.prefs[key];
      persistAll();
      render();
    })
  );

  // 삭제
  document.querySelectorAll('[data-del]').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.del;
      const m = memberOf(id);
      if (!m) return;
      if (!confirm(`${m.name}님을 명단에서 삭제할까요?`)) return;
      state.roster.men = state.roster.men.filter((x) => x.id !== id);
      state.roster.women = state.roster.women.filter((x) => x.id !== id);
      state.attend.selectedIds = state.attend.selectedIds.filter((x) => x !== id);
      delete state.attend.excludeOverrides[id];
      persistAll();
      render();
    })
  );

  // ▲▼ 이동
  const move = (key, i, d) => {
    const list = state.roster[key];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    persistAll();
    render();
  };
  document.querySelectorAll('[data-up]').forEach((el) =>
    el.addEventListener('click', () => { const [k, i] = el.dataset.up.split(':'); move(k, +i, -1); })
  );
  document.querySelectorAll('[data-down]').forEach((el) =>
    el.addEventListener('click', () => { const [k, i] = el.dataset.down.split(':'); move(k, +i, +1); })
  );

  // 드래그 순서 변경 (같은 성별 리스트 내)
  document.querySelectorAll('[data-mrow]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      state.dragId = el.dataset.mrow;
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', (e) => {
      if (!state.dragId || state.dragId === el.dataset.mrow) return;
      if (genderOf(state.dragId) !== genderOf(el.dataset.mrow)) return;
      e.preventDefault();
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = state.dragId;
      const to = el.dataset.mrow;
      state.dragId = null;
      if (!from || from === to || genderOf(from) !== genderOf(to)) return;
      const key = genderOf(from) === 'M' ? 'men' : 'women';
      const list = state.roster[key];
      const fi = list.findIndex((m) => m.id === from);
      const ti = list.findIndex((m) => m.id === to);
      const [item] = list.splice(fi, 1);
      list.splice(ti, 0, item);
      persistAll();
      render();
    });
  });

  // 추가
  document.querySelectorAll('[data-addbtn]').forEach((el) =>
    el.addEventListener('click', () => addMember(el.dataset.addbtn))
  );
  document.querySelectorAll('[data-addname]').forEach((el) =>
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMember(el.dataset.addname); })
  );
}

function addMember(key) {
  const input = document.querySelector(`[data-addname="${key}"]`);
  const guest = document.querySelector(`[data-addguest="${key}"]`);
  const name = (input.value || '').trim();
  if (!name) { toast('이름을 입력하세요.'); return; }
  const dup = [...state.roster.men, ...state.roster.women].some((m) => m.name === name);
  if (dup) { toast('같은 이름이 이미 있습니다. 구분되게 입력해주세요 (예: 김철수B).'); return; }
  state.roster[key].push({
    id: uid(),
    name,
    prefs: { gamePriority: false, newMember: false, mixedPreferred: false },
    presetExclude: [],
    guest: !!(guest && guest.checked),
  });
  persistAll();
  render();
  const again = document.querySelector(`[data-addname="${key}"]`);
  if (again) again.focus();
}

function bindSettings() {
  document.querySelectorAll('input[name="mtype"]').forEach((el) =>
    el.addEventListener('change', () => { state.settings.meetingType = el.value; persistAll(); render(); })
  );
  const num = (id, key, lo, hi, dflt) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => {
      state.settings[key] = Math.max(lo, Math.min(hi, +el.value || dflt));
      persistAll(); render();
    });
  };
  num('#rounds', 'rounds', 1, 12, 5);
  num('#gpp', 'gamesPerPerson', 1, 10, 4);

  const md = $('#opt-maxdiff');
  if (md) md.addEventListener('change', () => { state.settings.maxDiff = md.value === '' ? null : +md.value; persistAll(); });
  const mm = $('#opt-maxmeet');
  if (mm) mm.addEventListener('change', () => { state.settings.maxMeet = mm.value === '' ? null : +mm.value; persistAll(); });
  const roundListToggle = (attr, key) =>
    document.querySelectorAll(`[data-${attr}]`).forEach((el) =>
      el.addEventListener('click', () => {
        const n = +el.dataset[attr];
        const cur = state.settings[key] || [];
        state.settings[key] = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((a, b) => a - b);
        persistAll();
        render();
      })
    );
  roundListToggle('mxr', 'mixedRounds');
  roundListToggle('tgr', 'tightRounds');
  const chk = (id, key) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { state.settings[key] = el.checked; persistAll(); });
  };
  chk('#opt-consec', 'allowConsecutiveSit');
  chk('#opt-partner', 'allowPartnerRepeat');
  chk('#opt-nogender', 'ignoreGender');

  const pwSave = $('#pw-save');
  if (pwSave) pwSave.addEventListener('click', async () => {
    const el = $('#opt-pw');
    const pw = (el.value || '').trim();
    if (pw.length < 4) { toast('비밀번호는 4자 이상으로 해주세요.'); return; }
    localStorage.setItem(K_KEY, b64uEncode(await digestOfPassword(pw)));
    el.value = '';
    el.placeholder = '설정됨 · 변경하려면 입력';
    toast('관리자 비밀번호가 저장되었습니다.');
  });
}

function bindAttendance() {
  document.querySelectorAll('[data-att]').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.att;
      const sel = state.attend.selectedIds;
      state.attend.selectedIds = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
      persistAll();
      render();
    })
  );
  document.querySelectorAll('[data-xr]').forEach((el) =>
    el.addEventListener('click', () => {
      const [id, rStr] = el.dataset.xr.split(':');
      const r = +rStr;
      const cur = effectiveExclude(id);
      const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r];
      state.attend.excludeOverrides[id] = next;
      persistAll();
      render();
    })
  );
}

function bindActions() {
  const gen = $('#gen');
  if (gen) gen.addEventListener('click', () => generate());
  const print = $('#print');
  if (print) print.addEventListener('click', () => window.print());
  const shareB = $('#share-b');
  if (shareB) shareB.addEventListener('click', async () => {
    // 복사 먼저(새 탭을 먼저 열면 포커스를 잃어 클립보드 복사가 실패한다), 그 다음 새 탭
    const link = await makeShareLink('bracket');
    if (link) {
      const tab = window.open(link, '_blank');
      if (!tab) toast('링크는 복사되었지만 팝업이 차단되어 새 탭을 열지 못했습니다.');
    }
  });
  const undo = $('#undo');
  if (undo) undo.addEventListener('click', () => undoSwap());
  const redo = $('#redo');
  if (redo) redo.addEventListener('click', () => redoSwap());
  document.querySelectorAll('[data-ver]').forEach((el) =>
    el.addEventListener('click', () => viewVersion(+el.dataset.ver))
  );
}

function bindResult() {
  document.querySelectorAll('[data-tok]').forEach((el) => el.addEventListener('click', () => onTokenClick(el)));
}

// ─── 생성·버전·수동 편집 ───
function buildConfig(seed) {
  const players = [];
  const collect = (key, gender) =>
    state.roster[key].forEach((m, idx) => {
      if (!state.attend.selectedIds.includes(m.id)) return;
      players.push({
        id: m.id,
        name: m.name,
        gender,
        score: idx + 1, // 명단 순서 = 성별 내 실력 순위 (불참자 있어도 절대 순위 유지)
        prefs: m.prefs,
        unavailableRounds: effectiveExclude(m.id),
      });
    });
  collect('men', 'M');
  collect('women', 'W');
  const s = state.settings;
  return {
    type: s.meetingType,
    rounds: s.rounds,
    gamesPerPerson: s.gamesPerPerson,
    players,
    options: {
      maxDiff: s.maxDiff,
      maxMeet: s.maxMeet,
      tightRounds: s.tightRounds,
      mixedRounds: s.mixedRounds,
      allowConsecutiveSit: s.allowConsecutiveSit,
      allowPartnerRepeat: s.allowPartnerRepeat,
      ignoreGender: s.ignoreGender,
    },
    seed,
  };
}

function generate() {
  const config = buildConfig(Math.floor(Math.random() * 1e9));
  state.swapSel = null;
  state.undoStack = [];
  state.redoStack = [];
  try {
    const res = generateSchedule(config);
    res.edited = false;
    state.result = res;
    const entry = {
      ts: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
      seed: res.seed,
      config,
      rounds: deepClone(res.rounds),
      edited: false,
      summary: {
        avgDiff: res.stats.scoreDiffAvg.toFixed(1),
        maxMeet: res.stats.maxMeet,
        partnerRepeats: res.stats.partnerRepeats,
      },
    };
    state.history.unshift(entry);
    if (state.history.length > 10) state.history.length = 10;
    state.currentIdx = 0;
  } catch (e) {
    if (e instanceof SchedulerError) {
      state.result = { fatal: { message: e.message, suggestions: e.suggestions } };
    } else {
      state.result = { fatal: { message: '예상치 못한 오류: ' + e.message, suggestions: [] } };
    }
  }
  persistAll();
  render();
  const cards = document.querySelectorAll('section.card');
  if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: 'smooth' });
}

function viewVersion(i) {
  const entry = state.history[i];
  if (!entry) return;
  try {
    const plan = buildPlan(entry.config);
    const rounds = deepClone(entry.rounds);
    const schedule = { type: plan.type, rounds };
    const { errors, warnings, stats } = validateSchedule(schedule, plan);
    state.result = {
      type: plan.type,
      rounds,
      seed: entry.seed,
      plan,
      errors,
      warnings: [...plan.planWarnings, ...warnings],
      stats,
      relaxationsApplied: [],
      edited: !!entry.edited,
    };
    state.currentIdx = i;
    state.swapSel = null;
    state.undoStack = [];
    state.redoStack = [];
    render();
  } catch (e) {
    toast('이 버전을 불러올 수 없습니다: ' + e.message);
  }
}

function onTokenClick(el) {
  const round = +el.dataset.round;
  const loc = el.dataset.loc;
  const id = el.dataset.tok;
  if (!state.swapSel) {
    state.swapSel = { round, loc, id };
    render();
    return;
  }
  if (state.swapSel.round === round && state.swapSel.loc === loc) {
    state.swapSel = null;
    render();
    return;
  }
  const firstId = state.swapSel.id;
  const firstRound = state.swapSel.round;
  // 되돌리기 스냅샷 (스왑 직전 상태)
  state.undoStack.push(deepClone(state.result.rounds));
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
  applySwap(state.swapSel, { round, loc });
  state.swapSel = null;
  if (state.result) state.result.edited = true;
  revalidate();
  syncCurrentVersion();
  // 스왑된 두 사람의 새 위치를 잠시 음영 표시 (CSS 애니메이션으로 서서히 투명)
  state._justSwapped = new Set([round + ':' + firstId, firstRound + ':' + id]);
  render();
  state._justSwapped = null;
}

function undoSwap() {
  if (!state.result || state.result.fatal || !state.undoStack.length) return;
  state.redoStack.push(deepClone(state.result.rounds));
  state.result.rounds = state.undoStack.pop();
  state.result.edited = true;
  state.swapSel = null;
  revalidate();
  syncCurrentVersion();
  render();
}

function redoSwap() {
  if (!state.result || state.result.fatal || !state.redoStack.length) return;
  state.undoStack.push(deepClone(state.result.rounds));
  state.result.rounds = state.redoStack.pop();
  state.result.edited = true;
  state.swapSel = null;
  revalidate();
  syncCurrentVersion();
  render();
}

function locRef(rd, loc) {
  const parts = loc.split(':');
  if (parts[0] === 'g') {
    const gi = +parts[1], ti = +parts[2], si = +parts[3];
    return {
      get: () => rd.games[gi].teams[ti][si],
      set: (v) => (rd.games[gi].teams[ti][si] = v),
    };
  }
  const li = +parts[1];
  return {
    get: () => rd.lesson[li],
    set: (v) => (rd.lesson[li] = v),
  };
}

function applySwap(selA, selB) {
  const rdA = state.result.rounds[selA.round];
  const rdB = state.result.rounds[selB.round];
  const a = locRef(rdA, selA.loc);
  const b = locRef(rdB, selB.loc);
  const va = a.get();
  a.set(b.get());
  b.set(va);
}

function revalidate() {
  const res = state.result;
  const { errors, warnings, stats } = validateSchedule({ type: res.type, rounds: res.rounds }, res.plan);
  res.errors = errors;
  res.warnings = [...res.plan.planWarnings, ...warnings];
  res.stats = stats;
}

function syncCurrentVersion() {
  const entry = state.history[state.currentIdx];
  if (!entry) return;
  entry.rounds = deepClone(state.result.rounds);
  entry.edited = true;
  persistAll();
}

// ─── 시작 ───
async function init() {
  state.roster = load(K_ROSTER, state.roster);
  state.settings = Object.assign({}, state.settings, load(K_SETTINGS, {}));
  // 마이그레이션: 예전 저장값(빡겜=숫자 n)은 [1..n]으로, 그때의 혼복 기본값 [2,4]는 새 기본 [1,3]으로
  if (!Array.isArray(state.settings.tightRounds)) {
    const n = Number(state.settings.tightRounds) || 0;
    state.settings.tightRounds = Array.from({ length: Math.max(0, n) }, (_, i) => i + 1);
    if (JSON.stringify(state.settings.mixedRounds || []) === '[2,4]') state.settings.mixedRounds = [1, 3];
  }
  state.attend = Object.assign({ selectedIds: [], excludeOverrides: {} }, load(K_ATTEND, {}));
  state.history = load(K_HISTORY, []);
  // 명단에서 삭제된 인원이 참석 목록에 남아있지 않도록 정리
  state.attend.selectedIds = state.attend.selectedIds.filter((id) => memberOf(id));
  await handleShareHash();
  // 앱을 다시 열면 최근 대진표를 바로 보여준다
  if (!state.viewerMode && !state.result && state.history.length) {
    viewVersion(0);
    return;
  }
  render();
}
// 열려 있는 탭에 공유 링크를 붙여넣는 경우에도 동작하도록
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#d=')) location.reload();
});
// 스왑 되돌리기/다시 실행 단축키 (입력창에 타이핑 중일 때는 제외)
window.addEventListener('keydown', (e) => {
  if (state.viewerMode || !state.result || state.result.fatal) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoSwap();
  } else if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) {
    e.preventDefault();
    redoSwap();
  }
});
init();
