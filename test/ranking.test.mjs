import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRanking, resultDateMs } from '../engine/ranking.js';

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

test('미입력은 제외, 동점(무승부)은 경기·득실에 포함', () => {
  const players = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  const rows = computeRanking([
    result([
      g(['A', 'B'], ['C', 'D'], 5, 5), // 동점 → 무승부로 집계
      g(['A', 'B'], ['C', 'D'], null, null), // 미입력 → 제외
      g(['A', 'B'], ['C', 'D'], 6, 3), // 승
    ], players),
  ]);
  const A = rows.find((r) => r.memberId === 'A');
  assert.equal(A.G, 2, '동점+승 = 2게임 집계(미입력 제외)');
  assert.equal(A.W, 1); assert.equal(A.D, 1); assert.equal(A.L, 0);
  assert.equal(A.GF, 11); assert.equal(A.GA, 8); assert.equal(A.GD, 3);
  assert.equal(A.points, 3, '종합점수는 승×3 (무승부는 미반영)');
});

test('같은 승수면 패가 적은(무가 많은) 사람이 득실차와 무관하게 위', () => {
  // A: 3승1무0패 이지만 득실차 작음. B: 3승0무1패 이지만 득실차 큼. → A가 위여야
  const ppl = ['A', 'B', 'p', 'q', 'r', 's'].map((id) => ({ memberId: id, name: id }));
  const games = [
    // A의 3승(빠듯하게) + 1무
    { round: 0, court: 'a', teamA: ['A', 'p'], teamB: ['q', 'r'], scoreA: 6, scoreB: 5 },
    { round: 1, court: 'a', teamA: ['A', 'p'], teamB: ['q', 'r'], scoreA: 6, scoreB: 5 },
    { round: 2, court: 'a', teamA: ['A', 'p'], teamB: ['q', 'r'], scoreA: 6, scoreB: 5 },
    { round: 3, court: 'a', teamA: ['A', 'p'], teamB: ['q', 'r'], scoreA: 5, scoreB: 5 }, // 무
    // B의 3승(크게) + 1패(크게) → 득실차 A보다 큼
    { round: 0, court: 'b', teamA: ['B', 's'], teamB: ['q', 'r'], scoreA: 6, scoreB: 0 },
    { round: 1, court: 'b', teamA: ['B', 's'], teamB: ['q', 'r'], scoreA: 6, scoreB: 0 },
    { round: 2, court: 'b', teamA: ['B', 's'], teamB: ['q', 'r'], scoreA: 6, scoreB: 0 },
    { round: 3, court: 'b', teamA: ['B', 's'], teamB: ['q', 'r'], scoreA: 0, scoreB: 6 }, // 패
  ];
  const rows = computeRanking([{ id: 'r1', players: ppl, games }]);
  const A = rows.find((r) => r.memberId === 'A');
  const B = rows.find((r) => r.memberId === 'B');
  assert.equal(A.W, 3); assert.equal(A.L, 0); assert.equal(A.D, 1);
  assert.equal(B.W, 3); assert.equal(B.L, 1); assert.equal(B.D, 0);
  assert.ok(A.GD < B.GD, '전제: A 득실차가 B보다 작음');
  assert.ok(A.rank < B.rank, '3승0패(1무)가 3승1패보다 위 — 득실차 작아도');
});

test('무승부는 승/패보다 순위 중립 — 득실차로 패보다 위', () => {
  const players = ['A', 'B', 'C', 'D', 'E', 'F', 'p', 'q'].map((id) => ({ memberId: id, name: id }));
  // A: 1무 (GD 0), C: 1패 (GD -3) → 둘 다 0승이지만 A가 위
  const rows = computeRanking([
    result([
      g(['A', 'B'], ['p', 'q'], 5, 5), // A 무
      g(['C', 'D'], ['E', 'F'], 3, 6), // C 패
    ], players),
  ]);
  const A = rows.find((r) => r.memberId === 'A');
  const C = rows.find((r) => r.memberId === 'C');
  assert.equal(A.W, 0); assert.equal(C.W, 0);
  assert.equal(A.D, 1); assert.equal(C.L, 1);
  assert.ok(A.rank < C.rank, '0승 동일하지만 무승부(GD0)가 패배(GD-3)보다 위');
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

test('평균 기준 — 적게 뛰고 승률 높은 사람이 누적 1위보다 위', () => {
  // 많이: 4경기 3승1패(75%) / 완승: 2경기 2승(100%). 나머지는 1경기씩만 뛰어 누적 승수가 적다.
  const games = [
    { round: 0, court: 'a', teamA: ['많이', 'a1'], teamB: ['b1', 'b2'], scoreA: 6, scoreB: 1 },
    { round: 1, court: 'a', teamA: ['많이', 'a2'], teamB: ['b3', 'b4'], scoreA: 6, scoreB: 1 },
    { round: 2, court: 'a', teamA: ['많이', 'a3'], teamB: ['b5', 'b6'], scoreA: 6, scoreB: 1 },
    { round: 3, court: 'a', teamA: ['많이', 'a4'], teamB: ['b7', 'b8'], scoreA: 1, scoreB: 6 },
    { round: 4, court: 'a', teamA: ['완승', 'c1'], teamB: ['d1', 'd2'], scoreA: 6, scoreB: 0 },
    { round: 5, court: 'a', teamA: ['완승', 'c2'], teamB: ['d3', 'd4'], scoreA: 6, scoreB: 0 },
  ];
  const ids = [...new Set(games.flatMap((g) => [...g.teamA, ...g.teamB]))];
  const players = ids.map((id) => ({ memberId: id, name: id }));
  const total = computeRanking([{ id: 'r1', players, games }]);
  const avg = computeRanking([{ id: 'r1', players, games }], { basis: 'avg', minGames: 2 });
  assert.equal(total[0].name, '많이', '누적 기준 1위는 3승한 많이');
  assert.equal(avg[0].name, '완승', '평균 기준 1위는 승률 100%인 완승');
  assert.equal(avg[0].winRate, 1);
  const many = avg.find((r) => r.name === '많이');
  assert.equal(many.winRate, 0.75);
  assert.equal(many.rank, 2, '평균 기준에서 많이는 2위');
  // 1경기만 뛴 인원은 최소 경기(2) 미달 → 순위 없음
  assert.ok(avg.filter((r) => r.G === 1).every((r) => r.rank === null));
});

test('평균 기준 — 최소 경기 미달자는 순위 없음(rank null)', () => {
  const ppl = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  const rows = computeRanking([{
    id: 'r1', players: ppl,
    games: [{ round: 0, court: 'a', teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 6, scoreB: 0 }],
  }], { basis: 'avg', minGames: 4 });
  assert.ok(rows.every((r) => r.rank === null), '1경기뿐이므로 전원 순위 없음');
  assert.ok(rows.every((r) => r.qualified === false));
});

test('평균 기준 — 경기당 득실차·평균 승점 계산', () => {
  const ppl = ['A', 'B', 'C', 'D'].map((id) => ({ memberId: id, name: id }));
  const rows = computeRanking([{
    id: 'r1', players: ppl,
    games: [
      { round: 0, court: 'a', teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 6, scoreB: 2 },
      { round: 1, court: 'a', teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 2, scoreB: 6 },
    ],
  }], { basis: 'avg', minGames: 2 });
  const A = rows.find((r) => r.memberId === 'A');
  assert.equal(A.G, 2); assert.equal(A.W, 1); assert.equal(A.GD, 0);
  assert.equal(A.avgGD, 0); assert.equal(A.avgPoints, 1.5); assert.equal(A.winRate, 0.5);
});

test('only — 지정한 대상만 줄 세우고 순위를 다시 매김 (현재 명단만)', () => {
  const ppl = ['회원A', '회원B', '게스트', '탈퇴'].map((id) => ({ memberId: id, name: id }));
  const games = [
    { round: 0, court: 'a', teamA: ['게스트', '탈퇴'], teamB: ['회원A', '회원B'], scoreA: 6, scoreB: 0 }, // 비회원 승
    { round: 1, court: 'a', teamA: ['회원A', '게스트'], teamB: ['회원B', '탈퇴'], scoreA: 6, scoreB: 3 },
  ];
  const full = computeRanking([{ id: 'r1', players: ppl, games }]);
  assert.equal(full.length, 4);
  assert.equal(full[0].name, '게스트', '전체 기준 1위는 2승한 게스트');

  const only = computeRanking([{ id: 'r1', players: ppl, games }], { only: ['회원A', '회원B'] });
  assert.deepEqual(only.map((r) => r.name), ['회원A', '회원B'], '회원 2명만 남음');
  assert.deepEqual(only.map((r) => r.rank), [1, 2], '순위가 1·2로 다시 매겨짐');
  // 제외된 상대와의 경기 기록 자체는 그대로 반영 (실제로 일어난 승패)
  const a = only.find((r) => r.name === '회원A');
  assert.equal(a.G, 2); assert.equal(a.W, 1); assert.equal(a.L, 1);
});

test('only — 멤버 ID로도, 이름으로도 매칭', () => {
  const games = [{ round: 0, court: 'a', teamA: ['m1', 'm2'], teamB: ['x1', 'x2'], scoreA: 6, scoreB: 2 }];
  const players = [
    { memberId: 'm1', name: '홍길동' }, { memberId: 'm2', name: '김철수' },
    { memberId: 'x1', name: '손님1' }, { memberId: 'x2', name: '손님2' },
  ];
  const byId = computeRanking([{ id: 'r1', players, games }], { only: ['m1'] });
  assert.deepEqual(byId.map((r) => r.name), ['홍길동']);
  const byName = computeRanking([{ id: 'r1', players, games }], { only: ['김철수'] });
  assert.deepEqual(byName.map((r) => r.name), ['김철수']);
});

test('resultDateMs — ISO·ko-KR 두 저장 형식 모두 파싱', () => {
  const iso = resultDateMs({ date: '2026-06-28' });
  const ko = resultDateMs({ date: '2026. 6. 28.' });
  assert.equal(new Date(iso).getFullYear(), 2026);
  assert.equal(new Date(iso).getMonth(), 5);
  assert.equal(new Date(iso).getDate(), 28);
  assert.equal(iso, ko, 'ISO와 ko-KR 표기가 같은 날짜로 파싱');
  assert.equal(resultDateMs({}), null);
  assert.equal(resultDateMs({ date: '' }), null);
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
