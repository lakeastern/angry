// live.js — Firebase Firestore 실시간 대회(라이브 스코어) 계층.
// 선택적 계층: firebaseConfig 미설정·오프라인·파일(file://) 열기 등으로 SDK 로드에 실패하면
// 조용히 비활성화되고, 앱의 나머지 오프라인 기능은 그대로 동작한다.
//
// 데이터 모델:
//   events/{id}            = { mode, title, date, status:'live', createdAt, bracket:{...} }
//   events/{id}/games/{gid} = { a, b, updatedAt }   (gid = `${round}_${court}`)
// 링크(정확한 랜덤 문서 ID)를 아는 사람만 읽기·쓰기(보안 규칙). ID 추측/목록 조회는 차단.

const FB_VERSION = '10.14.1';
let _cfg = null; // firebaseConfig
let _ready = null; // Promise<{db, fs}>

export function liveConfigure(config) {
  if (config && config.projectId) _cfg = config;
}

export function liveEnabled() {
  return !!_cfg;
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
      return { db, fs };
    })().catch((e) => { _ready = null; throw e; });
  }
  return _ready;
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
