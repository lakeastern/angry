// Phase A: 설정 정규화, 라운드/코트 계획, 실현 가능성 사전 검사.

export class SchedulerError extends Error {
  constructor(message, suggestions = []) {
    super(message);
    this.name = 'SchedulerError';
    this.suggestions = suggestions;
  }
}

const MEN_IDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const WOMEN_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

// 입력 형식: { id: '1'~'9' | 'A'~'I', prefs?: {gamePriority, newMember, mixedPreferred}, unavailableRounds?: [1-based...] }
export function normalizePlayer(raw) {
  const id = String(raw.id).toUpperCase();
  let gender, score;
  if (MEN_IDS.includes(id)) {
    gender = 'M';
    score = Number(id);
  } else if (WOMEN_IDS.includes(id)) {
    gender = 'W';
    score = id.charCodeAt(0) - 64; // A=1 … I=9
  } else {
    throw new SchedulerError(`알 수 없는 선수 번호입니다: ${raw.id} (남자 1~9, 여자 A~I)`);
  }
  return {
    id,
    gender,
    score,
    label: (gender === 'M' ? '남' : '여') + id,
    prefs: {
      gamePriority: !!(raw.prefs && raw.prefs.gamePriority),
      newMember: !!(raw.prefs && raw.prefs.newMember),
      mixedPreferred: !!(raw.prefs && raw.prefs.mixedPreferred),
    },
    unavailable: new Set((raw.unavailableRounds || []).map((n) => n - 1)), // 내부는 0-based
  };
}

// 라운드에 유효한 (남복 a, 여복 b, 혼복 c) 구성이 존재하는지: m=4a+2c ≤ availM, w=4b+2c ≤ availW
export function enumerateCompositions(courtCount, availM, availW) {
  const comps = [];
  for (let c = 0; c <= courtCount; c++) {
    for (let a = 0; a <= courtCount - c; a++) {
      const b = courtCount - c - a;
      const m = 4 * a + 2 * c;
      const w = 4 * b + 2 * c;
      if (m <= availM && w <= availW) comps.push({ a, b, c, m, w });
    }
  }
  return comps;
}

export function buildPlan(config) {
  const type = config.type === 'monthly' ? 'monthly' : 'regular';
  if (!Array.isArray(config.players) || config.players.length === 0) {
    throw new SchedulerError('참석자 목록이 비어 있습니다.');
  }

  const players = config.players.map(normalizePlayer);
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) throw new SchedulerError('참석자 번호가 중복되었습니다.');

  const men = players.filter((p) => p.gender === 'M');
  const women = players.filter((p) => p.gender === 'W');
  const N = players.length;
  const M = men.length;
  const W = women.length;

  if (N < 8) {
    throw new SchedulerError(`참석 인원이 ${N}명입니다. 2코트 게임을 위해 최소 8명이 필요합니다.`, [
      '인원을 8명 이상으로 늘리거나, 8명 미만 모임은 수동으로 진행하세요.',
    ]);
  }
  if (N > 18) {
    throw new SchedulerError(`참석 인원이 ${N}명입니다. 현재 버전은 최대 18명까지 지원합니다.`);
  }
  if (M === 1) {
    throw new SchedulerError('남자가 1명이면 어떤 게임(남복 4명, 혼복 2명 필요)도 구성할 수 없습니다.', [
      '해당 남자 회원을 제외하거나 남자 인원을 2명 이상으로 조정하세요.',
    ]);
  }
  if (W === 1) {
    throw new SchedulerError('여자가 1명이면 어떤 게임(여복 4명, 혼복 2명 필요)도 구성할 수 없습니다.', [
      '해당 여자 회원을 제외하거나 여자 인원을 2명 이상으로 조정하세요.',
    ]);
  }

  // 라운드·코트 계획
  let R, courtsPerRound, extraGames = null, gamesPerPerson = null;
  const planWarnings = [];

  if (type === 'regular') {
    R = Number(config.rounds) || 5;
    if (R < 1 || R > 12) throw new SchedulerError('라운드 수는 1~12 사이여야 합니다.');
    courtsPerRound = Array(R).fill(2);
  } else {
    gamesPerPerson = Number(config.gamesPerPerson) || 4;
    if (gamesPerPerson < 1 || gamesPerPerson > 10) throw new SchedulerError('인당 게임 수는 1~10 사이여야 합니다.');
    const baseCourts = N >= 12 ? 3 : 2;
    const raw = N * gamesPerPerson;
    let T;
    if (raw % 4 === 0) {
      T = raw / 4;
    } else {
      const d = raw % 4;
      // 올림하면 (4−d)명이 +1게임, 내림하면 d명이 −1게임 — 편차 인원이 적은 쪽, 동률이면 +1 우선
      if (4 - d <= d) {
        T = Math.ceil(raw / 4);
        extraGames = { delta: +1, count: 4 - d };
      } else {
        T = Math.floor(raw / 4);
        extraGames = { delta: -1, count: d };
      }
      planWarnings.push({
        code: 'W_UNEVEN_GAMES',
        message: `${N}명 × ${gamesPerPerson}게임은 4로 나누어떨어지지 않아 ${extraGames.count}명이 ${gamesPerPerson + extraGames.delta}게임을 하게 됩니다.`,
      });
    }
    R = Math.ceil(T / baseCourts);
    // 게임 수를 라운드에 최대한 고르게 분배 (마지막에 몰지 않음 → 연속 대기 완화)
    courtsPerRound = [];
    const q = Math.floor(T / R);
    const rem = T % R;
    for (let i = 0; i < R; i++) {
      courtsPerRound.push(q + (Math.floor(((i + 1) * rem) / R) - Math.floor((i * rem) / R)));
    }
  }

  // 라운드별 가용 인원·패리티 검사
  for (let r = 0; r < R; r++) {
    const avail = players.filter((p) => !p.unavailable.has(r));
    const availM = avail.filter((p) => p.gender === 'M').length;
    const availW = avail.length - availM;
    let C = courtsPerRound[r];
    if (avail.length < 4 * C) {
      const reduced = Math.floor(avail.length / 4);
      if (reduced < 1) {
        throw new SchedulerError(`${r + 1}라운드 가용 인원이 ${avail.length}명이라 게임을 구성할 수 없습니다.`, [
          '해당 라운드의 제외 인원을 줄이세요.',
        ]);
      }
      courtsPerRound[r] = reduced;
      C = reduced;
      planWarnings.push({
        code: 'W_ROUND_REDUCED',
        message: `${r + 1}라운드는 가용 인원 부족으로 ${reduced}개 코트만 운영합니다.`,
      });
    }
    if (enumerateCompositions(C, availM, availW).length === 0) {
      // 대표 원인: 대기 0명인데 남자(또는 여자)가 홀수 → 잡복 없이 불가능
      throw new SchedulerError(
        `${r + 1}라운드(가용 남${availM}/여${availW}, ${C}코트)에서 남복/여복/혼복만으로는 코트를 채울 수 없습니다.` +
          (avail.length === 4 * C && availM % 2 === 1 ? ' 전원 출전 라운드인데 남자 인원이 홀수라서 발생하는 문제입니다.' : ''),
        ['인원을 조정하거나(성별 1명 추가/제외), 해당 라운드 제외 인원을 조정하세요.']
      );
    }
  }

  // 파트너 풀 사전 경고: 어떤 선수의 목표 게임 수가 가능한 파트너 수를 넘으면 중복이 불가피
  const totalSlots = courtsPerRound.reduce((a, c) => a + 4 * c, 0);
  const targetGames = totalSlots / N;
  for (const p of players) {
    const partnerPool = p.gender === 'M' ? M - 1 + W : W - 1 + M;
    const myRounds = courtsPerRound.length - p.unavailable.size;
    const myTarget = Math.min(Math.ceil(targetGames), myRounds);
    if (myTarget > partnerPool) {
      planWarnings.push({
        code: 'W_PARTNER_POOL',
        message: `${p.label}의 예상 게임 수(${myTarget})가 가능한 파트너 수(${partnerPool})보다 많아 파트너 중복이 발생할 수 있습니다.`,
      });
    }
  }

  // 월례 혼복 커버리지 목표
  let mixedNeedTotal = 0;
  if (type === 'monthly' && M > 0 && W > 0) {
    mixedNeedTotal = Math.max(Math.ceil(M / 2), Math.ceil(W / 2));
  }

  return {
    type,
    players,
    byId: new Map(players.map((p) => [p.id, p])),
    men,
    women,
    N,
    M,
    W,
    R,
    courtsPerRound,
    totalGames: courtsPerRound.reduce((a, c) => a + c, 0),
    targetGames,
    gamesPerPerson,
    extraGames,
    mixedNeedTotal,
    planWarnings,
  };
}
