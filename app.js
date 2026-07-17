// 앵그리 테니스 클럽 대진표 — UI
import { generateSchedule, validateSchedule, SchedulerError } from './engine/scheduler.js';

const MEN = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const WOMEN = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const STORE_KEY = 'angry-bracket-setup-v1';

const state = {
  meetingType: 'regular', // 'regular' | 'monthly'
  rounds: 5,
  gamesPerPerson: 4,
  selected: {}, // id → {gamePriority, newMember, mixedPreferred}
  exclusions: {}, // id → [1-based round…]
  result: null,
  seed: null,
  edited: false,
  swapSel: null, // {round, loc, id}
};

// ─── 유틸 ───
const $ = (sel) => document.querySelector(sel);
const genderOf = (id) => (MEN.includes(id) ? 'M' : 'W');
const labelOf = (id) => (genderOf(id) === 'M' ? '남' : '여') + id;
const scoreOf = (id) => (genderOf(id) === 'M' ? Number(id) : id.charCodeAt(0) - 64);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function saveSetup() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        meetingType: state.meetingType,
        rounds: state.rounds,
        gamesPerPerson: state.gamesPerPerson,
        selected: state.selected,
        exclusions: state.exclusions,
      })
    );
  } catch (e) { /* 저장 실패는 무시 */ }
}

function loadSetup() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.meetingType) state.meetingType = d.meetingType;
    if (d.rounds) state.rounds = d.rounds;
    if (d.gamesPerPerson) state.gamesPerPerson = d.gamesPerPerson;
    if (d.selected) state.selected = d.selected;
    if (d.exclusions) state.exclusions = d.exclusions;
  } catch (e) { /* 무시 */ }
}

function estimatedRounds() {
  if (state.meetingType === 'regular') return Math.max(1, Math.min(12, state.rounds));
  const N = Object.keys(state.selected).length;
  if (N < 8) return state.gamesPerPerson + 1;
  const T = Math.ceil((N * state.gamesPerPerson) / 4);
  return Math.ceil(T / (N >= 12 ? 3 : 2));
}

// ─── 렌더링 ───
function render() {
  $('#app').innerHTML = `
    <h1>🎾 앵그리 테니스 클럽 대진표</h1>
    ${renderSetup()}
    ${renderResult()}
  `;
  bindSetup();
  bindResult();
}

function renderSetup() {
  const menChips = MEN.map((id) => chip(id)).join('');
  const womenChips = WOMEN.map((id) => chip(id)).join('');
  const selectedIds = [...MEN, ...WOMEN].filter((id) => state.selected[id]);
  const N = selectedIds.length;
  const M = selectedIds.filter((id) => genderOf(id) === 'M').length;

  return `
  <section class="card no-print">
    <h2>1. 모임 설정</h2>
    <div class="row">
      <label class="radio"><input type="radio" name="mtype" value="regular" ${state.meetingType === 'regular' ? 'checked' : ''}> 정기모임 (a·b 게임 + c 레슨)</label>
      <label class="radio"><input type="radio" name="mtype" value="monthly" ${state.meetingType === 'monthly' ? 'checked' : ''}> 월례대회 (3코트 게임)</label>
    </div>
    <div class="row" style="margin-top:8px">
      ${state.meetingType === 'regular'
        ? `<label>총 라운드 수 <input type="number" id="rounds" min="1" max="12" value="${state.rounds}"></label>`
        : `<label>인당 게임 수 <input type="number" id="gpp" min="1" max="10" value="${state.gamesPerPerson}"></label>`}
    </div>
  </section>
  <section class="card no-print">
    <h2>2. 참석자 선택 <span style="font-weight:400;color:var(--muted);font-size:0.85rem">— 남 ${M}명, 여 ${N - M}명, 총 ${N}명</span></h2>
    <div class="chips">${menChips}</div>
    <div class="chips">${womenChips}</div>
    ${N > 0 ? renderDetail(selectedIds) : '<div class="hint">번호를 눌러 오늘 참석자를 선택하세요. 번호가 빠를수록(1, A) 실력이 높습니다.</div>'}
  </section>
  <section class="card no-print">
    <div class="row">
      <button class="primary" id="gen">대진표 생성</button>
      ${state.result ? '<button class="ghost" id="regen">🔀 다시 섞기</button>' : ''}
      ${state.result ? '<button class="ghost" id="print">🖨 인쇄</button>' : ''}
    </div>
    <div class="hint">같은 구성이라도 "다시 섞기"를 누르면 다른 대진이 나옵니다.</div>
  </section>`;
}

function chip(id) {
  const on = !!state.selected[id];
  const g = genderOf(id) === 'M' ? 'm' : 'w';
  return `<span class="chip ${g} ${on ? 'on' : ''}" data-chip="${id}">${labelOf(id)}</span>`;
}

function renderDetail(ids) {
  const R = estimatedRounds();
  const rows = ids
    .map((id) => {
      const p = state.selected[id];
      const ex = state.exclusions[id] || [];
      const xr = Array.from({ length: R }, (_, i) => i + 1)
        .map((r) => `<span class="xr ${ex.includes(r) ? 'on' : ''}" data-xr="${id}:${r}">${r}</span>`)
        .join('');
      return `<tr>
        <td class="${genderOf(id) === 'M' ? 'm' : 'w'}" style="color:${genderOf(id) === 'M' ? 'var(--men)' : 'var(--women)'}">${labelOf(id)}</td>
        <td><input type="checkbox" data-pref="${id}:gamePriority" ${p.gamePriority ? 'checked' : ''}></td>
        <td><input type="checkbox" data-pref="${id}:newMember" ${p.newMember ? 'checked' : ''}></td>
        <td><input type="checkbox" data-pref="${id}:mixedPreferred" ${p.mixedPreferred ? 'checked' : ''}></td>
        <td style="text-align:left">${xr}</td>
      </tr>`;
    })
    .join('');
  return `
  <details ${Object.values(state.selected).some((p) => p.gamePriority || p.newMember || p.mixedPreferred) || Object.keys(state.exclusions).length ? 'open' : ''}>
    <summary style="cursor:pointer;font-size:0.9rem;color:var(--muted)">개인 특성·라운드 제외 설정</summary>
    <table class="detail-table" style="margin-top:8px">
      <tr><th>선수</th><th>게임선호⚡</th><th>신규회원🔰</th><th>혼복선호💞</th><th style="text-align:left">제외 라운드 (지각/조퇴)</th></tr>
      ${rows}
    </table>
    <div class="hint">게임선호: 레슨/대기 배정 최소화 · 신규회원: 레슨 우선 + 상위 실력자와 매칭 · 혼복선호: 혼복 우선 배정(정기모임)</div>
  </details>`;
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
      const gameRows = rd.games
        .map((g, gi) => {
          const sum = (t) => t.reduce((a, id) => a + scoreOf(id), 0);
          const diff = Math.abs(sum(g.teams[0]) - sum(g.teams[1]));
          const team = (ti) => g.teams[ti].map((id, si) => tok(id, r, `g:${gi}:${ti}:${si}`)).join('');
          return `<td>
            <span class="gtype ${g.type}">${{ MM: '남복', WW: '여복', MX: '혼복' }[g.type]}</span>
            ${team(0)}<span class="vs">vs</span>${team(1)}
            <span class="diffbadge">점수차 ${diff}</span>
          </td>`;
        })
        .join('');
      const lessonToks = rd.lesson.map((id, li) => tok(id, r, `l:${li}`)).join('') || '<span class="lessonlabel">—</span>';
      const excludedTxt = rd.excluded.length
        ? `<div style="margin-top:3px"><span class="lessonlabel">불참: ${rd.excluded.map(labelOf).join(', ')}</span></div>`
        : '';
      return `<tr>
        <td class="roundcell">${r + 1}R</td>
        ${gameRows}
        <td>${lessonToks}${excludedTxt}</td>
      </tr>`;
    })
    .join('');

  const maxCourts = Math.max(...res.rounds.map((rd) => rd.games.length));
  const courtHeads = Array.from({ length: maxCourts }, (_, i) => `<th>${'abc'[i]}코트</th>`).join('');

  // 인원별 통계
  const statRows = [...res.stats.perPlayer.entries()]
    .filter(([id, s]) => s.games + s.sits > 0)
    .map(([id, s]) => {
      const prefs = state.selected[id] || {};
      const icons = `${prefs.gamePriority ? '⚡' : ''}${prefs.newMember ? '🔰' : ''}${prefs.mixedPreferred ? '💞' : ''}`;
      return `<tr><td>${labelOf(id)} <span class="preficon">${icons}</span></td><td>${s.games}</td><td>${s.mixed}</td><td>${s.sits}</td></tr>`;
    })
    .join('');

  return `
  <section class="card">
    <h2>${isReg ? '정기모임' : '월례대회'} 대진표 <span style="font-weight:400;color:var(--muted);font-size:0.8rem">(시드 ${res.seed}${state.edited ? ' · 수동 수정됨' : ''})</span></h2>
    ${banners.join('')}
    <table class="bracket">
      <tr><th></th>${courtHeads}<th>${isReg ? 'c코트 레슨' : '대기'}</th></tr>
      ${roundsHtml}
    </table>
    <div class="hint no-print">선수 이름을 두 번(바꿀 두 사람) 누르면 자리를 맞바꿉니다. 같은 라운드, 같은 성별끼리만 가능합니다.</div>
    <div class="statline">
      파트너 중복 <b>${res.stats.partnerRepeats}</b>회 ·
      같은 상대 최대 <b>${res.stats.maxMeet}</b>번 ·
      게임 점수차 평균 <b>${res.stats.scoreDiffAvg.toFixed(1)}</b> / 최대 <b>${res.stats.scoreDiffMax}</b>
    </div>
    <table class="detail-table" style="max-width:340px">
      <tr><th>선수</th><th>게임</th><th>혼복</th><th>${isReg ? '레슨' : '대기'}</th></tr>
      ${statRows}
    </table>
  </section>`;
}

function tok(id, round, loc) {
  const g = genderOf(id) === 'M' ? 'm' : 'w';
  const sel = state.swapSel && state.swapSel.round === round && state.swapSel.loc === loc;
  return `<span class="tok ${g} ${sel ? 'sel' : ''}" data-tok="${id}" data-round="${round}" data-loc="${loc}">${labelOf(id)}</span>`;
}

// ─── 이벤트 바인딩 ───
function bindSetup() {
  document.querySelectorAll('input[name="mtype"]').forEach((el) =>
    el.addEventListener('change', () => {
      state.meetingType = el.value;
      saveSetup();
      render();
    })
  );
  const rounds = $('#rounds');
  if (rounds) rounds.addEventListener('change', () => { state.rounds = Math.max(1, Math.min(12, +rounds.value || 5)); saveSetup(); render(); });
  const gpp = $('#gpp');
  if (gpp) gpp.addEventListener('change', () => { state.gamesPerPerson = Math.max(1, Math.min(10, +gpp.value || 4)); saveSetup(); render(); });

  document.querySelectorAll('[data-chip]').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.chip;
      if (state.selected[id]) {
        delete state.selected[id];
        delete state.exclusions[id];
      } else {
        state.selected[id] = { gamePriority: false, newMember: false, mixedPreferred: false };
      }
      saveSetup();
      render();
    })
  );

  document.querySelectorAll('[data-pref]').forEach((el) =>
    el.addEventListener('change', () => {
      const [id, key] = el.dataset.pref.split(':');
      state.selected[id][key] = el.checked;
      saveSetup();
    })
  );

  document.querySelectorAll('[data-xr]').forEach((el) =>
    el.addEventListener('click', () => {
      const [id, rStr] = el.dataset.xr.split(':');
      const r = +rStr;
      const list = state.exclusions[id] || [];
      state.exclusions[id] = list.includes(r) ? list.filter((x) => x !== r) : [...list, r];
      if (!state.exclusions[id].length) delete state.exclusions[id];
      saveSetup();
      render();
    })
  );

  const gen = $('#gen');
  if (gen) gen.addEventListener('click', () => generate());
  const regen = $('#regen');
  if (regen) regen.addEventListener('click', () => generate());
  const print = $('#print');
  if (print) print.addEventListener('click', () => window.print());
}

function bindResult() {
  document.querySelectorAll('[data-tok]').forEach((el) => el.addEventListener('click', () => onTokenClick(el)));
}

// ─── 생성·수동 편집 ───
function generate() {
  const players = [...MEN, ...WOMEN]
    .filter((id) => state.selected[id])
    .map((id) => ({
      id,
      prefs: state.selected[id],
      unavailableRounds: state.exclusions[id] || [],
    }));
  const config = {
    type: state.meetingType,
    rounds: state.rounds,
    gamesPerPerson: state.gamesPerPerson,
    players,
    seed: Math.floor(Math.random() * 1e9),
  };
  state.swapSel = null;
  state.edited = false;
  try {
    state.result = generateSchedule(config);
    state.seed = state.result.seed;
  } catch (e) {
    if (e instanceof SchedulerError) {
      state.result = { fatal: { message: e.message, suggestions: e.suggestions } };
    } else {
      state.result = { fatal: { message: '예상치 못한 오류: ' + e.message, suggestions: [] } };
    }
  }
  render();
  const card = document.querySelectorAll('section.card');
  if (card.length) card[card.length - 1].scrollIntoView({ behavior: 'smooth' });
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
  if (state.swapSel.round !== round) {
    toast('같은 라운드 안에서만 맞바꿀 수 있어요.');
    state.swapSel = null;
    render();
    return;
  }
  if (genderOf(state.swapSel.id) !== genderOf(id)) {
    toast('같은 성별끼리만 맞바꿀 수 있어요 (잡복 방지).');
    state.swapSel = null;
    render();
    return;
  }
  applySwap(round, state.swapSel.loc, loc);
  state.swapSel = null;
  state.edited = true;
  revalidate();
  render();
}

function locRef(rd, loc) {
  const parts = loc.split(':');
  if (parts[0] === 'g') {
    const [, gi, ti, si] = parts.map(Number);
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

function applySwap(r, locA, locB) {
  const rd = state.result.rounds[r];
  const a = locRef(rd, locA);
  const b = locRef(rd, locB);
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

// ─── 시작 ───
loadSetup();
render();
