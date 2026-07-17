// 엣지 케이스·요구사항 회귀 테스트

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule, SchedulerError } from '../engine/scheduler.js';

const mk = (ids, extra = {}) => ids.map((id) => ({ id, ...(extra[id] || {}) }));

test('남7 여5 정기 5라운드 — 기준 케이스', () => {
  const res = generateSchedule({
    type: 'regular',
    rounds: 5,
    players: mk(['1', '2', '3', '4', '5', '6', '7', 'A', 'B', 'C', 'D', 'E']),
    seed: 42,
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.consecutiveSits, 0);
  assert.equal(res.stats.spreadPenalty, 0);
  assert.equal(res.stats.rotationMiss, 0, '12명이면 3라운드 내 전원 레슨 가능');

  // 짝수 라운드(2·4)는 혼복 우세, 홀수 라운드는 동성복식 우세
  const cOf = (r) => res.rounds[r].games.filter((g) => g.type === 'MX').length;
  const evenC = cOf(1) + cOf(3);
  const oddC = cOf(0) + cOf(2) + cOf(4);
  assert.ok(cOf(1) >= 1 && cOf(3) >= 1, '2·4라운드에 혼복이 있어야 함');
  assert.ok(evenC >= oddC, `짝수 라운드 혼복(${evenC})이 홀수 라운드(${oddC})보다 많거나 같아야 함`);
});

test('남자 1명 — 사전 에러', () => {
  assert.throws(
    () => generateSchedule({ type: 'regular', rounds: 5, players: mk(['1', 'A', 'B', 'C', 'D', 'E', 'F', 'G']) }),
    SchedulerError
  );
});

test('8명 전원 출전인데 남자 홀수(남3 여5) — 사전 에러', () => {
  assert.throws(
    () => generateSchedule({ type: 'regular', rounds: 5, players: mk(['1', '2', '3', 'A', 'B', 'C', 'D', 'E']) }),
    SchedulerError
  );
});

test('월례 12명 남자 홀수(남5 여7) — 사전 에러', () => {
  assert.throws(
    () =>
      generateSchedule({
        type: 'monthly',
        gamesPerPerson: 4,
        players: mk(['1', '2', '3', '4', '5', 'A', 'B', 'C', 'D', 'E', 'F', 'G']),
      }),
    SchedulerError
  );
});

test('남6 여3 정기 — 성별 강제 편차는 경고로 알리고 진행', () => {
  const res = generateSchedule({
    type: 'regular',
    rounds: 5,
    players: mk(['1', '2', '3', '4', '5', '6', 'A', 'B', 'C']),
    seed: 7,
  });
  assert.deepEqual(res.errors, [], '파트너 중복 등 하드 위반은 없어야 함');
  assert.equal(res.stats.consecutiveSits, 0);
  assert.ok(res.warnings.some((w) => w.code === 'W_GAME_SPREAD'), '남자 전원 출전 강제로 게임 수 편차 경고가 있어야 함');
});

test('월례 남4 여8, 인당 4게임 — 전원 정확히 4게임 + 인당 혼복 1회', () => {
  const res = generateSchedule({
    type: 'monthly',
    gamesPerPerson: 4,
    players: mk(['1', '2', '3', '4', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']),
    seed: 11,
  });
  assert.deepEqual(res.errors, []);
  for (const [id, s] of res.stats.perPlayer) {
    assert.equal(s.games, 4, `${id}는 4게임이어야 함 (실제 ${s.games})`);
  }
  assert.equal(res.stats.mixedUncovered, 0, '전원 혼복 최소 1회');
});

test('월례 남7 여7(14명), 인당 4게임 — 혼복 커버리지 + 게임 수 ±1', () => {
  const res = generateSchedule({
    type: 'monthly',
    gamesPerPerson: 4,
    players: mk(['1', '2', '3', '4', '5', '6', '7', 'A', 'B', 'C', 'D', 'E', 'F', 'G']),
    seed: 3,
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.spreadPenalty, 0, '게임 수 차이는 1 이하');
  assert.equal(res.stats.mixedUncovered, 0, '전원 혼복 최소 1회');
  assert.equal(res.stats.consecutiveSits, 0);
});

test('라운드별 제외 — 남1이 1·2라운드 불참', () => {
  const res = generateSchedule({
    type: 'regular',
    rounds: 5,
    players: mk(['1', '2', '3', '4', '5', '6', '7', 'A', 'B', 'C', 'D', 'E'], {
      1: { unavailableRounds: [1, 2] },
    }),
    seed: 5,
  });
  assert.deepEqual(res.errors, []);
  for (const r of [0, 1]) {
    const rd = res.rounds[r];
    const assigned = new Set([...rd.games.flatMap((g) => [...g.teams[0], ...g.teams[1]]), ...rd.lesson]);
    assert.ok(!assigned.has('1'), `${r + 1}라운드에 제외된 남1이 배정됨`);
    assert.ok(rd.excluded.includes('1'));
  }
});

test('개인 특성 — 게임선호는 결장 최소, 신규회원은 레슨 보장', () => {
  const res = generateSchedule({
    type: 'regular',
    rounds: 5,
    players: mk(['1', '2', '3', '4', '5', '6', '7', 'A', 'B', 'C', 'D', 'E'], {
      7: { prefs: { gamePriority: true } },
      E: { prefs: { newMember: true } },
    }),
    seed: 9,
  });
  assert.deepEqual(res.errors, []);
  const sitsOf = (id) => res.stats.perPlayer.get(id).sits;
  const allSits = [...res.stats.perPlayer.values()].map((s) => s.sits);
  assert.ok(sitsOf('7') <= Math.min(...allSits) + 1, '게임선호 회원의 결장은 최소 수준이어야 함');
  assert.ok(sitsOf('E') >= 1, '신규회원은 레슨을 최소 1회 받아야 함');
});

test('정기 17명 — 대기 인원 초과로 연속 결장 완화가 명시됨', () => {
  const res = generateSchedule({
    type: 'regular',
    rounds: 5,
    players: mk(['1', '2', '3', '4', '5', '6', '7', '8', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']),
    seed: 13,
  });
  assert.deepEqual(res.errors, []);
  assert.ok(
    res.relaxationsApplied.some((r) => r.includes('연속')),
    '완화 내역에 연속 결장 완화가 있어야 함'
  );
});

test('시드 고정 시 결과 재현 가능', () => {
  const config = {
    type: 'regular',
    rounds: 5,
    players: mk(['1', '2', '3', '4', '5', '6', '7', 'A', 'B', 'C', 'D', 'E']),
    seed: 77,
  };
  const a = generateSchedule(config);
  const b = generateSchedule(config);
  assert.deepEqual(a.rounds, b.rounds);
});
