// Phase C: 사전식(lexicographic) 비용 튜플 + 하드 제약 보존형 이웃 연산으로 로컬 서치.

import { computeStats } from './validate.js';

// 우선순위 순서 그대로의 비용 튜플 — 앞 요소부터 비교하므로 가중치 역전이 없다.
export function costOf(schedule, plan) {
  const st = computeStats(schedule, plan);
  return [
    st.structural.length * 10 + st.partnerRepeats, // 하드 (항상 0이어야 함)
    st.consecutiveSits * 2 + st.spreadPenalty * 2, // 준하드: 연속 결장 + 게임 수 편차
    st.rankerMiss, // 랭커 라운드: 상위 풀 멤버로 구성된 랭커 게임 보장
    st.diffCapViolations + st.meetCapViolations, // 점수차·같은 상대 상한(설정) 위반
    st.rotationMiss + st.newMemberLessonMiss, // 레슨 로테이션(정기)
    st.mixedUncovered, // 게임데이 인당 최소 혼복 게임 수 부족분 합
    st.earlyTightness, // 빡겜: 같은 게임 4인의 실력 폭 최소화
    // 상대 중복(5순위)과 점수 균형(6순위)은 인접 계층이라 가중 합산으로 묶는다.
    // 사전식으로 완전 분리하면 재대면 1회를 피하려고 점수차 7짜리 게임을 만드는 왜곡이 생긴다.
    st.opponentPenalty * 8 + st.scoreDiffSq,
    st.traitPenalty, // 개인 특성 매칭
    st.typePrefCost, // 라운드별 유형 선호
    st.lessonSkillSpread, // 레슨 그룹 실력 유사성
  ];
}

export function cmpCost(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function listSlots(rd) {
  const slots = [];
  rd.games.forEach((g, gi) => {
    g.teams.forEach((team, ti) => {
      team.forEach((id, si) => {
        slots.push({ kind: 'game', gi, ti, id, set: (v) => (g.teams[ti][si] = v) });
      });
    });
  });
  rd.lesson.forEach((id, li) => {
    slots.push({ kind: 'lesson', li, id, set: (v) => (rd.lesson[li] = v) });
  });
  return slots;
}

// 같은 성별끼리만 교환하므로 게임 유형(남복/여복/혼복)이 항상 보존된다.
function proposeMove(schedule, plan, rng) {
  const R = schedule.rounds.length;
  if (rng.next() < 0.88) {
    const r = rng.int(R);
    const rd = schedule.rounds[r];
    const slots = listSlots(rd);
    if (slots.length < 2) return null;
    const s1 = rng.pick(slots);
    const g1 = plan.byId.get(s1.id).gender;
    const cands = slots.filter((s2) => {
      if (s2 === s1) return false;
      if (plan.byId.get(s2.id).gender !== g1) return false;
      if (s1.kind === 'lesson' && s2.kind === 'lesson') return false; // 무의미
      if (s1.kind === 'game' && s2.kind === 'game' && s1.gi === s2.gi && s1.ti === s2.ti) return false; // 같은 팀
      return true;
    });
    if (!cands.length) return null;
    const s2 = rng.pick(cands);
    const id1 = s1.id;
    const id2 = s2.id;
    return {
      apply() {
        s1.set(id2);
        s2.set(id1);
      },
      revert() {
        s1.set(id1);
        s2.set(id2);
      },
    };
  }
  // 라운드 순서 교환 — 연속 결장 패턴·유형 선호(짝수 라운드 혼복) 개선용.
  // 제외 인원이나 코트 수가 다른 라운드끼리 바꾸면 하드 제약이 깨지므로 동일할 때만 허용.
  if (R < 2) return null;
  const r1 = rng.int(R);
  let r2 = rng.int(R);
  if (r1 === r2) r2 = (r2 + 1) % R;
  const a = schedule.rounds[r1];
  const b = schedule.rounds[r2];
  const sameExcluded =
    a.excluded.length === b.excluded.length && a.excluded.every((id) => b.excluded.includes(id));
  if (!sameExcluded || a.games.length !== b.games.length) return null;
  return {
    apply() {
      const t = schedule.rounds[r1];
      schedule.rounds[r1] = schedule.rounds[r2];
      schedule.rounds[r2] = t;
    },
    revert() {
      const t = schedule.rounds[r1];
      schedule.rounds[r1] = schedule.rounds[r2];
      schedule.rounds[r2] = t;
    },
  };
}

export function hillClimb(schedule, plan, rng, iters) {
  let bestCost = costOf(schedule, plan);
  for (let i = 0; i < iters; i++) {
    const move = proposeMove(schedule, plan, rng);
    if (!move) continue;
    move.apply();
    const c = costOf(schedule, plan);
    const cmp = cmpCost(c, bestCost);
    if (cmp < 0 || (cmp === 0 && rng.next() < 0.35)) {
      bestCost = c;
    } else {
      move.revert();
    }
  }
  return bestCost;
}
