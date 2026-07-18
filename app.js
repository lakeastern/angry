// 앵그리 테니스 클럽 대진표 — UI v2 (실명 명단·설정 튜닝·버전 히스토리)
import { generateSchedule, validateSchedule, SchedulerError } from './engine/scheduler.js';
import { buildPlan } from './engine/planner.js';

const K_ROSTER = 'angry-roster-v2';
const K_SETTINGS = 'angry-settings-v2';
const K_ATTEND = 'angry-attend-v2';
const K_HISTORY = 'angry-history-v2';

const state = {
  roster: { men: [], women: [] }, // {id, name, prefs:{gamePriority,newMember,mixedPreferred}, presetExclude:[], guest}
  settings: {
    meetingType: 'regular',
    rounds: 5,
    gamesPerPerson: 4,
    maxDiff: null,
    tightRounds: 3,
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
  const tightOpts = [0, 1, 2, 3, 4, 5]
    .map((v) => `<option value="${v}" ${s.tightRounds === v ? 'selected' : ''}>${v === 0 ? '끄기' : v + '라운드'}</option>`).join('');
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
        <label>초반 빡겜 라운드 <select id="opt-tight">${tightOpts}</select></label>
        <span class="hint">초반 라운드는 비슷한 실력끼리 한 게임에 배정 (팀은 균형 분할)</span>
        <label><input type="checkbox" id="opt-consec" ${s.allowConsecutiveSit ? 'checked' : ''}> 연속 결장(레슨/대기) 허용</label>
        <span class="hint">인원이 많아 연속 결장이 불가피할 때 수동으로 허용</span>
        <label><input type="checkbox" id="opt-partner" ${s.allowPartnerRepeat ? 'checked' : ''}> 파트너 중복 허용</label>
        <span class="hint">라운드가 많거나 인원이 적어 같은 파트너가 불가피할 때</span>
        <label><input type="checkbox" id="opt-nogender" ${s.ignoreGender ? 'checked' : ''}> 성별 구분 없이 편성 (잡복 허용)</label>
        <span class="hint">남녀 상관없이 실력 순위만으로 팀 구성 — 극단적 성비일 때 사용</span>
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
      ${state.result && !state.result.fatal ? '<button class="ghost" id="regen">🔀 다시 섞기</button>' : ''}
      ${state.result && !state.result.fatal ? '<button class="ghost" id="print">🖨 인쇄</button>' : ''}
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

  const banners = [];
  if (res.errors.length) {
    banners.push(`<div class="banner error"><b>규칙 위반 ${res.errors.length}건</b><ul>${res.errors.map((e) => `<li>${esc(e.message)}</li>`).join('')}</ul></div>`);
  }
  if (res.relaxationsApplied.length) {
    banners.push(`<div class="banner info"><b>자동 완화 적용</b><ul>${res.relaxationsApplied.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`);
  }
  if (res.warnings.length) {
    banners.push(`<div class="banner warn"><b>참고</b><ul>${res.warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></div>`);
  }

  const isReg = res.type === 'regular';
  const roundsHtml = res.rounds
    .map((rd, r) => {
      const gameCells = rd.games
        .map((g, gi) => {
          const team = (ti) => `<span class="team">${g.teams[ti].map((id, si) => tok(id, r, `g:${gi}:${ti}:${si}`)).join('')}</span>`;
          return `<td>${team(0)}<span class="vs">vs</span>${team(1)}</td>`;
        })
        .join('');
      const lessonToks = rd.lesson.map((id, li) => tok(id, r, `l:${li}`)).join('') || '<span class="lessonlabel">—</span>';
      const excludedTxt = rd.excluded.length
        ? `<div style="margin-top:3px"><span class="lessonlabel">불참: ${rd.excluded.map((id) => esc(nameOf(id))).join(', ')}</span></div>`
        : '';
      return `<tr>
        <td class="roundcell">${r + 1}R</td>
        ${gameCells}
        <td>${lessonToks}${excludedTxt}</td>
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

  return `
  <section class="card">
    <h2>${isReg ? '정기모임' : '월례대회'} 대진표 ${verLabel} <span class="hint-inline">(시드 ${res.seed}${res.edited ? ' · 수동 수정됨' : ''})</span></h2>
    ${banners.join('')}
    <table class="bracket">
      <tr><th></th>${courtHeads}<th>${isReg ? 'c코트 레슨' : '대기'}</th></tr>
      ${roundsHtml}
    </table>
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
  const g = genderOf(id) === 'M' ? 'm' : 'w';
  const sel = state.swapSel && state.swapSel.round === round && state.swapSel.loc === loc;
  return `<span class="tok ${g} ${sel ? 'sel' : ''}" data-tok="${id}" data-round="${round}" data-loc="${loc}">${esc(nameOf(id))}</span>`;
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
  const tt = $('#opt-tight');
  if (tt) tt.addEventListener('change', () => { state.settings.tightRounds = +tt.value; persistAll(); });
  const chk = (id, key) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { state.settings[key] = el.checked; persistAll(); });
  };
  chk('#opt-consec', 'allowConsecutiveSit');
  chk('#opt-partner', 'allowPartnerRepeat');
  chk('#opt-nogender', 'ignoreGender');
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
  const regen = $('#regen');
  if (regen) regen.addEventListener('click', () => generate());
  const print = $('#print');
  if (print) print.addEventListener('click', () => window.print());
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
      tightRounds: s.tightRounds,
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
  applySwap(state.swapSel, { round, loc });
  state.swapSel = null;
  if (state.result) state.result.edited = true;
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
function init() {
  state.roster = load(K_ROSTER, state.roster);
  state.settings = Object.assign({}, state.settings, load(K_SETTINGS, {}));
  state.attend = Object.assign({ selectedIds: [], excludeOverrides: {} }, load(K_ATTEND, {}));
  state.history = load(K_HISTORY, []);
  // 명단에서 삭제된 인원이 참석 목록에 남아있지 않도록 정리
  state.attend.selectedIds = state.attend.selectedIds.filter((id) => memberOf(id));
  render();
}
init();
