// 把仓库里的网页装进 mobile/www，供 Capacitor 打进 APK。
//
//   CNM_API_BASE=https://xuexi.example.com node build-www.mjs
//
// 和网页版的区别：
// - 页面从 APK 本地加载（离线可用），孩子档案和诊断记录只走服务器的 /api
// - 去掉 pwa.js 和 pwa.css：「添加到桌面」在 app 里没有意义，service worker 也会让
//   app 更新后继续用旧的 JS
// - 不拷 data/_qbatches 等生成中间产物，不拷 screenshots、docs、scripts
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'www');
const apiBase = (process.env.CNM_API_BASE || '').replace(/\/+$/, '');

const PAGES = 'index.html manifest.webmanifest .nojekyll';
const DIRS = ['assets', 'explore', 'diagnose', 'children', 'account'];
const DATA_FILES = [
  'topics.json', 'dependencies.json', 'cn-curriculum-standards.json',
  'questions.json', 'id-aliases.json'
];
// 这些子目录不进包：收款码（可选）、生成中间产物
const SKIP = new Set(['sponsor']);

async function copyDir(from, to, depth = 0) {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const src = join(from, e.name), dst = join(to, e.name);
    if (e.isDirectory()) await copyDir(src, dst, depth + 1);
    else if (e.isFile()) await cp(src, dst);
  }
}

async function stripPwa(htmlPath) {
  let s = await readFile(htmlPath, 'utf8');
  const before = s;
  s = s.replace(/[ \t]*<script[^>]*assets\/pwa\.js[^>]*><\/script>\r?\n?/g, '');
  s = s.replace(/[ \t]*<link[^>]*assets\/pwa\.css[^>]*>\r?\n?/g, '');
  if (s !== before) await writeFile(htmlPath, s);
}

async function walkHtml(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkHtml(p);
    else if (e.name.endsWith('.html')) await stripPwa(p);
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const f of PAGES.split(' ')) {
  await cp(join(root, f), join(out, f));
}
for (const d of DIRS) {
  await copyDir(join(root, d), join(out, d));
}
await mkdir(join(out, 'data'), { recursive: true });
for (const f of DATA_FILES) {
  await cp(join(root, 'data', f), join(out, 'data', f));
}

// 服务器地址。网页版读同一个文件（值为空，同源），APK 里指向真实域名。
await writeFile(
  join(out, 'assets', 'sync-config.js'),
  '/* 由 mobile/build-www.mjs 生成。APK 里的页面和服务器不同源，必须写完整地址。 */\n' +
  `window.CNM_API_BASE = ${JSON.stringify(apiBase)};\n`
);

await walkHtml(out);

const size = async (dir) => {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? await size(p) : (await stat(p)).size;
  }
  return n;
};
const total = await size(out);
console.log(`www 生成完毕：${(total / 1024 / 1024).toFixed(1)} MB，API 地址 = ${apiBase || '(空，将访问相对路径 /api，APK 里不可用)'}`);
if (!apiBase) {
  console.warn('警告：没有设置 CNM_API_BASE，打出来的 APK 连不上服务器。用 CNM_API_BASE=https://你的域名 node build-www.mjs');
}
