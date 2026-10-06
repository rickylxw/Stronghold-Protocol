// test/update-apply.test.js — tools/update/: manifest building and the part of the updater that
// actually touches the installed tree (staging with zip-slip protection, apply with backup,
// rollback, cleanup). Everything runs in throwaway temp dirs, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { zipSync } from 'fflate';
import { buildManifest, isPreservedRel, readManifest, sanitizeRel } from '../tools/update/manifest.mjs';
import {
  applyStaged, discardStaged, finishUpdate, hasStagedUpdate, installedVersion, rollbackUpdate, stageUpdate, stagedVersion,
} from '../tools/update/apply.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** A throwaway directory that removes itself after the test. */
async function tmp(t, name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `sp-upd-${name}-`));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
  }
}

/** An installed tree shaped like a bundle (code + deps + preserved user files) with its manifest. */
async function makeInstalledApp(t, version) {
  const appRoot = await tmp(t, 'app');
  await writeTree(appRoot, {
    'server/index.js': `console.log("server ${version}");`,
    'b.js': `module b ${version}`,
    'data/assets.json': `{"assets":"${version}"}`,
    'node_modules/x/index.js': 'old dep x',
    'public/vendor/lib.js': 'vendor old',
    'public/assets/keep.png': 'user art — must survive everything',
    'public/fonts/keep.ttf': 'user font — must survive everything',
    'data/local-assets.json': '{"local":true}',
  });
  const manifest = await buildManifest(appRoot, { version });
  await fsp.writeFile(path.join(appRoot, 'manifest.json'), JSON.stringify(manifest));
  return { appRoot, manifest };
}

/** A staged package with a manifest, zipped the way make-update-package.mjs does. */
async function makePackage(t, { version, files }) {
  const stage = await tmp(t, 'pkg');
  await writeTree(stage, files);
  const manifest = await buildManifest(stage, { version });
  await fsp.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
  const entries = {};
  const walk = async (dir, rel) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), child);
      else entries[child] = new Uint8Array(await fsp.readFile(path.join(dir, e.name)));
    }
  };
  await walk(stage, '');
  const zipped = zipSync(entries);
  const zipFile = path.join(await tmp(t, 'zip'), 'update.zip');
  await fsp.writeFile(zipFile, zipped);
  return { zipFile, zipSha256: sha256(zipped) };
}

test('sanitizeRel: the zip-slip gate', () => {
  assert.equal(sanitizeRel('server/index.js'), 'server/index.js');
  assert.equal(sanitizeRel('a\\b.js'), 'a/b.js');            // windows separators normalize
  assert.equal(sanitizeRel('dir/'), null);                   // directory entries carry no content
  assert.equal(sanitizeRel('../evil.txt'), null);
  assert.equal(sanitizeRel('a/../../evil.txt'), null);
  assert.equal(sanitizeRel('/abs/evil.txt'), null);
  assert.equal(sanitizeRel('C:/evil.txt'), null);
  assert.equal(sanitizeRel('a/./b'), null);
  assert.equal(sanitizeRel('a//b'), null);
  assert.equal(sanitizeRel(''), null);
});

test('isPreservedRel: user files are protected, packaged code is not', () => {
  assert.equal(isPreservedRel('public/assets/a/b.png'), true);
  assert.equal(isPreservedRel('public/fonts/f.ttf'), true);
  assert.equal(isPreservedRel('data/local-assets.json'), true);
  assert.equal(isPreservedRel('.env'), true);
  assert.equal(isPreservedRel('.update-staging/update.zip'), true);
  assert.equal(isPreservedRel('.update-backup/files/b.js'), true);
  assert.equal(isPreservedRel('server/index.js'), false);
  assert.equal(isPreservedRel('public/vendor/lib.js'), false);   // vendor ships in the package
  assert.equal(isPreservedRel('node_modules/ws/index.js'), false);
});

test('buildManifest: hashes a tree, skips its own manifest.json and updater scratch dirs', async (t) => {
  const dir = await tmp(t, 'mfst');
  await writeTree(dir, {
    'a.js': 'A',
    'manifest.json': '{"pretend":"this is a manifest"}',
    '.update-staging/x': 'scratch',
    'sub/b.js': 'B',
  });
  const m = await buildManifest(dir, { version: '9.9.9' });
  assert.equal(m.manifestVersion, 1);
  assert.equal(m.version, '9.9.9');
  assert.deepEqual(Object.keys(m.files).sort(), ['a.js', 'sub/b.js']);
  assert.equal(m.files['a.js'].sha256, sha256(Buffer.from('A')));
  assert.equal(m.files['a.js'].bytes, 1);
  // readManifest refuses things that are not manifests
  await assert.rejects(() => readManifest(path.join(dir, 'manifest.json')), /manifestVersion/);
});

test('stageUpdate: extracts a good package, refuses one without a manifest, never follows zip-slip paths', async (t) => {
  const appRoot = (await makeInstalledApp(t, '0.1.3')).appRoot;

  const ok = await makePackage(t, { version: '0.1.4', files: { 'server/index.js': 'new' } });
  const r = await stageUpdate({ zipFile: ok.zipFile, appRoot, zipSha256: ok.zipSha256 });
  assert.equal(r.version, '0.1.4');
  assert.equal(await hasStagedUpdate(appRoot), true);
  assert.equal(await stagedVersion(appRoot), '0.1.4');
  assert.equal(await installedVersion(appRoot), '0.1.3');
  assert.ok(existsSync(path.join(appRoot, '.update-staging', 'pkg', 'server', 'index.js')));

  // a zip without any manifest (not our packer's shape) is refused outright
  const bare = zipSync({ 'server/index.js': new Uint8Array(Buffer.from('x')) });
  const bareZip = path.join(await tmp(t, 'bare'), 'bare.zip');
  await fsp.writeFile(bareZip, bare);
  await assert.rejects(() => stageUpdate({ zipFile: bareZip, appRoot, zipSha256: 'x' }), /manifest/);

  // zip-slip: hostile entry names are dropped, the package still stages for its honest files
  // (it carries a valid manifest — the slip test is about the hostile paths, not the manifest)
  const evil = zipSync({
    'server/index.js': new Uint8Array(Buffer.from('honest')),
    'manifest.json': new Uint8Array(Buffer.from(JSON.stringify({
      manifestVersion: 1, version: '0.1.4',
      files: { 'server/index.js': { sha256: sha256(Buffer.from('honest')), bytes: 6 } },
    }))),
    '../evil.txt': new Uint8Array(Buffer.from('slipped')),
    '/abs/evil.txt': new Uint8Array(Buffer.from('slipped')),
    'C:/evil.txt': new Uint8Array(Buffer.from('slipped')),
  });
  const evilZip = path.join(await tmp(t, 'evil'), 'evil.zip');
  await fsp.writeFile(evilZip, evil);
  const parent = path.dirname(appRoot);
  const before = (await fsp.readdir(parent)).sort();
  await stageUpdate({ zipFile: evilZip, appRoot, zipSha256: 'x' });
  assert.deepEqual((await fsp.readdir(parent)).sort(), before, 'nothing appeared outside the app root');
  assert.equal(existsSync(path.join(appRoot, 'evil.txt')), false);
});

test('applyStaged → assert → rollbackUpdate: an exact round trip that spares the user files', async (t) => {
  const { appRoot, manifest: oldManifest } = await makeInstalledApp(t, '0.1.3');
  const read = (rel) => fsp.readFile(path.join(appRoot, ...rel.split('/')), 'utf8');

  const pkg = await makePackage(t, {
    version: '0.1.4',
    files: {
      'server/index.js': 'console.log("server 0.1.4");',  // updated
      'c.js': 'added file',                                // added
      'data/assets.json': '{"assets":"0.1.4"}',            // updated → assetsChanged
      'node_modules/y/index.js': 'new dep y',              // added (x is gone → deleted)
      'public/vendor/lib.js': 'vendor new',                // updated
    },
  });
  await stageUpdate({ zipFile: pkg.zipFile, appRoot, zipSha256: pkg.zipSha256 });
  const r = await applyStaged({ appRoot });
  assert.equal(r.from, '0.1.3');
  assert.equal(r.to, '0.1.4');
  assert.equal(r.assetsChanged, true);
  assert.ok(r.updated >= 2 && r.added >= 2 && r.deleted >= 2, `counts look wrong: ${JSON.stringify(r)}`);

  // the swap happened
  assert.equal(await read('server/index.js'), 'console.log("server 0.1.4");');
  assert.equal(await read('c.js'), 'added file');
  assert.equal(await read('public/vendor/lib.js'), 'vendor new');
  assert.equal(existsSync(path.join(appRoot, 'b.js')), false);
  assert.equal(existsSync(path.join(appRoot, 'node_modules', 'x')), false);
  assert.ok(existsSync(path.join(appRoot, 'node_modules', 'y', 'index.js')));
  // the manifest committed
  assert.equal((await readManifest(path.join(appRoot, 'manifest.json'))).version, '0.1.4');
  // the user's files did not move
  assert.equal(await read('public/assets/keep.png'), 'user art — must survive everything');
  assert.equal(await read('public/fonts/keep.ttf'), 'user font — must survive everything');
  assert.equal(await read('data/local-assets.json'), '{"local":true}');
  // and the old tree is in the backup
  assert.equal(await fsp.readFile(path.join(appRoot, '.update-backup', 'files', 'b.js'), 'utf8'), 'module b 0.1.3');

  // the new server never came up: roll it all back
  assert.equal(await rollbackUpdate(appRoot), true);
  assert.equal(await read('server/index.js'), 'console.log("server 0.1.3");');
  assert.equal(await read('b.js'), 'module b 0.1.3');
  assert.equal(existsSync(path.join(appRoot, 'c.js')), false);
  assert.equal(await read('node_modules/x/index.js'), 'old dep x');
  assert.equal(existsSync(path.join(appRoot, 'node_modules', 'y')), false);
  assert.equal(await read('public/vendor/lib.js'), 'vendor old');
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(appRoot, 'manifest.json'), 'utf8')), oldManifest);
  assert.equal(existsSync(path.join(appRoot, '.update-backup')), false);
  assert.equal(await read('public/assets/keep.png'), 'user art — must survive everything');
});

test('applyStaged: refuses downgrades and re-applying the same version', async (t) => {
  const { appRoot } = await makeInstalledApp(t, '0.1.3');
  for (const version of ['0.1.2', '0.1.3']) {
    const pkg = await makePackage(t, { version, files: { 'server/index.js': 'x' } });
    await stageUpdate({ zipFile: pkg.zipFile, appRoot, zipSha256: pkg.zipSha256 });
    await assert.rejects(() => applyStaged({ appRoot }), /拒绝应用更新/);
  }
});

test('finishUpdate / discardStaged: cleanup removes backup and staging', async (t) => {
  const { appRoot } = await makeInstalledApp(t, '0.1.3');
  const pkg = await makePackage(t, { version: '0.1.4', files: { 'c.js': 'new' } });
  await stageUpdate({ zipFile: pkg.zipFile, appRoot, zipSha256: pkg.zipSha256 });
  await applyStaged({ appRoot });
  await finishUpdate(appRoot);
  assert.equal(existsSync(path.join(appRoot, '.update-backup')), false);
  assert.equal(existsSync(path.join(appRoot, '.update-staging')), false);

  await stageUpdate({ zipFile: pkg.zipFile, appRoot, zipSha256: pkg.zipSha256 });
  await discardStaged(appRoot);
  assert.equal(await hasStagedUpdate(appRoot), false);
  assert.equal(await stagedVersion(appRoot), null);
});

test('installedVersion: null for a tree without a manifest (updater must refuse those)', async (t) => {
  const dir = await tmp(t, 'bare');
  assert.equal(await installedVersion(dir), null);
});
