// 앵그리랭킹 집계 — 순수 함수 (저장·UI와 분리, 테스트 가능)
//
// 결과(result) 형식:
//   { id, date, mode, players: [{ memberId, name }],
//     games: [{ round, court, teamA:[memberId,memberId], teamB:[...], scoreA, scoreB }] }
//
// 멤버별 누적 후 랭킹 정렬(사전식): 승수 W desc → 득실차 GD desc → 승률 desc → 이름
// (승이 많은 사람은 득실차와 무관하게 항상 상위)

export function computeRanking(results) {
  const stat = new Map(); // memberId → { memberId, name, G, W, L, GF, GA }
  const ensure = (id, name) => {
    if (!stat.has(id)) stat.set(id, { memberId: id, name: name || id, G: 0, W: 0, L: 0, GF: 0, GA: 0 });
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
      const a = Number(g.scoreA);
      const b = Number(g.scoreB);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue; // 미입력·동점 게임은 집계 제외
      const teamA = (g.teamA || []).filter(Boolean);
      const teamB = (g.teamB || []).filter(Boolean);
      const aWin = a > b;
      const take = (id, gf, ga, win) => {
        if ((counted.get(id) || 0) >= cap) return; // 상한 초과분은 점수에 반영하지 않음
        counted.set(id, (counted.get(id) || 0) + 1);
        const s = ensure(id, nameOf.get(id));
        s.G++; s.GF += gf; s.GA += ga; if (win) s.W++; else s.L++;
      };
      for (const id of teamA) take(id, a, b, aWin);
      for (const id of teamB) take(id, b, a, !aWin);
    }
  }

  const rows = [...stat.values()].map((s) => ({
    ...s,
    GD: s.GF - s.GA,
    points: s.W * 3, // 종합점수(승점) — 표시용. 순위는 아래 사전식 정렬
    winRate: s.G ? s.W / s.G : 0,
  }));

  rows.sort((x, y) =>
    y.W - x.W || // 승수 절대 우선
    y.GD - x.GD || // 득실차
    y.GF - x.GF || // 같은 득실차면 득점 많은 쪽
    y.winRate - x.winRate || // 승률
    x.name.localeCompare(y.name, 'ko') // 이름
  );

  let rank = 0, prevKey = null;
  rows.forEach((r, i) => {
    const key = r.W + '/' + r.GD + '/' + r.GF + '/' + r.winRate.toFixed(4);
    if (key !== prevKey) { rank = i + 1; prevKey = key; } // 동률은 같은 순위
    r.rank = rank;
  });
  return rows;
}
