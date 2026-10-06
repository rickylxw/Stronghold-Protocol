#!/usr/bin/env node
// scripts/make-update-package.mjs — 打「自动更新」用的纯代码包（shared/update.js 通道的发布侧）。
//
//   node scripts/make-update-package.mjs [--out <dir>] [--help]
//
// 产物（默认 <仓库上一级>\Stronghold-Protocol-Update\）：
//   stronghold-protocol-code-vX.Y.Z.zip       纯代码包：git 跟踪文件（略过 test/）+ 生产依赖 + public/vendor，
//                                             **不含** public/assets 与 public/fonts（那 330 MB 由玩家的
//                                             整合包自己留着，素材清单有变时更新后补跑 setup 下载）。
//   stronghold-protocol-code-vX.Y.Z.zip.sha256  zip 的 sha256（与 latest.json 里的一致，人肉复核用）。
//   latest.json                               { version, zip, url, sha256, notes } —— 发版时**两处都要**：
//                                             附到 GitHub release（API 检查源），并把新的这一份提交到仓库根
//                                             （jsDelivr 检查源：https://cdn.jsdelivr.net/gh/<slug>@master/latest.json）。
//
// 和 make-windows-bundle.mjs 同源：文件清单来自 `git ls-files`，依赖用 `npm ci --omit=dev` 重装，
// zip 用 fflate 在内存里打（条目名保证正斜杠，Compress-Archive 在老版 PowerShell 里的反斜杠条目名
// 会让 zip-slip 校验之后的真实路径全都对不上）。
//
// 发版顺序见 docs/WINDOWS.md「发布一个新版本」。

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip as fflateZip } from 'fflate';
import { APP_VERSION } from '../shared/constants.js';
import { parseVersion, releaseDownloadUrl, releaseNotesUrl, repoSlugFromUrl } from '../shared/update.js';
import { buildManifest } from '../tools/update/manifest.mjs';
import { copyDir, copyFiles, installProductionDeps, SKIP_TRACKED, trackedFiles } from './make-windows-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const promisifyZip = (files) => new Promise((resolve, reject) =>
  fflateZip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data))));

function parseArgs(argv) {
  const o = { out: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    if (k === '--out') o.out = String(v !== undefined ? v : argv[++i] ?? '');
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const HELP = `node scripts/make-update-package.mjs — 生成自动更新用的纯代码包

  --out <dir>        产物目录（默认 <仓库上一级>/Stronghold-Protocol-Update）

  产物：stronghold-protocol-code-v<APP_VERSION>.zip（+ .sha256 + latest.json）。
  版本号取 shared/constants.js 的 APP_VERSION；zip 名与 URL 规则见 shared/update.js
  （releases/download/v<version>/<zip>），发版时把 zip、latest.json 附到 release，
  并把 latest.json 提交到仓库根（jsDelivr 从分支读取）。
`;

/** 读 package.json 的 repository（仓库根），拿不到公开 GitHub 地址就报错 —— URL 规则依赖它。 */
async function repoSlug() {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const slug = repoSlugFromUrl(pkg.repository);
    if (slug) return slug;
  } catch { /* fallthrough */ }
  throw new Error('package.json 的 repository 不是公开的 GitHub 地址：无法生成 latest.json 的下载 URL');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }
  const version = APP_VERSION;
  if (!parseVersion(version)) throw new Error(`shared/constants.js 的 APP_VERSION 不是可比较的版本号：${version}`);
  const slug = await repoSlug();

  const out = path.resolve(o.out || path.join(path.dirname(ROOT), 'Stronghold-Protocol-Update'));
  const zipName = `stronghold-protocol-code-v${version}.zip`;
  console.log(`\n卫戍协议 · 自动更新代码包\n  版本：  v${version}\n  仓库：  ${slug}\n  产物：  ${out}\n`);
  await fsp.mkdir(out, { recursive: true });

  // 1) 暂存目录：代码 + vendor + 生产依赖，打好清单后压成 zip
  const stage = path.join(out, `.stage-v${version}`);
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });
  try {
    const all = trackedFiles();
    const wanted = all.filter((rel) => !SKIP_TRACKED.some((p) => rel === p || rel.startsWith(p)));
    console.log(`  · 复制代码（git 跟踪的 ${wanted.length} 个文件，略过 ${all.length - wanted.length} 个 test/ 文件）…`);
    const copied = await copyFiles(wanted, stage);
    console.log(`    完成：${copied.files} 个文件 / ${MB(copied.bytes)}`);

    const vendor = path.join(ROOT, 'public', 'vendor');
    if (!fs.existsSync(vendor)) throw new Error('缺少 public/vendor —— 先运行 node tools/setup.mjs');
    console.log('  · 复制前端库（public/vendor）…');
    const vend = await copyDir(vendor, path.join(stage, 'public', 'vendor'));
    console.log(`    完成：${vend.files} 个文件 / ${MB(vend.bytes)}`);

    console.log('  · 安装生产依赖…');
    await installProductionDeps(stage);

    console.log('  · 生成文件清单 manifest.json …');
    const manifest = await buildManifest(stage, { version });
    const manifestFiles = Object.keys(manifest.files).length;
    await fsp.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
    console.log(`    完成：${manifestFiles + 1} 个文件（清单本身不计哈希）`);

    console.log('  · 打 zip（fflate，稍等）…');
    const files = {};
    const walk = async (dir, rel) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), child);
        else if (e.isFile()) files[child] = new Uint8Array(await fsp.readFile(path.join(dir, e.name)));
      }
    };
    await walk(stage, '');
    const zipped = await promisifyZip(files);

    const zipPath = path.join(out, zipName);
    await fsp.writeFile(zipPath, zipped);
    const sha256 = createHash('sha256').update(zipped).digest('hex');
    await fsp.writeFile(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);
    const latest = {
      version,
      zip: zipName,
      url: releaseDownloadUrl(slug, version, zipName),
      sha256,
      notes: releaseNotesUrl(slug, version),
    };
    await fsp.writeFile(path.join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);

    console.log(`\n✔ 更新包已生成：${out}`);
    console.log(`  ${zipName}           ${MB(zipped.length)}`);
    console.log(`  latest.json          version=${version} sha256=${sha256.slice(0, 12)}…`);
    console.log('\n  发版三步（缺一不可，见 docs/WINDOWS.md「发布一个新版本」）：');
    console.log('    1. 把上面的 zip 与 latest.json 附到 GitHub release（v' + version + '）');
    console.log('    2. 把这份 latest.json 提交到仓库根（jsDelivr 检查源靠它）');
    console.log('    3. 用 node scripts/make-windows-bundle.mjs 重打整合包（老玩家的最后一次手动升级入口）');
    return 0;
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
  }
}

// 与 make-windows-bundle.mjs 相同的 isMain 约定：被 import 时只导出纯函数。
function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
