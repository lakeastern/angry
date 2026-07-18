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

export function generateSchedule(config) {
  const plan = buildPlan(config);
  const seed = Number.isFinite(config.seed) ? config.seed >>> 0 : 20260718;
  const rng = makeRng(seed || 1);
  const budget = Object.assign({ restarts: 24, iters: 500, polish: 1500 }, config.searchBudget || {});

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
      const s = constructSchedule(plan, rng, stage.opts);
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
