// live.js — Firebase 계층: ① 실시간 대회(라이브 스코어) ② 클라우드 앵그리랭킹 ③ 관리자 로그인.
// 선택적 계층: firebaseConfig 미설정·오프라인·파일(file://) 열기 등으로 SDK 로드에 실패하면
// 조용히 비활성화되고, 앱의 나머지 오프라인 기능은 그대로 동작한다.
//
// 데이터 모델:
//   events/{id}             = { mode, title, date, status:'live', createdAt, bracket(JSON문자열) }
//   events/{id}/games/{gid} = { a, b, updatedAt }   (gid = `${round}_${court}`)
//     → 링크(정확한 랜덤 문서 ID)를 아는 사람만 읽기·쓰기. ID 추측/목록 조회는 차단.
//   results/{id}            = 확정 대회 결과(앵그리랭킹 원본). 누구나 읽기, 관리자(Google 로그인)만 쓰기.
//     games 형식은 그대로, 과거 이력의 playerGames[].scores는 Firestore가 중첩 배열을
//     지원하지 않으므로 [{my,opp}] 맵 배열로 변환해 저장한다.

const FB_VERSION = '10.14.1';
let _cfg = null; // firebaseConfig
let _ready = null; // Promise<{db, fs}>
let _auth = null; // Promise<{auth, au}>

export function liveConfigure(config) {
  if (config && config.projectId) _cfg = config;
}

// 파일(file://)로 열면 Firebase 인증·Firestore가 동작하지 않는다(승인된 도메인·오리진 없음).
// 단일 HTML 배포본을 그냥 열어 쓰는 경우이므로, 클라우드 기능은 비활성으로 보고 안내만 한다.
export function cloudAvailable() {
  return typeof location !== 'undefined' && location.protocol !== 'file:';
}

export function liveEnabled() {
  return !!_cfg && cloudAvailable();
}

// Firebase SDK를 CDN에서 동적 로드 (번들/모듈 양쪽에서 동작, 오프라인이면 reject)
function fb() {
  if (!_cfg) return Promise.reject(new Error('Firebase 미설정'));
  if (!_ready) {
    _ready = (async () => {
      const appMod = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-app.js`);
      const fs = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-firestore.js`);
      const app = appMod.getApps && appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(_cfg);
      const db = fs.getFirestore(app);
      return { db, fs, app };
    })().catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

// ─── 관리자 로그인 (Google) — 랭킹 쓰기 권한 ───
function fbAuth() {
  if (!_auth) {
    _auth = (async () => {
      const { app } = await fb();
      const au = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-auth.js`);
      const auth = au.getAuth(app);
      return { auth, au };
    })().catch((e) => { _auth = null; throw e; });
  }
  return _auth;
}

// 로그인 상태 변화 구독 → cb(user | null). 반환: unsubscribe
export async function authSubscribe(cb) {
  const { auth, au } = await fbAuth();
  return au.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email, name: u.displayName } : null));
}

export async function authSignIn() {
  const { auth, au } = await fbAuth();
  const provider = new au.GoogleAuthProvider();
  try {
    const res = await au.signInWithPopup(auth, provider);
    return { uid: res.user.uid, email: res.user.email, name: res.user.displayName };
  } catch (e) {
    // 팝업 차단·모바일 인앱 브라우저 등 → 리다이렉트 방식으로 폴백
    if (/popup|blocked|cancelled|operation-not-supported/i.test(String(e && (e.code || e.message)))) {
      await au.signInWithRedirect(auth, provider);
      return null; // 리다이렉트 후 복귀 시 authSubscribe가 알려준다
    }
    throw e;
  }
}

export async function authSignOut() {
  const { auth, au } = await fbAuth();
  await au.signOut(auth);
}

// ─── 클라우드 앵그리랭킹 (results 컬렉션) ───
// Firestore는 배열 안의 배열을 지원하지 않으므로 scores [[my,opp]] ↔ [{my,opp}] 변환
function resultToDoc(r) {
  const doc = { ...r };
  delete doc.id;
  if (Array.isArray(r.playerGames)) {
    doc.playerGames = r.playerGames.map((p) => ({
      ...p,
      scores: (p.scores || []).map((s) => (Array.isArray(s) ? { my: Number(s[0]), opp: Number(s[1]) } : { my: Number(s.my), opp: Number(s.opp) })),
    }));
  }
  doc.updatedAt = Date.now();
  return doc;
}
function docToResult(id, d) {
  const r = { id, ...d };
  if (Array.isArray(d.playerGames)) {
    r.playerGames = d.playerGames.map((p) => ({ ...p, scores: (p.scores || []).map((s) => (Array.isArray(s) ? s : [s.my, s.opp])) }));
  }
  return r;
}

// ─── 클럽 명단 (club/roster) — 관리자만 읽기·쓰기 (실력 순위·개인 특성이 담겨 있어 공개하지 않는다) ───
export async function rosterSubscribe(cb) {
  const { db, fs } = await fb();
  return fs.onSnapshot(
    fs.doc(db, 'club', 'roster'),
    (snap) => cb(snap.exists() ? snap.data() : null),
    (err) => { console.warn('명단 구독 오류', err); cb(undefined, err); }
  );
}

export async function rosterPut(roster) {
  const { db, fs } = await fb();
  await fs.setDoc(fs.doc(db, 'club', 'roster'), {
    men: (roster.men || []).map(normMember),
    women: (roster.women || []).map(normMember),
    updatedAt: Date.now(),
  });
}

// Firestore에 넣을 수 있는 형태로 정리 (undefined 제거, 중첩 배열 없음)
function normMember(m) {
  return {
    id: String(m.id),
    name: String(m.name || ''),
    guest: !!m.guest,
    prefs: {
      gamePriority: !!(m.prefs && m.prefs.gamePriority),
      newMember: !!(m.prefs && m.prefs.newMember),
      mixedPreferred: !!(m.prefs && m.prefs.mixedPreferred),
    },
    presetExclude: Array.isArray(m.presetExclude) ? m.presetExclude.map(Number) : [],
  };
}

// 결과 실시간 구독 → cb(results[]). 반환: unsubscribe
export async function resultsSubscribe(cb) {
  const { db, fs } = await fb();
  return fs.onSnapshot(
    fs.collection(db, 'results'),
    (qs) => { const out = []; qs.forEach((d) => out.push(docToResult(d.id, d.data()))); cb(out); },
    (err) => { console.warn('랭킹 구독 오류', err); cb(null, err); }
  );
}

export async function resultsPut(result) {
  const { db, fs } = await fb();
  await fs.setDoc(fs.doc(db, 'results', String(result.id)), resultToDoc(result));
}

export async function resultsDelete(id) {
  const { db, fs } = await fb();
  await fs.deleteDoc(fs.doc(db, 'results', String(id)));
}

// 라이브 대회 생성 → 랜덤 문서 ID 반환
export async function liveCreate(bracket, meta) {
  const { db, fs } = await fb();
  const ref = fs.doc(fs.collection(db, 'events'));
  await fs.setDoc(ref, {
    mode: meta.mode,
    title: meta.title || '',
    date: meta.date || '',
    status: 'live',
    createdAt: Date.now(),
    // Firestore는 중첩 배열(teams:[[..],[..]])을 지원하지 않으므로 bracket은 JSON 문자열로 저장
    bracket: JSON.stringify(bracket),
  });
  return ref.id;
}

export async function liveGetEvent(id) {
  const { db, fs } = await fb();
  const snap = await fs.getDoc(fs.doc(db, 'events', id));
  if (!snap.exists()) return null;
  const data = snap.data();
  if (typeof data.bracket === 'string') { try { data.bracket = JSON.parse(data.bracket); } catch (e) { /* 무시 */ } }
  return data;
}

// 게임 스코어 저장(게임마다 개별 문서라 동시 입력 충돌 없음). a/b가 비면 문서 삭제.
export async function liveSetScore(id, gid, a, b) {
  const { db, fs } = await fb();
  const ref = fs.doc(db, 'events', id, 'games', gid);
  if (a == null && b == null) { await fs.deleteDoc(ref); return; }
  await fs.setDoc(ref, {
    a: a == null ? null : Math.max(0, Math.min(99, a | 0)),
    b: b == null ? null : Math.max(0, Math.min(99, b | 0)),
    updatedAt: Date.now(),
  });
}

// 현재 스코어 1회 조회 → { gid: {a,b} }
export async function liveFetchScores(id) {
  const { db, fs } = await fb();
  const qs = await fs.getDocs(fs.collection(db, 'events', id, 'games'));
  const scores = {};
  qs.forEach((d) => { scores[d.id] = d.data(); });
  return scores;
}

// 실시간 스코어 구독 → cb({ gid: {a,b} }). 반환값은 unsubscribe 함수(Promise).
export async function liveSubscribeScores(id, cb) {
  const { db, fs } = await fb();
  return fs.onSnapshot(fs.collection(db, 'events', id, 'games'), (qs) => {
    const scores = {};
    qs.forEach((d) => { scores[d.id] = d.data(); });
    cb(scores);
  }, (err) => { console.warn('live 구독 오류', err); });
}

// 이벤트 문서 존재 여부 구독 → cb(exists). 관리자가 "대회 종료"로 삭제하면 exists=false.
export async function liveSubscribeEvent(id, cb) {
  const { db, fs } = await fb();
  return fs.onSnapshot(fs.doc(db, 'events', id), (snap) => cb(snap.exists()), () => {});
}

// 이벤트 문서(+게임 하위문서) 삭제 — 관리자 확정/정리
export async function liveDelete(id) {
  const { db, fs } = await fb();
  const gs = await fs.getDocs(fs.collection(db, 'events', id, 'games'));
  await Promise.all(gs.docs.map((d) => fs.deleteDoc(d.ref)));
  await fs.deleteDoc(fs.doc(db, 'events', id));
}
