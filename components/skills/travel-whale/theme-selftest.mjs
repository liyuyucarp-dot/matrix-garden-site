// 矩阵庭院（travel-whale + courtyard-map）· 可切换世界锚点/主题包与无陈旧装备端到端自测
// 运行方式：node skills/travel-whale/theme-selftest.mjs

import assert from 'node:assert/strict';
import * as TW from './index.js';
import * as S from './state.js?v=realworld-1';
import * as T from './trip.js';
import * as OW from './outfits.js';
import * as H from './help.js';
import { buildSnapshot } from '../courtyard-map/index.js';

const mockDeps = (extra = {}) => ({
  rand: () => 0, // 固定抽第 0 项，检验跨大区点名是否能突破随机初始区限制
  search: async () => [],
  llm: async () => JSON.stringify({
    spots: [{ name: '测试地标', scene: '阳光下的古老城墙' }],
    souvenirs: [{ name: '测试特产', rarity: 'common', kind: 'food' }]
  }),
  ...extra
});

console.log('=== [1/4] 验证 default 默认主题（地球 9 大区全部解锁 + 无陈旧现实装备） ===');
TW.setWorldTheme('default');
assert.equal(TW.activeThemeId(), 'default');
assert.equal(TW.isDefaultTheme(), true);
assert.equal(TW.defaultBaseRegionId(), 'asia');
assert.equal(TW.getMapTheme(), null);

const defaultRegions = T.loadRegions();
assert.equal(defaultRegions.length, 24, '默认主题应有 24 个地区（9 地球 + 15 异世界）');
const defaultBaseRegions = defaultRegions.filter((r) => r.defaultUnlocked === true);
const defaultOtherRegions = defaultRegions.filter((r) => !r.defaultUnlocked);
assert.equal(defaultBaseRegions.length, 9, '默认主题应有 9 个默认解锁大区');
assert.equal(defaultOtherRegions.length, 15, '默认主题应有 15 个异世界');

for (const r of defaultBaseRegions) {
  assert.equal(r.equipment, undefined, `默认解锁的现实地区 ${r.id} 不应再保留陈旧的解锁装备字段`);
}
for (const r of defaultOtherRegions) {
  assert.ok(typeof r.equipment === 'string' && r.equipment.length > 0, `未默认解锁的异世界 ${r.id} 必须保留解锁装备字段`);
}

const stDefault = S.emptyState('group:test_default');
assert.equal(stDefault.whale.equipUnlocked.length, 9);
for (const r of defaultBaseRegions) {
  assert.ok(stDefault.whale.equipUnlocked.includes(r.id), `新存档应默认解锁 ${r.id}`);
}

// 验证在无任何装备的情况下，跨大区点名去「巴黎」（欧洲）与「开罗」（非洲）均可直接成行
stDefault.bag.food.normal = 5;
const goParis = await TW.depart('group:test_default', stDefault, 'normal', mockDeps({ target: { city: '巴黎' } }));
assert.equal(goParis.ok, true, `点名去默认解锁的欧洲「巴黎」应直接成功，实际：${goParis.reason}`);
assert.equal(goParis.plan.region, 'europe');
assert.equal(goParis.plan.city, '巴黎');
stDefault.trip = null;

// 验证点名去未解锁异世界「神圣泰拉」会被拦下并提示买「伺服颅骨提灯」
const goTerra = await TW.depart('group:test_default', stDefault, 'normal', mockDeps({ target: { city: '神圣泰拉' } }));
assert.equal(goTerra.ok, false, '未解锁战锤40K时点名去神圣泰拉应被拦截');
assert.ok(goTerra.reason.includes('伺服颅骨提灯'), `拦截文案应提示需购买伺服颅骨提灯，实际：${goTerra.reason}`);

// 验证帮助图 HTML 不再包含任何陈旧现实装备名
const helpHtml = H.buildWhaleHelpHtml(TW.internals.helpDataFor(stDefault)) + H.buildHelpText();
for (const legacyEq of ['水墨纸伞', '牛皮旅行箱', '探险遮阳帽', '牛仔帽', '冲浪板', '潜水镜', '航海罗盘', '珊瑚手串', '厚毛围巾']) {
  assert.ok(!helpHtml.includes(legacyEq), `帮助图不应再出现陈旧现实装备「${legacyEq}」`);
}

const snapDefault = buildSnapshot(stDefault, Date.now());
assert.equal(snapDefault.mapTheme, undefined, '默认主题下快照不应多出 mapTheme 字段');
assert.equal(snapDefault.world.asia.kind, 'real');
assert.equal(snapDefault.world.asia.unlocked, true);
assert.equal(snapDefault.world.asia.equipment, '');
assert.equal(snapDefault.world.azeroth.kind, 'other');
assert.equal(snapDefault.world.azeroth.unlocked, false);
console.log('  ✓ default 主题验证通过（9 地球基础区全部解锁、陈旧现实装备已净除、跨大区点名直达）');

console.log('=== [2/4] 验证重锚定至「艾泽拉斯」(azeroth 主题包：五大洲全部默认解锁且无解锁装备) ===');
const azTheme = TW.setWorldTheme('艾泽拉斯');
assert.equal(azTheme.id, 'azeroth');
assert.equal(TW.activeThemeId(), 'azeroth');
assert.equal(TW.isDefaultTheme(), false);
assert.equal(TW.defaultBaseRegionId(), 'azeroth_ek');

const azRegions = T.loadRegions();
const azBaseRegions = azRegions.filter((r) => r.defaultUnlocked === true);
assert.deepEqual(azBaseRegions.map((r) => r.id), [
  'azeroth_ek',
  'azeroth_kalimdor',
  'azeroth_northrend',
  'azeroth_pandaria',
  'azeroth_outland'
]);
for (const r of azBaseRegions) {
  assert.equal(r.equipment, undefined, `艾泽拉斯基础大区 ${r.id} 默认全部解锁，不应带解锁装备字段`);
}

const azOtherIds = TW.otherworldIdsOfTheme();
assert.equal(azOtherIds.length, 15, '艾泽拉斯主题下异世界应为 14 个其余虚构世界 + 1 个收束后的「蔚蓝地球」');
assert.ok(azOtherIds.includes('earth'), '原地球 9 大区应被收束为异世界 earth（蔚蓝地球）');
assert.ok(!azOtherIds.includes('azeroth'), '艾泽拉斯已晋升为基础世界，不应再留在未解锁异世界池');

const stAz = S.emptyState('group:test_azeroth');
assert.deepEqual(stAz.whale.equipUnlocked, azBaseRegions.map((r) => r.id), '新世界存档默认解锁应包含全部五大洲');
for (const r of azBaseRegions) {
  assert.equal(TW.internals.isRegionUnlocked(stAz, r), true, `新世界大区 ${r.id} 必须处于已解锁状态`);
}

// 验证在艾泽拉斯主题下，无任何装备点名去「达拉然」（诺森德）、「奥格瑞玛」（卡利姆多）均可直接前往
stAz.bag.food.normal = 5;
const goDalaran = await TW.depart('group:test_azeroth', stAz, 'normal', mockDeps({ target: { city: '达拉然' } }));
assert.equal(goDalaran.ok, true, `点名去诺森德「达拉然」应直接成功，实际：${goDalaran.reason}`);
assert.equal(goDalaran.plan.region, 'azeroth_northrend');
assert.equal(goDalaran.plan.city, '达拉然');
stAz.trip = null;

// 验证世界速写 / 视觉速写 / 影调 / 属地标签跨 parentWorldId 自动继承
const wbEk = TW.worldbookForTrip({ regionId: 'azeroth_ek', country: '东部王国', city: '暴风城' });
assert.ok(wbEk.includes('东部王国') && wbEk.includes('人类与矮人'), '东部王国应自动继承 azeroth|东部王国 的世界速写');

const vbKal = TW.internals.visualBriefForTrip({ regionId: 'azeroth_kalimdor', country: '卡利姆多', city: '奥格瑞玛' });
assert.ok(vbKal.includes('赭黄与深绿'), '卡利姆多应自动继承 azeroth|卡利姆多 的视觉速写');

const toneNr = TW.internals.toneForTrip({ regionId: 'azeroth_northrend', country: '诺森德', city: '冰冠堡垒' });
assert.ok(toneNr.tone.length > 0, '诺森德应自动继承 azeroth|诺森德 的影调约束');

const tagsUc = TW.internals.placeTagsFor({ region: 'azeroth_ek', country: '东部王国', city: '幽暗城' });
assert.deepEqual(tagsUc, ['corridor', 'settlement'], '幽暗城应命中城市级属地标签');

// 验证到访子区域对原 azeroth 服装与技能的联动解锁
TW.internals.markAreaSeen(stAz, { regionId: 'azeroth_ek', country: '东部王国' });
assert.ok(stAz.areasSeen['azeroth_ek|东部王国'] && stAz.areasSeen['azeroth|东部王国'], 'markAreaSeen 应同步写入父世界键 azeroth|东部王国');
const stormwindOutfit = OW.outfitOf('stormwind');
assert.ok(stormwindOutfit && stAz.areasSeen[`${stormwindOutfit.region}|${stormwindOutfit.area}`], '联盟板甲应自动满足购买前置');

// 验证 courtyard-map 快照在艾泽拉斯主题下的主地图重锚定
const snapAz = buildSnapshot(stAz, Date.now());
assert.ok(snapAz.mapTheme, '艾泽拉斯主题下快照应包含 mapTheme');
assert.equal(snapAz.mapTheme.id, 'azeroth');
assert.equal(snapAz.mapTheme.zoneOrder.length, 5);
assert.ok(Array.isArray(snapAz.mapTheme.worldLand) && snapAz.mapTheme.worldLand.length > 30, '应包含艾泽拉斯点阵大陆轮廓');
for (const r of azBaseRegions) {
  assert.equal(snapAz.world[r.id].kind, 'real');
  assert.equal(snapAz.world[r.id].unlocked, true, `面板快照中 ${r.id} 必须为已解锁`);
  assert.equal(snapAz.world[r.id].equipment, '', `面板快照中 ${r.id} 不应有解锁装备`);
}
assert.equal(snapAz.world.earth.kind, 'other');
assert.equal(snapAz.world.earth.name, '蔚蓝地球');
assert.equal(snapAz.world.earth.equipment, '蔚蓝星图');
assert.equal(snapAz.world.earth.unlocked, false);
console.log('  ✓ 艾泽拉斯主题包验证通过（五大洲全部解锁且无解锁装备 + 跨大区点名直达 + 地球退居异世界）');

console.log('=== [3/4] 验证任意世界一键自动晋升（以「提瓦特」teyvat 为例：六国全部默认解锁且无解锁装备） ===');
const teyvatTheme = TW.setWorldTheme('提瓦特');
assert.equal(teyvatTheme.id, 'teyvat');
const tvBaseRegions = T.loadRegions().filter((r) => r.defaultUnlocked === true);
assert.equal(tvBaseRegions.length, 6, '提瓦特 6 国应自动晋升为 6 个默认解锁基础大区');
for (const r of tvBaseRegions) {
  assert.equal(r.equipment, undefined, `自动晋升的提瓦特基础大区 ${r.id} 不应带解锁装备字段`);
}
const stTv = S.emptyState('group:test_teyvat');
assert.equal(stTv.whale.equipUnlocked.length, 6);
stTv.bag.food.normal = 5;
const goLiyue = await TW.depart('group:test_teyvat', stTv, 'normal', mockDeps({ target: { city: '璃月港' } }));
assert.equal(goLiyue.ok, true, '点名去提瓦特「璃月港」应直接成行');
assert.equal(goLiyue.plan.city, '璃月港');
const snapTv = buildSnapshot(stTv, Date.now());
assert.equal(snapTv.mapTheme.id, 'teyvat');
assert.equal(snapTv.mapTheme.zoneOrder.length, 6);
assert.ok(snapTv.mapTheme.worldLand.length > 10, '自动晋升世界应自动生成点阵大陆轮廓');
console.log('  ✓ 任意世界自动晋升验证通过（提瓦特 6 国全部默认解锁、无解锁装备、点名直达）');

console.log('=== [4/4] 验证切回 default 主题零残留 ===');
TW.setWorldTheme('default');
assert.equal(TW.activeThemeId(), 'default');
assert.equal(T.loadRegions().length, 24);
assert.equal(TW.defaultBaseRegionId(), 'asia');
const shopTxt = TW.internals.shopText(stDefault);
assert.ok(shopTxt.length > 100 && shopTxt.length < 1200, `shopText 长度 (${shopTxt.length}) 应保持 < 1200`);
console.log('  ✓ 切回 default 零残留验证通过！');
console.log('\n🎉 ALL THEME PACK, BASE-WORLD UNLOCK & LEGACY EQUIPMENT REMOVAL TESTS PASSED!');
