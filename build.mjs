// 더블클릭으로 열 수 있는 단일 HTML 파일 생성 (외부 파일·서버 불필요)
// 사용: npm run build → dist/앵그리대진표.html

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// import가 제거된 단일 스코프로 합쳐지므로 의존 순서대로 나열
const ENGINE_FILES = [
  'engine/rng.js',
  'engine/validate.js',
  'engine/planner.js',
  'engine/construct.js',
  'engine/optimize.js',
  'engine/scheduler.js',
  'app.js',
];

function stripModuleSyntax(src) {
  return src
    .replace(/^export\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\s*$/gm, '') // 재수출 제거
    .replace(/^import\s[^;]*;?\s*$/gm, '') // import 제거
    .replace(/^export\s+/gm, ''); // export 키워드만 제거
}

const bundled = ENGINE_FILES.map((f) => {
  const src = readFileSync(join(root, f), 'utf8');
  return `// ─── ${f} ───\n${stripModuleSyntax(src)}`;
}).join('\n');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const out = html.replace(
  '<script type="module" src="./app.js"></script>',
  `<script>\n'use strict';\n${bundled}\n</script>`
);

if (out === html) {
  throw new Error('index.html에서 스크립트 태그를 찾지 못했습니다.');
}

mkdirSync(join(root, 'dist'), { recursive: true });
const outPath = join(root, 'dist', '앵그리대진표.html');
writeFileSync(outPath, out, 'utf8');
console.log('생성 완료:', outPath, `(${Math.round(out.length / 1024)}KB)`);
