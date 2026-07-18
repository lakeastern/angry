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

  // 짝수 라운드(2·4)는 혼복 우세
  const cOf = (r) => res.rounds[r].games.filter((g) => g.type === 'MX').length;
  assert.ok(cOf(1) >= 1 && cOf(3) >= 1, '2·4라운드에 혼복이 있어야 함');
  assert.ok(cOf(1) + cOf(3) >= cOf(0) + cOf(2) + cOf(4), '짝수 라운드 혼복이 홀수 라운드보다 많거나 같아야 함');
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

test('월례 12명 남자 홀수(남5 여7) — 사전 에러', () => {
  assert.throws(() => generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(5, 7) }), SchedulerError);
});

test('남6 여3 정기 — 성별 강제 편차는 경고로 알리고 진행', () => {
  const res = generateSchedule({ type: 'regular', rounds: 5, players: mk(6, 3), seed: 7 });
  assert.deepEqual(res.errors, [], '파트너 중복 등 하드 위반은 없어야 함');
  assert.equal(res.stats.consecutiveSits, 0);
  assert.ok(res.warnings.some((w) => w.code === 'W_GAME_SPREAD'), '남자 전원 출전 강제로 게임 수 편차 경고가 있어야 함');
});

test('월례 남4 여8, 인당 4게임 — 전원 정확히 4게임 + 인당 혼복 1회', () => {
  const res = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(4, 8), seed: 11 });
  assert.deepEqual(res.errors, []);
  for (const [id, s] of res.stats.perPlayer) {
    assert.equal(s.games, 4, `${id}는 4게임이어야 함 (실제 ${s.games})`);
  }
  assert.equal(res.stats.mixedUncovered, 0, '전원 혼복 최소 1회');
});

test('월례 남7 여7(14명), 인당 4게임 — 혼복 커버리지 + 게임 수 ±1', () => {
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
