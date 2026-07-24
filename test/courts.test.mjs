// 게임데이·앵그리대회 코트 수 옵션 (자동 1~3, 수동 1~4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule } from '../engine/scheduler.js';

function mk(M, W) {
  return [
    ...Array.from({ length: M }, (_, i) => ({ id: `m${i + 1}`, name: `남${i + 1}`, gender: 'M', score: i + 1 })),
    ...Array.from({ length: W }, (_, i) => ({ id: `w${i + 1}`, name: `여${i + 1}`, gender: 'W', score: i + 1 })),
  ];
}
const gen = (players, courts) => generateSchedule({ type: 'monthly', gamesPerPerson: 4, players, seed: 7, options: courts ? { courts } : {} });

test('자동(기본) — 12명은 3코트', () => {
  const r = gen(mk(6, 6));
  assert.ok(Math.max(...r.plan.courtsPerRound) === 3, '자동 3코트');
});

test('수동 2코트 — 12명이어도 2코트만', () => {
  const r = gen(mk(6, 6), 2);
  assert.ok(r.plan.courtsPerRound.every((c) => c <= 2), '모든 라운드 2코트 이하');
  assert.ok(r.plan.courtsPerRound.some((c) => c === 2), '2코트 사용');
});

test('수동 4코트 — 16명', () => {
  const r = gen(mk(8, 8), 4);
  assert.ok(r.plan.courtsPerRound.some((c) => c === 4), '4코트 사용');
});

test('요청 코트가 인원상 불가하면 축소 + 경고', () => {
  const r = gen(mk(6, 6), 4); // 12명 → 최대 3코트
  assert.ok(Math.max(...r.plan.courtsPerRound) <= 3, '12명은 최대 3코트로 축소');
  assert.ok((r.warnings || []).some((w) => w.code === 'W_COURT_CLAMPED'), '축소 경고');
});

test('수동 1코트 — 전원 한 코트 순환', () => {
  const r = gen(mk(6, 6), 1);
  assert.ok(r.plan.courtsPerRound.every((c) => c === 1), '모든 라운드 1코트');
});
