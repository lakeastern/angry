// 5~18명 남녀 전 조합 × 정기/게임데이 자동 검증.
// 성공 시: 하드 제약 위반 0 (파트너 중복·연속 결장은 완화 명시 시에만 허용).
// 실패 시: 문서화된 SchedulerError(사전 감지된 불가능 케이스)여야 한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule, SchedulerError } from '../engine/scheduler.js';

function makePlayers(M, W) {
  return [
    ...Array.from({ length: M }, (_, i) => ({ id: `m${i + 1}`, name: `남자${i + 1}`, gender: 'M', score: i + 1 })),
    ...Array.from({ length: W }, (_, i) => ({ id: `w${i + 1}`, name: `여자${i + 1}`, gender: 'W', score: i + 1 })),
  ];
}

// 사전에 알려진 구조적 불가능 케이스
function expectedInfeasible(type, M, W) {
  if (M === 1 || W === 1) return true;
  const N = M + W;
  if (M % 2 === 1) {
    if (type === 'regular' && N === 8) return true; // 전원 출전 + 남자 홀수
    if (type === 'monthly' && (N === 8 || N === 12)) return true; // 매 라운드 대기 0명 + 남자 홀수
  }
  return false;
}

const HARD_STRUCTURAL = ['E_DUP_ASSIGN', 'E_EXCLUDED_ASSIGNED', 'E_JAPBOK', 'E_BAD_GAME', 'E_UNASSIGNED', 'E_UNKNOWN_PLAYER'];
const BUDGET = { restarts: 8, iters: 250, polish: 400 };

for (const type of ['regular', 'monthly']) {
  for (let N = 5; N <= 18; N++) {
    for (let M = Math.max(0, N - 15); M <= Math.min(12, N); M++) {
      const W = N - M;
      const name = `${type} 남${M} 여${W} (${N}명)`;
      test(name, () => {
        const config = {
          type,
          rounds: 5,
          gamesPerPerson: 4,
          players: makePlayers(M, W),
          seed: 20260718,
          searchBudget: BUDGET,
        };
        let res;
        try {
          res = generateSchedule(config);
        } catch (e) {
          assert.ok(e instanceof SchedulerError, `${name}: SchedulerError가 아닌 예외 — ${e.stack}`);
          assert.ok(expectedInfeasible(type, M, W), `${name}: 예상치 못한 불가능 판정 — ${e.message}`);
          return;
        }
        assert.ok(!expectedInfeasible(type, M, W), `${name}: 불가능해야 하는 조합인데 성공했습니다.`);

        // 하드 제약: 구조적 위반은 어떤 경우에도 0
        const structural = res.errors.filter((e) => HARD_STRUCTURAL.includes(e.code));
        assert.deepEqual(structural, [], `${name}: 구조적 위반 발생`);

        // 파트너 중복: 완화가 명시된 경우에만 허용
        const partnerRelaxed = res.relaxationsApplied.some((r) => r.includes('파트너'));
        const partnerErrors = res.errors.filter((e) => e.code === 'E_PARTNER_REPEAT');
        if (!partnerRelaxed) {
          assert.deepEqual(partnerErrors, [], `${name}: 완화 없이 파트너 중복 발생`);
        }

        // 연속 결장: 완화가 명시된 경우에만 허용
        const sitRelaxed = res.relaxationsApplied.some((r) => r.includes('연속'));
        if (!sitRelaxed) {
          assert.equal(res.stats.consecutiveSits, 0, `${name}: 완화 없이 연속 결장 발생`);
        }

        // 라운드 구조: 계획된 코트 수만큼 게임, 각 게임 4인
        res.rounds.forEach((rd, r) => {
          assert.equal(rd.games.length, res.plan.courtsPerRound[r], `${name}: ${r + 1}라운드 코트 수 불일치`);
          for (const g of rd.games) {
            const all = [...g.teams[0], ...g.teams[1]];
            assert.equal(new Set(all).size, 4, `${name}: ${r + 1}라운드 게임 인원 오류`);
          }
        });

        // 게임 수 편차는 완화 케이스가 아니면 2 이하 (성별 강제 편차 케이스 포함 상한)
        assert.ok(res.stats.spreadPenalty <= 2, `${name}: 게임 수 편차 과다 (${JSON.stringify(res.stats.spreadDetails)})`);
      });
    }
  }
}
