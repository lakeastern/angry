// 스케줄 검증기 — 엔진 자기검증, 비용 계산, UI 수동편집 경고가 모두 이 모듈을 공유한다.

export function pairKey(a, b) {
  return a < b ? a + '|' + b : b + '|' + a;
}

export function teamGenderType(team, byId) {
  const g = team.map((id) => byId.get(id).gender).sort().join('');
  if (g === 'MM') return 'MM';
  if (g === 'WW') return 'WW';
  return 'MW';
}

// 스케줄 전체를 한 번 훑어 통계를 만든다. (비용 함수와 검증기가 함께 사용)
export function computeStats(schedule, plan) {
  const byId = plan.byId;
  const R = schedule.rounds.length;

  const per = new Map();
  for (const p of plan.players) {
    per.set(p.id, { games: 0, sits: 0, mixed: 0, sitRounds: [], gameRounds: [] });
  }

  const partnerCount = new Map();
  const meetCount = new Map();
  const structural = [];
  const gameDiffs = [];
  let scoreDiffSum = 0;
  const opt = plan.options || {};
  const tightList = Array.isArray(opt.tightRounds)
    ? opt.tightRounds
    : Array.from({ length: Math.max(0, Number(opt.tightRounds) || 0) }, (_, i) => i + 1);
  let earlyTightness = 0; // 빡겜 라운드의 게임 내 실력 폭 합

  schedule.rounds.forEach((rd, r) => {
    const seen = new Map(); // id → 배정 횟수 (라운드 내 중복 감지)
    const mark = (id, where) => {
      if (!byId.has(id)) {
        structural.push({ code: 'E_UNKNOWN_PLAYER', round: r, message: `${r + 1}라운드에 알 수 없는 선수(${id})가 있습니다.` });
        return;
      }
      seen.set(id, (seen.get(id) || 0) + 1);
      const p = byId.get(id);
      if (p.unavailable.has(r)) {
        structural.push({ code: 'E_EXCLUDED_ASSIGNED', round: r, players: [id], message: `${r + 1}라운드에서 제외된 ${p.label}이(가) ${where}에 배정되었습니다.` });
      }
    };

    for (const game of rd.games) {
      const [t1, t2] = game.teams;
      const all = [...t1, ...t2];
      if (all.length !== 4 || new Set(all).size !== 4) {
        const dups = [...new Set(all.filter((x, i) => all.indexOf(x) !== i))];
        structural.push({
          code: 'E_BAD_GAME',
          round: r,
          court: game.court,
          players: dups,
          message: `${r + 1}라운드 ${game.court}코트 게임 구성이 잘못되었습니다(4인 미충족${dups.length ? ` — ${dups.map((id) => (byId.has(id) ? byId.get(id).label : id)).join(', ')} 중복` : ''}).`,
        });
        continue;
      }
      all.forEach((id) => mark(id, `${game.court}코트`));
      if (!all.every((id) => byId.has(id))) continue;

      const type1 = teamGenderType(t1, byId);
      const type2 = teamGenderType(t2, byId);
      if (type1 !== type2) {
        structural.push({ code: 'E_JAPBOK', round: r, players: all, message: `${r + 1}라운드 ${game.court}코트가 잡복(${type1} vs ${type2})입니다.` });
      }
      const actualType = type1 === type2 ? (type1 === 'MW' ? 'MX' : type1) : null;

      for (const id of all) {
        const s = per.get(id);
        s.games++;
        s.gameRounds.push(r);
        if (actualType === 'MX') s.mixed++;
      }
      for (const team of [t1, t2]) {
        const k = pairKey(team[0], team[1]);
        partnerCount.set(k, (partnerCount.get(k) || 0) + 1);
      }
      for (const x of t1) for (const y of t2) {
        const k = pairKey(x, y);
        meetCount.set(k, (meetCount.get(k) || 0) + 1);
      }
      const sum = (team) => team.reduce((acc, id) => acc + byId.get(id).score, 0);
      const diff = Math.abs(sum(t1) - sum(t2));
      gameDiffs.push({ round: r, court: game.court, diff });
      scoreDiffSum += diff;
      if (tightList.includes(r + 1)) {
        // 남녀 순위는 절대 실력이 다르므로 실력 폭은 성별 내에서만 계산
        for (const g of ['M', 'W']) {
          const scores = all.filter((id) => byId.get(id).gender === g).map((id) => byId.get(id).score);
          if (scores.length > 1) earlyTightness += Math.max(...scores) - Math.min(...scores);
        }
      }
    }

    for (const id of rd.lesson) {
      mark(id, '레슨/대기');
      if (byId.has(id)) {
        const s = per.get(id);
        s.sits++;
        s.sitRounds.push(r);
      }
    }

    for (const [id, cnt] of seen) {
      if (cnt > 1) {
        structural.push({ code: 'E_DUP_ASSIGN', round: r, players: [id], message: `${r + 1}라운드에 ${byId.get(id).label}이(가) ${cnt}번 배정되었습니다.` });
      }
    }

    // 배정 누락: 가용 인원인데 게임에도 레슨/대기에도 없음
    for (const p of plan.players) {
      if (!p.unavailable.has(r) && !seen.has(p.id)) {
        structural.push({ code: 'E_UNASSIGNED', round: r, players: [p.id], message: `${r + 1}라운드에서 ${p.label}이(가) 게임에도 레슨/대기에도 배정되지 않았습니다.` });
      }
    }
  });

  // 파트너 중복
  let partnerRepeats = 0;
  const repeatedPartners = [];
  for (const [k, cnt] of partnerCount) {
    if (cnt > 1) {
      partnerRepeats += cnt - 1;
      repeatedPartners.push({ pair: k.split('|'), count: cnt });
    }
  }

  // 상대 중복
  let opponentPenalty = 0;
  let maxMeet = 0;
  const frequentOpponents = [];
  for (const [k, cnt] of meetCount) {
    if (cnt > maxMeet) maxMeet = cnt;
    if (cnt > 1) {
      opponentPenalty += (cnt - 1) * (cnt - 1);
      frequentOpponents.push({ pair: k.split('|'), count: cnt });
    }
  }

  // 연속 결장(레슨/대기)
  let consecutiveSits = 0;
  const consecutiveSitList = [];
  for (const p of plan.players) {
    const rounds = per.get(p.id).sitRounds;
    for (let i = 1; i < rounds.length; i++) {
      if (rounds[i] === rounds[i - 1] + 1) {
        consecutiveSits++;
        consecutiveSitList.push({ id: p.id, rounds: [rounds[i - 1], rounds[i]] });
      }
    }
  }

  // 게임 수 편차: 가용 라운드 수가 같은 그룹 내에서 max−min ≤ 1이 목표
  const groups = new Map();
  for (const p of plan.players) {
    let availCount = 0;
    for (let r = 0; r < R; r++) if (!p.unavailable.has(r)) availCount++;
    if (!groups.has(availCount)) groups.set(availCount, []);
    groups.get(availCount).push(p.id);
  }
  let spreadPenalty = 0;
  const spreadDetails = [];
  for (const [availCount, ids] of groups) {
    if (ids.length < 2) continue;
    const counts = ids.map((id) => per.get(id).games);
    const mx = Math.max(...counts);
    const mn = Math.min(...counts);
    if (mx - mn > 1) {
      spreadPenalty += mx - mn - 1;
      spreadDetails.push({ availCount, max: mx, min: mn, ids });
    }
  }

  // 레슨 로테이션(정기): 3라운드 내 전원 1회 레슨.
  // 결장 슬롯의 성별 구성은 게임 유형 규칙이 결정하므로, 성별별 실제 슬롯 대비 미달성분만 벌점.
  let rotationMiss = 0;
  let rotationMissedIds = [];
  if (schedule.type === 'regular' && R >= 3) {
    for (const g of ['M', 'W']) {
      const members = plan.players.filter((p) => p.gender === g && [0, 1, 2].some((r) => !p.unavailable.has(r)));
      if (!members.length) continue;
      const sitSlots = schedule.rounds
        .slice(0, 3)
        .reduce((acc, rd) => acc + rd.lesson.filter((id) => byId.has(id) && byId.get(id).gender === g).length, 0);
      const missed = members.filter((p) => !per.get(p.id).sitRounds.some((r) => r < 3));
      const minMissed = Math.max(0, members.length - sitSlots);
      const penalty = Math.max(0, missed.length - minMissed);
      rotationMiss += penalty;
      if (penalty > 0) rotationMissedIds.push(...missed.map((p) => p.id));
    }
  }

  // 신규회원 레슨 미충족(정기, 레슨 슬롯이 있는 경우만)
  let newMemberLessonMiss = 0;
  if (schedule.type === 'regular') {
    const anyByes = schedule.rounds.some((rd) => rd.lesson.length > 0);
    if (anyByes) {
      for (const p of plan.players) {
        if (p.prefs.newMember && per.get(p.id).sits === 0) newMemberLessonMiss++;
      }
    }
  }

  // 게임데이: 인당 최소 혼복 게임 수 (기본 1). 부족분 합을 비용으로.
  const minMixed = schedule.type === 'monthly' ? (opt.minMixedGames || 0) : 0;
  let mixedUncovered = 0;
  const mixedUncoveredIds = [];
  if (minMixed > 0 && plan.M > 0 && plan.W > 0) {
    for (const p of plan.players) {
      const s = per.get(p.id);
      if (s.games > 0 && s.mixed < minMixed) {
        mixedUncovered += minMixed - s.mixed;
        mixedUncoveredIds.push(p.id);
      }
    }
  }

  // 라운드별 유형 선호: 정기는 혼복 지정 라운드(설정, 기본 2·4)에서 혼복 우세,
  // 그 외 모든 라운드는 동성복식 우세(가중 2배)
  const mixedRounds = opt.mixedRounds || [1, 3];
  let typePrefCost = 0;
  schedule.rounds.forEach((rd, r) => {
    const c = rd.games.filter((g) => teamGenderType(g.teams[0], byId) === 'MW').length;
    const C = rd.games.length;
    if (schedule.type === 'regular' && mixedRounds.includes(r + 1)) typePrefCost += C - c;
    else if (schedule.type === 'regular') typePrefCost += c * 2;
    else typePrefCost += c;
  });

  // 레슨 그룹 실력 유사성(정기, 최하 우선순위)
  let lessonSkillSpread = 0;
  if (schedule.type === 'regular') {
    for (const rd of schedule.rounds) {
      if (rd.lesson.length >= 2) {
        const scores = rd.lesson.filter((id) => byId.has(id)).map((id) => byId.get(id).score);
        lessonSkillSpread += Math.max(...scores) - Math.min(...scores);
      }
    }
  }

  // 랭커 라운드 규칙(정기): 각 랭커 라운드에 "상위 풀 멤버로만 구성된 랭커 게임"이 있는지 측정.
  // 풀 기준(동성: 상위 5명 / 혼복: 남녀 각 상위 3명)이라 랜덤 선정과 달라도 풀 안이면 무벌점 —
  // 수동 스왑으로 풀 내 교체를 허용하기 위함.
  let rankerMiss = 0;
  if (schedule.type === 'regular') {
    const poolOf = (g, r, size) =>
      new Set(
        plan.players
          .filter((p) => p.gender === g && !p.unavailable.has(r))
          .sort((a, b) => a.score - b.score)
          .slice(0, size)
          .map((p) => p.id)
      );
    for (const rn of opt.rankerRounds || []) {
      const r = rn - 1;
      const rd = schedule.rounds[r];
      if (!rd) continue;
      if (mixedRounds.includes(rn)) {
        const pm = poolOf('M', r, 3);
        const pw = poolOf('W', r, 3);
        if (pm.size < 2 || pw.size < 2) continue;
        let best = 4;
        for (const game of rd.games) {
          const all = [...game.teams[0], ...game.teams[1]];
          if (!all.every((id) => byId.has(id))) continue;
          const men = all.filter((id) => byId.get(id).gender === 'M');
          const women = all.filter((id) => byId.get(id).gender === 'W');
          if (men.length !== 2 || women.length !== 2) continue;
          const hit = men.filter((id) => pm.has(id)).length + women.filter((id) => pw.has(id)).length;
          best = Math.min(best, 4 - hit);
        }
        rankerMiss += best;
      } else {
        for (const g of ['M', 'W']) {
          const pool = poolOf(g, r, 5);
          if (pool.size < 4) continue;
          let best = 4;
          for (const game of rd.games) {
            const all = [...game.teams[0], ...game.teams[1]];
            if (!all.every((id) => byId.has(id) && byId.get(id).gender === g)) continue;
            const hit = all.filter((id) => pool.has(id)).length;
            best = Math.min(best, 4 - hit);
          }
          rankerMiss += best;
        }
      }
    }
  }

  // 개인 특성(정기): 혼복선호자 혼복 미경험 + 신규회원 상위레벨 매칭 점수
  let traitPenalty = 0;
  if (schedule.type === 'regular') {
    for (const p of plan.players) {
      if (p.prefs.mixedPreferred && per.get(p.id).games > 0 && per.get(p.id).mixed === 0) traitPenalty += 5;
    }
  }
  for (const p of plan.players) {
    if (!p.prefs.newMember) continue;
    for (const rd of schedule.rounds) {
      for (const game of rd.games) {
        const all = [...game.teams[0], ...game.teams[1]];
        if (!all.includes(p.id)) continue;
        const others = all.filter((id) => id !== p.id && byId.has(id)).map((id) => byId.get(id).score);
        if (others.length) traitPenalty += Math.min(...others) * 0.1;
      }
    }
  }

  const scoreDiffSq = gameDiffs.reduce((a, g) => a + g.diff * g.diff, 0);

  // 게임 점수차 상한 위반 (설정된 경우)
  let diffCapViolations = 0;
  const diffCapList = [];
  if (opt.maxDiff != null) {
    for (const g of gameDiffs) {
      if (g.diff > opt.maxDiff) {
        diffCapViolations++;
        diffCapList.push(g);
      }
    }
  }

  // 같은 상대 상한 위반 (설정된 경우)
  let meetCapViolations = 0;
  const meetCapList = [];
  if (opt.maxMeet != null) {
    for (const [k, cnt] of meetCount) {
      if (cnt > opt.maxMeet) {
        meetCapViolations += cnt - opt.maxMeet;
        meetCapList.push({ pair: k.split('|'), count: cnt });
      }
    }
  }

  return {
    perPlayer: per,
    scoreDiffSq,
    earlyTightness,
    rankerMiss,
    diffCapViolations,
    diffCapList,
    partnerCount,
    meetCount,
    structural,
    partnerRepeats,
    repeatedPartners,
    meetCapViolations,
    meetCapList,
    opponentPenalty,
    maxMeet,
    frequentOpponents,
    consecutiveSits,
    consecutiveSitList,
    spreadPenalty,
    spreadDetails,
    rotationMiss,
    rotationMissedIds,
    newMemberLessonMiss,
    mixedUncovered,
    mixedUncoveredIds,
    typePrefCost,
    lessonSkillSpread,
    traitPenalty,
    scoreDiffSum,
    scoreDiffAvg: gameDiffs.length ? scoreDiffSum / gameDiffs.length : 0,
    scoreDiffMax: gameDiffs.length ? Math.max(...gameDiffs.map((g) => g.diff)) : 0,
    gameDiffs,
  };
}

// 사람이 읽을 수 있는 오류/경고 목록. severity: 'error'(하드 위반) / 'warn'(소프트 미달)
export function validateSchedule(schedule, plan) {
  const stats = computeStats(schedule, plan);
  const errors = [];
  const warnings = [];
  const byId = plan.byId;
  const label = (id) => (byId.has(id) ? byId.get(id).label : id);

  for (const s of stats.structural) errors.push({ code: s.code, message: s.message });

  for (const rp of stats.repeatedPartners) {
    errors.push({
      code: 'E_PARTNER_REPEAT',
      message: `${label(rp.pair[0])}·${label(rp.pair[1])} 파트너 조합이 ${rp.count}번 사용되었습니다.`,
    });
  }

  for (const cs of stats.consecutiveSitList) {
    warnings.push({
      code: 'W_CONSECUTIVE_SIT',
      message: `${label(cs.id)}이(가) ${cs.rounds[0] + 1}·${cs.rounds[1] + 1}라운드 연속으로 게임에 들어가지 못했습니다.`,
    });
  }

  for (const sd of stats.spreadDetails) {
    warnings.push({
      code: 'W_GAME_SPREAD',
      message: `게임 수 차이가 ${sd.max - sd.min}입니다 (최대 ${sd.max}게임, 최소 ${sd.min}게임).`,
    });
  }

  if (stats.rotationMiss > 0) {
    warnings.push({
      code: 'W_LESSON_ROTATION',
      message: `3라운드 내 레슨을 받지 못한 인원이 이론적 최소보다 ${stats.rotationMiss}명 많습니다 (${stats.rotationMissedIds.map(label).join(', ')}).`,
    });
  }

  if (stats.mixedUncovered > 0) {
    const minMixed = plan.options ? plan.options.minMixedGames : 1;
    warnings.push({
      code: 'W_MIXED_UNCOVERED',
      message: `혼복 게임이 최소 ${minMixed}회에 못 미친 인원: ${stats.mixedUncoveredIds.map(label).join(', ')}`,
    });
  }

  for (const g of stats.diffCapList) {
    warnings.push({
      code: 'W_DIFF_CAP',
      message: `${g.round + 1}라운드 ${g.court}코트의 점수차(${g.diff})가 설정된 상한(${plan.options.maxDiff})을 넘습니다.`,
    });
  }

  if (plan.options && plan.options.maxMeet != null) {
    for (const mc of stats.meetCapList) {
      warnings.push({
        code: 'W_MEET_CAP',
        message: `${label(mc.pair[0])}와(과) ${label(mc.pair[1])}이(가) 상대로 ${mc.count}번 만나 상한(${plan.options.maxMeet}번)을 넘습니다.`,
      });
    }
  } else {
    for (const fo of stats.frequentOpponents) {
      if (fo.count >= 3) {
        warnings.push({
          code: 'W_FREQUENT_OPPONENT',
          message: `${label(fo.pair[0])}와(과) ${label(fo.pair[1])}이(가) 상대로 ${fo.count}번 만납니다.`,
        });
      }
    }
  }

  return { errors, warnings, stats };
}
