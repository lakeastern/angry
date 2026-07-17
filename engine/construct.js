// Phase B: 라운드별 구성 — 레슨(결장)자 선정 → 파트너 페어링(백트래킹) → 매치업.
// 하드 제약(1인 1게임, 잡복 금지, 파트너 중복 0)은 여기서 구조적으로 보장한다.

import { pairKey } from './validate.js';
import { enumerateCompositions } from './planner.js';

export function constructSchedule(plan, rng, opts = {}) {
  const { allowPartnerRepeat = false, allowConsecutiveSit = false } = opts;

  const games = new Map(); // id → 게임 수
  const sits = new Map(); // id → 결장(레슨/대기) 수
  const mixed = new Map(); // id → 혼복 수
  const lessoned = new Set(); // 한 번이라도 결장(=레슨)한 사람
  const partnersUsed = new Map(); // pairKey → 횟수
  const meets = new Map(); // pairKey → 상대로 만난 횟수
  let satPrev = new Set();
  for (const p of plan.players) {
    games.set(p.id, 0);
    sits.set(p.id, 0);
    mixed.set(p.id, 0);
  }

  const rounds = [];

  for (let r = 0; r < plan.R; r++) {
    const C = plan.courtsPerRound[r];
    const avail = plan.players.filter((p) => !p.unavailable.has(r));
    const excluded = plan.players.filter((p) => p.unavailable.has(r)).map((p) => p.id);
    const availM = avail.filter((p) => p.gender === 'M').sort((a, b) => a.score - b.score);
    const availW = avail.filter((p) => p.gender === 'W').sort((a, b) => a.score - b.score);
    const requiredIds = new Set(avail.filter((p) => satPrev.has(p.id)).map((p) => p.id));
    const reqM = availM.filter((p) => requiredIds.has(p.id)).length;
    const reqW = availW.filter((p) => requiredIds.has(p.id)).length;

    let comps = enumerateCompositions(C, availM.length, availW.length);
    if (comps.length === 0) return null;
    const fitting = comps.filter((cp) => cp.m >= reqM && cp.w >= reqW);
    if (fitting.length) comps = fitting;
    else if (!allowConsecutiveSit) return null;

    // 라운드 목표 혼복 수: 정기 짝수 라운드는 최대, 그 외 최소. 월례는 커버리지 긴급도만큼.
    const cVals = comps.map((cp) => cp.c);
    const cMin = Math.min(...cVals);
    const cMax = Math.max(...cVals);
    let cTarget;
    if (plan.type === 'regular') {
      cTarget = (r + 1) % 2 === 0 ? cMax : cMin;
    } else {
      let urgency = 0;
      if (plan.M > 0 && plan.W > 0) {
        const uncovM = plan.men.filter((p) => mixed.get(p.id) === 0).length;
        const uncovW = plan.women.filter((p) => mixed.get(p.id) === 0).length;
        const needGames = Math.max(Math.ceil(uncovM / 2), Math.ceil(uncovW / 2));
        urgency = Math.ceil(needGames / (plan.R - r));
      }
      cTarget = Math.min(cMax, Math.max(cMin, urgency));
    }

    // 남녀 출전 배분 목표: 성별 잔여 게임 부족분(deficit)에 비례
    const deficit = (pool) =>
      pool.reduce((acc, p) => acc + Math.max(0.1, plan.targetGames - games.get(p.id)), 0);
    const defM = deficit(availM);
    const defW = deficit(availW);
    const idealM = (4 * C * defM) / (defM + defW || 1);

    // 성별 출전 균형(게임 수 균등, 4순위)이 유형 선호(10순위)보다 우선하도록 가중
    const ranked = comps
      .map((cp) => ({ cp, s: Math.abs(cp.m - idealM) * 40 + Math.abs(cp.c - cTarget) * 12 + rng.jitter(5) }))
      .sort((a, b) => a.s - b.s)
      .map((o) => o.cp);

    let built = null;
    for (const comp of ranked) {
      built = tryBuildRound(comp);
      if (built) break;
    }
    if (!built) return null;

    // 커밋
    const courtLetters = ['a', 'b', 'c'];
    const roundGames = built.games.map((g, i) => ({
      court: courtLetters[i],
      type: g.type,
      teams: g.teams.map((team) => team.map((p) => p.id)),
      result: null,
    }));
    for (const g of built.games) {
      for (const team of g.teams) {
        const k = pairKey(team[0].id, team[1].id);
        partnersUsed.set(k, (partnersUsed.get(k) || 0) + 1);
      }
      for (const x of g.teams[0]) for (const y of g.teams[1]) {
        const k = pairKey(x.id, y.id);
        meets.set(k, (meets.get(k) || 0) + 1);
      }
      for (const p of [...g.teams[0], ...g.teams[1]]) {
        games.set(p.id, games.get(p.id) + 1);
        if (g.type === 'MX') mixed.set(p.id, mixed.get(p.id) + 1);
      }
    }
    for (const p of built.sitters) {
      sits.set(p.id, sits.get(p.id) + 1);
      lessoned.add(p.id);
    }
    satPrev = new Set(built.sitters.map((p) => p.id));
    rounds.push({
      games: roundGames,
      lesson: built.sitters.map((p) => p.id),
      excluded,
    });

    // ─── 라운드 내부 헬퍼 ───

    function tryBuildRound(comp) {
      // 1) 결장자(레슨/대기) 선정
      const sitM = pickSitters(availM, availM.length - comp.m);
      if (!sitM) return null;
      const sitW = pickSitters(availW, availW.length - comp.w);
      if (!sitW) return null;
      const sitIds = new Set([...sitM, ...sitW].map((p) => p.id));
      const playingM = availM.filter((p) => !sitIds.has(p.id));
      const playingW = availW.filter((p) => !sitIds.has(p.id));

      // 2) 혼복 인원 선발 + 페어링 (실패 시 혼복 인원을 바꿔 재시도)
      for (let attempt = 0; attempt < 4; attempt++) {
        const mxMen = pickTop(playingM, 2 * comp.c, mxScore);
        const mxWomen = pickTop(playingW, 2 * comp.c, mxScore);
        const mxMenIds = new Set(mxMen.map((p) => p.id));
        const mxWomenIds = new Set(mxWomen.map((p) => p.id));
        const mmPool = playingM.filter((p) => !mxMenIds.has(p.id));
        const wwPool = playingW.filter((p) => !mxWomenIds.has(p.id));

        const mmPairs = pairUpSame(mmPool);
        if (!mmPairs) continue;
        const wwPairs = pairUpSame(wwPool);
        if (!wwPairs) continue;
        const mxPairs = pairUpMixed(mxMen, mxWomen);
        if (!mxPairs) continue;

        // 3) 매치업 — 같은 유형의 페어끼리 게임으로 결합
        const mmGames = bestMatchup(mmPairs);
        const wwGames = bestMatchup(wwPairs);
        const mxGames = bestMatchup(mxPairs);
        if (!mmGames || !wwGames || !mxGames) continue;

        const gamesOut = [
          ...mmGames.map((t) => ({ type: 'MM', teams: t })),
          ...wwGames.map((t) => ({ type: 'WW', teams: t })),
          ...mxGames.map((t) => ({ type: 'MX', teams: t })),
        ];
        return { games: gamesOut, sitters: [...sitM, ...sitW] };
      }
      return null;
    }

    function pickSitters(pool, count) {
      if (count <= 0) return [];
      let cands = pool.filter((p) => !requiredIds.has(p.id));
      if (cands.length < count) {
        if (!allowConsecutiveSit) return null;
        const extra = pool
          .filter((p) => requiredIds.has(p.id))
          .sort((a, b) => sits.get(a.id) - sits.get(b.id) + rng.jitter(0.5));
        cands = cands.concat(extra);
      }
      return cands
        .map((p) => ({ p, s: sitScore(p) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, count)
        .map((o) => o.p);
    }

    // 결장 우선순위: 게임 수 많음 > (정기 초반) 미레슨자 > 신규회원 레슨 특전 > 게임선호는 후순위
    function sitScore(p) {
      let s = games.get(p.id) * 100;
      if (plan.type === 'regular' && r < 3 && !lessoned.has(p.id)) s += 30;
      if (plan.type === 'regular' && p.prefs.newMember && sits.get(p.id) === 0) s += 20;
      if (p.prefs.gamePriority) s -= 35;
      s += rng.jitter(8);
      return s;
    }

    // 혼복 슬롯 우선순위: 월례는 혼복 미경험자, 정기는 혼복선호자
    function mxScore(p) {
      let s = 0;
      if (plan.type === 'monthly' && mixed.get(p.id) === 0) s += 50;
      if (plan.type === 'regular' && p.prefs.mixedPreferred) s += 50;
      s += rng.jitter(20);
      return s;
    }

    function pickTop(pool, count, scoreFn) {
      return pool
        .map((p) => ({ p, s: scoreFn(p) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, count)
        .map((o) => o.p);
    }

    // 동성 풀을 미사용 페어로 완전 분할 (MRV + 백트래킹)
    function pairUpSame(pool) {
      if (pool.length === 0) return [];
      const avgSum = (2 * pool.reduce((a, p) => a + p.score, 0)) / pool.length;
      return recPair(pool, avgSum);
    }

    function recPair(remaining, avgSum) {
      if (remaining.length === 0) return [];
      let best = null;
      for (const p of remaining) {
        const cands = remaining.filter(
          (q) => q !== p && (allowPartnerRepeat || !partnersUsed.has(pairKey(p.id, q.id)))
        );
        if (cands.length === 0) return null;
        if (!best || cands.length < best.cands.length) best = { p, cands };
      }
      const { p, cands } = best;
      const ordered = cands
        .map((q) => ({ q, s: partnerOrderScore(p, q, avgSum) }))
        .sort((a, b) => a.s - b.s)
        .map((o) => o.q);
      for (const q of ordered) {
        const rest = remaining.filter((x) => x !== p && x !== q);
        const res = recPair(rest, avgSum);
        if (res) return [[p, q], ...res];
      }
      return null;
    }

    // 혼복 페어: 남↔여 이분 매칭 (MRV + 백트래킹)
    function pairUpMixed(menPool, womenPool) {
      if (menPool.length === 0) return [];
      const all = [...menPool, ...womenPool];
      const avgSum = (2 * all.reduce((a, p) => a + p.score, 0)) / all.length;
      const rec = (menLeft, womenLeft) => {
        if (menLeft.length === 0) return [];
        let best = null;
        for (const p of menLeft) {
          const cands = womenLeft.filter(
            (q) => allowPartnerRepeat || !partnersUsed.has(pairKey(p.id, q.id))
          );
          if (cands.length === 0) return null;
          if (!best || cands.length < best.cands.length) best = { p, cands };
        }
        const { p, cands } = best;
        const ordered = cands
          .map((q) => ({ q, s: partnerOrderScore(p, q, avgSum) }))
          .sort((a, b) => a.s - b.s)
          .map((o) => o.q);
        for (const q of ordered) {
          const res = rec(
            menLeft.filter((x) => x !== p),
            womenLeft.filter((x) => x !== q)
          );
          if (res) return [[p, q], ...res];
        }
        return null;
      };
      return rec(menPool, womenPool);
    }

    // 파트너 후보 순서: 팀 합이 풀 평균에 가깝게(균형 밑작업), 신규회원은 강자와, 중복 허용 시 덜 쓴 조합부터
    function partnerOrderScore(p, q, avgSum) {
      let s = Math.abs(p.score + q.score - avgSum);
      if (allowPartnerRepeat) s += (partnersUsed.get(pairKey(p.id, q.id)) || 0) * 100;
      if (p.prefs.newMember || q.prefs.newMember) s += Math.min(p.score, q.score) * 0.8;
      s += rng.jitter(1.5);
      return s;
    }

    // 같은 유형 페어들을 2개씩 묶어 게임으로 — 상대 중복·점수차 최소 조합 선택
    function bestMatchup(pairs) {
      if (pairs.length === 0) return [];
      if (pairs.length % 2 !== 0) return null;
      const options = enumerateMatchings(pairs);
      let best = null;
      let bestCost = Infinity;
      for (const opt of options) {
        let cost = rng.jitter(0.5);
        for (const [A, B] of opt) {
          let meetPen = 0;
          for (const x of A) for (const y of B) meetPen += meets.get(pairKey(x.id, y.id)) || 0;
          const sum = (t) => t[0].score + t[1].score;
          cost += meetPen * 10 + Math.abs(sum(A) - sum(B));
          const four = [...A, ...B];
          if (four.some((p) => p.prefs.newMember)) cost += Math.min(...four.map((p) => p.score)) * 0.3;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = opt;
        }
      }
      return best;
    }

    function enumerateMatchings(pairs) {
      if (pairs.length === 0) return [[]];
      const [first, ...rest] = pairs;
      const out = [];
      for (let i = 0; i < rest.length; i++) {
        const partner = rest[i];
        const remaining = rest.filter((_, j) => j !== i);
        for (const sub of enumerateMatchings(remaining)) {
          out.push([[first, partner], ...sub]);
        }
      }
      return out;
    }
  }

  return { type: plan.type, rounds };
}
