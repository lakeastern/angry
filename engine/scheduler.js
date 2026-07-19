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
import { validateSchedule } from './validate.js';

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

export function generateSchedule(config) {
  const plan = buildPlan(config);
  const seed = Number.isFinite(config.seed) ? config.seed >>> 0 : 20260718;
  const rng = makeRng(seed || 1);
  const budget = Object.assign({ restarts: 24, iters: 500, polish: 1500 }, config.searchBudget || {});
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
