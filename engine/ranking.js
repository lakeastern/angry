// 앵그리랭킹 집계 — 순수 함수 (저장·UI와 분리, 테스트 가능)
//
// 결과(result) 형식:
//   { id, date, mode, players: [{ memberId, name }],
//     games: [{ round, court, teamA:[memberId,memberId], teamB:[...], scoreA, scoreB }] }
//
// 멤버별 누적 후 랭킹 정렬(사전식): 승수 W desc → 패 L asc(적을수록 위) → 득실차 GD desc → 득점 GF desc → 승률 desc → 이름
// (승이 많은 사람은 항상 상위; 같은 승수면 패가 적은=무가 많은 사람이 득실차와 무관하게 위). 동점(무승부)은 경기·득실에 포함.

export function computeRanking(results) {
  const stat = new Map(); // memberId → { memberId, name, G, W, D, L, GF, GA }
  const ensure = (id, name) => {
    if (!stat.has(id)) stat.set(id, { memberId: id, name: name || id, G: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
    const s = stat.get(id);
    if (name) s.name = name; // 최신 이름으로 갱신
    return s;
  };

  for (const r of results || []) {
    const nameOf = new Map((r.players || []).map((p) => [p.memberId, p.name]));
    // 점수 반영 인당 게임 수 상한 (capGames): 각 선수의 앞선 N게임까지만 집계. 없으면 전부.
    const cap = Number.isFinite(+r.capGames) && +r.capGames > 0 ? +r.capGames : Infinity;
    const counted = new Map(); // memberId → 이 대회에서 지금까지 집계된 게임 수
    // 라운드→코트 순으로 정렬해 "앞선 게임"의 기준을 명확히
    const games = [...(r.games || [])].sort((x, y) =>
      (Number(x.round) || 0) - (Number(y.round) || 0) || String(x.court || '').localeCompare(String(y.court || ''))
    );
    for (const g of games) {
      // 미입력(null·undefined·빈값)은 제외. Number(null)===0 이므로 반드시 원값으로 먼저 판별.
      if (g.scoreA == null || g.scoreB == null || g.scoreA === '' || g.scoreB === '') continue;
      const a = Number(g.scoreA);
      const b = Number(g.scoreB);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue; // 동점=무승부는 집계
      const teamA = (g.teamA || []).filter(Boolean);
      const teamB = (g.teamB || []).filter(Boolean);
      const outcome = a > b ? 'W' : (b > a ? 'L' : 'D'); // 팀A 기준 결과
      const take = (id, gf, ga, oc) => {
        if ((counted.get(id) || 0) >= cap) return; // 상한 초과분은 점수에 반영하지 않음
        counted.set(id, (counted.get(id) || 0) + 1);
        const s = ensure(id, nameOf.get(id));
        s.G++; s.GF += gf; s.GA += ga;
        if (oc === 'W') s.W++; else if (oc === 'L') s.L++; else s.D++;
      };
      for (const id of teamA) take(id, a, b, outcome);
      for (const id of teamB) take(id, b, a, outcome === 'W' ? 'L' : outcome === 'L' ? 'W' : 'D');
    }
  }

  const rows = [...stat.values()].map((s) => ({
    ...s,
    GD: s.GF - s.GA,
    points: s.W * 3, // 종합점수(승점) — 표시용. 무승부는 종합점수엔 미반영(경기·득실·무로 기록, 순위는 승수 우선 후 득실차)
    winRate: s.G ? s.W / s.G : 0,
  }));

  rows.sort((x, y) =>
    y.W - x.W || // 승수 절대 우선
    x.L - y.L || // 같은 승수면 패가 적은 쪽(무가 많은 쪽)이 위 — 득실차보다 우선
    y.GD - x.GD || // 득실차
    y.GF - x.GF || // 같은 득실차면 득점 많은 쪽
    y.winRate - x.winRate || // 승률
    x.name.localeCompare(y.name, 'ko') // 이름
  );

  let rank = 0, prevKey = null;
  rows.forEach((r, i) => {
    const key = r.W + '/' + r.L + '/' + r.GD + '/' + r.GF + '/' + r.winRate.toFixed(4);
    if (key !== prevKey) { rank = i + 1; prevKey = key; } // 동률은 같은 순위
    r.rank = rank;
  });
  return rows;
}
