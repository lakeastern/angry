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

// 1코트처럼 연속 결장이 불가피한 구성: 3라운드 이상 연속 결장은 없어야 하고,
// 연속 결장 총량은 이론상 최소에 가깝게, 한 사람에게 몰리지 않게.
const sitRuns = (r) => {
  let maxRun = 0;
  for (const p of r.plan.players) {
    let run = 0;
    for (const rd of r.rounds) { run = rd.lesson.includes(p.id) ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  }
  return maxRun;
};
for (const [M, W] of [[3, 5], [4, 4], [2, 6], [3, 6]]) {
  test(`1코트 ${M}남${W}여 — 3라운드 연속 결장 없음`, () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(M, W), seed, options: { courts: 1 } });
      assert.ok(sitRuns(r) <= 2, `seed ${seed}: ${sitRuns(r)}라운드 연속 결장`);
      assert.equal(r.stats.longSitRuns, 0);
      const games = [...r.stats.perPlayer.values()].map((s) => s.games);
      assert.ok(Math.max(...games) - Math.min(...games) <= 1, '인당 게임 수 편차');
    }
  });
}

test('1코트 3남5여 — 연속 결장은 이론상 최소(라운드 전환당 1명)에 가깝고 한 사람에게 몰리지 않음', () => {
  // 8명·1코트는 매 라운드 4명이 쉬고, 남3이라 매 게임이 혼복/여복 → 8라운드 전환 7번마다 최소 1명은 연속 결장
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(3, 5), seed, options: { courts: 1 } });
    assert.equal(r.rounds.length, 8);
    assert.ok(r.stats.consecutiveSits <= 8, `seed ${seed}: 연속 결장 ${r.stats.consecutiveSits}회 (최소 7)`);
    const per = new Map();
    r.stats.consecutiveSitList.forEach((c) => per.set(c.id, (per.get(c.id) || 0) + 1));
    assert.ok(Math.max(0, ...per.values()) <= 1, `seed ${seed}: 한 사람이 연속 결장 ${Math.max(...per.values())}회`);
  }
});

// 사용자가 "성별 구분 없이 편성"(잡복 허용)을 켜면 연속 결장을 잡복보다 먼저 줄인다
test('1코트 3남5여 · 잡복 허용 — 연속 결장이 기본(7회)보다 크게 줄고, 배너로 알림', () => {
  for (const seed of [1, 2, 3]) {
    const base = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(3, 5), seed, options: { courts: 1 } });
    const ig = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(3, 5), seed, options: { courts: 1, ignoreGender: true } });
    assert.equal(base.stats.japbokGames, 0, '기본은 잡복 0');
    assert.ok(ig.stats.consecutiveSits <= 4, `seed ${seed}: 잡복 허용인데 연속 결장 ${ig.stats.consecutiveSits}회`);
    assert.ok(ig.stats.consecutiveSits < base.stats.consecutiveSits);
    assert.equal(ig.stats.partnerRepeats, 0);
    assert.equal(ig.stats.mmVsWwGames, 0, '남복 팀 vs 여복 팀은 여전히 금지');
    assert.ok(ig.relaxationsApplied.some((m) => m.includes('연속 결장을 줄이기 위해 잡복')));
  }
});

test('잡복 허용이어도 연속 결장이 없는 구성은 잡복을 늘리지 않는다 (3남9여 2코트)', () => {
  for (const seed of [1, 2, 3, 4]) {
    const r = generateSchedule({ type: 'monthly', gamesPerPerson: 4, players: mk(3, 9), seed, options: { courts: 2, ignoreGender: true } });
    assert.equal(r.stats.consecutiveSits, 0);
    assert.equal(r.plan.options.sitsOverJapbok, false, '연속 결장이 없으면 기본 우선순위 결과를 그대로 쓴다');
  }
});
