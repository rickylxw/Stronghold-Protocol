// Follow-up to GitHub issue #184 「建议加入对于特殊地形的单击信息提示」: a tap on a STAGE DEVICE (阻隔工事 / “双眼皮” /
// 射击台 / 气流) explains the device — `screens/game.js` tileClick hands over `{ kind: 'device', device }`, resolved
// from the stage the board on screen is built from (`gameLogic.deviceInfo`), and the panel opens its device card.
// Covered here: what the card says for every tip-able device of the real stages (the sim's own numbers —
// sim/content/devices.js), what the screen's override pipeline does to it (a 机变 card removes the crate → no tip),
// the panel link (resolveDetail), and that the card closes on the next field press.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { resolveDetail, } = await import('../../public/js/ui/detailPanel.js');
const { deviceInfo, effectiveStage, closesOnFieldPress } = await import('../../public/js/ui/gameLogic.js');

const stages = JSON.parse(readFileSync(path.join(ROOT, 'data', 'stages.json'), 'utf8'));

/** The first device of `role` in the stage. */
function deviceAt(stage, role) {
  const d = (stage.devices || []).find((x) => x.role === role);
  if (!d) throw new Error(`no ${role} device in ${stage.id}`);
  return d;
}

test('阻隔工事: the crate says its own HP and the enemy behaviour the sim runs', () => {
  const st = stages['act1autochess_m01'];
  const d = deviceAt(st, 'crate');
  const info = deviceInfo(st, d.pos[0], d.pos[1]);
  assert.equal(info.key, 'crate');
  assert.equal(info.name, '阻隔工事');
  assert.equal(info.tag, '场地装置');
  assert.match(info.lines[0], /绕开它走/);
  assert.match(info.lines[0], /无路可走/);
  assert.match(info.lines[1], /生命 100 点/);
  assert.deepEqual(info.facts, ['这一格不能部署']);
  assert.equal(info.stats, undefined, 'the crate needs no stat row beyond its HP line');
});

test('“双眼皮”: the turret reads its stats and the bond-layer scaling from the device entry', () => {
  const st = stages['act1autochess_m01'];
  // every stage's turrets stand dormant (active: false) until 机械援助 or a 机变 card turns the alias on — the screen
  // passes the player's own effectiveStage, so the tip lights up exactly when the client draws the turret
  const d = deviceAt(st, 'turret');
  assert.equal(deviceInfo(st, d.pos[0], d.pos[1]), null, 'dormant: no tip');
  const live = effectiveStage(st, { deviceOverrides: { 'trap_1104_aclasert#1': true } });
  const info = deviceInfo(live, d.pos[0], d.pos[1]);
  assert.equal(info.name, '“双眼皮”');
  assert.match(info.lines[0], /法术伤害/);
  assert.match(info.lines[0], /易伤/);
  assert.match(info.lines[1], /盟约/);
  assert.match(info.lines[1], /攻击速度 \+1（至多 \+300）/);
  assert.match(info.lines[1], /易伤加深 0\.1%（至多 \+30%）/);
  assert.match(info.lines[1], /持续 2 秒/);
  assert.deepEqual(info.stats, [
    { k: '生命', v: 3000 }, { k: '攻击', v: 900 }, { k: '防御', v: 200 }, { k: '攻击间隔', v: '4 秒' },
  ]);
});

test('射击台: the platform tells the deploy class it feeds the deploy map', () => {
  const st = stages['act1autochess_m03'];
  const d = deviceAt(st, 'platform');
  const info = deviceInfo(st, d.pos[0], d.pos[1]);
  assert.equal(info.name, '射击台');
  assert.match(info.lines[0], /高台位/);
  assert.match(info.lines[1], /远程位干员可以部署/);
  assert.match(info.lines[1], /不阻挡敌人/);
  assert.deepEqual(info.facts, ['远程位可部署']);
});

test('源石流发生装置: the blower names its direction and the airflow numbers the sim applies', () => {
  const st = stages['act2autochess_m01'];
  const d = deviceAt(st, 'blower');
  assert.equal(d.dir, 'DOWN');
  const info = deviceInfo(st, d.pos[0], d.pos[1]);
  assert.equal(info.name, '源石流发生装置');
  assert.match(info.lines[0], /朝下/);
  assert.match(info.lines[1], /攻击力 \+30%/);
  assert.match(info.lines[1], /−30%/);
  assert.match(info.lines[2], /×1\.5/);
  assert.match(info.lines[2], /×0\.5/);
});

test('a device the client does not draw says nothing: inactive, card-removed, tip-less role, ordinary tile', () => {
  // act1 m02's platforms stand dormant (weight-0 cards add them) — not drawn, so no tip
  const m02 = stages['act1autochess_m02'];
  const p = deviceAt(m02, 'platform');
  assert.equal(deviceInfo(m02, p.pos[0], p.pos[1]), null);
  // the screen passes the player's own effectiveStage: a 机变 card's deviceOverride flips the crate's active off
  const fake = { rows: [], tiles: {}, devices: [{ key: 'trap_1105_accrate', alias: 'trap_1105_accrate#001', role: 'crate', pos: [3, 3], active: true, stats: { maxHp: 100 } }] };
  assert.ok(deviceInfo(fake, 3, 3), 'the crate stands');
  const removed = effectiveStage(fake, { deviceOverrides: { 'trap_1105_accrate#001': false } });
  assert.equal(deviceInfo(removed, 3, 3), null);
  // a tip-less role (盟约寒风 is invisible; the controllers have no tile) falls through like an ordinary tile
  const m01 = stages['act1autochess_m01'];
  const cw = deviceAt(m01, 'coldWind');
  assert.equal(deviceInfo(m01, cw.pos[0], cw.pos[1]), null);
  assert.equal(deviceInfo(m01, 5, 5), null);
  assert.equal(deviceInfo(null, 0, 0), null);
});

test('every tip-able device of every active stage carries a well-formed card', () => {
  for (const st of Object.values(stages)) {
    if (!st.active) continue;
    for (const d of st.devices || []) {
      if (!['crate', 'turret', 'platform', 'blower'].includes(d.role)) continue;
      if (!(typeof d.active === 'boolean' ? d.active : !d.hidden)) continue;
      const info = deviceInfo(st, d.pos[0], d.pos[1]);
      assert.ok(info, `${st.id} ${d.role} @${d.pos} has a tip`);
      assert.ok(info.name, `${st.id} ${d.role} has a name`);
      assert.ok(info.lines.length, `${st.id} ${d.role} has mechanism lines`);
      for (const line of info.lines) assert.ok(typeof line === 'string' && line.length, `${st.id} ${d.role} line`);
    }
  }
});

test('a device target resolves into the panel card; a malformed one resolves to nothing; the card closes on a field press', () => {
  const st = stages['act1autochess_m01'];
  const d = deviceAt(st, 'crate');
  const info = deviceInfo(st, d.pos[0], d.pos[1]);
  const live = { ...info, hp: 62, maxHp: 100 };
  assert.deepEqual(resolveDetail({ kind: 'device', device: info }, new Map()), { type: 'device', device: info });
  assert.deepEqual(resolveDetail({ kind: 'device', device: live }, new Map()), { type: 'device', device: live },
    'the screen-added live HP rides along');
  assert.equal(resolveDetail({ kind: 'device' }, new Map()), null);
  assert.equal(resolveDetail({ kind: 'device', device: '阻隔工事' }, new Map()), null);
  assert.equal(resolveDetail(null, new Map()), null);
  assert.equal(closesOnFieldPress({ kind: 'device', device: info }), true, 'the next field press closes the device card');
});
