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
    for (const g of r.games || []) {
      const a = Number(g.scoreA);
      const b = Number(g.scoreB);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue; // 미입력·동점 게임은 집계 제외
      const teamA = (g.teamA || []).filter(Boolean);
      const teamB = (g.teamB || []).filter(Boolean);
      const aWin = a > b;
      for (const id of teamA) {
        const s = ensure(id, nameOf.get(id));
        s.G++; s.GF += a; s.GA += b; if (aWin) s.W++; else s.L++;
      }
      for (const id of teamB) {
        const s = ensure(id, nameOf.get(id));
        s.G++; s.GF += b; s.GA += a; if (!aWin) s.W++; else s.L++;
      }
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
    y.GD - x.GD || // 득실차 타이브레이크
    y.winRate - x.winRate || // 승률
    x.name.localeCompare(y.name, 'ko') // 이름
  );

  let rank = 0, prevKey = null;
  rows.forEach((r, i) => {
    const key = r.W + '/' + r.GD + '/' + r.winRate.toFixed(4);
    if (key !== prevKey) { rank = i + 1; prevKey = key; } // 동률은 같은 순위
    r.rank = rank;
  });
  return rows;
}
