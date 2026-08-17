"""앵그리 대진표 앱 E2E 테스트 (Playwright).

단위 테스트(`npm test`)가 엔진 로직을 검증한다면, 이 스위트는 **브라우저에서 실제로
렌더링되고 클릭이 동작하는지**를 검증한다. 엔진은 맞는데 화면이 깨지는 종류의 사고
(예: build.mjs ENGINE_FILES 누락으로 computeRanking 미정의 → 앱 크래시)를 잡는 것이 목적.

실행:
    python test/e2e/run_e2e.py              # 기본 (헤드리스)
    python test/e2e/run_e2e.py --headed     # 브라우저 보면서
    python test/e2e/run_e2e.py --dist       # dist/앵그리대진표.html (배포 번들) 검증
    python test/e2e/run_e2e.py -k 게임데이   # 이름으로 필터

준비물:
    pip install playwright && python -m playwright install chromium

중요 — 이 스위트는 **Firebase 를 네트워크 레벨에서 차단**한다:
  · 테스트가 운영 Firestore 의 실제 클럽 명단·경기 기록을 읽어오지 않게 (실명 유출 방지)
  · 네트워크 상태에 따라 결과가 흔들리지 않게 (테스트 격리)
  · `page.wait_for_load_state("networkidle")` 은 절대 쓰지 말 것 — Firebase 가 연결을
    열어두기 때문에 영원히 idle 이 되지 않아 타임아웃 난다. #app 렌더 완료를 기다릴 것.
"""

from __future__ import annotations

import argparse
import http.server
import re
import socket
import socketserver
import sys
import threading
from contextlib import closing
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]

# Firebase / Google CDN 전면 차단 → live.js 가 오프라인으로 판단해 클라우드 기능을 끈다.
BLOCK_PATTERNS = [
    "**gstatic.com/**",
    "**googleapis.com/**",
    "**firebaseio.com/**",
    "**firebaseapp.com/**",
    "**firebasestorage.app/**",
]

# 별칭(남1·여1…)과 헷갈리지 않도록 시드 멤버는 다른 이름 체계를 쓴다.
def seed_roster(n_men: int = 6, n_women: int = 6) -> dict:
    mk = lambda pid, name: {"id": pid, "name": name, "prefs": {}, "presetExclude": [], "guest": False}
    return {
        "men": [mk(f"tm{i}", f"테스터남{i}") for i in range(1, n_men + 1)],
        "women": [mk(f"tw{i}", f"테스터여{i}") for i in range(1, n_women + 1)],
    }


# ---------------------------------------------------------------- 서버
def _free_port() -> int:
    with closing(socket.socket()) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # 요청 로그 억제
        pass


def start_server(directory: Path) -> tuple[str, socketserver.TCPServer]:
    port = _free_port()
    handler = lambda *a, **kw: _QuietHandler(*a, directory=str(directory), **kw)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", httpd


# ---------------------------------------------------------------- 테스트 골격
class Failure(AssertionError):
    pass


def check(cond: bool, msg: str):
    if not cond:
        raise Failure(msg)


SCENARIOS: list[tuple[str, callable]] = []


def scenario(name: str):
    def deco(fn):
        SCENARIOS.append((name, fn))
        return fn
    return deco


class App:
    """테스트용 앱 조작 헬퍼."""

    def __init__(self, page, base_url: str, entry: str):
        self.page = page
        self.url = f"{base_url}/{entry}"
        self.errors: list[str] = []
        page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        page.on("console", self._on_console)

    # 우리가 일부러 막은 Firebase 요청은 브라우저가 console.error 로 찍는다 — 앱 결함이 아니다.
    _EXPECTED = re.compile(r"Failed to load resource|net::ERR_(FAILED|BLOCKED|ABORTED)")

    def _on_console(self, msg):
        if msg.type == "error" and not self._EXPECTED.search(msg.text):
            self.errors.append(f"console.error: {msg.text}")

    def open(self, roster=None, attend=None, settings=None):
        self.page.goto(self.url, wait_until="domcontentloaded")
        if roster is not None:
            ids = [p["id"] for p in roster["men"] + roster["women"]]
            self.page.evaluate(
                """([r, a, s]) => {
                    localStorage.setItem('angry-roster-v2', JSON.stringify(r));
                    localStorage.setItem('angry-attend-v2', JSON.stringify(a));
                    localStorage.setItem('angry-settings-v2', JSON.stringify(s));
                }""",
                [roster,
                 attend if attend is not None else {"selectedIds": ids, "excludeOverrides": {}},
                 settings or {}],
            )
            self.page.reload(wait_until="domcontentloaded")
        self._wait_rendered()
        return self

    def _wait_rendered(self):
        # networkidle 금지 (모듈 docstring 참조). #app 이 채워지는 것으로 판단한다.
        try:
            self.page.wait_for_function(
                "document.querySelector('#app') && document.querySelector('#app').children.length > 0",
                timeout=10000,
            )
        except Exception:
            # 앱이 렌더되지 않는 전형적 원인은 스크립트 로드 실패(build.mjs ENGINE_FILES 누락 등).
            # 맨 타임아웃 대신 실제 원인을 보여준다.
            detail = "; ".join(self.errors[:3]) or "(수집된 JS 에러 없음)"
            raise Failure(f"#app 이 렌더되지 않음 — 스크립트 로드/실행 실패 의심. 원인: {detail}") from None

    def generate(self):
        self.page.locator("#gen").click()
        self.page.wait_for_selector("table.bracket", timeout=15000)
        return self

    # ---- 조회 ----
    def bracket(self) -> list[dict]:
        """대진표를 [{round, courts:{a: '...', ...}, wait: '...'}] 로 파싱."""
        return self.page.evaluate("""() => {
            const t = document.querySelector('table.bracket');
            if (!t) return [];
            const head = [...t.rows[0].cells].map(c => c.textContent.trim());
            return [...t.rows].slice(1).map(r => {
                const cells = [...r.cells];
                const out = { round: cells[0].textContent.trim(), courts: {}, wait: '' };
                cells.slice(1).forEach((c, i) => {
                    const label = head[i + 1] || '';
                    if (label === '대기') out.wait = c.textContent.trim();
                    else out.courts[label] = c.textContent.trim();
                });
                return out;
            });
        }""")

    def per_player(self) -> list[dict]:
        """인당 통계 표를 [{name, games, mixed, wait}] 로 파싱."""
        return self.page.evaluate("""() => {
            const t = [...document.querySelectorAll('table')].find(x =>
                x.rows.length && /선수/.test(x.rows[0].textContent) && /게임/.test(x.rows[0].textContent));
            if (!t) return [];
            return [...t.rows].slice(1).map(r => {
                const c = [...r.cells].map(x => x.textContent.trim());
                return { name: c[0], games: Number(c[1]), mixed: Number(c[2]), wait: Number(c[3]) };
            });
        }""")

    def banners(self) -> list[str]:
        return self.page.evaluate(
            """() => [...document.querySelectorAll('.banner')].map(b => b.className + ': ' + b.textContent.trim())"""
        )

    def error_banners(self) -> list[str]:
        return [b for b in self.banners() if "error" in b.split(":")[0]]

    def text(self) -> str:
        return self.page.locator("#app").inner_text()


# ---------------------------------------------------------------- 시나리오
@scenario("초기 로드 — 빈 명단이어도 깨지지 않는다")
def t_initial(app: App):
    app.open()
    body = app.text()
    check("앵그리 테니스 클럽 대진표" in body, "제목이 렌더되지 않음")
    check("① 클럽 명단 관리" in body, "명단 섹션 없음")
    check("먼저 ① 클럽 명단에 멤버를 추가하세요." in body, "빈 명단 안내 문구 없음")
    check(app.page.locator("#gen").is_visible(), "대진표 생성 버튼이 안 보임")


@scenario("Firebase 차단 — 운영 데이터를 읽지 않는다 (테스트 격리 보증)")
def t_isolated(app: App):
    app.open()
    # 클라우드 랭킹 표가 뜨면 운영 Firestore 를 읽은 것 → 격리 실패
    check(app.page.locator("table.rank-table").count() == 0,
          "클라우드 랭킹 표가 렌더됨 — Firebase 차단이 뚫렸다 (실명 유출 위험)")


@scenario("게임데이 12명·4라운드 — 3코트, 전원 4게임, 대기 0")
def t_gameday(app: App):
    roster = seed_roster(6, 6)
    app.open(roster, settings={"meetingType": "monthly", "rounds": 4, "gamesPerPerson": 4, "courts": None})
    check("남 6명, 여 6명, 총 12명" in app.text(), "참석자 집계가 12명이 아님")
    app.generate()

    rows = app.bracket()
    check(len(rows) == 4, f"라운드 수가 4가 아님: {len(rows)}")
    check(all(set(r["courts"]) == {"a코트", "b코트", "c코트"} for r in rows),
          f"코트가 a·b·c 3면이 아님: {rows[0]['courts'].keys()}")
    check(all(r["wait"] in ("—", "") for r in rows), f"대기자가 있음: {[r['wait'] for r in rows]}")

    stats = app.per_player()
    check(len(stats) == 12, f"인당 통계가 12명이 아님: {len(stats)}")
    games = {s["games"] for s in stats}
    # 슬롯 48 = 4R × 3코트 × 4명, 12명 → 나누어떨어지므로 편차 0 이어야 한다
    check(games == {4}, f"게임 수 편차 발생 (전원 4게임이어야 함): {sorted(games)}")
    check(all(s["mixed"] >= 1 for s in stats),
          f"혼복 0회인 선수 있음: {[s['name'] for s in stats if s['mixed'] < 1]}")

    check(not app.error_banners(), f"규칙 위반 배너: {app.error_banners()}")


@scenario("게임데이 — 남복 팀 vs 여복 팀 대진은 절대 없다")
def t_no_mm_vs_ww(app: App):
    roster = seed_roster(6, 6)
    app.open(roster, settings={"meetingType": "monthly", "rounds": 4, "gamesPerPerson": 4, "courts": None})
    app.generate()

    def gender_of(team: str) -> str:
        m, w = team.count("테스터남"), team.count("테스터여")
        return "M" if m == 2 else "W" if w == 2 else "X"  # X = 혼성

    bad = []
    for row in app.bracket():
        for court, txt in row["courts"].items():
            if "vs" not in txt:
                continue
            a, b = txt.split("vs", 1)
            ga, gb = gender_of(a), gender_of(b)
            if {ga, gb} == {"M", "W"}:
                bad.append(f"{row['round']} {court}: {txt}")
    check(not bad, f"남복 vs 여복 대진 발견: {bad}")


@scenario("정기모임 — a·b 게임 + c 레슨 구조")
def t_regular(app: App):
    roster = seed_roster(6, 6)
    app.open(roster, settings={"meetingType": "regular", "rounds": 4, "gamesPerPerson": 4})
    app.generate()

    rows = app.bracket()
    check(len(rows) == 4, f"라운드 수가 4가 아님: {len(rows)}")
    heads = set(rows[0]["courts"])
    check("a코트" in heads and "b코트" in heads, f"a·b 코트가 없음: {heads}")
    # 정기모임은 c 코트가 레슨 — 비출전자 전원이 여기로 간다
    body = app.text()
    check("레슨" in body, "정기모임인데 레슨 표기가 없음")
    check(not app.error_banners(), f"규칙 위반 배너: {app.error_banners()}")


@scenario("앵그리대회 — 별칭(남1·여1) 대진표로 생성된다")
def t_tournament(app: App):
    roster = seed_roster(6, 6)
    app.open(roster, settings={"meetingType": "tournament", "rounds": 4, "gamesPerPerson": 4, "courts": None})
    app.generate()

    joined = " ".join(c for r in app.bracket() for c in r["courts"].values())
    check(re.search(r"남\d", joined), f"별칭(남N)이 대진표에 없음: {joined[:120]}")
    check("테스터남" not in joined,
          f"별칭 대진표인데 실명이 그대로 노출됨: {joined[:120]}")
    check(not app.error_banners(), f"규칙 위반 배너: {app.error_banners()}")


@scenario("코트 수 수동 지정 — 16명·4코트")
def t_courts_option(app: App):
    roster = seed_roster(8, 8)
    app.open(roster, settings={"meetingType": "monthly", "rounds": 4, "gamesPerPerson": 4, "courts": 4})
    app.generate()

    rows = app.bracket()
    check(all(set(r["courts"]) == {"a코트", "b코트", "c코트", "d코트"} for r in rows),
          f"4코트가 아님: {sorted(rows[0]['courts'])}")
    stats = app.per_player()
    check(len(stats) == 16, f"인당 통계가 16명이 아님: {len(stats)}")
    check({s["games"] for s in stats} == {4}, f"전원 4게임이어야 함: {sorted({s['games'] for s in stats})}")


@scenario("자바스크립트 런타임 에러가 없다 (번들 누락 회귀 방지)")
def t_no_js_errors(app: App):
    roster = seed_roster(6, 6)
    app.open(roster, settings={"meetingType": "monthly", "rounds": 4, "gamesPerPerson": 4})
    app.generate()
    # 랭킹 카드까지 펼쳐 computeRanking 등 전 모듈이 로드됐는지 확인
    app.page.evaluate("""() => document.querySelectorAll('details').forEach(d => d.open = true)""")
    app.page.wait_for_timeout(300)
    check(not app.errors, f"런타임 에러 발생: {app.errors[:5]}")


# ---------------------------------------------------------------- 러너
def main() -> int:
    ap = argparse.ArgumentParser(description="앵그리 앱 E2E 테스트")
    ap.add_argument("--headed", action="store_true", help="브라우저 창을 띄운다")
    ap.add_argument("--dist", action="store_true", help="dist/앵그리대진표.html 을 검증한다")
    ap.add_argument("-k", dest="filter", default="", help="시나리오 이름 부분 일치 필터")
    ap.add_argument("--allow-firebase", action="store_true",
                    help="[비권장] Firebase 차단 해제 — 운영 데이터를 읽게 된다")
    args = ap.parse_args()

    if args.dist:
        entry, serve_dir = "앵그리대진표.html", ROOT / "dist"
        if not (serve_dir / entry).exists():
            print("dist 번들이 없습니다. 먼저 `npm run build` 를 실행하세요.", file=sys.stderr)
            return 2
    else:
        entry, serve_dir = "index.html", ROOT

    base, httpd = start_server(serve_dir)
    picked = [(n, f) for n, f in SCENARIOS if args.filter in n]
    print(f"앵그리 E2E — {entry} · {len(picked)}개 시나리오"
          f"{' · Firebase 허용(!)' if args.allow_firebase else ' · Firebase 차단'}\n")

    passed, failed = 0, []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not args.headed)
            for name, fn in picked:
                ctx = browser.new_context(viewport={"width": 1400, "height": 1200})
                if not args.allow_firebase:
                    for pat in BLOCK_PATTERNS:
                        ctx.route(pat, lambda route: route.abort())
                page = ctx.new_page()
                try:
                    fn(App(page, base, entry))
                    print(f"  ✓ {name}")
                    passed += 1
                except Exception as e:
                    print(f"  ✗ {name}\n      {type(e).__name__}: {e}")
                    failed.append(name)
                finally:
                    ctx.close()
            browser.close()
    finally:
        httpd.shutdown()

    print(f"\n통과 {passed} / 실패 {len(failed)} / 전체 {len(picked)}")
    if failed:
        print("실패:", ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
