// 정기모임 게임온리 라운드 — c코트도 레슨 없이 게임 (코치 부재 라운드)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule } from '../engine/scheduler.js';

function mk(M, W) {
  return [
    ...Array.from({ length: M }, (_, i) => ({ id: `m${i + 1}`, name: `남${i + 1}`, gender: 'M', score: i + 1 })),
    ...Array.from({ length: W }, (_, i) => ({ id: `w${i + 1}`, name: `여${i + 1}`, gender: 'W', score: i + 1 })),
  ];
}
const gen = (M, W, gameOnlyRounds, extra = {}) => generateSchedule({
  type: 'regular', rounds: 5, players: mk(M, W), seed: 7,
  searchBudget: { restarts: 6, iters: 150, polish: 300 },
  options: { gameOnlyRounds, ...extra },
});

test('옵션 미지정(옛 대진표)은 전 라운드 레슨 — 하위 호환', () => {
  const r = generateSchedule({ type: 'regular', rounds: 5, players: mk(6, 6), seed: 7 });
  assert.deepEqual(r.plan.courtsPerRound, [2, 2, 2, 2, 2]);
  assert.ok(r.rounds.every((rd) => !rd.gameOnly));
});

test('12명 · 1라운드 게임온리 — 3코트 전원 출전, 나머지는 2코트+레슨', () => {
  const r = gen(6, 6, [1]);
  assert.deepEqual(r.plan.courtsPerRound, [3, 2, 2, 2, 2]);
  assert.equal(r.rounds[0].gameOnly, true);
  assert.equal(r.rounds[0].games.length, 3);
  assert.deepEqual(r.rounds[0].lesson, [], '12명이면 쉬는 사람 없음');
  assert.deepEqual(r.rounds[0].games.map((g) => g.court), ['a', 'b', 'c']);
  assert.ok(r.rounds.slice(1).every((rd) => !rd.gameOnly && rd.games.length === 2 && rd.lesson.length === 4));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
});

test('레슨 로테이션은 게임온리를 뺀 첫 레슨 라운드 3개(2·3·4R) 기준 — 12명 전원 1회 레슨', () => {
  const r = gen(6, 6, [1]);
  const lessoned = new Set([1, 2, 3].flatMap((i) => r.rounds[i].lesson));
  assert.equal(lessoned.size, 12, `2~4R 레슨 인원 ${lessoned.size}`);
  assert.ok(!r.warnings.some((w) => w.code === 'W_LESSON_ROTATION'));
});

for (const [M, W] of [[7, 7], [8, 6], [8, 8], [9, 9], [6, 7]]) {
  test(`${M + W}명 · 1라운드 게임온리 — 3코트 + 휴식 ${M + W - 12}명, 위반 없음`, () => {
    const r = gen(M, W, [1]);
    const rd = r.rounds[0];
    assert.equal(rd.games.length, 3);
    assert.equal(rd.lesson.length, M + W - 12, '남는 인원은 휴식(대기)');
    const ids = [...rd.games.flatMap((g) => g.teams.flat()), ...rd.lesson];
    assert.equal(new Set(ids).size, M + W, '전원 정확히 한 번');
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  });
}

test('10명 · 게임온리 — 2코트만 가능하면 2코트 + 휴식 2명', () => {
  const r = gen(5, 5, [1]);
  assert.equal(r.rounds[0].games.length, 2);
  assert.equal(r.rounds[0].lesson.length, 2);
  assert.equal(r.rounds[0].gameOnly, true);
});

test('여러 라운드 게임온리 + 지각자 제외', () => {
  const players = mk(7, 7);
  players[0].unavailableRounds = [1];
  const r = generateSchedule({ type: 'regular', rounds: 5, players, seed: 3, searchBudget: { restarts: 6, iters: 150, polish: 300 }, options: { gameOnlyRounds: [1, 5] } });
  assert.deepEqual(r.plan.courtsPerRound, [3, 2, 2, 2, 3]);
  assert.ok(r.rounds[0].excluded.includes('m1'));
  assert.equal(r.rounds[0].lesson.length, 1, '14명 중 1명 지각 → 12명 게임 + 1명 휴식');
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
});
