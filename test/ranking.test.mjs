import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRanking } from '../engine/ranking.js';

// 게임 헬퍼: 팀A(2명) vs 팀B(2명), 스코어
const g = (teamA, teamB, scoreA, scoreB) => ({ round: 0, court: 'a', teamA, teamB, scoreA, scoreB });
const result = (games, players) => ({ id: 'r1', date: '2026-07-20', mode: 'tournament', players, games });

test('기본 승/패·득실 집계', () => {
  const players = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  const rows = computeRanking([result([g(['A', 'B'], ['C', 'D'], 6, 3)], players)]);
  const byId = Object.fromEntries(rows.map((r) => [r.memberId, r]));
  assert.equal(byId.A.W, 1); assert.equal(byId.A.GF, 6); assert.equal(byId.A.GA, 3); assert.equal(byId.A.GD, 3); assert.equal(byId.A.points, 3);
  assert.equal(byId.C.W, 0); assert.equal(byId.C.L, 1); assert.equal(byId.C.GD, -3);
});

test('승수 절대 우선 — 2승(득실 나쁨)이 1승(득실 좋음)보다 항상 위', () => {
  const players = ['P', 'Q', 'x', 'y', 'z', 'w'].map((id) => ({ memberId: id, name: id }));
  // P: 2승이지만 득실차 -1 (6:5, 6:5) → W2, GF12 GA10 GD+2 ... 조정: 아슬한 승 2번
  // Q: 1승이지만 큰 점수차 (7:0) → W1 GD+7
  const rows = computeRanking([
    result([
      g(['P', 'x'], ['y', 'z'], 6, 5),
      g(['P', 'x'], ['z', 'w'], 6, 5),
      g(['Q', 'y'], ['w', 'z'], 7, 0),
    ], players),
  ]);
  const P = rows.find((r) => r.memberId === 'P');
  const Q = rows.find((r) => r.memberId === 'Q');
  assert.ok(P.rank < Q.rank, `2승 P(rank ${P.rank})가 1승 Q(rank ${Q.rank})보다 위여야 함`);
  assert.equal(P.W, 2); assert.equal(Q.W, 1);
});

test('동일 승수는 득실차로 타이브레이크', () => {
  const players = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ memberId: id, name: id }));
  const rows = computeRanking([
    result([
      g(['A', 'C'], ['E', 'F'], 6, 1), // A: 1승 GD+5
      g(['B', 'D'], ['E', 'F'], 6, 4), // B: 1승 GD+2
    ], players),
  ]);
  const A = rows.find((r) => r.memberId === 'A');
  const B = rows.find((r) => r.memberId === 'B');
  assert.equal(A.W, 1); assert.equal(B.W, 1);
  assert.ok(A.rank < B.rank, '같은 1승이면 득실차 큰 A가 위');
});

test('여러 대회 누적 합산', () => {
  const players = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  const r1 = result([g(['A', 'B'], ['C', 'D'], 6, 2)], players);
  const r2 = { ...result([g(['A', 'C'], ['B', 'D'], 6, 4)], players), id: 'r2' };
  const rows = computeRanking([r1, r2]);
  const A = rows.find((r) => r.memberId === 'A');
  assert.equal(A.G, 2); assert.equal(A.W, 2); assert.equal(A.GF, 12); assert.equal(A.GA, 6); assert.equal(A.GD, 6);
});

test('미입력·동점 게임은 집계에서 제외', () => {
  const players = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  const rows = computeRanking([
    result([
      g(['A', 'B'], ['C', 'D'], 6, 6), // 동점 → 제외
      g(['A', 'B'], ['C', 'D'], null, null), // 미입력 → 제외
      g(['A', 'B'], ['C', 'D'], 6, 3), // 유효
    ], players),
  ]);
  const A = rows.find((r) => r.memberId === 'A');
  assert.equal(A.G, 1, '유효 게임 1개만 집계');
});

test('같은 득실차면 득점(GF) 많은 쪽이 위', () => {
  const players = ['A', 'B', 'C', 'D', 'E', 'F', 'p', 'q', 'r', 's'].map((id) => ({ memberId: id, name: id }));
  const rows = computeRanking([
    result([
      g(['A', 'C'], ['p', 'q'], 7, 5), // A: 1승 GD+2, GF7
      g(['B', 'D'], ['r', 's'], 6, 4), // B: 1승 GD+2, GF6
    ], players),
  ]);
  const A = rows.find((r) => r.memberId === 'A');
  const B = rows.find((r) => r.memberId === 'B');
  assert.equal(A.GD, 2); assert.equal(B.GD, 2);
  assert.ok(A.GF > B.GF);
  assert.ok(A.rank < B.rank, '같은 득실차(+2)면 득점 7인 A가 득점 6인 B보다 위');
});

test('capGames — 인당 앞선 N게임까지만 점수 반영', () => {
  const players = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  // A는 3게임(모두 승) 진행, capGames=2 → 앞 2게임만 반영 (라운드 순)
  const games = [
    { round: 0, court: 'a', teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 6, scoreB: 1 },
    { round: 1, court: 'a', teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 6, scoreB: 2 },
    { round: 2, court: 'a', teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 6, scoreB: 3 },
  ];
  const capped = computeRanking([{ id: 'r1', players, games, capGames: 2 }]);
  const A = capped.find((r) => r.memberId === 'A');
  assert.equal(A.G, 2, '앞 2게임만 집계');
  assert.equal(A.GF, 12); assert.equal(A.GA, 3, '3번째 게임(실점3) 제외');
  // 상한 없으면 3게임 모두
  const full = computeRanking([{ id: 'r1', players, games }]);
  assert.equal(full.find((r) => r.memberId === 'A').G, 3);
});

test('capGames — 라운드 순서대로 앞선 게임을 센다(입력 순서 무관)', () => {
  const players = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  // 저장 순서를 라운드 역순으로 넣어도 라운드 오름차순 앞 1게임만
  const games = [
    { round: 2, court: 'a', teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 0, scoreB: 6 }, // R2 패
    { round: 0, court: 'a', teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 6, scoreB: 0 }, // R0 승
  ];
  const rows = computeRanking([{ id: 'r1', players, games, capGames: 1 }]);
  const A = rows.find((r) => r.memberId === 'A');
  assert.equal(A.G, 1); assert.equal(A.W, 1, 'R0(승)이 앞선 게임');
});

test('동률(승수·득실·득점·승률 동일)은 같은 순위', () => {
  const players = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  // A와 B 각각 1승 GD+3 (대칭). 이름순으로 나열되지만 rank 동일
  const rows = computeRanking([
    result([
      g(['A', 'x'], ['p', 'q'], 6, 3),
      g(['B', 'y'], ['r', 's'], 6, 3),
    ], [...players, ...['x', 'y', 'p', 'q', 'r', 's'].map((id) => ({ memberId: id, name: id }))]),
  ]);
  const A = rows.find((r) => r.memberId === 'A');
  const B = rows.find((r) => r.memberId === 'B');
  assert.equal(A.rank, B.rank, 'A·B 동률 → 같은 순위');
});
