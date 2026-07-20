// Phase B: 라운드별 구성 — 레슨(결장)자 선정 → 파트너 페어링(백트래킹) → 매치업.
// 하드 제약(1인 1게임, 잡복 금지, 파트너 중복 0)은 여기서 구조적으로 보장한다.

import { pairKey } from './validate.js';
import { enumerateCompositions } from './planner.js';

export function constructSchedule(plan, rng, opts = {}) {
  const { allowPartnerRepeat = false, allowConsecutiveSit = false } = opts;
  const ignoreGender = !!(plan.options && plan.options.ignoreGender);
  const maxDiff = plan.options ? plan.options.maxDiff : null;
  const maxMeet = plan.options ? plan.options.maxMeet : null;
  const tightRounds = plan.options && Array.isArray(plan.options.tightRounds) ? plan.options.tightRounds : [];
  const mixedRounds = plan.options && plan.options.mixedRounds ? plan.options.mixedRounds : [1, 3];
  // 게임데이 인당 최소 혼복 게임 수 (정기모임은 0 → 혼복 강제 없음)
  const minMixed = plan.type === 'monthly' && plan.options ? plan.options.minMixedGames || 0 : 0;

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

  // 랭커 라운드 선정 멤버 (scheduler에서 생성당 1회 랜덤 선정)
  const rankerPicks = opts.rankerPicks || {};
  const rankerIdsOf = (r) => {
    const pk = rankerPicks[r];
    return pk ? new Set([...pk.men, ...pk.women]) : null;
  };

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

    // 라운드 목표 혼복 수: 정기는 혼복 위주 라운드(설정, 기본 1·3)에서 최대, 그 외 최소.
    // 게임데이는 인당 최소 혼복(minMixed) 달성을 위한 잔여 부족분 기반 긴급도만큼.
    const cVals = comps.map((cp) => cp.c);
    const cMin = Math.min(...cVals);
    const cMax = Math.max(...cVals);
    const isMixedRound = plan.type === 'regular' && mixedRounds.includes(r + 1);
    let cTarget;
    if (plan.type === 'regular') {
      cTarget = isMixedRound ? cMax : cMin;
    } else if (minMixed > 0 && plan.M > 0 && plan.W > 0) {
      const deficit = (pool) => pool.reduce((acc, p) => acc + Math.max(0, minMixed - mixed.get(p.id)), 0);
      const needGames = Math.max(Math.ceil(deficit(plan.men) / 2), Math.ceil(deficit(plan.women) / 2));
      const urgency = Math.ceil(needGames / (plan.R - r));
      cTarget = Math.min(cMax, Math.max(cMin, urgency));
    } else {
      cTarget = cMin;
    }

    // 남녀 출전 배분 목표: 성별 잔여 게임 부족분(deficit)에 비례
    const deficit = (pool) =>
      pool.reduce((acc, p) => acc + Math.max(0.1, plan.targetGames - games.get(p.id)), 0);
    const defM = deficit(availM);
    const defW = deficit(availW);
    const idealM = (4 * C * defM) / (defM + defW || 1);

    // 성별 출전 균형(게임 수 균등, 4순위)이 유형 선호(10순위)보다 우선하도록 가중(40 미만).
    // 정기의 동성복식 선호 라운드(혼복 지정 외 전체)는 혼복 배제를 강하게 반영
    const typeWeight = plan.type === 'regular' && !isMixedRound ? 22 : 12;
    const ranked = comps
      .map((cp) => ({ cp, s: Math.abs(cp.m - idealM) * 40 + Math.abs(cp.c - cTarget) * typeWeight + rng.jitter(5) }))
      .sort((a, b) => a.s - b.s)
      .map((o) => o.cp);

    // 라이벌 라운드는 실력 인접 4명 청크 구성을 우선 시도, 실패 시 일반 구성으로 폴백
    const tight = tightRounds.includes(r + 1);
    // 랭커 라운드: 선정된 상위 랭커끼리 게임 우선
    const ranker = rankerPicks[r] || null;
    const rankerIds = ranker ? new Set([...ranker.men, ...ranker.women]) : null;
    let built = null;
    for (const comp of ranked) {
      // 랭커 라운드는 랜덤 선정 멤버를 써야 하므로 실력순 청크(tight) 대신 랭커 조립 경로 사용
      if (tight && !ranker) built = tryBuildRoundTight(comp);
      if (!built) built = tryBuildRound(comp);
      if (built) break;
    }
    if (!built) return null;

    // 커밋 — 게임 순서가 항상 남복→여복→혼복이라 남복이 a코트에 고정되는 것을 막기 위해
    // 라운드 인덱스만큼 회전시켜 코트 배정을 순환시킨다
    const courtLetters = ['a', 'b', 'c'];
    const rot = built.games.length > 1 ? r % built.games.length : 0;
    const orderedGames = [...built.games.slice(rot), ...built.games.slice(0, rot)];
    const roundGames = orderedGames.map((g, i) => ({
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

      // 2) 랭커 게임 우선 조립 → 혼복 인원 선발 + 페어링 (실패 시 인원을 바꿔 재시도)
      for (let attempt = 0; attempt < 4; attempt++) {
        // 랭커 라운드: 선정 멤버로 랭커 게임을 먼저 만든다 (불가하면 일반 구성으로 폴백)
        const pre = { mm: null, ww: null, mx: null };
        const usedIds = new Set();
        if (ranker) {
          const playingIds = new Set([...playingM, ...playingW].map((p) => p.id));
          const resolve = (ids, pool) => ids.map((id) => pool.find((p) => p.id === id));
          if (ranker.type === 'same') {
            if (ranker.men.length === 4 && comp.a >= 1 && ranker.men.every((id) => playingIds.has(id))) {
              const g = chunkGameSame(resolve(ranker.men, playingM).sort((a, b) => a.score - b.score), 'MM');
              if (g) {
                pre.mm = g;
                ranker.men.forEach((id) => usedIds.add(id));
              }
            }
            if (ranker.women.length === 4 && comp.b >= 1 && ranker.women.every((id) => playingIds.has(id))) {
              const g = chunkGameSame(resolve(ranker.women, playingW).sort((a, b) => a.score - b.score), 'WW');
              if (g) {
                pre.ww = g;
                ranker.women.forEach((id) => usedIds.add(id));
              }
            }
          } else if (comp.c >= 1 && [...ranker.men, ...ranker.women].every((id) => playingIds.has(id))) {
            const g = chunkGameMixed(resolve(ranker.men, playingM), resolve(ranker.women, playingW));
            if (g) {
              pre.mx = g;
              [...ranker.men, ...ranker.women].forEach((id) => usedIds.add(id));
            }
          }
        }
        const remM = playingM.filter((p) => !usedIds.has(p.id));
        const remW = playingW.filter((p) => !usedIds.has(p.id));
        const mxNeed = 2 * comp.c - (pre.mx ? 2 : 0);
        const mxMen = pickTop(remM, mxNeed, mxScore);
        const mxWomen = pickTop(remW, mxNeed, mxScore);
        const mxMenIds = new Set(mxMen.map((p) => p.id));
        const mxWomenIds = new Set(mxWomen.map((p) => p.id));
        const mmPool = remM.filter((p) => !mxMenIds.has(p.id));
        const wwPool = remW.filter((p) => !mxWomenIds.has(p.id));

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
          ...(pre.mm ? [pre.mm] : []),
          ...mmGames.map((t) => ({ type: 'MM', teams: t })),
          ...(pre.ww ? [pre.ww] : []),
          ...wwGames.map((t) => ({ type: 'WW', teams: t })),
          ...(pre.mx ? [pre.mx] : []),
          ...mxGames.map((t) => ({ type: 'MX', teams: t })),
        ];
        return { games: gamesOut, sitters: [...sitM, ...sitW] };
      }
      return null;
    }

    // 라이벌 라운드 구성: 실력순 인접 4명(혼복은 남2+여2)이 한 게임이 되도록 청크 분할
    function tryBuildRoundTight(comp) {
      const sitM = pickSitters(availM, availM.length - comp.m);
      if (!sitM) return null;
      const sitW = pickSitters(availW, availW.length - comp.w);
      if (!sitW) return null;
      const sitIds = new Set([...sitM, ...sitW].map((p) => p.id));
      const playingM = availM.filter((p) => !sitIds.has(p.id)).sort((a, b) => a.score - b.score);
      const playingW = availW.filter((p) => !sitIds.has(p.id)).sort((a, b) => a.score - b.score);

      const mmMen = playingM.slice(0, 4 * comp.a);
      const mxMen = playingM.slice(4 * comp.a);
      const wwWomen = playingW.slice(0, 4 * comp.b);
      const mxWomen = playingW.slice(4 * comp.b);

      const games = [];
      for (let i = 0; i < comp.a; i++) {
        const g = chunkGameSame(mmMen.slice(4 * i, 4 * i + 4), 'MM');
        if (!g) return null;
        games.push(g);
      }
      for (let i = 0; i < comp.b; i++) {
        const g = chunkGameSame(wwWomen.slice(4 * i, 4 * i + 4), 'WW');
        if (!g) return null;
        games.push(g);
      }
      for (let i = 0; i < comp.c; i++) {
        const g = chunkGameMixed(mxMen.slice(2 * i, 2 * i + 2), mxWomen.slice(2 * i, 2 * i + 2));
        if (!g) return null;
        games.push(g);
      }
      return { games, sitters: [...sitM, ...sitW] };
    }

    function pairFree(x, y) {
      return allowPartnerRepeat || !partnersUsed.has(pairKey(x.id, y.id));
    }

    // 실력순 4명 [s1,s2,s3,s4]의 팀 분할 — 합 균형이 좋은 순서(1·4 vs 2·3 우선)로 미사용 페어 조합 선택
    function chunkGameSame(four, type) {
      const splits = [
        [[0, 3], [1, 2]],
        [[0, 2], [1, 3]],
        [[0, 1], [2, 3]],
      ];
      let best = null;
      let bestDiff = Infinity;
      for (const [i1, i2] of splits) {
        const t1 = i1.map((i) => four[i]);
        const t2 = i2.map((i) => four[i]);
        if (!pairFree(t1[0], t1[1]) || !pairFree(t2[0], t2[1])) continue;
        const diff = Math.abs(t1[0].score + t1[1].score - t2[0].score - t2[1].score);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = { type, teams: [t1, t2] };
        }
      }
      return best;
    }

    function chunkGameMixed(men2, women2) {
      const splits = [
        [[men2[0], women2[1]], [men2[1], women2[0]]],
        [[men2[0], women2[0]], [men2[1], women2[1]]],
      ];
      let best = null;
      let bestDiff = Infinity;
      for (const [t1, t2] of splits) {
        if (!pairFree(t1[0], t1[1]) || !pairFree(t2[0], t2[1])) continue;
        const diff = Math.abs(t1[0].score + t1[1].score - t2[0].score - t2[1].score);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = { type: 'MX', teams: [t1, t2] };
        }
      }
      return best;
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

    // 결장 우선순위: 게임 수 많음 > (정기 초반) 미레슨자 > 신규회원 레슨 특전 > 게임선호는 후순위.
    // 2라운드는 상위 랭커(1~4위)가 출전하도록 결장 후순위.
    function sitScore(p) {
      let s = games.get(p.id) * 100;
      if (plan.type === 'regular' && r < 3 && !lessoned.has(p.id)) s += 30;
      if (plan.type === 'regular' && p.prefs.newMember && sits.get(p.id) === 0) s += 20;
      if (p.prefs.gamePriority) s -= 35;
      if (rankerIds && rankerIds.has(p.id)) s -= 60;
      // 선행 배치: 다음 라운드 랭커 멤버는 이번 라운드에 결장(레슨)해 두면
      // 연속 결장 금지에 의해 다음 라운드 출전이 보장된다 (이번 라운드도 랭커 라운드면 생략)
      const nextRanker = rankerPicks[r + 1];
      if (!ranker && nextRanker && rankerIdsOf(r + 1).has(p.id)) s += 40;
      s += rng.jitter(8);
      return s;
    }

    // 혼복 슬롯 우선순위: 게임데이는 혼복 부족자(부족분 비례), 정기는 혼복선호자.
    // 랭커 라운드 상위 랭커는 남복/여복에 남도록 혼복 후순위.
    function mxScore(p) {
      let s = 0;
      if (minMixed > 0 && mixed.get(p.id) < minMixed) s += 50 * (minMixed - mixed.get(p.id));
      if (plan.type === 'regular' && p.prefs.mixedPreferred) s += 50;
      // 동성복식 랭커 멤버는 혼복 후순위, 혼복 랭커 멤버는 혼복 우선
      if (ranker && rankerIds.has(p.id)) s += ranker.type === 'mixed' ? 120 : -120;
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
      // 성별 무시 편성: 혼성 페어(남+여)를 선호해 남복/여복 팀 자체가 덜 생기게 한다.
      // → 남복 팀 vs 여복 팀(남남 vs 여여) 대진이 구조적으로 거의 발생하지 않음.
      if (ignoreGender && (p.realGender || p.gender) !== (q.realGender || q.gender)) s -= 6;
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
          for (const x of A) for (const y of B) {
            const met = meets.get(pairKey(x.id, y.id)) || 0;
            meetPen += met;
            if (maxMeet != null && met >= maxMeet) cost += 500; // 이 게임으로 상대 상한 초과 → 사실상 배제
          }
          const sum = (t) => t[0].score + t[1].score;
          const diff = Math.abs(sum(A) - sum(B));
          cost += meetPen * 10 + diff;
          if (maxDiff != null && diff > maxDiff) cost += 500 * (diff - maxDiff); // 점수차 상한 위반은 사실상 배제
          // 남복 팀 vs 여복 팀(남남 vs 여여) 금지 — 성별 무시 편성에서만 발생 가능, 사실상 배제
          const realT = (t) => t.map((p) => p.realGender || p.gender).sort().join('');
          const ra = realT(A);
          const rb = realT(B);
          if ((ra === 'MM' && rb === 'WW') || (ra === 'WW' && rb === 'MM')) cost += 800;
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
