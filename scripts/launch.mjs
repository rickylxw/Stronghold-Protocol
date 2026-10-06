#!/usr/bin/env node
// scripts/launch.mjs — cross-platform "prepare + start + open the browser", used by scripts/start-windows.bat,
// scripts/start-windows.ps1 and scripts/start.sh (docs/DEPLOY.md).
//
//   node scripts/launch.mjs [--port 3000] [--host 0.0.0.0] [--no-open] [--no-setup] [--update] [--no-update] [setup options…]
//
//   1. If our server already answers on the port, just open the browser (double-clicking twice is harmless).
//   2. Self-update (docs/DEPLOY.md「更新」; skip with --no-update or SP_NO_UPDATE_CHECK, force with --update):
//      applies an already staged update, else checks for a newer release (server/updateCheck.js) and — for bundle
//      installs, never git checkouts — asks to download and apply it while nothing is running.
//   3. node tools/setup.mjs --quiet (dependencies, vendor libs, art download / resume, optional local extraction);
//      setup options such as --no-assets, --no-local, --local, --game <dir>, -y are passed through.
//   4. node server/index.js (PORT / HOST from the options or the environment; SP_COMBAT / SP_VERIFY / TRUST_PROXY /
//      DEBUG are inherited), then — once /healthz answers — prints the addresses to share and opens
//      http://localhost:<port> (not with --no-open, SP_NO_BROWSER=1, or on a Linux box without a display).
//      If an update was applied this boot and the server fails to come up, the pre-update files are restored
//      from .update-backup and the server starts once more on them.
// Ctrl+C stops the server (it gets the signal from the terminal itself); the exit code is the server's.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
// 打开浏览器只有一份实现（走 shell 关联 = 默认浏览器，且不会把浏览器拉成提权）
import { openBrowser as openInBrowser } from './open-browser.mjs';
import { APP_VERSION } from '../shared/constants.js';
import { compareVersions, DEFAULT_GITHUB_PROXY } from '../shared/update.js';
import { checkForUpdate, repoSlug, updateCheckDisabled } from '../server/updateCheck.js';
import {
  applyStaged, discardStaged, finishUpdate, hasStagedUpdate, installedVersion, rollbackUpdate, stageUpdate, stagedVersion,
} from '../tools/update/apply.mjs';
import { downloadUpdate } from '../tools/update/download.mjs';
import { normalizeProxyPrefix } from '../tools/assets/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node.js ${process.versions.node} 太旧，需要 22 或更高（22 / 24 LTS）：https://nodejs.org/zh-cn/download`);
  process.exit(1);
}

const { c, mark } = await import('../tools/setup.mjs');
const { probePort, classifyAddresses, KIND_LABEL } = await import('../tools/doctor.mjs');

function parseArgs(argv) {
  const o = { port: Number(process.env.PORT) || 3000, host: process.env.HOST || '0.0.0.0', open: !/^(1|true|yes)$/i.test(process.env.SP_NO_BROWSER || ''), setup: true, update: undefined, setupArgs: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--port') o.port = Number(val()) || o.port;
    else if (k === '--host') o.host = Number(val()) || o.host;
    else if (a === '--no-open') o.open = false;
    else if (a === '--no-setup') o.setup = false;
    else if (a === '--update') o.update = true;
    else if (a === '--no-update') o.update = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--game') o.setupArgs.push(a, argv[++i] ?? '');
    else o.setupArgs.push(a);
  }
  return o;
}

function openBrowser(url) {
  return openInBrowser(url) !== null;
}

function printShare(port) {
  const addrs = classifyAddresses().filter((a) => a.kind === 'lan' || a.kind === 'vpn' || a.kind === 'public');
  const line = c.dim('─'.repeat(56));
  console.log(`\n${line}`);
  console.log(`${mark.ok} ${c.bold('服务器已启动')}   本机打开：${c.cyan(`http://localhost:${port}`)}`);
  if (addrs.length) {
    console.log('  发给朋友（需要能访问这台电脑的网络）：');
    for (const a of addrs.slice(0, 4)) console.log(`    ${c.cyan(`http://${a.address}:${port}`)}  ${c.dim(KIND_LABEL[a.kind])}`);
  } else {
    console.log(c.warn('  没有检测到局域网地址：朋友暂时无法连接（检查网线/Wi-Fi）。'));
  }
  console.log(c.dim('  建房后把 4 位「同盟密钥」或「复制链接」（…/?room=密钥）发给朋友。'));
  console.log(c.dim('  朋友打不开？运行 node tools/doctor.mjs 检查防火墙。按 Ctrl+C 停止服务器。'));
  console.log(`${line}\n`);
}

async function waitHealthy(port, child, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && child.exitCode === null) {
    const p = await probePort(port);
    if (p.state === 'ours') return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(src.slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const localUrl = `http://localhost:${o.port}`;

  const before = await probePort(o.port, o.host);
  if (before.state === 'ours') {
    console.log(`${mark.ok} 服务器已经在运行（端口 ${o.port}），直接打开浏览器。`);
    printShare(o.port);
    if (o.open) openBrowser(localUrl);
    return 0;
  }
  if (before.state !== 'free') {
    console.error(`${mark.err} 端口 ${o.port} 被其他程序占用或无权限（${before.code || before.state}）。`);
    console.error(`  换一个端口：${IS_WIN ? 'scripts\\start-windows.bat --port 3001' : 'scripts/start.sh --port 3001'}`);
    return 1;
  }

  // —— 自动更新：走到这里说明没有任何我们的服务器在跑，是唯一可以安全换文件的窗口 ——
  const updateResult = await maybeUpdate(o);

  if (o.setup) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'setup.mjs'), '--quiet', ...o.setupArgs], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) { console.error(`${mark.err} 准备步骤失败（见上方）。`); return r.status || 1; }
  } else if (updateResult?.assetsChanged) {
    console.log(`${mark.warn} 本版素材清单有变化，而本次是 --no-setup 启动：包内素材仍可玩，联网运行 node tools/setup.mjs 可补齐新素材。`);
  }

  const env = { ...process.env, PORT: String(o.port), HOST: o.host };
  let child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: 'inherit' });
  const forward = (sig) => { if (child.exitCode === null) { try { child.kill(sig); } catch { /* gone */ } } };
  // SIGINT reaches the server straight from the terminal (same process group / console); forwarding it too would make
  // the server's second-signal path force-exit. Other signals (service managers, `kill`) are forwarded.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => forward(sig === 'SIGBREAK' ? 'SIGTERM' : sig)); } catch { /* unsupported here */ } }

  const exitedFor = (p) => new Promise((resolve) => p.once('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1))));
  let exited = exitedFor(child);
  if (await waitHealthy(o.port, child)) {
    if (updateResult) await finishUpdate(ROOT).catch(() => {});   // 新版本确认能跑：备份与暂存清理掉
    printShare(o.port);
    if (o.open && !openBrowser(localUrl)) console.log(c.dim(`（未能自动打开浏览器，请手动访问 ${localUrl}）`));
    return exited;
  }
  // 本次启动应用过更新且服务器没能起来：回滚到更新前的文件再试一次。
  if (updateResult) {
    console.error(`${mark.err} 更新后的 v${updateResult.to} 未能启动，回滚到 v${updateResult.from} 再试一次…`);
    if (child.exitCode === null) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    if (await rollbackUpdate(ROOT)) {
      await new Promise((r) => setTimeout(r, 1000));               // 给端口释放留一点时间
      child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: 'inherit' });
      exited = exitedFor(child);
      if (await waitHealthy(o.port, child)) {
        console.log(`${mark.warn} 已回滚到 v${updateResult.from}。这次更新没能启动的原因值得报一个 Issue（.update-backup 已清理）。`);
        printShare(o.port);
        if (o.open && !openBrowser(localUrl)) console.log(c.dim(`（未能自动打开浏览器，请手动访问 ${localUrl}）`));
        return exited;
      }
      console.error(`${mark.err} 回滚到 v${updateResult.from} 后仍未能启动 —— 问题多半不在更新本身。诊断：node tools/doctor.mjs`);
    } else {
      console.error(`${mark.err} 回滚失败（.update-backup 不完整）：请到 Releases 页面重新下载整合包覆盖。`);
    }
  }
  return exited;
}

// ---- 自动更新（shared/update.js 通道；docs/DEPLOY.md「更新」）--------------------------------------

const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** --update / SP_AUTO_UPDATE=1 免确认；交互终端才询问，脚本/服务等非交互场景一律不下载。 */
async function confirmUpdate(version) {
  if (/^(1|true|yes)$/i.test(process.env.SP_AUTO_UPDATE || '')) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`发现新版本 v${version}（当前 v${APP_VERSION}），下载并更新吗？[Y/n] `)).trim().toLowerCase();
    return a === '' || a === 'y' || a === 'yes';
  } finally { rl.close(); }
}

/**
 * 下载是否走镜像前缀：复用素材下载的开关（SP_ASSET_SOURCE=mirror + SP_GITHUB_PROXY 前缀，可用
 * SP_UPDATE_SOURCE 单独覆盖），前缀无效就退回直连 —— 项目对第三方代理的立场是「提示，不自动切」。
 */
function updateMirror() {
  const mode = String(process.env.SP_UPDATE_SOURCE || process.env.SP_ASSET_SOURCE || 'direct').toLowerCase();
  if (mode !== 'mirror') return { mirror: false, proxyPrefix: DEFAULT_GITHUB_PROXY };
  try { return { mirror: true, proxyPrefix: normalizeProxyPrefix(process.env.SP_GITHUB_PROXY) }; }
  catch (e) { console.error(`${mark.warn} 镜像前缀无效（${e.message}），本次用直连。`); return { mirror: false, proxyPrefix: DEFAULT_GITHUB_PROXY }; }
}

/**
 * Boot-window updater: apply an already staged update, else check → ask → download → stage → apply.
 * Only ever runs while NO server of ours is up (main() probes the port first), so files are never
 * swapped under a running game. Git checkouts never self-update — that is `git pull` territory.
 * @returns the applyStaged() result when an update was applied this boot (drives the health-check
 *   rollback in main()), else null. Never throws: a failed updater must not stop the game.
 */
async function maybeUpdate(o) {
  if (o.update === false || updateCheckDisabled()) return null;
  try {
    // a) 上次已下载好的更新：直接应用（断网也认）。暂存版本不比已装的新（重装 / 回滚残留）就清掉。
    if (await hasStagedUpdate(ROOT)) {
      const v = await stagedVersion(ROOT);
      const cur = await installedVersion(ROOT);
      if (!cur || compareVersions(v, cur) <= 0) {
        await discardStaged(ROOT);
        console.log(`${mark.skip} 清理了过期的更新暂存（v${v ?? '?'}）。`);
      } else {
        console.log(`${mark.ok} 发现已下载的更新 v${v}，正在应用…`);
        const r = await applyStaged({ appRoot: ROOT, log: (m) => console.log(`  · ${m}`) });
        console.log(`${mark.ok} 已更新到 v${r.to}。`);
        if (r.assetsChanged) console.log(`${mark.warn} 素材清单有变化：联网运行 node tools/setup.mjs 可补齐新素材。`);
        return r;
      }
    }

    // b) 检查最新版本（慢网下最多约 3×4 s，之后正常启动；离线机器请设 SP_NO_UPDATE_CHECK=1）
    const slug = await repoSlug(ROOT);
    if (!slug) return null;
    const r = await checkForUpdate({ slug, timeoutMs: 4000 });
    if (!r.available || !r.version) {
      if (o.update === true) console.log(`${mark.ok} 已是最新（v${APP_VERSION}）。`);
      return null;
    }

    // c) 有新版本。三种安装形态三档处理：源码 → git pull；没拿到校验和 → 手动下载；整合包 → 走流程。
    if (fs.existsSync(path.join(ROOT, '.git'))) {
      console.log(`${mark.warn} 有新版本 v${r.version}（当前 v${APP_VERSION}）：${r.notes || r.url || 'Releases'}`);
      console.log(c.dim('  这是源码检出：运行 git pull 更新，自动更新不适用于源码安装。'));
      return null;
    }
    if (!r.url || !r.sha256) {
      console.log(`${mark.warn} 有新版本 v${r.version}（当前 v${APP_VERSION}）：${r.notes || 'Releases 页面'}`);
      console.log(c.dim('  这次没拿到带 sha256 的下载地址，请到上面的页面手动下载新的整合包。'));
      return null;
    }
    if (!(o.update === true || await confirmUpdate(r.version))) {
      console.log(c.dim(`  保留 v${APP_VERSION}，下次启动再问（--update 立即更新，--no-update 不再检查）。`));
      return null;
    }

    // d) 下载（边下边校验 sha256）→ 暂存解包 → 应用
    const { mirror, proxyPrefix } = updateMirror();
    const zipFile = path.join(ROOT, '.update-staging', `update-v${r.version}.zip`);
    console.log(`  · 下载 ${r.url}${mirror ? '（镜像）' : ''}`);
    let lastPct = 0;
    await downloadUpdate({
      url: r.url, destFile: zipFile, expectedSha256: r.sha256, mirror, proxyPrefix,
      onProgress: (got, total) => {
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct >= lastPct + 20) { lastPct = pct; console.log(`    ${pct}%（${MB(got)}）`); }
      },
    });
    await stageUpdate({ zipFile, appRoot: ROOT, zipSha256: r.sha256 });
    const res = await applyStaged({ appRoot: ROOT, log: (m) => console.log(`  · ${m}`) });
    console.log(`${mark.ok} 已更新到 v${res.to}，即将以新版本启动。`);
    if (res.assetsChanged) console.log(`${mark.warn} 素材清单有变化：稍后的准备步骤会补下载素材。`);
    return res;
  } catch (e) {
    console.error(`${mark.err} 自动更新失败，继续用当前版本 v${APP_VERSION} 启动：${e?.message || e}`);
    if (!String(process.env.SP_UPDATE_SOURCE || process.env.SP_ASSET_SOURCE || '').toLowerCase().includes('mirror')) {
      console.error(c.dim('  下载不稳定时可用国内镜像重试：设置 SP_ASSET_SOURCE=mirror（与素材下载同一前缀规则，SP_GITHUB_PROXY 可换前缀）。'));
    }
    return null;
  }
}

// Same convention as tools/setup.mjs: the helpers above are importable, but only running this file starts anything.
// Without the guard, importing launch.mjs would fall through to main() in the background and bind a port.
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
}
