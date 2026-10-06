// ui/gameLogic/terrain.js — special terrain tips (GitHub issue #184: 特殊地形的单击信息提示). Re-exported from
// ../gameLogic.js.
//
// The words go through t() (docs/I18N.md: the Chinese text is the msgid, public/i18n/en.json the English): the name /
// tag / fact tables are marked N_() and translated where terrainInfo hands them out, the mechanism lines are built
// with their numbers as params.

import { isObj } from './shared.js';
import { t, N_ } from '../../../../shared/i18n.js';

// ---- special terrain tips (GitHub issue #184: 特殊地形的单击信息提示) ----------------------------------------

/**
 * What tapping a special tile says. `lines` are functions of the stage's own terrain parameters (`stage.special[<terrain>]`
 * and the tile's `bb`, the very numbers the sim runs on — server/sim/content/devices.js), so a tip can never disagree with
 * the battle; the prose is ours (docs/PLAYING.md wording, PRTS 特殊地形 / 沼泽控制 / 深水区 地形信息).
 * `tag` is the chip above the name; `fact` needs the tile's own legend entry (see terrainInfo).
 */
const TERRAIN_TIPS = Object.freeze({
  infection: {
    name: N_('活性源石'), tag: N_('特殊地形'),
    lines: (st) => {
      const b = isObj(st?.infection?.bb) ? st.infection.bb : {};
      const dmg = param(b.damage, 0);
      const mods = [];
      if (param(b.atk, 0)) mods.push(t('攻击力 +{atk}%', { atk: Math.round(param(b.atk, 0) * 100) }));
      if (param(b.attack_speed, 0)) mods.push(t('攻击速度 +{aspd}', { aspd: param(b.attack_speed, 0) }));
      return [
        dmg ? t('部署于其上的我方单位、经过的敌方单位，每秒受到 {dmg} 点真实伤害（无来源）', { dmg }) : t('在其上的我方单位与经过的敌方单位持续受到伤害'),
        mods.length ? t('同时获得：{mods}', { mods }) : null,
        param(b.duration, 0) ? t('效果持续 {sec} 秒；离开地块后仍然保留，再次接触会重新计时', { sec: param(b.duration, 0) }) : null,
      ].filter(Boolean);
    },
  },
  mire: {
    name: N_('沼泽'), tag: N_('特殊地形'),
    lines: (st) => {
      const m = isObj(st?.mire) ? st.mire : {};
      const per = param(m.aspdPerStack, -0.05);
      const move = param(m.moveMulPerStack, -0.05);
      const max = param(m.maxStacks, 10);
      const heavy = param(m.heavyWeight, 3);
      const sec = param(m.intervalSec, 1);
      return [
        move
          ? t('留在沼泽里的单位每 {sec} 秒获得 1 层「陷入沼泽」：攻击速度 {aspd}，敌方单位还有移动速度 {move}', { sec, aspd: pctText(per), move: pctText(move) })
          : t('留在沼泽里的单位每 {sec} 秒获得 1 层「陷入沼泽」：攻击速度 {aspd}', { sec, aspd: pctText(per) }),
        heavy ? t('重量 ≥ {heavy} 的敌人一次获得 2 层', { heavy }) : null,
        t('最多 {max} 层；离开沼泽后解除', { max }),
      ].filter(Boolean);
    },
  },
  smog: {
    name: N_('排气格栅'), tag: N_('特殊地形'),
    // the sim gives the tile's buff `flags: { stealth: true }` (devices.js enterTerrain): enemy ranged targeting
    // skips it like 隐匿 — and, like 隐匿, it does NOT stop the enemy it blocks from attacking it (PRTS 隐匿).
    lines: () => [
      t('站在排气格栅上的干员不会被敌方的远程攻击选中（效果相当于隐匿）'),
      t('但挡住敌人的干员仍会被它攻击到'),
    ],
  },
  deepsea: {
    name: N_('深水区'), tag: N_('特殊地形'),
    lines: (st) => {
      const b = isObj(st?.deepsea?.bb) ? st.deepsea.bb : {};
      const dmg = param(b['sea_drown[enemy].damage'], 0);
      const aspd = param(b['sea_drown[enemy].attack_speed'], 0);
      const move = param(b['sea_drown[enemy].move_speed'], 0);
      const out = [];
      if (dmg) out.push(t('敌人每秒受到 {dmg} 点伤害', { dmg }));
      const slowed = move && move !== 1;
      if (aspd && slowed) out.push(t('攻击速度 {aspd}、移动速度 ×{move}', { aspd: pctText(aspd), move }));
      else if (aspd) out.push(t('攻击速度 {aspd}', { aspd: pctText(aspd) }));
      else if (slowed) out.push(t('移动速度 ×{move}', { move }));
      // devices.js tickDeepsea: sourceless true damage tagged 'dot' / 'periodic' / 'deepsea' — deliberately NOT 'terrain'
      // (环境伤害, which is what 活性源石's tick is): it is nobody's damage, so no 干员's 增伤 / 穿透 / 装备 applies.
      out.push(t('溺水伤害属于无来源伤害（不吃干员的增伤、穿透与装备加成），也不归类为环境伤害'));
      out.push(t('拒绝部署（特制水上平台可以让这一格变得可部署）'));
      return out;
    },
  },
  start: { name: N_('红门'), tag: N_('敌方入口'), lines: () => [t('敌方单位从这里出场')] },
  end: { name: N_('蓝门'), tag: N_('保护目标'), lines: () => [t('敌人走进这里会扣你的目标生命值（LP），一回合至多 10 点')] },
  telin: { name: N_('传送入口'), tag: N_('特殊地形'), lines: () => [t('敌人走到这里会从场上消失')] },
  telout: { name: N_('传送出口'), tag: N_('特殊地形'), lines: () => [t('消失的敌人会从这里重新出现')] },
});

/** Tile keys that carry a tip of their own although the legend gives them no `special` tag (gates, teleports). */
const TIP_BY_TILEKEY = Object.freeze({ tile_start: 'start', tile_end: 'end', tile_telin: 'telin', tile_telout: 'telout' });
/** 深水区's own legend entry is the one tile whose mechanism overrides the level's buildableType (grid.js DEPLOY_REFUSED_TILES). */
const BUILDABILITY = Object.freeze({ ALL: N_('可部署'), MELEE: N_('仅近战位可部署'), RANGED: N_('仅远程位可部署'), NONE: N_('不可部署') });

const param = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pctText = (v) => `${v > 0 ? '+' : '−'}${Math.abs(Math.round(param(v, 0) * 100))}%`;

/**
 * The tip a tap on board tile (row, col) opens (GitHub issue #184 — "建议加入对于特殊地形的单击信息提示"), or null for an
 * ordinary tile (road / floor / wall / fence …): those say nothing, so a tap on them still just closes what is open.
 * The tile comes from the stage the board on screen is built from (`stage.rows` + `stage.tiles`, data/stages.json), and
 * the numbers from that stage's own terrain parameters — the same values the sim runs. It reads the stage only, so a
 * 补位 / 自选 board (whose pieces are other records) explains its tiles the same way. The text is in the current
 * language (t()).
 * @param {{ rows?: string[], tiles?: Record<string, any>, special?: any } | null | undefined} stage the shown field's stage
 * @param {number} row board row (row 0 = the bottom row, DESIGN §1)
 * @param {number} col
 * @returns {{ key:string, name:string, tag:string, row:number, col:number, lines:string[], facts:string[] } | null}
 */
export function terrainInfo(stage, row, col) {
  const rows = Array.isArray(stage?.rows) ? stage.rows : null;
  const line = rows && Number.isInteger(row) && row >= 0 ? rows[row] : null;
  if (typeof line !== 'string' || !Number.isInteger(col) || col < 0 || col >= line.length) return null;
  const tiles = isObj(stage.tiles) ? stage.tiles : null;
  const tile = tiles ? tiles[line[col]] : null;
  if (!isObj(tile)) return null;
  const key = tile.special || TIP_BY_TILEKEY[tile.tileKey] || null;
  const tip = key ? TERRAIN_TIPS[key] : null;
  if (!tip) return null;
  const facts = [];
  const build = BUILDABILITY[tile.buildable];
  if (build) facts.push(t(build));
  if (tile.height === 'HIGH') facts.push(t('高台'));
  if (tile.groundPassable === false) facts.push(t('只有空中单位能通过'));
  else if (tile.groundPassable === true) facts.push(t('地面单位可通过'));
  return { key, name: t(tip.name), tag: t(tip.tag), row, col, lines: tip.lines(stage.special).filter((s) => typeof s === 'string' && s), facts };
}

// ---- stage device tips (follow-up to GitHub issue #184: the stage DEVICES, not only the tiles) -----------------

/** The device roles a tap explains; the rest is invisible (盟约寒风, the 沼泽/涨潮 controllers) or already covered by a terrain tip. */
const DEVICE_TIP_ROLES = Object.freeze(['crate', 'turret', 'platform', 'blower']);

const BLOWER_DIR_NAME = Object.freeze({ UP: N_('上'), DOWN: N_('下'), LEFT: N_('左'), RIGHT: N_('右') });

/**
 * What tapping a stage device says — the same contract as TERRAIN_TIPS, but `lines` read the device's own stage entry
 * (data/stages.json `stage.devices[]`: stats / skill blackboard / dir), the very numbers the sim runs
 * (`sim/content/devices.js`, `Battle.js _spawnStageDevices`), so a tip can never disagree with the battle. The prose is
 * ours (docs/PLAYING.md wording, PRTS 阻隔工事 / “双眼皮” / 射击台 / 源石流发生装置).
 */
const DEVICE_TIPS = Object.freeze({
  crate: {
    name: N_('阻隔工事'), tag: N_('场地装置'),
    lines: (st, d) => [
      t('挡在地上的工事：地面敌人会绕开它走，只有无路可走时才会撞上来把它摧毁，然后继续前进'),
      t('生命 {hp} 点，被摧毁后从场上消失', { hp: param(d.stats?.maxHp, 100) }),
    ],
    facts: () => [N_('这一格不能部署')],
  },
  turret: {
    name: N_('“双眼皮”'), tag: N_('场地装置'),
    lines: (st, d) => {
      const bb = isObj(d.skill?.bb) ? d.skill.bb : {};
      const aspd = param(bb.attack_speed_per_stack, 1);
      const frag = param(bb.damage_scale_per_stack, 0.001);
      const aspdMax = param(bb.max_attack_speed, 300);
      const fragMax = param(bb.max_damage_scale, 1.3);
      const dur = /持续(\d+(?:\.\d+)?)秒/.exec(String(d.skill?.desc ?? ''));
      return [
        t('自动攻击射程内的一名敌人，造成法术伤害，命中的敌人附加易伤'),
        t('我方当前层数最高的盟约每 1 层：它的攻击速度 +{aspd}（至多 +{aspdMax}），易伤加深 {frag}%（至多 +{fragMax}%）{dur}', {
          aspd, aspdMax, frag: Math.round(frag * 1000) / 10, fragMax: Math.round((fragMax - 1) * 1000) / 10,
          dur: dur ? t('，持续 {sec} 秒', { sec: dur[1] }) : '',
        }),
      ];
    },
    stats: (st, d) => {
      const s = isObj(d.stats) ? d.stats : {};
      const out = [{ k: N_('生命'), v: param(s.maxHp, 100) }];
      if (param(s.atk, 0)) out.push({ k: N_('攻击'), v: param(s.atk, 0) });
      if (param(s.def, 0)) out.push({ k: N_('防御'), v: param(s.def, 0) });
      if (param(s.bat, 1) !== 1) out.push({ k: N_('攻击间隔'), v: t('{sec} 秒', { sec: param(s.bat, 1) }) });
      return out;
    },
    facts: () => [N_('这一格不能部署')],
  },
  platform: {
    name: N_('射击台'), tag: N_('场地装置'),
    lines: () => [
      t('高台位装置：地面敌人不能走上这一格'),
      t('远程位干员可以部署在其上；站上去的干员在高位，不阻挡敌人'),
    ],
    facts: () => [N_('远程位可部署')],
  },
  blower: {
    name: N_('源石流发生装置'), tag: N_('场地装置'),
    lines: (st, d) => {
      const bb = isObj(d.skill?.bb) ? d.skill.bb : (isObj(st?.blower?.bb) ? st.blower.bb : {});
      const out = [t('向前方吹出气流（这一台朝{dir}）', { dir: t(BLOWER_DIR_NAME[String(d.dir || 'UP').toUpperCase()] || BLOWER_DIR_NAME.UP) })];
      const eq = param(bb['blower_s_character[equal].atk'], 0);
      const op = param(bb['blower_s_character[opposite].atk'], 0);
      const mods = [];
      if (eq) mods.push(t('面向与风向相同的干员攻击力 {atk}', { atk: pctText(eq) }));
      if (op) mods.push(t('相反的 {atk}', { atk: pctText(op) }));
      if (mods.length) out.push(t('部署在气流里的干员：{mods}', { mods: mods.join(t('；')) }));
      const eqM = param(bb['blower_s_enemy[equal].move_speed'], 0);
      const opM = param(bb['blower_s_enemy[opposite].move_speed'], 0);
      const em = [];
      if (eqM) em.push(t('顺着风移动速度 {mul}', { mul: moveMulText(1 + eqM) }));
      if (opM) em.push(t('逆着风 {mul}', { mul: moveMulText(1 + opM) }));
      if (em.length) out.push(t('在气流里移动的敌人：{mods}', { mods: em.join(t('，')) }));
      return out;
    },
    facts: () => [N_('这一格不能部署')],
  },
});

const moveMulText = (v) => `×${Math.round(v * 100) / 100}`;

/**
 * The tip a tap on a tile occupied by a stage device opens (follow-up to GitHub issue #184), or null: an ordinary tile
 * — or a device this client does not draw (`active` false, a 机变 card removed the crate / the turret is off) — falls
 * through to `terrainInfo`. Visibility mirrors what the renderers draw (`render/board3d/layout.js stageDevices`,
 * `render/tiles.js _stageDevices`): `active` when set, else not `hidden`. The screen passes the player's own
 * `effectiveStage`, so a card-removed crate is already out of the list.
 * @param {{ devices?: any[], special?: any } | null | undefined} stage the shown field's stage (already effectiveStage)
 * @param {number} row board row (row 0 = the bottom row, DESIGN §1)
 * @param {number} col
 * @returns {{ key:string, name:string, tag:string, row:number, col:number, lines:string[], facts:string[], stats?:{k:string,v:string|number}[] } | null}
 */
export function deviceInfo(stage, row, col) {
  const list = Array.isArray(stage?.devices) ? stage.devices : null;
  if (!list || !Number.isInteger(row) || !Number.isInteger(col)) return null;
  let found = null;
  for (const d of list) {
    if (!isObj(d) || !Array.isArray(d.pos) || d.pos[0] !== row || d.pos[1] !== col) continue;
    const tip = DEVICE_TIPS[d.role];
    if (!tip || !DEVICE_TIP_ROLES.includes(d.role)) continue;
    if (!(typeof d.active === 'boolean' ? d.active : !d.hidden)) continue;
    found = { tip, d };
    break;
  }
  if (!found) return null;
  const { tip, d } = found;
  const lines = (typeof tip.lines === 'function' ? tip.lines(stage.special, d) : []).filter((s) => typeof s === 'string' && s);
  const facts = (typeof tip.facts === 'function' ? tip.facts(stage.special, d) : []).filter(Boolean).map((f) => t(f));
  const stats = (typeof tip.stats === 'function' ? tip.stats(stage.special, d) : null)
    ?.map((s) => ({ k: t(s.k), v: s.v }));
  return { key: d.role, name: t(tip.name), tag: t(tip.tag), row, col, lines, facts, ...(stats && stats.length ? { stats } : {}) };
}
