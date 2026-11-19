// bis.xivtc.com 求解器的轉接程式：把本專案的 OptimizerInput 轉成它的候選格式後呼叫 optimizeDps，
// 供 compare.ts 對照結果與計時（npm run test-optimizer -- --bis=<bis.xivtc.com 原始碼目錄>）。
//
// 本檔只包含轉接用的程式碼。bis.xivtc.com 的原始碼沒有授權聲明，不放進專案，只在本機由參數指定的目錄載入；
// 該目錄需有 js/core/optimize.js（求解器）與其讀取的 data/*.json。
// compare.ts 以環境變數 BIS_XIVTC_DIR 傳入此目錄。
//
// 規則差異：
// - 魔晶石：它預設會列舉堅韌，此處改為不鑲堅韌，與本專案一致。
// - 禁斷孔：它固定使用全部禁斷孔，只能對齊「滿禁斷」與「不禁斷」兩種情境。
// - GCD 目標無法達成時：本專案改為速度最大化，它則改求最接近目標的 GCD，結果本來就可能不同。
const path = require('path');

const sourceDir = process.env.BIS_XIVTC_DIR;
if (!sourceDir) throw Error('未指定 bis.xivtc.com 原始碼目錄（環境變數 BIS_XIVTC_DIR）');
const core = require(path.join(sourceDir, 'js', 'core', 'optimize.js'));

// 與本專案規則對齊：魔晶石不鑲堅韌
const originalDims = globalThis._optDims;
globalThis._optDims = (...args) => {
  const D = originalDims(...args);
  const i = D.meldStats.indexOf('TEN');
  if (i >= 0) {
    D.meldStats = D.meldStats.filter((_, k) => k !== i);
    D.meldIdx = D.meldIdx.filter((_, k) => k !== i);
  }
  return D;
};

const SLOT_NAMES = { 13: 'Weapon', 1: 'Weapon', 2: 'OffHand', 3: 'Head', 4: 'Body', 5: 'Hands', 7: 'Legs', 8: 'Feet',
  9: 'Earrings', 10: 'Necklace', 11: 'Bracelets', 12: 'Ring' };

exports.optimize = async function optimize(input, G) {
  const { job, jobLevel, baseStats, gcdTarget, overmeldLimit } = input;
  const schema = G.jobSchemas[job];
  const mainStat = schema.mainStat;
  const wdStat = mainStat === 'MND' || mainStat === 'INT' ? 'MDMG' : 'PDMG';
  const speedStat = schema.stats.includes('SPS') ? 'SPS' : 'SKS';
  const renameStat = stat => {
    if (stat === 'main') return mainStat;
    if (stat === 'secondary') return schema.secondaryStat;
    if (stat === 'DHT') return 'DH';
    if (stat === wdStat) return 'WD';
    if (stat === 'PDMG' || stat === 'MDMG' || stat === 'DLY') return undefined;
    return stat;
  };

  const candidatesBySlot = {};
  for (const { slot, gears } of input.slots) {
    if (slot === -12) continue;  // 兩個戒指欄位在它的模型中共用一組候選
    const name = SLOT_NAMES[slot];
    candidatesBySlot[name] = gears.map(({ data }) => {
      const stats = {};
      for (const [ stat, value ] of Object.entries(data.stats)) {
        const key = renameStat(stat);
        if (key !== undefined) stats[key] = (stats[key] ?? 0) + value;
      }
      const caps = {};
      for (const [ stat, value ] of Object.entries(G.getCaps(data))) {
        const key = stat === 'DHT' ? 'DH' : stat;
        if ([ 'CRT', 'DH', 'DET', 'SKS', 'SPS', 'TEN', 'PIE' ].includes(key)) caps[key] = value;
      }
      return {
        id: data.id,
        name: data.name,
        slot: name,
        ilvl: data.level,
        materia_slots: data.materiaSlot,
        materia_advanced: !!data.materiaAdvanced && overmeldLimit > 0,
        stats,
        caps,
        unique: slot === 12 ? !!data.unique : undefined,
      };
    });
  }

  const foods = input.foods.map(({ data }) => ({
    id: data.id,
    name: data.name,
    boosts: Object.entries(data.stats).map(([ stat, max ]) => ({
      stat: stat === 'DHT' ? 'DH' : stat,
      value: data.statRates[stat] ?? 1e6,  // 沒有比例限制時直接加滿
      max,
    })),
  }));

  // 不需要速度時不設目標（與本專案「達到目標即可」的語意相同）
  const baseSpeed = baseStats[speedStat] ?? 0;
  const needSpeed = Math.round(G.calcGcd(job, jobLevel, baseSpeed) * 100) > Math.round(gcdTarget * 100);

  const start = Date.now();
  const result = await core.optimizeDps(candidatesBySlot, {
    job, jobLevel, clanIdx: 0, foods: foods.length > 0 ? foods : [null], targetGcd: needSpeed ? gcdTarget : null,
  });
  const elapsed = Date.now() - start;
  if (!result) return { error: '找不到可行的配置', elapsed };
  return {
    damage: Math.exp(result.log),
    elapsed,
    foodId: result.food?.id,
    gears: Object.entries(result.gear).map(([ slot, g ]) => `${slot}:${g?.id ?? ''}`).join(' '),
  };
};
