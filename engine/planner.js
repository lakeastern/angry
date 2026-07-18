// Phase A: 설정 정규화, 라운드/코트 계획, 실현 가능성 사전 검사.

export class SchedulerError extends Error {
  constructor(message, suggestions = []) {
    super(message);
    this.name = 'SchedulerError';
    this.suggestions = suggestions;
  }
}

export const DEFAULT_OPTIONS = {
  maxDiff: null, // 게임 점수차 상한 (null = 제한 없음)
  maxMeet: 2, // 같은 상대와 만나는 횟수 상한 (null = 제한 없음)
  tightRounds: [1, 2, 3], // 빡겜(비슷한 실력 4명 한 게임) 라운드 (1-based). 2라운드는 상위 랭커(1~4위) 동성복식 우선
  mixedRounds: [1, 3], // 혼복 선호 라운드 (1-based, 정기모임 전용) — 그 외 라운드는 동성복식 선호
  allowConsecutiveSit: false, // 연속 결장 허용 (설정에 의한 강제 완화)
  allowPartnerRepeat: false, // 파트너 중복 허용 (설정에 의한 강제 완화)
  ignoreGender: false, // 성별 구분 없이 편성 (잡복 허용)
};

// 입력 형식: { id, name, gender:'M'|'W', score(성별 내 실력 순위, 1=최강),
//             prefs?: {gamePriority,newMember,mixedPreferred}, unavailableRounds?: [1-based...] }
export function normalizePlayer(raw, ignoreGender) {
  const name = String(raw.name || '').trim();
  if (!name) throw new SchedulerError('이름이 비어 있는 참석자가 있습니다.');
  if (raw.gender !== 'M' && raw.gender !== 'W') {
    throw new SchedulerError(`${name}의 성별 정보가 잘못되었습니다.`);
  }
  const score = Number(raw.score);
  if (!Number.isFinite(score) || score < 1) {
    throw new SchedulerError(`${name}의 실력 순위(점수)가 잘못되었습니다: ${raw.score}`);
  }
  return {
    id: String(raw.id),
    gender: ignoreGender ? 'M' : raw.gender,
    realGender: raw.gender,
    score,
    label: name,
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
  const options = Object.assign({}, DEFAULT_OPTIONS, config.options || {});
  options.mixedRounds = Array.isArray(options.mixedRounds) ? options.mixedRounds.map(Number) : [1, 3];
  // 하위 호환: 숫자 n(초반 n라운드)으로 온 경우 [1..n]으로 변환
  if (!Array.isArray(options.tightRounds)) {
    const n = Number(options.tightRounds) || 0;
    options.tightRounds = Array.from({ length: Math.max(0, n) }, (_, i) => i + 1);
  } else {
    options.tightRounds = options.tightRounds.map(Number);
  }
  if (!Array.isArray(config.players) || config.players.length === 0) {
    throw new SchedulerError('참석자 목록이 비어 있습니다.');
  }

  const players = config.players.map((p) => normalizePlayer(p, options.ignoreGender));
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) throw new SchedulerError('참석자 id가 중복되었습니다.');

  const men = players.filter((p) => p.gender === 'M');
  const women = players.filter((p) => p.gender === 'W');
  const N = players.length;
  const M = men.length;
  const W = women.length;

  if (N < 5) {
    throw new SchedulerError(`참석 인원이 ${N}명입니다. 대진표 구성에는 최소 5명이 필요합니다.`);
  }
  if (N > 24) {
    throw new SchedulerError(`참석 인원이 ${N}명입니다. 현재 버전은 최대 24명까지 지원합니다.`);
  }
  if (M === 1) {
    throw new SchedulerError('남자가 1명이면 어떤 게임(남복 4명, 혼복 2명 필요)도 구성할 수 없습니다.', [
      '설정에서 "성별 구분 없이 편성"을 켜면 진행할 수 있습니다.',
      '또는 해당 남자 회원을 제외하거나 남자 인원을 2명 이상으로 조정하세요.',
    ]);
  }
  if (W === 1) {
    throw new SchedulerError('여자가 1명이면 어떤 게임(여복 4명, 혼복 2명 필요)도 구성할 수 없습니다.', [
      '설정에서 "성별 구분 없이 편성"을 켜면 진행할 수 있습니다.',
      '또는 해당 여자 회원을 제외하거나 여자 인원을 2명 이상으로 조정하세요.',
    ]);
  }

  // 라운드·코트 계획
  let R, courtsPerRound, extraGames = null, gamesPerPerson = null;
  const planWarnings = [];
  const maxCourts = type === 'regular' ? 2 : 3;

  if (type === 'regular') {
    R = Number(config.rounds) || 5;
    if (R < 1 || R > 12) throw new SchedulerError('라운드 수는 1~12 사이여야 합니다.');
    const C = Math.min(2, Math.floor(N / 4));
    courtsPerRound = Array(R).fill(C);
    if (C < 2) {
      planWarnings.push({
        code: 'W_COURT_REDUCED',
        message: `인원이 ${N}명이라 게임 코트를 ${C}개만 운영합니다 (코트당 4명 필요).`,
      });
    }
  } else {
    gamesPerPerson = Number(config.gamesPerPerson) || 4;
    if (gamesPerPerson < 1 || gamesPerPerson > 10) throw new SchedulerError('인당 게임 수는 1~10 사이여야 합니다.');
    const baseCourts = N >= 12 ? 3 : N >= 8 ? 2 : 1;
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
    // 앞 라운드는 풀코트로 채우고, 비는 코트는 마지막 라운드에 배치
    const q = Math.floor(T / R);
    const rem = T % R;
    courtsPerRound = Array.from({ length: R }, (_, i) => q + (i < rem ? 1 : 0));
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
        ['설정에서 "성별 구분 없이 편성"을 켜거나, 인원·제외 라운드를 조정하세요.']
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

  // 월례 혼복 커버리지 목표 (성별 무시 모드에서는 해당 없음)
  let mixedNeedTotal = 0;
  if (type === 'monthly' && M > 0 && W > 0) {
    mixedNeedTotal = Math.max(Math.ceil(M / 2), Math.ceil(W / 2));
  }

  return {
    type,
    options,
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
