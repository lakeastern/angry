// 앵그리랭킹 집계 — 순수 함수 (저장·UI와 분리, 테스트 가능)
//
// 결과(result)는 두 형식을 지원한다.
//  ① 게임 기반(앱에서 생성·입력한 대회):
//     { id, date, mode, players: [{ memberId, name }],
//       games: [{ round, court, teamA:[memberId,memberId], teamB:[...], scoreA, scoreB }] }
//  ② 선수별 스코어(과거 이력 이관 — 팀 구성 정보가 없는 기록):
//     { id, date, mode:'legacy', playerGames: [{ memberId?, name, scores: [[내점수, 상대점수], ...] }] }
//
// 멤버별 누적 후 랭킹 정렬(사전식): 승수 W desc → 패 L asc(적을수록 위) → 득실차 GD desc → 득점 GF desc → 승률 desc → 이름
// (승이 많은 사람은 항상 상위; 같은 승수면 패가 적은=무가 많은 사람이 득실차와 무관하게 위). 동점(무승부)은 경기·득실에 포함.

// 유효 스코어 판별 — Number(null)===0 이므로 반드시 원값으로 먼저 걸러낸다.
const validScore = (v) => !(v == null || v === '') && Number.isFinite(Number(v));

// 결과 → 선수별 경기 스코어 로그 { key: { name, scores:[{my,opp}, ...] } } (두 형식 공통, 경기 순서 유지)
export function playerScoreLogs(result) {
  const out = new Map();
  const push = (key, name, my, opp) => {
    if (!out.has(key)) out.set(key, { name: name || key, scores: [] });
    const e = out.get(key);
    if (name) e.name = name;
    e.scores.push({ my: Number(my), opp: Number(opp) });
  };
  if (Array.isArray(result && result.playerGames)) {
    for (const p of result.playerGames) {
      const key = p.memberId || `n:${p.name}`;
      for (const s of p.scores || []) {
        const [my, opp] = Array.isArray(s) ? s : [s.my, s.opp];
        if (validScore(my) && validScore(opp)) push(key, p.name, my, opp);
      }
    }
    return out;
  }
  const nameOf = new Map(((result && result.players) || []).map((p) => [p.memberId, p.name]));
  // 라운드→코트 순으로 정렬해 "앞선 게임"의 기준을 명확히
  const games = [...((result && result.games) || [])].sort((x, y) =>
    (Number(x.round) || 0) - (Number(y.round) || 0) || String(x.court || '').localeCompare(String(y.court || ''))
  );
  for (const g of games) {
    if (!validScore(g.scoreA) || !validScore(g.scoreB)) continue; // 미입력만 제외 (동점=무승부는 집계)
    const a = Number(g.scoreA), b = Number(g.scoreB);
    for (const id of (g.teamA || []).filter(Boolean)) push(id, nameOf.get(id), a, b);
    for (const id of (g.teamB || []).filter(Boolean)) push(id, nameOf.get(id), b, a);
  }
  return out;
}

// opts: { basis: 'total'(기본) | 'avg', minGames: 평균 기준 최소 경기 수 }
export function computeRanking(results, opts = {}) {
  const stat = new Map(); // memberId → { memberId, name, G, W, D, L, GF, GA }
  const ensure = (id, name) => {
    if (!stat.has(id)) stat.set(id, { memberId: id, name: name || id, G: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
    const s = stat.get(id);
    if (name) s.name = name; // 최신 이름으로 갱신
    return s;
  };

  for (const r of results || []) {
    // 점수 반영 인당 게임 수 상한 (capGames): 각 선수의 앞선 N게임까지만 집계. 없으면 전부.
    const cap = Number.isFinite(+r.capGames) && +r.capGames > 0 ? +r.capGames : Infinity;
    for (const [id, entry] of playerScoreLogs(r)) {
      const s = ensure(id, entry.name);
      for (const { my, opp } of entry.scores.slice(0, cap === Infinity ? undefined : cap)) {
        s.G++; s.GF += my; s.GA += opp;
        if (my > opp) s.W++; else if (my < opp) s.L++; else s.D++;
      }
    }
  }

  const minGames = Number.isFinite(+opts.minGames) && +opts.minGames > 0 ? Math.floor(+opts.minGames) : 0;
  const rows = [...stat.values()].map((s) => ({
    ...s,
    GD: s.GF - s.GA,
    points: s.W * 3, // 종합점수(승점) — 표시용. 무승부는 종합점수엔 미반영(경기·득실·무로 기록, 순위는 승수 우선 후 득실차)
    winRate: s.G ? s.W / s.G : 0,
    avgGD: s.G ? (s.GF - s.GA) / s.G : 0, // 경기당 평균 득실차
    avgPoints: s.G ? (s.W * 3) / s.G : 0, // 경기당 평균 승점
    qualified: s.G >= minGames, // 평균 기준의 최소 경기 수 충족 여부
  }));

  // 평균 기준: 참석 횟수와 무관하게 비교 — 승률 → 경기당 득실차 → 경기 수(많이 뛴 쪽) → 이름.
  // 최소 경기 수(minGames) 미달자는 순위를 매기지 않고 뒤에 둔다.
  const avg = opts.basis === 'avg';
  rows.sort((x, y) => (avg
    ? (y.qualified - x.qualified) ||
      y.winRate - x.winRate ||
      y.avgGD - x.avgGD ||
      y.G - x.G ||
      x.name.localeCompare(y.name, 'ko')
    : y.W - x.W || // 승수 절대 우선
      x.L - y.L || // 같은 승수면 패가 적은 쪽(무가 많은 쪽)이 위 — 득실차보다 우선
      y.GD - x.GD || // 득실차
      y.GF - x.GF || // 같은 득실차면 득점 많은 쪽
      y.winRate - x.winRate || // 승률
      x.name.localeCompare(y.name, 'ko') // 이름
  ));

  let rank = 0, prevKey = null, n = 0;
  rows.forEach((r) => {
    if (avg && !r.qualified) { r.rank = null; return; } // 최소 경기 미달 → 순위 없음
    n++;
    const key = avg
      ? r.winRate.toFixed(6) + '/' + r.avgGD.toFixed(6) + '/' + r.G
      : r.W + '/' + r.L + '/' + r.GD + '/' + r.GF + '/' + r.winRate.toFixed(4);
    if (key !== prevKey) { rank = n; prevKey = key; } // 동률은 같은 순위
    r.rank = rank;
  });
  return rows;
}

// 결과의 날짜 → 시각(ms). 저장 형식이 섞여 있어(ISO 'YYYY-MM-DD', ko-KR '2026. 7. 22.') 둘 다 처리.
export function resultDateMs(result) {
  const s = String((result && result.date) || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  m = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); // '2026. 7. 22.' / '2026/7/22'
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
