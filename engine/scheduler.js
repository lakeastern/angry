// 공개 API: generateSchedule(config)
// config = {
//   type: 'regular' | 'monthly',            // 정기모임(2게임코트+레슨) | 월례대회(3게임코트)
//   rounds: 5,                              // 정기: 총 라운드 수
//   gamesPerPerson: 4,                      // 월례: 인당 게임 수
//   players: [{ id, name, gender:'M'|'W', score(성별 내 실력 순위, 1=최강),
//               prefs?:{gamePriority,newMember,mixedPreferred}, unavailableRounds?:[1-based] }],
//   options?: { maxDiff, tightRounds, allowConsecutiveSit, allowPartnerRepeat, ignoreGender },
//   seed?: number,
//   searchBudget?: { restarts, iters, polish } // 탐색 강도 (테스트용 축소 가능)
// }

import { buildPlan, SchedulerError } from './planner.js';
import { makeRng } from './rng.js';
import { constructSchedule } from './construct.js';
import { costOf, cmpCost, hillClimb } from './optimize.js';
import { validateSchedule, computeStats } from './validate.js';

export { SchedulerError } from './planner.js';
export { validateSchedule, computeStats } from './validate.js';

// 랭커 라운드 멤버 선정: 생성당 1회, 시드 rng로 랜덤 (재시도 간 고정 → 매 생성마다 조합이 달라짐)
// 동성복식 랭커: 참석자 상위 5명 풀에서 4명 / 혼복 랭커(혼복 위주 라운드와 겹칠 때): 남녀 각 상위 3명 풀에서 2명
function pickRankers(plan, rng) {
  const picks = {};
  if (plan.type !== 'regular') return picks;
  for (const rn of plan.options.rankerRounds) {
    const r = rn - 1;
    if (r < 0 || r >= plan.R) continue;
    const poolOf = (arr, size) =>
      arr.filter((p) => !p.unavailable.has(r)).sort((a, b) => a.score - b.score).slice(0, size);
    if (plan.options.mixedRounds.includes(rn)) {
      const pm = poolOf(plan.men, 3);
      const pw = poolOf(plan.women, 3);
      if (pm.length >= 2 && pw.length >= 2) {
        picks[r] = {
          type: 'mixed',
          men: rng.shuffle(pm).slice(0, 2).map((p) => p.id),
          women: rng.shuffle(pw).slice(0, 2).map((p) => p.id),
        };
      }
    } else {
      const entry = { type: 'same', men: [], women: [] };
      const pm = poolOf(plan.men, 5);
      if (pm.length >= 4) entry.men = rng.shuffle(pm).slice(0, 4).map((p) => p.id);
      const pw = poolOf(plan.women, 5);
      if (pw.length >= 4) entry.women = rng.shuffle(pw).slice(0, 4).map((p) => p.id);
      if (entry.men.length || entry.women.length) picks[r] = entry;
    }
  }
  return picks;
}

// 한 plan·opts로 멀티 리스타트 구성 → 최적 스케줄 반환
function solvePlan(plan, rng, budget, opts) {
  const rankerPicks = pickRankers(plan, rng);
  let best = null, bestCost = null;
  for (let i = 0; i < budget.restarts; i++) {
    const s = constructSchedule(plan, rng, { ...opts, rankerPicks });
    if (!s) continue;
    hillClimb(s, plan, rng, budget.iters);
    const c = costOf(s, plan);
    if (!best || cmpCost(c, bestCost) < 0) { best = s; bestCost = c; }
  }
  return best;
}

// 스케줄의 인당 게임 수 편차 (max−min, 출전자 기준)
function gameSpread(schedule, plan) {
  const st = computeStats(schedule, plan);
  const counts = [...st.perPlayer.values()].filter((s) => s.games + s.sits > 0).map((s) => s.games);
  return counts.length ? Math.max(...counts) - Math.min(...counts) : 0;
}

// 게임데이·앵그리대회: 인당 게임 수를 맞추기 위해 덜 중요한 제약부터 자동 완화(마지막 잡복)
function generateStrict(config, seed, rng, budget) {
  const userOpts = config.options || {};
  // 완화 사다리 (누적). 각 단계에서 인당 게임 수 편차가 목표치에 도달하면 멈춤.
  const ladder = [
    { add: {}, relax: [] },
    { add: { allowConsecutiveSit: true }, relax: ['연속 결장'] },
    { add: { allowConsecutiveSit: true, minMixedGames: 0 }, relax: ['연속 결장', '인당 최소 혼복'] },
    { add: { allowConsecutiveSit: true, minMixedGames: 0, allowPartnerRepeat: true }, relax: ['연속 결장', '인당 최소 혼복', '파트너 중복'] },
    { add: { allowConsecutiveSit: true, minMixedGames: 0, allowPartnerRepeat: true, ignoreGender: true }, relax: ['연속 결장', '인당 최소 혼복', '파트너 중복', '잡복(성별 무시 편성)'] },
  ];
  let best = null, bestSpread = Infinity, bestPlan = null, lastErr = null;
  for (const stage of ladder) {
    let plan;
    try {
      plan = buildPlan({ ...config, options: { ...userOpts, ...stage.add } });
    } catch (e) {
      lastErr = e; // 파리티 불가 등 → 다음(더 완화된) 단계에서 해소
      continue;
    }
    const slots = plan.totalGames * 4;
    const achievable = slots % plan.N === 0 ? 0 : 1; // 산술적으로 가능한 최소 편차
    // 잡복 단계는 잡복 최소화를 위해 탐색을 늘린다
    const stageBudget = stage.add.ignoreGender
      ? { restarts: budget.restarts * 2, iters: budget.iters * 2, polish: budget.polish }
      : budget;
    const s = solvePlan(plan, rng, stageBudget, stage.add);
    if (!s) continue;
    const spread = gameSpread(s, plan);
    if (spread < bestSpread) { best = s; bestSpread = spread; bestPlan = plan; }
    if (spread <= achievable) break; // 목표 달성 → 더 완화하지 않음
  }
  if (!best) throw lastErr || new SchedulerError('대진표를 구성하지 못했습니다. 인원·게임 수 설정을 조정해 주세요.');

  hillClimb(best, bestPlan, rng, budget.polish);
  const { errors, warnings, stats } = validateSchedule(best, bestPlan);
  // 실제 발생한 완화만 배너로 표시 (특히 잡복은 게임 수 명시)
  const applied = [];
  if (stats.consecutiveSits > 0) applied.push('연속 결장');
  if (stats.partnerRepeats > 0) applied.push('파트너 중복');
  if (stats.japbokGames > 0) applied.push(`잡복 ${stats.japbokGames}게임 (불가피)`);
  const relaxationsApplied = applied.length
    ? [`인당 게임 수를 맞추기 위해 최소한으로 완화했습니다: ${applied.join(' · ')}`]
    : [];
  return {
    type: bestPlan.type,
    rounds: best.rounds,
    seed,
    plan: bestPlan,
    errors,
    warnings: [...bestPlan.planWarnings, ...warnings],
    stats,
    relaxationsApplied,
  };
}

export function generateSchedule(config) {
  const seed = Number.isFinite(config.seed) ? config.seed >>> 0 : 20260718;
  const rng = makeRng(seed || 1);
  const budget = Object.assign({ restarts: 24, iters: 500, polish: 1500 }, config.searchBudget || {});

  // 게임데이·앵그리대회(내부 type 'monthly')는 기본적으로 인당 게임 수 우선(strict) 사다리 사용
  const isMT = config.type === 'monthly';
  const strict = isMT && (!config.options || config.options.strictGameCount !== false);
  if (strict) return generateStrict(config, seed, rng, budget);

  const plan = buildPlan(config);
  const rankerPicks = pickRankers(plan, rng);

  // 완화 사다리: 엄격 → 연속 결장 허용 → 파트너 중복 최소화. 앞 단계가 전멸했을 때만 다음 단계로.
  // 설정에서 강제로 허용한 항목은 첫 단계부터 켠 채 시작한다.
  const base = {};
  const baseRelax = [];
  if (plan.options.allowConsecutiveSit) {
    base.allowConsecutiveSit = true;
    baseRelax.push('연속 결장(레슨/대기)이 설정에 의해 허용되었습니다.');
  }
  if (plan.options.allowPartnerRepeat) {
    base.allowPartnerRepeat = true;
    baseRelax.push('파트너 중복이 설정에 의해 허용되었습니다 (중복 최소화로 배정).');
  }
  const stages = [{ opts: { ...base }, relaxations: [...baseRelax] }];
  if (!base.allowConsecutiveSit) {
    stages.push({
      opts: { ...base, allowConsecutiveSit: true },
      relaxations: [...baseRelax, '연속 결장(레슨/대기) 금지를 완화했습니다. 연속 결장을 최소화하는 방향으로 배정합니다.'],
    });
  }
  if (!base.allowPartnerRepeat) {
    stages.push({
      opts: { allowConsecutiveSit: true, allowPartnerRepeat: true },
      relaxations: [
        ...baseRelax,
        '연속 결장(레슨/대기) 금지를 완화했습니다.',
        '파트너 중복 0회 제약을 지킬 수 없어 "중복 최소화"로 완화했습니다.',
      ],
    });
  }

  let best = null;
  let bestCost = null;
  let usedStage = null;
  for (const stage of stages) {
    for (let i = 0; i < budget.restarts; i++) {
      const s = constructSchedule(plan, rng, { ...stage.opts, rankerPicks });
      if (!s) continue;
      hillClimb(s, plan, rng, budget.iters);
      const c = costOf(s, plan);
      if (!best || cmpCost(c, bestCost) < 0) {
        best = s;
        bestCost = c;
      }
    }
    if (best) {
      usedStage = stage;
      break;
    }
  }

  if (!best) {
    throw new SchedulerError('대진표를 구성하지 못했습니다. 인원 구성이나 라운드 설정을 조정해 다시 시도해주세요.');
  }

  hillClimb(best, plan, rng, budget.polish);

  const { errors, warnings, stats } = validateSchedule(best, plan);
  return {
    type: plan.type,
    rounds: best.rounds,
    seed,
    plan,
    errors,
    warnings: [...plan.planWarnings, ...warnings],
    stats,
    relaxationsApplied: usedStage.relaxations,
  };
}
