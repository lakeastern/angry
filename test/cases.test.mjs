// 엣지 케이스·요구사항 회귀 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule, SchedulerError } from '../engine/scheduler.js';

// mk(M, W, extra): 남 M명(m1~), 여 W명(w1~), 실력순 score = 순번. extra로 특성·제외 지정
const mk = (M, W, extra = {}) => [
  ...Array.from({ length: M }, (_, i) => ({
    id: `m${i + 1}`, name: `남자${i + 1}`, gender: 'M', score: i + 1, ...(extra[`m${i + 1}`] || {}),
  })),
  ...Array.from({ length: W }, (_, i) => ({
    id: `w${i + 1}`, name: `여자${i + 1}`, gender: 'W', score: i + 1, ...(extra[`w${i + 1}`] || {}),
  })),
];

test('남7 여5 정기 5라운드 — 기준 케이스', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(7, 5), seed: 42 });
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.consecutiveSits, 0);
  assert.equal(res.stats.spreadPenalty, 0);
  assert.equal(res.stats.rotationMiss, 0, '12명이면 3라운드 내 전원 레슨 가능');

  // 기본 혼복 라운드는 1·3, 2라운드는 동성복식
  const cOf = (r) => res.rounds[r].games.filter((g) => g.type === 'MX').length;
  assert.ok(cOf(0) >= 1 && cOf(2) >= 1, '1·3라운드에 혼복이 있어야 함');
  assert.equal(cOf(1), 0, '2라운드는 동성복식이어야 함');
});

const gameIds = (g) => [...g.teams[0], ...g.teams[1]];

test('랭커 라운드(기본 2) — 남복/여복이 상위 5명 풀에서 4명으로 구성', () => {
  for (const [M, W] of [[7, 5], [6, 6], [8, 6]]) {
    const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(M, W), seed: 42 });
    const r2 = res.rounds[1];
    const mm = r2.games.find((g) => g.type === 'MM');
    const ww = r2.games.find((g) => g.type === 'WW');
    assert.ok(mm && ww, `남${M}여${W}: 2라운드에 남복·여복이 있어야 함`);
    const top5m = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const top5w = ['w1', 'w2', 'w3', 'w4', 'w5'];
    assert.ok(gameIds(mm).every((id) => top5m.includes(id)), `남${M}여${W}: 남복 랭커 게임은 상위 5명 풀 안에서`);
    assert.ok(gameIds(ww).every((id) => top5w.includes(id)), `남${M}여${W}: 여복 랭커 게임은 상위 5명 풀 안에서`);
    assert.equal(res.stats.rankerMiss, 0);
  }
});

test('랭커 라운드 — 시드에 따라 풀 내 조합이 달라짐 (랜덤 선정)', () => {
  const combos = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(7, 5), seed });
    const mm = res.rounds[1].games.find((g) => g.type === 'MM');
    combos.add(gameIds(mm).sort().join(','));
  }
  assert.ok(combos.size >= 2, `8개 시드에서 남복 조합이 ${combos.size}가지 — 랜덤 선정이면 2가지 이상이어야 함`);
});

test('혼복 랭커 라운드 — 남녀 각 상위 3명 풀에서 2명씩', () => {
  const res = generateSchedule({
    type: 'regular', rounds: 5, players: mk(7, 5), seed: 11,
    options: { mixedRounds: [2, 4], rankerRounds: [2] },
  });
  const r2 = res.rounds[1];
  const top3m = ['m1', 'm2', 'm3'];
  const top3w = ['w1', 'w2', 'w3'];
  const rankerGame = r2.games.find((g) => {
    if (g.type !== 'MX') return false;
    const men = gameIds(g).filter((id) => id.startsWith('m'));
    const women = gameIds(g).filter((id) => id.startsWith('w'));
    return men.every((id) => top3m.includes(id)) && women.every((id) => top3w.includes(id));
  });
  assert.ok(rankerGame, '2라운드에 상위 3명 풀 기반 혼복 랭커 게임이 있어야 함');
  assert.equal(res.stats.rankerMiss, 0);
});

test('랭커 라운드 위치 변경 [4] — 4라운드에 동성 랭커 게임', () => {
  const res = generateSchedule({
    type: 'regular', rounds: 5, players: mk(7, 5), seed: 21,
    options: { rankerRounds: [4] },
  });
  const r4 = res.rounds[3];
  const mm = r4.games.find((g) => g.type === 'MM');
  assert.ok(mm, '4라운드에 남복이 있어야 함');
  assert.ok(gameIds(mm).every((id) => ['m1', 'm2', 'm3', 'm4', 'm5'].includes(id)));
  assert.equal(res.stats.rankerMiss, 0);
});

test('혼복 선호 라운드 변경 — mixedRounds [1,5]', () => {
  const res = generateSchedule({
    type: 'regular', rounds: 5, players: mk(7, 5), seed: 42,
    options: { mixedRounds: [1, 5] },
  });
  const cOf = (r) => res.rounds[r].games.filter((g) => g.type === 'MX').length;
  assert.ok(cOf(0) >= 1, '1라운드는 혼복 위주여야 함');
  assert.ok(cOf(4) >= 1, '5라운드는 혼복 위주여야 함');
  assert.equal(cOf(1), 0, '2라운드는 동성복식이어야 함');
  assert.equal(cOf(2), 0, '3라운드는 동성복식이어야 함');
});

test('같은 상대 상한 — 기본값 2번 준수', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(7, 5), seed: 42 });
  assert.ok(res.stats.maxMeet <= 2, `같은 상대 최대 ${res.stats.maxMeet}번 — 상한 2 초과`);
  assert.equal(res.stats.meetCapViolations, 0);
});

test('코트 배정 다양화 — 남복이 한 코트에만 몰리지 않음', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(8, 4), seed: 42 });
  const mmCourts = new Set();
  res.rounds.forEach((rd) => rd.games.forEach((g) => { if (g.type === 'MM') mmCourts.add(g.court); }));
  assert.ok(mmCourts.size >= 2, `남복 코트 분포가 ${[...mmCourts].join(',')}뿐 — 2개 이상이어야 함`);
});

test('랭커 라운드 상대 순위 적용 — 상위권 불참 시 참석자 기준 풀', () => {
  // 남자 2위, 여자 2·5위 불참 — 풀은 참석자 상위 5명
  const men = [1, 3, 4, 5, 6, 7, 8].map((s) => ({ id: `m${s}`, name: `남${s}`, gender: 'M', score: s }));
  const women = [1, 3, 4, 6, 7, 8, 9].map((s) => ({ id: `w${s}`, name: `여${s}`, gender: 'W', score: s }));
  const res = generateSchedule({ type: 'regular', rounds: 5, players: [...men, ...women], seed: 42 });
  const r2 = res.rounds[1];
  const mm = r2.games.find((g) => g.type === 'MM');
  const ww = r2.games.find((g) => g.type === 'WW');
  assert.ok(mm && ww, '2라운드에 남복·여복이 있어야 함');
  assert.ok(gameIds(mm).every((id) => ['m1', 'm3', 'm4', 'm5', 'm6'].includes(id)), '남복은 참석 남자 상위 5명 풀 안에서');
  assert.ok(gameIds(ww).every((id) => ['w1', 'w3', 'w4', 'w6', 'w7'].includes(id)), '여복은 참석 여자 상위 5명 풀 안에서');
  assert.equal(res.stats.rankerMiss, 0);
});

test('빡겜 — 초반 3라운드는 게임 내 실력 폭이 후반보다 좁다', () => {
  const res = generateSchedule({ type: 'regular', rounds: 6, players: mk(8, 8), seed: 21 });
  const spreadOf = (rd) => {
    let s = 0;
    for (const g of rd.games) {
      const all = [...g.teams[0], ...g.teams[1]];
      for (const gen of ['M', 'W']) {
        const sc = all.filter((id) => res.plan.byId.get(id).gender === gen).map((id) => res.plan.byId.get(id).score);
        if (sc.length > 1) s += Math.max(...sc) - Math.min(...sc);
      }
    }
    return s / rd.games.length;
  };
  const early = (spreadOf(res.rounds[0]) + spreadOf(res.rounds[1]) + spreadOf(res.rounds[2])) / 3;
  const late = (spreadOf(res.rounds[3]) + spreadOf(res.rounds[4]) + spreadOf(res.rounds[5])) / 3;
  assert.ok(early <= late + 0.001, `초반 평균 실력폭(${early.toFixed(2)})이 후반(${late.toFixed(2)})보다 커서는 안 됨`);
  assert.deepEqual(res.errors, []);
});

test('빡겜 끄기 — tightRounds 0이면 earlyTightness 통계도 0', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(7, 5), seed: 42, options: { tightRounds: 0 } });
  assert.equal(res.stats.earlyTightness, 0);
});

test('점수차 상한 maxDiff=2 — 전 게임 점수차 2 이하', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(7, 5), seed: 9, options: { maxDiff: 2 } });
  assert.equal(res.stats.diffCapViolations, 0);
  assert.ok(res.stats.gameDiffs.every((g) => g.diff <= 2));
  assert.ok(!res.warnings.some((w) => w.code === 'W_DIFF_CAP'));
});

test('남3 여13 (16명) — 극단 성비도 하드 위반 없이 구성', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(3, 13), seed: 7 });
  assert.deepEqual(res.errors.filter((e) => e.code !== 'E_PARTNER_REPEAT'), []);
  // 대기 8명 > 게임 8자리라 연속 결장 완화가 명시되어야 함
  if (res.stats.consecutiveSits > 0) {
    assert.ok(res.relaxationsApplied.some((r) => r.includes('연속')));
  }
});

test('5명 (남3 여2) 정기 — 1코트 운영 + 파트너 풀 부족은 완화로 처리', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(3, 2), seed: 7 });
  assert.ok(res.rounds.every((rd) => rd.games.length === 1), '매 라운드 1게임');
  assert.ok(res.warnings.some((w) => w.code === 'W_COURT_REDUCED'));
  const partnerErrors = res.errors.filter((e) => e.code === 'E_PARTNER_REPEAT');
  if (partnerErrors.length) {
    assert.ok(res.relaxationsApplied.some((r) => r.includes('파트너')), '파트너 중복은 완화 명시가 있어야 함');
  }
});

test('성별 무시 편성 — 남1 여7도 진행 가능', () => {
  const res = generateSchedule({
    type: 'regular', rounds: 5, players: mk(1, 7), seed: 3, options: { ignoreGender: true },
  });
  assert.deepEqual(res.errors, []);
  const m1 = res.stats.perPlayer.get('m1');
  assert.ok(m1.games > 0, '남자 1명도 게임에 참여해야 함');
});

test('성별 무시 없이 남1 여7 — 사전 에러 + 토글 안내', () => {
  try {
    generateSchedule({ type: 'regular', rounds: 5, players: mk(1, 7), seed: 3 });
    assert.fail('에러가 나야 함');
  } catch (e) {
    assert.ok(e instanceof SchedulerError);
    assert.ok(e.suggestions.some((s) => s.includes('성별 구분 없이')));
  }
});

test('강제 완화 토글 — 설정 문구가 relaxationsApplied에 표시', () => {
  const res = generateSchedule({
    type: 'regular', rounds: 5, players: mk(7, 5), seed: 3,
    options: { allowPartnerRepeat: true, allowConsecutiveSit: true },
  });
  assert.ok(res.relaxationsApplied.some((r) => r.includes('설정에 의해')));
});

test('8명 전원 출전인데 남자 홀수(남3 여5) — 사전 에러', () => {
  assert.throws(() => generateSchedule({ type: 'regular', rounds: 5, players: mk(3, 5) }), SchedulerError);
});

test('게임데이 12명 남자 홀수(남5 여7) — 인당 게임 수 우선(잡복 최소 허용)으로 전원 4게임', () => {
  const res = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(5, 7), seed: 42 });
  assert.deepEqual(res.errors, [], '하드 위반은 없어야 함');
  const counts = [...res.stats.perPlayer.values()].map((s) => s.games);
  assert.equal(Math.min(...counts), 4);
  assert.equal(Math.max(...counts), 4, '전원 정확히 4게임');
  assert.ok(res.stats.japbokGames >= 1, '성비상 잡복이 불가피 → 최소 허용');
  assert.ok(res.relaxationsApplied.some((r) => r.includes('잡복')), '잡복 완화가 배너에 표시');
});

test('게임데이 strictGameCount:false면 예전처럼 잡복 없이 구조적 에러', () => {
  assert.throws(
    () => generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(5, 7), options: { strictGameCount: false } }),
    SchedulerError
  );
});

test('게임데이 인당 게임 수 우선 — 균형 성비는 잡복 0', () => {
  const res = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(6, 6), seed: 42 });
  assert.equal(res.stats.japbokGames, 0, '균형 성비는 잡복 없이 전원 균등');
  const counts = [...res.stats.perPlayer.values()].map((s) => s.games);
  assert.equal(Math.max(...counts) - Math.min(...counts), 0);
});

test('남6 여3 정기 — 성별 강제 편차는 경고로 알리고 진행', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(6, 3), seed: 7 });
  assert.deepEqual(res.errors, [], '파트너 중복 등 하드 위반은 없어야 함');
  assert.equal(res.stats.consecutiveSits, 0);
  assert.ok(res.warnings.some((w) => w.code === 'W_GAME_SPREAD'), '남자 전원 출전 강제로 게임 수 편차 경고가 있어야 함');
});

test('게임데이 남4 여8, 인당 4게임 — 전원 정확히 4게임 + 인당 혼복 1회', () => {
  const res = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(4, 8), seed: 11 });
  assert.deepEqual(res.errors, []);
  for (const [id, s] of res.stats.perPlayer) {
    assert.equal(s.games, 4, `${id}는 4게임이어야 함 (실제 ${s.games})`);
  }
  assert.equal(res.stats.mixedUncovered, 0, '전원 혼복 최소 1회');
});

test('게임데이 인당 최소 혼복 게임 수 설정 — minMixedGames=2 이면 전원 혼복 2회 이상', () => {
  const res = generateSchedule({
    type: 'monthly', gamesPerPerson: 4, players: mk(6, 6), seed: 11,
    options: { minMixedGames: 2 },
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.mixedUncovered, 0);
  for (const [, s] of res.stats.perPlayer) assert.ok(s.mixed >= 2, `혼복 ${s.mixed}회 — 최소 2회 미달`);
});

test('게임데이 minMixedGames=0 이면 혼복 강제 없음 (동성복식 위주)', () => {
  const res = generateSchedule({
    type: 'monthly', gamesPerPerson: 4, players: mk(6, 6), seed: 11,
    options: { minMixedGames: 0 },
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.mixedUncovered, 0, 'minMixed=0이면 uncovered는 항상 0');
  // 혼복 강제가 없으므로 minMixed=2일 때보다 혼복 총량이 적거나 같아야 함
  const res2 = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(6, 6), seed: 11, options: { minMixedGames: 2 } });
  const totalMixed = (r) => [...r.stats.perPlayer.values()].reduce((a, s) => a + s.mixed, 0);
  assert.ok(totalMixed(res) <= totalMixed(res2), '혼복 강제 없음이 강제 2회보다 혼복이 많을 수 없음');
});

test('정기모임은 minMixedGames 설정을 무시', () => {
  const res = generateSchedule({
    type: 'regular', rounds: 5, players: mk(7, 5), seed: 42,
    options: { minMixedGames: 3 },
  });
  assert.equal(res.stats.mixedUncovered, 0, '정기모임은 혼복 커버리지 강제 없음');
});

test('게임데이 게임 수가 라운드에 안 나눠떨어지면 빈 코트는 마지막 라운드로', () => {
  // 남4 여6 = 10명 × 4게임 = 40슬롯 → 10게임, 2코트 → 5라운드 (딱 떨어짐: [2,2,2,2,2])
  // 남6 여8 = 14명 × 4게임 = 14게임, 3코트 → 5라운드 → [3,3,3,3,2] (마지막만 부분)
  const res = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(6, 8), seed: 5 });
  const courts = res.plan.courtsPerRound;
  for (let i = 1; i < courts.length; i++) {
    assert.ok(courts[i] <= courts[i - 1], `코트 수는 감소만 해야 함: ${courts.join(',')}`);
  }
  assert.equal(courts[0], Math.max(...courts), '첫 라운드는 풀코트');
});

test('앵그리대회 경로 — 동등 점수 별칭 선수(남8여6)로 monthly 생성 시 하드 위반 0·밸런스', () => {
  // 앵그리대회는 UI가 동등 점수(score=1) 별칭 선수로 monthly 대진표를 생성한다
  const players = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `am${i + 1}`, name: `남${i + 1}`, gender: 'M', score: 1 })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `aw${i + 1}`, name: `여${i + 1}`, gender: 'W', score: 1 })),
  ];
  const res = generateSchedule({
    type: 'monthly', gamesPerPerson: 4, players, seed: 7,
    options: { maxDiff: null, tightRounds: [], mixedRounds: [], rankerRounds: [], minMixedGames: 1 },
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.scoreDiffMax, 0, '동등 점수라 팀 점수차는 항상 0');
  assert.equal(res.stats.mixedUncovered, 0, '전원 혼복 최소 1회');
  assert.equal(res.stats.consecutiveSits, 0);
});

test('게임데이 남7 여7(14명), 인당 4게임 — 혼복 커버리지 + 게임 수 ±1', () => {
  const res = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(7, 7), seed: 3 });
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.spreadPenalty, 0, '게임 수 차이는 1 이하');
  assert.equal(res.stats.mixedUncovered, 0, '전원 혼복 최소 1회');
  assert.equal(res.stats.consecutiveSits, 0);
});

test('라운드별 제외 — 남자1이 1·2라운드 불참', () => {
  const res = generateSchedule({
    type: 'regular', rounds: 5, seed: 5,
    players: mk(7, 5, { m1: { unavailableRounds: [1, 2] } }),
  });
  assert.deepEqual(res.errors, []);
  for (const r of [0, 1]) {
    const rd = res.rounds[r];
    const assigned = new Set([...rd.games.flatMap((g) => [...g.teams[0], ...g.teams[1]]), ...rd.lesson]);
    assert.ok(!assigned.has('m1'), `${r + 1}라운드에 제외된 남자1이 배정됨`);
    assert.ok(rd.excluded.includes('m1'));
  }
});

test('개인 특성 — 게임선호는 결장 최소, 신규회원은 레슨 보장', () => {
  const res = generateSchedule({
    type: 'regular', rounds: 5, seed: 9,
    players: mk(7, 5, { m7: { prefs: { gamePriority: true } }, w5: { prefs: { newMember: true } } }),
  });
  assert.deepEqual(res.errors, []);
  const sitsOf = (id) => res.stats.perPlayer.get(id).sits;
  const allSits = [...res.stats.perPlayer.values()].map((s) => s.sits);
  assert.ok(sitsOf('m7') <= Math.min(...allSits) + 1, '게임선호 회원의 결장은 최소 수준이어야 함');
  assert.ok(sitsOf('w5') >= 1, '신규회원은 레슨을 최소 1회 받아야 함');
});

test('정기 17명 — 대기 인원 초과로 연속 결장 완화가 명시됨', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(8, 9), seed: 13 });
  assert.deepEqual(res.errors, []);
  assert.ok(res.relaxationsApplied.some((r) => r.includes('연속')), '완화 내역에 연속 결장 완화가 있어야 함');
});

test('시드 고정 시 결과 재현 가능', () => {
  const config = { type: 'regular', rounds: 5, players: mk(7, 5), seed: 77 };
  const a = generateSchedule(config);
  const b = generateSchedule(config);
  assert.deepEqual(a.rounds, b.rounds);
});
