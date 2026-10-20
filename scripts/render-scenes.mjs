#!/usr/bin/env node
// render-scenes.mjs — 按镜头增量渲染 HyperFrames 工程
//
// 把 index.html 根层的每个镜头宿主（带 data-composition-src 的元素）切成独立片段，
// 按内容哈希跳过没改过的片段，只重渲改动的，再用 ffmpeg 无损拼接、套上总音轨。
//
// 用法：node render-scenes.mjs [工程目录] [选项]
//   --audio <文件>     总混音（默认：根层唯一一个 data-start=0 的 <audio>）
//   --out <文件>       成片路径（默认 renders/scenes-film.mp4）
//   --quality <q>      draft | looks | delivery（默认 draft）
//   --fps <n>          帧率（默认取根元素 data-fps，否则 30）
//   --only <a,b>       强制重渲这些片段（片段 id 或镜头 composition id）
//   --all              忽略缓存，全部重渲
//   --jobs <n>         同时渲染几个片段（默认 1；HyperFrames 自己已经多进程）
//   --dry-run          只打印计划，不渲染
//   --no-seams         不生成接缝检查图
//   --keep-wrappers    保留每个片段的临时 HTML（调试用）
//
// 环境变量：FFMPEG_DIR=ffmpeg/ffprobe 所在目录（不在 PATH 上时用）

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_VERSION = '1';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = { quality: 'draft', jobs: 1, seams: true };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--audio') opt.audio = next();
  else if (a === '--out') opt.out = next();
  else if (a === '--quality') opt.quality = next();
  else if (a === '--fps') opt.fps = Number(next());
  else if (a === '--only') opt.only = next().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--all') opt.all = true;
  else if (a === '--jobs') opt.jobs = Math.max(1, Number(next()) || 1);
  else if (a === '--dry-run') opt.dryRun = true;
  else if (a === '--no-seams') opt.seams = false;
  else if (a === '--keep-wrappers') opt.keepWrappers = true;
  else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  else if (a.startsWith('-')) die(`未知选项：${a}`);
  else pos.push(a);
}
const projectDir = path.resolve(pos[0] || '.');
const indexPath = path.join(projectDir, 'index.html');
if (!fs.existsSync(indexPath)) die(`找不到 ${indexPath}`);

function printHelp() {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
const warn = (msg) => console.warn(`⚠ ${msg}`);

// ---------- 依赖 ----------
async function loadLinkedom() {
  const req = path.join(scriptDir, 'node_modules', 'linkedom', 'esm', 'index.js');
  if (!fs.existsSync(req)) {
    console.log('· 首次运行，安装 HTML 解析器 linkedom…');
    execFileSync('npm', ['install', '--prefix', scriptDir, '--no-audit', '--no-fund', '--silent'], { stdio: 'inherit' });
  }
  return import(pathToFileURL(req).href);
}
const { parseHTML } = await loadLinkedom();

const binDir = process.env.FFMPEG_DIR;
const env = { ...process.env, PATH: binDir ? `${binDir}${path.delimiter}${process.env.PATH}` : process.env.PATH };
function bin(name) {
  try { execFileSync(name, ['-version'], { env, stdio: 'ignore' }); return name; }
  catch { die(`找不到 ${name}。装好 ffmpeg，或者设置 FFMPEG_DIR 指向它所在的目录。`); }
}
const FFMPEG = bin('ffmpeg');
const FFPROBE = bin('ffprobe');

// ---------- 解析工程 ----------
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const { document } = parseHTML(indexHtml);
const root = [...document.querySelectorAll('[data-composition-id]')].find((el) => !el.hasAttribute('data-composition-src'));
if (!root) die('index.html 里找不到根 composition（带 data-composition-id、且没有 data-composition-src 的元素）');
const rootId = root.getAttribute('data-composition-id');
const fps = opt.fps || Number(root.getAttribute('data-fps')) || 30;
const frame = (t) => Math.round(t * fps);
const num = (el, name, dflt) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : dflt);

// 根层计时元素：带 data-start、且不在某个镜头宿主里面
const isHost = (el) => el.hasAttribute('data-composition-src');
const timed = [...root.querySelectorAll('[data-start]')].filter((el) => {
  for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (isHost(p)) return false;
  return true;
});
const hosts = timed.filter(isHost);
if (!hosts.length) die('根层没有镜头宿主（带 data-composition-src 的元素），没法按镜头拆分');

const filmEnd = Math.max(
  num(root, 'data-duration', 0),
  ...timed.filter((el) => el.hasAttribute('data-duration')).map((el) => num(el, 'data-start', 0) + num(el, 'data-duration', 0)),
);
const totalFrames = frame(filmEnd);

// 时间上重叠的宿主（比如交叉转场）归进同一个片段；片段边界就是切点
const sortedHosts = hosts
  .map((el) => ({ el, id: el.getAttribute('data-composition-id') || el.id, s: frame(num(el, 'data-start', 0)), e: frame(num(el, 'data-start', 0) + num(el, 'data-duration', 0)) }))
  .sort((a, b) => a.s - b.s);
for (const h of sortedHosts) {
  const exact = num(h.el, 'data-start', 0) * fps;
  if (Math.abs(exact - Math.round(exact)) > 0.01) warn(`镜头 ${h.id} 的起点 ${h.el.getAttribute('data-start')}s 不在帧格上，已取整到第 ${h.s} 帧`);
}
const groups = [];
for (const h of sortedHosts) {
  const g = groups[groups.length - 1];
  if (g && h.s < g.e) { g.hosts.push(h); g.e = Math.max(g.e, h.e); } else groups.push({ hosts: [h], s: h.s, e: h.e });
}
// 片段窗口铺满整条时间线：从上一个切点到下一个片段的起点
const segments = groups.map((g, i) => ({
  id: g.hosts.map((h) => h.id).join('+'),
  hosts: g.hosts,
  f0: i === 0 ? 0 : g.s,
  f1: i === groups.length - 1 ? Math.max(totalFrames, g.e) : groups[i + 1].s,
}));

// ---------- 每个片段的临时 HTML ----------
const SHIM = (S, D) => `<script data-render-scenes-shim>(function(){
  window.__SCENE_WINDOW__ = { start: ${S}, duration: ${D} };
  var id = ${JSON.stringify(rootId)}, tls = window.__timelines || {}, orig = tls[id];
  if (!orig || !window.gsap) return;
  var proxy = gsap.timeline({ paused: true });
  proxy.add(orig.tweenFromTo(${S}, ${S + D}, { duration: ${D}, ease: "none" }), 0);
  tls[id] = proxy;
})();</script>`;

function buildWrapper(seg) {
  const { document: doc } = parseHTML(indexHtml);
  const r = [...doc.querySelectorAll('[data-composition-id]')].find((el) => !el.hasAttribute('data-composition-src'));
  const S = seg.f0 / fps, E = seg.f1 / fps, D = E - S;
  const notes = [];
  const items = [...r.querySelectorAll('[data-start]')].filter((el) => {
    for (let p = el.parentElement; p && p !== r; p = p.parentElement) if (isHost(p)) return false;
    return true;
  });
  for (const el of items) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'audio') { el.remove(); continue; } // 声音最后统一用总混音套上
    const s = num(el, 'data-start', 0);
    const e = el.hasAttribute('data-duration') ? s + num(el, 'data-duration', 0) : filmEnd;
    if (e <= S + 1e-6 || s >= E - 1e-6) { el.remove(); continue; }
    const ns = Math.max(s, S), ne = Math.min(e, E);
    if (s < S - 1e-6) {
      if (isHost(el)) notes.push(`镜头 ${el.getAttribute('data-composition-id')} 起点早于片段窗口`);
      else notes.push(`${el.id || tag} 跨过了 ${S.toFixed(3)}s 的切点`);
      if (tag === 'video') el.setAttribute('data-media-start', String(num(el, 'data-media-start', 0) + (S - s)));
    }
    el.setAttribute('data-start', String(+(ns - S).toFixed(6)));
    if (el.hasAttribute('data-duration') || ne < e) el.setAttribute('data-duration', String(+(ne - ns).toFixed(6)));
  }
  if (r.hasAttribute('data-duration')) r.setAttribute('data-duration', String(+D.toFixed(6)));
  doc.body.insertAdjacentHTML('beforeend', SHIM(S, D));
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, notes };
}

// ---------- 内容哈希 ----------
const REF_RE = /(?:src|href)\s*=\s*["']([^"'#?]+)|url\(\s*["']?([^"')#?]+)/g;
function localRefs(text, baseDir) {
  const out = new Set();
  for (const m of text.matchAll(REF_RE)) {
    const ref = (m[1] || m[2] || '').trim();
    if (!ref || /^(https?:|data:|blob:|\/\/)/.test(ref)) continue;
    for (const base of [projectDir, baseDir]) {
      const p = path.resolve(base, ref);
      if (p.startsWith(projectDir) && fs.existsSync(p) && fs.statSync(p).isFile()) { out.add(p); break; }
    }
  }
  return out;
}
const fileHashCache = new Map();
function hashFile(p) {
  if (!fileHashCache.has(p)) fileHashCache.set(p, createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  return fileHashCache.get(p);
}
let hfVersion = 'unknown';
try { hfVersion = execFileSync('npx', ['hyperframes', '--version'], { cwd: projectDir, env, encoding: 'utf8' }).trim(); } catch {}

function segmentHash(seg, wrapperHtml) {
  const h = createHash('sha256');
  h.update(JSON.stringify({ SCRIPT_VERSION, hfVersion, fps, quality: opt.quality, f0: seg.f0, f1: seg.f1 }));
  h.update(wrapperHtml);
  const files = new Set(localRefs(wrapperHtml, projectDir));
  for (const host of seg.hosts) {
    const src = path.resolve(projectDir, host.el.getAttribute('data-composition-src'));
    if (!fs.existsSync(src)) die(`镜头 ${host.id} 的文件不存在：${src}`);
    files.add(src);
    for (const f of localRefs(fs.readFileSync(src, 'utf8'), path.dirname(src))) files.add(f);
  }
  // 样式表里再引用的字体、图片也算进去
  for (const f of [...files]) if (f.endsWith('.css')) for (const g of localRefs(fs.readFileSync(f, 'utf8'), path.dirname(f))) files.add(g);
  for (const f of [...files].sort()) h.update(path.relative(projectDir, f) + ':' + hashFile(f));
  return h.digest('hex').slice(0, 16);
}

// ---------- 缓存 ----------
const cacheDir = path.join(projectDir, 'renders', '.scene-cache');
fs.mkdirSync(cacheDir, { recursive: true });
const manifestPath = path.join(cacheDir, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const safe = (id) => id.replace(/[^\w.+-]/g, '_');

const plan = segments.map((seg) => {
  const { html, notes } = buildWrapper(seg);
  const hash = segmentHash(seg, html);
  const file = path.join(cacheDir, safe(seg.id), `${hash}.mp4`);
  const forced = opt.all || (opt.only && (opt.only.includes(seg.id) || seg.hosts.some((h) => opt.only.includes(h.id))));
  const reuse = !forced && fs.existsSync(file);
  return { ...seg, html, notes, hash, file, reuse, prev: manifest[seg.id]?.hash };
});

const fmt = (f) => (f / fps).toFixed(3).padStart(8);
console.log(`\n工程：${projectDir}\n${segments.length} 个片段 · ${fps}fps · ${opt.quality} · 全长 ${(totalFrames / fps).toFixed(3)}s（${totalFrames} 帧）\n`);
for (const p of plan) {
  const why = p.reuse ? '复用' : opt.all ? '重渲（--all）' : (p.prev === p.hash && fs.existsSync(p.file)) ? '重渲（--only 指定）' : p.prev ? '重渲（内容变了）' : '渲染（无缓存）';
  console.log(`  ${p.reuse ? '·' : '▶'} ${p.id.padEnd(24)} ${fmt(p.f0)} → ${fmt(p.f1)}  ${why}`);
  for (const n of p.notes) console.log(`      ${n}`);
}
const todo = plan.filter((p) => !p.reuse);
console.log(`\n要渲染 ${todo.length} 个，复用 ${plan.length - todo.length} 个。`);
if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?__timelines/.test(indexHtml.split(/<\/head>/i)[1] || '')) {
  console.log('提示：根层有时间轴脚本。脚本本身一改，所有片段的哈希都会变，全部重渲。跨镜头的字幕/叠层最好放进各自镜头的 composition。');
}
if (opt.dryRun) process.exit(0);

// ---------- 渲染 ----------
function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('close', (code) => (code === 0 ? resolve(log) : reject(new Error(`${label} 失败（退出码 ${code}）\n${log.slice(-3000)}`))));
  });
}
const countFrames = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f], { env, encoding: 'utf8' }).trim());

async function renderOne(p) {
  const wrapperName = `__scene_${safe(p.id)}.html`;
  const wrapperPath = path.join(projectDir, wrapperName);
  fs.writeFileSync(wrapperPath, p.html);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  const tmp = p.file.replace(/\.mp4$/, '.part.mp4');
  const t0 = Date.now();
  try {
    await run('npx', ['hyperframes', 'render', '.', '-c', wrapperName, '-o', tmp, '-q', opt.quality, '-f', String(fps), '--quiet'], `渲染 ${p.id}`);
  } finally {
    if (!opt.keepWrappers) fs.rmSync(wrapperPath, { force: true });
  }
  const want = p.f1 - p.f0, got = countFrames(tmp);
  if (got !== want) throw new Error(`片段 ${p.id} 帧数不对：应为 ${want}，实际 ${got}`);
  fs.renameSync(tmp, p.file);
  // 每个片段只留最近 3 个版本
  const dir = path.dirname(p.file);
  fs.readdirSync(dir).filter((f) => f.endsWith('.mp4') && !f.includes('.part.'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
    .slice(3).forEach(({ f }) => fs.rmSync(path.join(dir, f)));
  console.log(`  ✓ ${p.id}  ${want} 帧  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const tStart = Date.now();
const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(opt.jobs, queue.length) }, async () => {
  while (queue.length) await renderOne(queue.shift());
})).catch((e) => die(e.message));

for (const p of plan) manifest[p.id] = { hash: p.hash, file: path.relative(projectDir, p.file), f0: p.f0, f1: p.f1 };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ---------- 拼接 + 套音轨 ----------
const out = path.resolve(projectDir, opt.out || 'renders/scenes-film.mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });
const listFile = path.join(cacheDir, 'concat.txt');
fs.writeFileSync(listFile, plan.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
const silent = path.join(cacheDir, 'film-silent.mp4');
await run(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-an', silent], '拼接').catch((e) => die(e.message));
const filmFrames = countFrames(silent);
if (filmFrames !== totalFrames) warn(`拼接后 ${filmFrames} 帧，时间线应为 ${totalFrames} 帧`);

let audio = opt.audio && path.resolve(projectDir, opt.audio);
if (!audio) {
  const auds = [...root.querySelectorAll('audio[src]')];
  const main = auds.filter((a) => num(a, 'data-start', 0) === 0 && num(a, 'data-media-start', 0) === 0);
  if (auds.length === 1 && main.length === 1) audio = path.resolve(projectDir, main[0].getAttribute('src'));
  else if (auds.length) warn(`根层有 ${auds.length} 个 <audio>，没法自动选总音轨；用 --audio 指定混好的总混音。这次输出无声版。`);
}
if (audio) {
  if (!fs.existsSync(audio)) die(`音轨不存在：${audio}`);
  await run(FFMPEG, ['-v', 'error', '-y', '-i', silent, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', out], '套音轨').catch((e) => die(e.message));
  const aDur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio], { env, encoding: 'utf8' }).trim());
  const vDur = filmFrames / fps;
  if (Math.abs(aDur - vDur) > 1 / fps) warn(`音轨 ${aDur.toFixed(3)}s，画面 ${vDur.toFixed(3)}s，相差超过 1 帧`);
} else {
  fs.copyFileSync(silent, out);
}

// ---------- 接缝检查图 ----------
// 每个重渲片段的前后切点，各取 −0.5s、−0.2s、−1 帧、切点、+0.2s、+0.5s 六帧拼成一行，给定点快检用
const seams = [];
if (opt.seams && todo.length) {
  const seamDir = path.join(cacheDir, 'seams');
  fs.rmSync(seamDir, { recursive: true, force: true });
  fs.mkdirSync(seamDir, { recursive: true });
  const cuts = new Set();
  for (const p of todo) { if (p.f0 > 0) cuts.add(p.f0); if (p.f1 < filmFrames) cuts.add(p.f1); }
  for (const c of [...cuts].sort((a, b) => a - b)) {
    const picks = [-0.5, -0.2, -1 / fps, 0, 0.2, 0.5].map((dt) => Math.min(filmFrames - 1, Math.max(0, c + Math.round(dt * fps))));
    const png = path.join(seamDir, `cut_${(c / fps).toFixed(3)}s.png`);
    const sel = picks.map((n) => `eq(n\\,${n})`).join('+');
    await run(FFMPEG, ['-v', 'error', '-y', '-i', silent, '-vf', `select='${sel}',scale=360:-2,tile=${picks.length}x1`, '-frames:v', '1', '-fps_mode', 'passthrough', png], '接缝图').catch((e) => warn(e.message));
    seams.push(path.relative(projectDir, png));
  }
}

const report = {
  at: new Date().toISOString(), fps, quality: opt.quality, out: path.relative(projectDir, out), frames: filmFrames,
  rendered: todo.map((p) => ({ id: p.id, start: p.f0 / fps, end: p.f1 / fps })),
  reused: plan.filter((p) => p.reuse).map((p) => p.id),
  seams, seconds: +((Date.now() - tStart) / 1000).toFixed(1),
};
fs.writeFileSync(path.join(cacheDir, 'last-run.json'), JSON.stringify(report, null, 2));
console.log(`\n成片：${report.out}（${filmFrames} 帧${audio ? '，已套音轨' : '，无声'}）· 用时 ${report.seconds}s`);
if (seams.length) console.log(`接缝检查图：\n${seams.map((s) => '  ' + s).join('\n')}`);
console.log(`本次记录：${path.relative(projectDir, path.join(cacheDir, 'last-run.json'))}`);
