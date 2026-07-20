// 앵그리 테니스 클럽 대진표 — UI v2 (실명 명단·설정 튜닝·버전 히스토리)
import { generateSchedule, validateSchedule, SchedulerError } from './engine/scheduler.js';
import { buildPlan } from './engine/planner.js';
import { pairKey } from './engine/validate.js';
import { computeRanking } from './engine/ranking.js';

const K_ROSTER = 'angry-roster-v2';
const K_SETTINGS = 'angry-settings-v2';
const K_ATTEND = 'angry-attend-v2';
const K_HISTORY = 'angry-history-v2';
const K_RESULTS = 'angry-results-v2'; // 확정 대회 결과 누적
const K_KEY = 'angry-key-v2'; // 관리자 비밀번호에서 파생한 키 (SHA-256, base64url)
const PUBLIC_URL = 'https://lakeastern.github.io/angry/';

// 결과 저장 계층 (지금은 localStorage, Phase 2에서 동일 인터페이스로 Firestore 교체)
const resultStore = {
  list() { try { return JSON.parse(localStorage.getItem(K_RESULTS)) || []; } catch (e) { return []; } },
  _save(arr) { try { localStorage.setItem(K_RESULTS, JSON.stringify(arr)); } catch (e) { /* 무시 */ } },
  add(entry) { const a = this.list(); const i = a.findIndex((r) => r.id === entry.id); if (i >= 0) a[i] = entry; else a.unshift(entry); this._save(a); },
  remove(id) { this._save(this.list().filter((r) => r.id !== id)); },
  get(id) { return this.list().find((r) => r.id === id) || null; },
};

const state = {
  roster: { men: [], women: [] }, // {id, name, prefs:{gamePriority,newMember,mixedPreferred}, presetExclude:[], guest}
  settings: {
    meetingType: 'regular',
    rounds: 5,
    gamesPerPerson: 4,
    maxDiff: null,
    maxMeet: 2,
    minMixedGames: 1,
    tightRounds: [1, 2, 3],
    mixedRounds: [1, 3],
    rankerRounds: [2],
    allowConsecutiveSit: false,
    allowPartnerRepeat: false,
    ignoreGender: false,
    strictGameCount: true, // 게임데이·앵그리대회: 인당 게임 수 우선 (필요 시 잡복까지 최소 허용)
  },
  attend: { selectedIds: [], excludeOverrides: {} },
  history: [], // [{ts, seed, config, rounds, summary}] 최신이 앞
  currentIdx: -1,
  result: null,
  swapSel: null, // {round, loc, id}
  editingId: null,
  dragId: null,
  showRealNames: false, // 앵그리대회: 대진표를 별칭(false) / 실명(true)으로 표시
  scoreMode: false, // 앵그리대회 결과(스코어) 입력 모드
  scores: {}, // 결과 입력 임시 버퍼: `${round}:${gi}` → {a, b}
  rankFilter: 'all', // 앵그리랭킹: 'all'(전체 누적) | resultId(대회별 단일)
  ui: { roster: null, adv: null, exclude: null, ranking: null, advHelp: false }, // details 접힘 상태 (null = 자동) + 고급 설정 설명 표시
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
  if (state.roster.men.some((m) => m.id === id)) return 'M';
  if (state.roster.women.some((m) => m.id === id)) return 'W';
  if (typeof id === 'string' && id.startsWith('am')) return 'M'; // 앵그리대회 남 별칭
  if (typeof id === 'string' && id.startsWith('aw')) return 'W'; // 앵그리대회 여 별칭
  return 'W';
}
function nameOf(id) {
  const m = memberOf(id);
  return m ? m.name : id;
}
// 대진표 토큰 표시명: 앵그리대회는 별칭 라벨(기본) 또는 실명(토글)
function dispName(id) {
  const res = state.result;
  if (res && res.mode === 'tournament') {
    if (state.showRealNames && res.aliasAssign) {
      const m = memberOf(res.aliasAssign[id]);
      if (m) return m.name;
    }
    const p = res.plan && res.plan.byId.get(id);
    if (p) return p.label; // 별칭 라벨 (남1, 여1…)
  }
  return nameOf(id);
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
    if (entry.mode === 'tournament') {
      payload.b.mode = 'tournament';
      // 배정된 별칭 → 실명 (제비뽑기 완료분만; 미배정이면 빈 값이라 뷰어는 별칭만 표시)
      const aliasReal = {};
      Object.entries(entry.aliasAssign || {}).forEach(([alias, mid]) => {
        const m = memberOf(mid);
        if (m) aliasReal[alias] = m.name;
      });
      payload.b.aliasReal = aliasReal;
    }
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
      const entry = {
        ts: payload.date || '공유됨',
        seed: dec.seed,
        config: dec.config,
        rounds: deepClone(payload.b.rounds),
        edited: false,
        summary: { avgDiff: '-', maxMeet: '-', partnerRepeats: '-' },
      };
      if (payload.b.mode === 'tournament') {
        entry.mode = 'tournament';
        // aliasReal(별칭→실명)을 명단에서 이름 매칭해 aliasAssign(별칭→멤버id)으로 복원
        const byName = {};
        (dec.roster ? [...dec.roster.men, ...dec.roster.women] : []).forEach((m) => (byName[m.name] = m.id));
        const assign = {};
        Object.entries(payload.b.aliasReal || {}).forEach(([alias, name]) => { if (byName[name]) assign[alias] = byName[name]; });
        entry.aliasAssign = assign;
      }
      state.history.unshift(entry);
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
    ${renderRanking()}
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
  const isTour = b.mode === 'tournament';
  const aliasReal = b.aliasReal || {};
  const hasAssign = Object.keys(aliasReal).length > 0;
  const nameV = (id) => viewerName(b, id);
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
    <button class="ghost" id="v-image">📷 이미지 저장</button>
    <button class="ghost" id="v-print">🖨 인쇄</button>
    ${isTour && hasAssign ? `<button class="ghost" id="v-nametoggle">${state.showRealNames ? '별칭 보기' : '실명 보기'}</button>` : ''}
    ${state.shareUnlocked
      ? '<button class="ghost" id="v-admin">⚙ 관리자 화면 열기</button>'
      : '<button class="ghost" id="v-unlock">🔑 관리자 모드</button>'}
  </div>`;
}

// 뷰어 표시명 (앵그리대회 실명 토글 반영)
function viewerName(b, id) {
  if (b.mode === 'tournament' && state.showRealNames && b.aliasReal && b.aliasReal[id]) return b.aliasReal[id];
  return b.names[id] ? b.names[id][0] : id;
}

// 대진표를 Canvas 2D로 직접 그려 PNG로 저장 (외부 라이브러리 없음 · PC/모바일 동작)
// spec = { rounds, isReg, name(id), date }
function renderBracketCanvas(spec) {
  const { rounds, isReg, name, date } = spec;
  const b = { rounds };
  const maxCourts = Math.max(...b.rounds.map((rd) => rd.games.length));

  const scale = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  const F_NAME = '600 15px "Malgun Gothic","Apple SD Gothic Neo",sans-serif';
  const F_VS = '700 12px sans-serif';
  const F_HEAD = '700 14px "Malgun Gothic",sans-serif';
  const F_TITLE = '700 20px "Malgun Gothic",sans-serif';
  const F_DATE = '12px "Malgun Gothic",sans-serif';
  const lineH = 22, padX = 10, padY = 8, gap = 10, margin = 16, titleH = 36, dateH = 22;

  const mctx = document.createElement('canvas').getContext('2d');
  const w = (t, f) => { mctx.font = f; return mctx.measureText(t).width; };
  const teamStr = (team) => team.map(name).join('   ');
  const vsPrefixW = w('vs  ', F_VS);

  // 열 폭 계산
  const courtW = [];
  for (let c = 0; c < maxCourts; c++) {
    let mx = w('a코트', F_HEAD);
    for (const rd of b.rounds) {
      const g = rd.games[c];
      if (!g) continue;
      mx = Math.max(mx, w(teamStr(g.teams[0]), F_NAME), vsPrefixW + w(teamStr(g.teams[1]), F_NAME));
    }
    courtW.push(Math.ceil(mx) + padX * 2);
  }
  const roundW = Math.ceil(w('9R', F_HEAD)) + padX * 2;
  const lessonHead = isReg ? 'c코트 레슨' : '대기';
  const lessonLinesOf = (rd) => {
    const ids = [...rd.lesson, ...(rd.excluded || [])];
    const lines = [];
    for (let i = 0; i < ids.length; i += 4) lines.push(ids.slice(i, i + 4));
    return lines.length ? lines : [[]];
  };
  let lessonW = w(lessonHead, F_HEAD);
  for (const rd of b.rounds) {
    for (const line of lessonLinesOf(rd)) {
      const lw = line.reduce((a, id) => a + w(name(id), F_NAME), 0) + Math.max(0, line.length - 1) * gap;
      lessonW = Math.max(lessonW, lw);
    }
  }
  lessonW = Math.ceil(lessonW) + padX * 2;

  const headH = lineH + padY * 2;
  const rowH = b.rounds.map((rd) => Math.max(2, lessonLinesOf(rd).length) * lineH + padY * 2);
  const tableW = roundW + courtW.reduce((a, x) => a + x, 0) + lessonW;
  const tableH = headH + rowH.reduce((a, x) => a + x, 0);
  const totalW = tableW + margin * 2;
  const totalH = titleH + tableH + dateH + margin * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(totalW * scale);
  canvas.height = Math.ceil(totalH * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, totalW, totalH);

  ctx.fillStyle = '#111';
  ctx.font = F_TITLE;
  ctx.textAlign = 'center';
  ctx.fillText('🎾 앵그리 테니스 클럽 대진표', totalW / 2, margin + titleH / 2);

  const x0 = margin, y0 = margin + titleH;
  const colX = [x0, x0 + roundW];
  for (let c = 0; c < maxCourts; c++) colX.push(colX[colX.length - 1] + courtW[c]);
  const lessonX = colX[colX.length - 1];
  const border = (x, y, cw, ch) => { ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, cw, ch); };
  const drawTeam = (team, x, y) => {
    let cx = x;
    ctx.font = F_NAME; ctx.fillStyle = '#111'; ctx.textAlign = 'left';
    team.forEach((id, i) => { const nm = name(id); if (i) cx += w('   ', F_NAME); ctx.fillText(nm, cx, y); cx += w(nm, F_NAME); });
  };

  // 헤더
  let cy = y0;
  ctx.fillStyle = '#f3f4f6'; ctx.fillRect(x0, cy, roundW, headH); border(x0, cy, roundW, headH);
  ctx.textAlign = 'center'; ctx.fillStyle = '#111'; ctx.font = F_HEAD;
  for (let c = 0; c < maxCourts; c++) {
    const cx = colX[1 + c];
    ctx.fillStyle = '#f3f4f6'; ctx.fillRect(cx, cy, courtW[c], headH); border(cx, cy, courtW[c], headH);
    ctx.fillStyle = '#111'; ctx.fillText('abc'[c] + '코트', cx + courtW[c] / 2, cy + headH / 2);
  }
  ctx.fillStyle = '#f3f4f6'; ctx.fillRect(lessonX, cy, lessonW, headH); border(lessonX, cy, lessonW, headH);
  ctx.fillStyle = '#111'; ctx.fillText(lessonHead, lessonX + lessonW / 2, cy + headH / 2);
  cy += headH;

  // 라운드
  b.rounds.forEach((rd, r) => {
    const rh = rowH[r];
    ctx.fillStyle = '#f9fafb'; ctx.fillRect(x0, cy, roundW, rh); border(x0, cy, roundW, rh);
    ctx.fillStyle = '#111'; ctx.font = F_HEAD; ctx.textAlign = 'center'; ctx.fillText((r + 1) + 'R', x0 + roundW / 2, cy + rh / 2);
    for (let c = 0; c < maxCourts; c++) {
      const cx = colX[1 + c];
      border(cx, cy, courtW[c], rh);
      const g = rd.games[c];
      if (!g) { ctx.fillStyle = '#c7cdd6'; ctx.font = F_NAME; ctx.textAlign = 'center'; ctx.fillText('—', cx + courtW[c] / 2, cy + rh / 2); continue; }
      const midY = cy + rh / 2;
      drawTeam(g.teams[0], cx + padX, midY - lineH / 2);
      ctx.font = F_VS; ctx.fillStyle = '#6b7280'; ctx.textAlign = 'left'; ctx.fillText('vs', cx + padX, midY + lineH / 2);
      drawTeam(g.teams[1], cx + padX + vsPrefixW, midY + lineH / 2);
    }
    border(lessonX, cy, lessonW, rh);
    const lines = lessonLinesOf(rd);
    const startY = cy + rh / 2 - (lines.length - 1) * lineH / 2;
    lines.forEach((line, li) => {
      const ly = startY + li * lineH;
      if (!line.length) { ctx.fillStyle = '#c7cdd6'; ctx.font = F_NAME; ctx.textAlign = 'left'; ctx.fillText('—', lessonX + padX, ly); return; }
      let lx = lessonX + padX;
      ctx.font = F_NAME; ctx.textAlign = 'left'; ctx.fillStyle = '#111';
      line.forEach((id) => { const nm = name(id); ctx.fillText(nm, lx, ly); lx += w(nm, F_NAME) + gap; });
    });
    cy += rh;
  });

  if (date) { ctx.fillStyle = '#6b7280'; ctx.font = F_DATE; ctx.textAlign = 'right'; ctx.fillText(date + ' 작성함', x0 + tableW, cy + dateH / 2); }
  return canvas;
}

// canvas를 PNG로 저장: 모바일은 공유 시트(사진 저장) 우선, PC는 다운로드 폴백
function saveCanvasPng(canvas, fname) {
  canvas.toBlob(async (blob) => {
    if (!blob) { toast('이미지 생성에 실패했습니다.'); return; }
    const file = new File([blob], fname, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast('대진표 이미지를 저장했습니다.');
  }, 'image/png');
}

// 뷰어(공유 링크) 대진표 이미지 저장
function saveBracketImage() {
  const p = state.share;
  if (!p || !p.b) return;
  try {
    const canvas = renderBracketCanvas({
      rounds: p.b.rounds,
      isReg: p.b.type === 'regular',
      name: (id) => viewerName(p.b, id),
      date: p.date,
    });
    saveCanvasPng(canvas, `앵그리대진표${p.date ? '_' + p.date.replace(/[^0-9]/g, '') : ''}.png`);
  } catch (e) {
    toast('이미지를 만들 수 없습니다: ' + e.message);
  }
}

// 관리자 화면 대진표 이미지 저장 (현재 표시 상태 그대로 — 앵그리대회 별칭/실명 반영)
function saveResultImage() {
  const res = state.result;
  if (!res || res.fatal) return;
  try {
    const canvas = renderBracketCanvas({
      rounds: res.rounds,
      isReg: res.type === 'regular',
      name: (id) => dispName(id),
      date: new Date().toLocaleDateString('ko-KR'),
    });
    saveCanvasPng(canvas, '앵그리대진표.png');
  } catch (e) {
    toast('이미지를 만들 수 없습니다: ' + e.message);
  }
}

function bindViewer() {
  const pr = $('#v-print');
  if (pr) pr.addEventListener('click', () => window.print());
  const img = $('#v-image');
  if (img) img.addEventListener('click', () => saveBracketImage());
  const nt = $('#v-nametoggle');
  if (nt) nt.addEventListener('click', () => { state.showRealNames = !state.showRealNames; render(); });
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

// ─── 🏆 앵그리랭킹 (앵그리대회 결과 누적 + 대회별 단일) ───
function renderRanking() {
  const results = resultStore.list();
  const open = state.ui.ranking === null ? false : state.ui.ranking;
  // 필터: 전체 누적 또는 특정 대회. 삭제 등으로 사라진 필터는 전체로
  if (state.rankFilter !== 'all' && !results.some((r) => r.id === state.rankFilter)) state.rankFilter = 'all';
  const scoped = state.rankFilter === 'all' ? results : results.filter((r) => r.id === state.rankFilter);
  const rows = computeRanking(scoped);
  const medal = (rk) => (rk === 1 ? '🥇' : rk === 2 ? '🥈' : rk === 3 ? '🥉' : rk);
  // 단일 대회 보기: 선수별 경기 스코어 로그 (예: 60 26 36 64, 이긴 게임 강조)
  const single = state.rankFilter !== 'all' && scoped.length === 1;
  const logByMember = {};
  if (single) {
    for (const g of scoped[0].games || []) {
      const a = +g.scoreA, b = +g.scoreB;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      (g.teamA || []).forEach((mid) => (logByMember[mid] || (logByMember[mid] = [])).push({ my: a, opp: b }));
      (g.teamB || []).forEach((mid) => (logByMember[mid] || (logByMember[mid] = [])).push({ my: b, opp: a }));
    }
  }
  const fmtScore = (my, opp) => (my > 9 || opp > 9 ? `${my}-${opp}` : `${my}${opp}`);
  const logCell = (mid) => (logByMember[mid] || []).map((x) => `<span class="${x.my > x.opp ? 'gwin' : 'glose'}">${fmtScore(x.my, x.opp)}</span>`).join(' ');
  const rankRows = rows
    .map((r) => `<tr>
      <td>${medal(r.rank)}</td>
      <td style="text-align:left;font-weight:700">${esc(r.name)}</td>
      <td><b>${r.points}</b></td>
      <td>${r.W}-${r.L}</td>
      <td>${r.GF}</td>
      <td>${r.GA}</td>
      <td>${r.GD > 0 ? '+' : ''}${r.GD}</td>
      <td>${r.G}</td>
      ${single ? `<td class="gamelog">${logCell(r.memberId)}</td>` : ''}
    </tr>`)
    .join('');
  // 필터 칩 (전체 누적 + 대회별)
  const chip = (val, label) => `<span class="vchip ${state.rankFilter === val ? 'on' : ''}" data-rankfilter="${val}">${esc(label)}</span>`;
  const filterChips = results.length
    ? `<div class="vrow"><span class="hint-inline">보기:</span> ${chip('all', '전체 누적')}${results.map((r) => chip(r.id, `${r.date || ''} ${r.title || '앵그리대회'}`)).join('')}</div>`
    : '';
  const eventRows = results
    .map((r) => {
      const gc = (r.games || []).filter((g) => Number.isFinite(+g.scoreA) && Number.isFinite(+g.scoreB) && +g.scoreA !== +g.scoreB).length;
      return `<div class="evrow"><span>${esc(r.date || '')} · ${esc(r.title || '앵그리대회')} <span class="hint-inline">(${r.players ? r.players.length : 0}명 · ${gc}게임)</span></span>
        <button class="mini del" data-delresult="${r.id}" title="이 대회 결과 삭제">×</button></div>`;
    })
    .join('');
  const scopeLabel = state.rankFilter === 'all' ? '전체 누적 (연말 시상)' : ((scoped[0] && ((scoped[0].date || '') + ' ' + (scoped[0].title || '앵그리대회'))) + ' — 당일 시상');
  return `
  <section class="card no-print">
    <details data-uikey="ranking" ${open ? 'open' : ''}>
      <summary class="secsum"><b>🏆 앵그리랭킹</b> <span class="hint-inline">— 승수 우선 · 득실차 · 득점 순</span></summary>
      ${results.length ? filterChips : ''}
      ${rows.length
        ? `<div class="hint-inline" style="display:block;margin:6px 0">${esc(scopeLabel)}</div>
           <table class="detail-table" style="max-width:${single ? 720 : 560}px">
             <tr><th>순위</th><th style="text-align:left">이름</th><th>종합점수</th><th>승-패</th><th>득</th><th>실</th><th>득실차</th><th>경기</th>${single ? '<th style="text-align:left">경기별(득실)</th>' : ''}</tr>
             ${rankRows}
           </table>
           <div style="margin-top:10px"><b class="hint-inline">저장된 대회</b>${eventRows}</div>`
        : '<div class="hint" style="margin-top:8px">아직 저장된 대회 결과가 없습니다. 앵그리대회 대진표에서 "📝 결과 입력"으로 스코어를 입력하고 저장하세요.</div>'}
      <div class="row" style="margin-top:10px">
        <button class="ghost mini2" id="rank-export">⬇ 백업 내보내기</button>
        <button class="ghost mini2" id="rank-import">⬆ 가져오기</button>
        <input type="file" id="rank-import-file" accept="application/json" style="display:none">
      </div>
      <div class="hint">Firebase 실시간 공유는 다음 단계에서 추가됩니다. 지금은 이 기기에 누적되며, 백업 파일로 옮길 수 있습니다.</div>
    </details>
  </section>`;
}

function renderSettings() {
  const s = state.settings;
  const isReg = s.meetingType === 'regular';
  const isTour = s.meetingType === 'tournament';
  const diffOpts = [['', '제한 없음'], ['1', '1점'], ['2', '2점'], ['3', '3점'], ['4', '4점'], ['5', '5점']]
    .map(([v, t]) => `<option value="${v}" ${String(s.maxDiff ?? '') === v ? 'selected' : ''}>${t}</option>`).join('');
  const meetOpts = [['', '제한 없음'], ['1', '1번'], ['2', '2번'], ['3', '3번'], ['4', '4번']]
    .map(([v, t]) => `<option value="${v}" ${String(s.maxMeet ?? '') === v ? 'selected' : ''}>${t}</option>`).join('');
  const minMixedOpts = [['0', '없음'], ['1', '1회'], ['2', '2회'], ['3', '3회'], ['4', '4회']]
    .map(([v, t]) => `<option value="${v}" ${String(s.minMixedGames ?? 1) === v ? 'selected' : ''}>${t}</option>`).join('');
  // 라운드 칩 개수는 실제 라운드 수에 맞춘다: 정기는 입력한 라운드 수, 게임데이는 참석자·인당 게임 수로 계산
  const roundNums = Array.from({ length: Math.max(1, estimatedRounds()) }, (_, i) => i + 1);
  const mixedChips = roundNums
    .map((n) => `<span class="xr ${(s.mixedRounds || []).includes(n) ? 'on' : ''}" data-mxr="${n}">${n}</span>`)
    .join('');
  const tightChips = roundNums
    .map((n) => `<span class="xr ${(s.tightRounds || []).includes(n) ? 'on' : ''}" data-tgr="${n}">${n}</span>`)
    .join('');
  const rankerChips = roundNums
    .map((n) => `<span class="xr ${(s.rankerRounds || []).includes(n) ? 'on' : ''}" data-rkr="${n}">${n}</span>`)
    .join('');
  return `
  <section class="card no-print">
    <h2>② 모임 설정</h2>
    <div class="row">
      <label class="radio"><input type="radio" name="mtype" value="regular" ${s.meetingType === 'regular' ? 'checked' : ''}> 정기모임 (a·b 게임 + c 레슨)</label>
      <label class="radio"><input type="radio" name="mtype" value="monthly" ${s.meetingType === 'monthly' ? 'checked' : ''}> 게임데이 (3코트 게임)</label>
      <label class="radio"><input type="radio" name="mtype" value="tournament" ${s.meetingType === 'tournament' ? 'checked' : ''}> 앵그리대회 (별칭 대진표)</label>
    </div>
    <div class="row" style="margin-top:8px">
      ${s.meetingType === 'regular'
        ? `<label>총 라운드 수 <input type="number" id="rounds" min="1" max="12" value="${s.rounds}"></label>`
        : `<label>인당 게임 수 <input type="number" id="gpp" min="1" max="10" value="${s.gamesPerPerson}"></label>`}
      ${s.meetingType === 'tournament' ? '<span class="hint-inline">참석자의 남/여 수만큼 남1·남2…/여1·여2… 별칭으로 대진표를 만들고, 현장 제비뽑기로 실제 멤버를 배정합니다.</span>' : ''}
    </div>
    <details data-uikey="adv" ${state.ui.adv ? 'open' : ''} style="margin-top:10px">
      <summary class="secsum">고급 설정 (제약 튜닝)</summary>
      <label class="adv-help-toggle"><input type="checkbox" id="adv-help" ${state.ui.advHelp ? 'checked' : ''}> 각 옵션 설명 표시</label>
      <div class="advgrid ${state.ui.advHelp ? '' : 'compact'}">
        ${!isTour ? `
        <label>게임 점수차 상한 <select id="opt-maxdiff">${diffOpts}</select></label>
        <span class="hint">한 게임의 두 팀 합산 점수 차이를 이 값 이하로 제한</span>` : ''}
        <label>같은 상대 상한 <select id="opt-maxmeet">${meetOpts}</select></label>
        <span class="hint">같은 상대와 만나는 횟수를 이 값 이하로 제한 (기본 2번)</span>
        ${!isReg ? `
        <label>인당 최소 혼복 게임 수 <select id="opt-minmixed">${minMixedOpts}</select></label>
        <span class="hint">모든 참가자가 최소 이 횟수만큼 혼복을 하도록 배정 (기본 1회, '없음'이면 미적용)</span>
        <label><input type="checkbox" id="opt-strict" ${s.strictGameCount !== false ? 'checked' : ''}> 인당 게임 수 우선</label>
        <span class="hint">전원이 목표 게임 수를 채우도록 우선 배정. 성비가 크게 치우쳐 불가피할 때만 잡복을 최소한으로 허용합니다 (끄면 잡복 없이 규칙 우선, 대신 게임 수 편차 발생 가능)</span>` : ''}
        ${isReg ? `
        <label>혼복 위주 라운드 <span style="display:inline-block;vertical-align:middle">${mixedChips}</span></label>
        <span class="hint">선택한 라운드는 혼복 위주, 나머지는 남복/여복 위주 (기본 1·3)</span>` : ''}
        ${!isTour ? `
        <label>라이벌 라운드 <span style="display:inline-block;vertical-align:middle">${tightChips}</span></label>
        <span class="hint">선택한 라운드는 비슷한 실력끼리 한 게임에 배정 — 팀은 균형 분할 (기본 1·2·3)</span>` : ''}
        ${isReg ? `
        <label>랭커 라운드 <span style="display:inline-block;vertical-align:middle">${rankerChips}</span></label>
        <span class="hint">선택한 라운드는 상위 랭커끼리 게임 — 남복/여복은 상위 5명 중 4명, 혼복(혼복 위주 라운드와 겹칠 때)은 남녀 각 상위 3명 중 2명을 매번 랜덤 선정 (기본 2)</span>` : ''}
        <label><input type="checkbox" id="opt-consec" ${s.allowConsecutiveSit ? 'checked' : ''}> 연속 결장(레슨/대기) 허용</label>
        <span class="hint">인원이 많아 연속 결장이 불가피할 때 수동으로 허용</span>
        <label><input type="checkbox" id="opt-partner" ${s.allowPartnerRepeat ? 'checked' : ''}> 파트너 중복 허용</label>
        <span class="hint">라운드가 많거나 인원이 적어 같은 파트너가 불가피할 때</span>
        <label><input type="checkbox" id="opt-nogender" ${s.ignoreGender ? 'checked' : ''}> 성별 구분 없이 편성 (잡복 허용)</label>
        <span class="hint">남녀 상관없이 실력 순위만으로 팀 구성 — 극단적 성비일 때 사용. 잡복은 허용하되 남복 팀 vs 여복 팀(남남 vs 여여) 대진은 만들지 않습니다</span>
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
  const isTour = res.mode === 'tournament';
  const assignedFull = isTour && res.aliasAssign && Object.values(res.aliasAssign).filter(Boolean).length === res.plan.byId.size;
  const scoreInput = isTour && state.scoreMode;
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
            // 실제 성별(realGender)로 유형 판정 — 성별 무시 편성에서는 gender가 가짜 'M'이라
            // realGender를 써야 혼복(파랑)/잡복(핫핑크)이 올바로 표시된다.
            const gtype = (t) => t.map((id) => { const p = res.plan.byId.get(id); return p.realGender || p.gender; }).sort().join('');
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
          // 결과 입력 모드(앵그리대회): 게임별 스코어 2칸
          let scoreHtml = '';
          if (scoreInput) {
            const sc = state.scores[r + ':' + gi] || {};
            scoreHtml = `<div class="scorein"><input type="number" min="0" max="99" inputmode="numeric" data-score="${r}:${gi}:a" value="${sc.a ?? ''}"><span>:</span><input type="number" min="0" max="99" inputmode="numeric" data-score="${r}:${gi}:b" value="${sc.b ?? ''}"></div>`;
          }
          return `<td class="gamecell">${badgeHtml}<div class="tline">${team(0)}</div><div class="tline"><span class="vs ${vsClass}">vs</span>${team(1)}</div>${scoreHtml}</td>`;
        })
        .join('') + '<td class="emptycourt">—</td>'.repeat(maxCourtsAll - rd.games.length);
      // 제외(지각/조퇴) 인원도 구분 없이 일반 이름으로 표기 (스왑 대상은 아님)
      const excludedToks = rd.excluded.map((id) => `<span class="tok" style="cursor:default">${esc(dispName(id))}</span>`).join('');
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
      return `<tr><td style="color:${genderOf(id) === 'M' ? 'var(--men)' : 'var(--women)'}">${esc(dispName(id))} <span class="preficon">${icons}</span></td><td>${s.games}</td><td>${s.mixed}</td><td>${s.sits}</td></tr>`;
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

  const modeLabel = isTour ? '앵그리대회' : isReg ? '정기모임' : '게임데이';
  const toggleBtn = isTour
    ? `<button class="ghost mini2" id="name-toggle">${state.showRealNames ? '별칭 보기' : '실명 보기'}</button>`
    : '';
  const scoreBtn = isTour
    ? `<button class="ghost mini2" id="score-toggle">${state.scoreMode ? '결과 입력 닫기' : '📝 결과 입력'}</button>`
    : '';
  const imageBtn = '<button class="ghost mini2" id="result-image">📷 이미지 저장</button>';

  return `
  <section class="card">
    <h2>${modeLabel} 대진표 ${verLabel} <span class="hint-inline">(시드 ${res.seed}${res.edited ? ' · 수동 수정됨' : ''})</span> <span class="no-print">${imageBtn} ${toggleBtn} ${scoreBtn}</span></h2>
    <div class="result-cols">
      <div class="bracket-col">
        <div class="bracket-scroll"><table class="bracket">
          <tr><th></th>${courtHeads}<th>${isReg ? 'c코트 레슨' : '대기'}</th></tr>
          ${roundsHtml}
        </table></div>
        ${legendHtml}
        ${scoreInput ? `<div class="scorebar no-print">
          ${assignedFull
            ? '<button class="primary" id="score-save">이 대회 결과 저장</button> <span class="hint-inline">각 게임의 스코어(예: 6 : 4)를 입력하고 저장하면 앵그리랭킹에 누적됩니다.</span>'
            : '<span class="hint" style="color:#b45309">먼저 아래 별칭 배정을 모두 완료해야 결과를 저장할 수 있습니다 (제비뽑기).</span>'}
        </div>` : ''}
      </div>
      ${warnHtml ? `<div class="note-side">${warnHtml}</div>` : ''}
    </div>
    ${errHtml}${relaxHtml}
    ${isTour ? renderAliasPanel() : `<div class="hint no-print">선수 이름 두 개를 차례로 누르면 자리를 맞바꿉니다 (라운드·성별 제한 없음 — 규칙에 어긋나면 경고로 알려드립니다).</div>`}
    <div class="statline">
      파트너 중복 <b>${res.stats.partnerRepeats}</b>회 ·
      같은 상대 최대 <b>${res.stats.maxMeet}</b>번${isTour ? '' : ` · 게임 점수차 평균 <b>${res.stats.scoreDiffAvg.toFixed(1)}</b> / 최대 <b>${res.stats.scoreDiffMax}</b>`}
    </div>
    <table class="detail-table" style="max-width:360px">
      <tr><th>선수</th><th>게임</th><th>혼복</th><th>${isReg ? '레슨' : '대기'}</th></tr>
      ${statRows}
    </table>
  </section>`;
}

// 앵그리대회: 별칭 → 실제 멤버 배정 패널 (참석자별 별칭 드롭다운, 동성만·이미 선택된 별칭 숨김)
function renderAliasPanel() {
  const res = state.result;
  const assign = res.aliasAssign || {}; // {aliasId: memberId}
  // 별칭 목록 (대진표에 등장한 순 = plan 순서)
  const aliases = [...res.plan.byId.keys()];
  const memberToAlias = {};
  Object.entries(assign).forEach(([alias, mid]) => { if (mid) memberToAlias[mid] = alias; });
  const takenAliases = new Set(Object.keys(assign).filter((a) => assign[a])); // 이미 누군가에게 배정된 별칭

  const pool = attendeePool();
  const row = (mid) => {
    const m = memberOf(mid);
    if (!m) return '';
    const g = genderOf(mid);
    const cur = memberToAlias[mid] || '';
    // 동성 별칭 중, 미배정이거나 자기 자신이 선택한 것만 노출 (다른 사람이 쓰는 별칭은 숨김)
    const opts = aliases
      .filter((a) => genderOf(a) === g && (!takenAliases.has(a) || a === cur))
      .map((a) => `<option value="${a}" ${a === cur ? 'selected' : ''}>${esc(res.plan.byId.get(a).label)}</option>`)
      .join('');
    return `<div class="arow">
      <span class="aname ${g === 'M' ? 'm' : 'w'}">${esc(m.name)}</span>
      <span class="aarrow">→</span>
      <select class="asel" data-assign="${mid}"><option value="">미배정</option>${opts}</select>
    </div>`;
  };
  const assignedCount = Object.values(assign).filter(Boolean).length;
  const total = pool.men.length + pool.women.length;
  return `
  <div class="alias-panel no-print">
    <div class="row" style="justify-content:space-between;align-items:center">
      <b>🎲 별칭 배정 <span class="hint-inline">(${assignedCount}/${total})</span></b>
      <span class="row" style="gap:6px">
        <button class="ghost mini2" id="alias-draw">🎲 제비뽑기</button>
        <button class="ghost mini2" id="alias-reset">초기화</button>
      </span>
    </div>
    <div class="hint">현장 제비뽑기 결과를 입력하거나, 제비뽑기 버튼으로 무작위 배정하세요. 상단 "실명 보기"로 대진표에 실제 이름이 반영됩니다.</div>
    <div class="acols">
      <div class="acol">${pool.men.map(row).join('') || '<span class="hint">남자 없음</span>'}</div>
      <div class="acol">${pool.women.map(row).join('') || '<span class="hint">여자 없음</span>'}</div>
    </div>
  </div>`;
}

function tok(id, round, loc) {
  // 기본은 무채색(검정) — 파트너 중복 팀만 성별 색으로 강조
  const dup = state._dupTeam && state._dupTeam.has(round + ':' + id) && loc.startsWith('g');
  const g = dup ? (genderOf(id) === 'M' ? 'm' : 'w') : '';
  const sel = state.swapSel && state.swapSel.round === round && state.swapSel.loc === loc;
  const swapped = state._justSwapped && state._justSwapped.has(round + ':' + id);
  const pb = state._pBadges && state._pBadges.get(round + ':' + id);
  return `<span class="tok ${g} ${sel ? 'sel' : ''} ${swapped ? 'swapped' : ''}" data-tok="${id}" data-round="${round}" data-loc="${loc}">${esc(dispName(id))}${pb ? `<sup class="vbadge">${pb}</sup>` : ''}</span>`;
}

// ─── 이벤트 바인딩 ───
function bindAll() {
  // details 접힘 상태 기억 (재렌더링 시 유지)
  document.querySelectorAll('details[data-uikey]').forEach((el) =>
    el.addEventListener('toggle', () => { state.ui[el.dataset.uikey] = el.open; })
  );
  bindRoster();
  bindRanking();
  bindSettings();
  bindAttendance();
  bindActions();
  bindResult();
}

function bindRanking() {
  document.querySelectorAll('[data-rankfilter]').forEach((el) =>
    el.addEventListener('click', () => { state.rankFilter = el.dataset.rankfilter; render(); })
  );
  document.querySelectorAll('[data-delresult]').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.delresult;
      const r = resultStore.get(id);
      if (!confirm(`${r ? (r.date || '') + ' ' : ''}대회 결과를 삭제할까요? 랭킹에서 빠집니다.`)) return;
      resultStore.remove(id);
      render();
    })
  );
  const exp = $('#rank-export');
  if (exp) exp.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(resultStore.list(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'angry-results-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast('결과 백업을 내보냈습니다.');
  });
  const imp = $('#rank-import');
  const impFile = $('#rank-import-file');
  if (imp && impFile) {
    imp.addEventListener('click', () => impFile.click());
    impFile.addEventListener('change', async () => {
      const f = impFile.files && impFile.files[0];
      if (!f) return;
      try {
        const arr = JSON.parse(await f.text());
        if (!Array.isArray(arr)) throw new Error('형식 오류');
        const cur = resultStore.list();
        const byId = new Map(cur.map((r) => [r.id, r]));
        arr.forEach((r) => { if (r && r.id) byId.set(r.id, r); }); // id 기준 병합(가져온 값 우선)
        resultStore._save([...byId.values()]);
        toast(`결과 ${arr.length}건을 가져왔습니다.`);
        render();
      } catch (e) {
        toast('가져오기 실패: ' + e.message);
      }
    });
  }
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
  const minmx = $('#opt-minmixed');
  if (minmx) minmx.addEventListener('change', () => { state.settings.minMixedGames = +minmx.value; persistAll(); });
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
  roundListToggle('rkr', 'rankerRounds');
  const chk = (id, key) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { state.settings[key] = el.checked; persistAll(); });
  };
  chk('#opt-consec', 'allowConsecutiveSit');
  chk('#opt-partner', 'allowPartnerRepeat');
  chk('#opt-nogender', 'ignoreGender');
  chk('#opt-strict', 'strictGameCount');

  const advHelp = $('#adv-help');
  if (advHelp) advHelp.addEventListener('change', () => { state.ui.advHelp = advHelp.checked; render(); });

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

  const nameToggle = $('#name-toggle');
  if (nameToggle) nameToggle.addEventListener('click', () => { state.showRealNames = !state.showRealNames; render(); });

  const resultImage = $('#result-image');
  if (resultImage) resultImage.addEventListener('click', () => saveResultImage());

  // 별칭 배정 드롭다운 (참석자 → 별칭)
  document.querySelectorAll('[data-assign]').forEach((el) =>
    el.addEventListener('change', () => {
      const mid = el.dataset.assign;
      const alias = el.value;
      const assign = state.result.aliasAssign || (state.result.aliasAssign = {});
      // 이 멤버의 기존 별칭 해제
      for (const [a, m] of Object.entries(assign)) if (m === mid) delete assign[a];
      // 새 별칭에 배정 (해당 별칭의 기존 배정도 해제 — 안전장치)
      if (alias) assign[alias] = mid;
      syncCurrentVersion(false);
      render();
    })
  );

  const draw = $('#alias-draw');
  if (draw) draw.addEventListener('click', () => drawLots());
  const reset = $('#alias-reset');
  if (reset) reset.addEventListener('click', () => {
    state.result.aliasAssign = {};
    syncCurrentVersion(false);
    render();
  });

  // 결과 입력
  const scoreToggle = $('#score-toggle');
  if (scoreToggle) scoreToggle.addEventListener('click', () => {
    state.scoreMode = !state.scoreMode;
    if (state.scoreMode) state.scores = loadScoresFromEntry();
    render();
  });
  document.querySelectorAll('[data-score]').forEach((el) =>
    el.addEventListener('input', () => {
      const [r, gi, side] = el.dataset.score.split(':');
      const key = r + ':' + gi;
      const cur = state.scores[key] || (state.scores[key] = {});
      const v = el.value === '' ? undefined : Math.max(0, Math.min(99, +el.value || 0));
      cur[side] = v;
      // 현재 버전 스냅샷에 입력값 보관(재편집 대비)
      const entry = state.history[state.currentIdx];
      if (entry) { entry.scores = state.scores; persistAll(); }
    })
  );
  const scoreSave = $('#score-save');
  if (scoreSave) scoreSave.addEventListener('click', () => saveTournamentResult());
}

function loadScoresFromEntry() {
  const entry = state.history[state.currentIdx];
  return entry && entry.scores ? deepClone(entry.scores) : {};
}

// 앵그리대회 결과 저장: 별칭→실명 확정, 게임 스코어 검증 후 resultStore에 누적
function saveTournamentResult() {
  const res = state.result;
  const assign = res.aliasAssign || {};
  const memberOfAlias = (aliasId) => assign[aliasId];
  const games = [];
  let missing = 0, tie = 0;
  res.rounds.forEach((rd, r) => {
    rd.games.forEach((g, gi) => {
      const sc = state.scores[r + ':' + gi] || {};
      const a = sc.a, b = sc.b;
      const teamA = g.teams[0].map(memberOfAlias);
      const teamB = g.teams[1].map(memberOfAlias);
      if (a == null || b == null) { missing++; return; }
      if (a === b) { tie++; }
      games.push({ round: r, court: g.court, teamA, teamB, scoreA: a, scoreB: b });
    });
  });
  if (games.length === 0) { toast('입력된 게임 스코어가 없습니다.'); return; }
  if (tie > 0) { toast(`동점 게임이 ${tie}개 있습니다. 승패가 갈리도록 수정하세요.`); return; }
  if (missing > 0 && !confirm(`스코어가 비어 있는 게임 ${missing}개는 제외하고 저장합니다. 계속할까요?`)) return;

  const players = [...new Set(Object.values(assign).filter(Boolean))].map((mid) => ({ memberId: mid, name: (memberOf(mid) || {}).name || mid }));
  const entry = state.history[state.currentIdx];
  const id = (entry && entry.resultId) || uid();
  const date = new Date().toLocaleDateString('ko-KR');
  resultStore.add({ id, date, mode: 'tournament', title: '앵그리대회', players, games });
  if (entry) { entry.resultId = id; entry.scores = state.scores; persistAll(); }
  state.ui.ranking = true;
  toast('대회 결과를 저장했습니다. 앵그리랭킹에 반영됩니다.');
  render();
}

// 제비뽑기: 성별 내 참석자를 섞어 별칭에 순서대로 배정
function drawLots() {
  const res = state.result;
  const aliases = [...res.plan.byId.keys()];
  const menAliases = aliases.filter((a) => genderOf(a) === 'M');
  const womenAliases = aliases.filter((a) => genderOf(a) === 'W');
  const pool = attendeePool();
  const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const assign = {};
  shuffle(pool.men).forEach((mid, i) => { if (menAliases[i]) assign[menAliases[i]] = mid; });
  shuffle(pool.women).forEach((mid, i) => { if (womenAliases[i]) assign[womenAliases[i]] = mid; });
  res.aliasAssign = assign;
  syncCurrentVersion(false);
  render();
}

// ─── 생성·버전·수동 편집 ───
// 참석자 중 남/여 실제 멤버 id 목록 (명단 순서 유지)
function attendeePool() {
  const men = state.roster.men.filter((m) => state.attend.selectedIds.includes(m.id)).map((m) => m.id);
  const women = state.roster.women.filter((m) => state.attend.selectedIds.includes(m.id)).map((m) => m.id);
  return { men, women };
}

function buildConfig(seed) {
  const s = state.settings;
  if (s.meetingType === 'tournament') {
    // 앵그리대회: 동등 점수 별칭 선수(남1.., 여1..)로 게임데이(monthly) 대진표 생성
    const pool = attendeePool();
    const players = [];
    pool.men.forEach((_, i) => players.push({ id: `am${i + 1}`, name: `남${i + 1}`, gender: 'M', score: 1 }));
    pool.women.forEach((_, i) => players.push({ id: `aw${i + 1}`, name: `여${i + 1}`, gender: 'W', score: 1 }));
    return {
      type: 'monthly',
      gamesPerPerson: s.gamesPerPerson,
      players,
      options: {
        maxDiff: null, // 별칭엔 랭킹 없음 → 점수차 상한 미적용
        maxMeet: s.maxMeet,
        minMixedGames: s.minMixedGames,
        tightRounds: [], // 라이벌 라운드 미적용
        mixedRounds: [],
        rankerRounds: [],
        allowConsecutiveSit: s.allowConsecutiveSit,
        allowPartnerRepeat: s.allowPartnerRepeat,
        ignoreGender: s.ignoreGender,
        strictGameCount: s.strictGameCount !== false,
      },
      seed,
    };
  }

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
  return {
    type: s.meetingType,
    rounds: s.rounds,
    gamesPerPerson: s.gamesPerPerson,
    players,
    options: {
      maxDiff: s.maxDiff,
      maxMeet: s.maxMeet,
      minMixedGames: s.minMixedGames,
      tightRounds: s.tightRounds,
      mixedRounds: s.mixedRounds,
      rankerRounds: s.rankerRounds,
      allowConsecutiveSit: s.allowConsecutiveSit,
      allowPartnerRepeat: s.allowPartnerRepeat,
      ignoreGender: s.ignoreGender,
      strictGameCount: s.strictGameCount !== false,
    },
    seed,
  };
}

function generate() {
  const config = buildConfig(Math.floor(Math.random() * 1e9));
  state.swapSel = null;
  state.undoStack = [];
  state.redoStack = [];
  const isTournament = state.settings.meetingType === 'tournament';
  try {
    const res = generateSchedule(config);
    res.edited = false;
    res.mode = state.settings.meetingType;
    res.aliasAssign = {};
    state.result = res;
    state.showRealNames = false;
    state.scoreMode = false;
    state.scores = {};
    const entry = {
      ts: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
      seed: res.seed,
      // 완화(성별 무시 등)가 반영된 유효 옵션으로 저장 — 복원 시 같은 plan을 재구성할 수 있게 한다
      config: { ...config, options: { ...res.plan.options } },
      rounds: deepClone(res.rounds),
      edited: false,
      mode: state.settings.meetingType,
      aliasAssign: isTournament ? {} : undefined,
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

// 저장된 버전의 plan 재구성 — 이미 확정된 대진표를 표시만 하므로,
// 옛 버전에서 완화(성별 무시 등)가 config에 없어 패리티 검사에 막히거나
// 잡복이 오류로 표시되는 경우 완화 옵션으로 재구성한다.
function planForEntry(entry) {
  const relaxed = () => buildPlan({
    ...entry.config,
    options: { ...(entry.config.options || {}), ignoreGender: true, allowConsecutiveSit: true, allowPartnerRepeat: true, minMixedGames: 0 },
  });
  let plan;
  try {
    plan = buildPlan(entry.config);
  } catch (e) {
    return relaxed();
  }
  // 확정된 대진표에 잡복이 있는데 plan이 성별 구분 모드면 잡복이 오류로 잡히므로 완화 재구성
  const teamType = (team) => team.map((id) => (plan.byId.has(id) ? plan.byId.get(id).gender : '?')).sort().join('');
  const hasJapbok = entry.rounds.some((rd) => rd.games.some((g) => g.teams && teamType(g.teams[0]) !== teamType(g.teams[1])));
  if (hasJapbok && !plan.options.ignoreGender) return relaxed();
  return plan;
}

function viewVersion(i) {
  const entry = state.history[i];
  if (!entry) return;
  try {
    const plan = planForEntry(entry);
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
      mode: entry.mode || (plan.type === 'regular' ? 'regular' : 'monthly'),
      aliasAssign: entry.aliasAssign ? deepClone(entry.aliasAssign) : {},
    };
    state.currentIdx = i;
    state.swapSel = null;
    state.showRealNames = false;
    state.scoreMode = false;
    state.scores = {};
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

function syncCurrentVersion(markEdited = true) {
  const entry = state.history[state.currentIdx];
  if (!entry) return;
  entry.rounds = deepClone(state.result.rounds);
  if (state.result.aliasAssign) entry.aliasAssign = deepClone(state.result.aliasAssign);
  if (markEdited) entry.edited = true;
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
