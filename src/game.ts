export type GearId = number & { readonly brand: unique symbol };

export interface GearBase {
  id: GearId,
  name: string,
  level: number,
  slot: number,
  jobCategory: number,
  stats: Stats,
  obsolete?: true,
}
export interface Gear extends GearBase {
  rarity: number,
  rawSlot?: number,
  role: number,
  equipLevel: number,
  equipLevelVariable?: true,
  materiaSlot: number,
  materiaAdvanced?: true,
  hq?: true,
  unique?: true,  // 唯一裝備，目前只標記戒指
  customizable?: true,
  bonusType?: 9 | 11,
  bonusStats?: Stats,
  source?: string,
  patch?: string,
}
export interface Food extends GearBase {
  statRates: Stats,
  statMain: Stat,
  best: boolean,
}

export interface Gearset {
  job: Job,
  jobLevel: JobLevel,
  syncLevel?: number,
  gears: {
    id: GearId,
    materias: GearsetMaterias,
    customStats?: Stats,
  }[],
}
export type GearsetMaterias = ([Stat, MateriaGrade] | null)[];

export const statNames = {
  STR: '力量', DEX: '靈巧', INT: '智力', MND: '精神', VIT: '耐力',
  CRT: '暴擊', DHT: '直擊', DET: '信念', SKS: '技速', SPS: '詠速', TEN: '堅韌', PIE: '信仰',
  CMS: '作業精度', CRL: '加工精度', CP: '製作力', GTH: '獲得力', PCP: '鑑別力', GP: '採集力',
  PDMG: '物理基本性能', MDMG: '魔法基本性能', DLY: '攻擊間隔',
  main: 'unreachable', secondary: 'unreachable',
};
export type Stat = keyof typeof statNames;
export type Stats = { [index in Stat]?: number };
export type StatPairs = [Stat, number][];

const levelCaps = require('../data/out/levelCaps').default as { [index in Stat | 'level']: number[] };
const slotCaps = require('../data/out/slotCaps').default as { [index in Stat]: number[] };
const roleCaps = require('../data/out/roleCaps').default as { [index in Stat]: number[] };
const levelCapsIndex: { [index: number]: number } = {};
levelCaps.level.forEach((level, i) => {
  levelCapsIndex[level] = i;
});
const capsCache: { [index: string]: Stats } = {};
export function getCaps(gear: Gear, syncLevel?: number): Stats {
  const level = syncLevel ?? gear.level;
  const slot = gear.rawSlot ?? gear.slot;
  const role = gear.role;
  const cacheKey = `${level},${slot},${role}`;
  if (!(cacheKey in capsCache)) {
    const caps: Stats = {};
    for (const stat of Object.keys(statNames) as Stat[]) {
      if (stat === 'main' || stat === 'secondary') continue;
      caps[stat] = stat === 'DLY' ? Infinity : Math.round(
        levelCaps[stat][levelCapsIndex[level]] *
        slotCaps[stat][slot] *
        roleCaps[stat][role] /
        100000);
    }
    capsCache[cacheKey] = caps;
  }
  return capsCache[cacheKey];
}

export const jobLevelModifiers = {
  50: {
    main: 202, sub: 341, div: 341, det: 202, detTrunc: 5,
    ap: 75, apTank: 53, hp: 14, vit: 11.2, vitTank: 15.5,
  },
  60: {
    main: 218, sub: 354, div: 600, det: 600 /* FIXME */, detTrunc: 2,
    ap: 100, apTank: 78, hp: 15, vit: 12.9, vitTank: 17.5,
  },
  70: {
    main: 292, sub: 364, div: 900, det: 900, detTrunc: 1,
    ap: 125, apTank: 105, hp: 17, vit: 14.0, vitTank: 18.8,
  },
  80: {
    main: 340, sub: 380, div: 1300, det: 1300, detTrunc: 1,
    ap: 165, apTank: 115, hp: 20, vit: 18.8, vitTank: 26.6,
  },
  90: {
    main: 390, sub: 400, div: 1900, det: 1900, detTrunc: 1,
    ap: 195, apTank: 156, hp: 30, vit: 24.3, vitTank: 34.6,
  },
  100: {
    main: 440, sub: 420, div: 2780, det: 2780, detTrunc: 1,
    ap: 237, apTank: 190, hp: 40, vit: 30.1, vitTank: 43.0,
  },
};
export type JobLevel = keyof typeof jobLevelModifiers;
export const jobLevels = Object.keys(jobLevelModifiers).map(l => Number(l) as JobLevel);
const jobLevelMax = jobLevels[jobLevels.length - 1];

export const baseStats: { [index in Stat]?: 'main' | 'sub' | number } = {
  STR: 'main', DEX: 'main', INT: 'main', MND: 'main', VIT: 'main',
  CRT: 'sub', DHT: 'sub', DET: 'main', SKS: 'sub', SPS: 'sub', TEN: 'sub', PIE: 'main',
  CMS: 0, CRL: 0, CP: 180, GTH: 0, PCP: 0, GP: 400,
};

export const customStatMax = 1000;

/** 幻境武器最終階段（795 品級）的屬性分配規則：兩種屬性為「大」（該屬性上限值）、一種為「小」（固定值） */
export interface RelicRule {
  stats: Stat[],  // 可選的屬性
  large: Stats,  // 各屬性選為「大」時的數值
  small: number,  // 選為「小」時的數值
}
export type RelicTier = 'large' | 'small';
const relicRuleLevel = 795;
const relicSmallValues: { [index: number]: number } = { 13: 108, 1: 76, 2: 32 };  // 雙手武器、單手武器、盾
const relicLargeCount = 2;
const relicSmallCount = 1;

/** 取得裝備的屬性分配規則，不是幻境武器最終階段時為 undefined。
 *  可選屬性為職業顯示的副屬性；坦克與治療（顯示七種屬性的職能）不能選直擊。
 *  數值與 xivgear.app 相同：雙手 447／108，騎士劍 319／76，騎士盾 128／32（大＝該部位的屬性上限） */
export function getRelicRule(gear: Gear, schemaStats: Stat[]): RelicRule | undefined {
  if (!gear.customizable || gear.level !== relicRuleLevel) return undefined;
  const small = relicSmallValues[gear.slot];
  if (small === undefined) return undefined;
  const caps = getCaps(gear);
  const stats = schemaStats.filter(stat => stat in materias && !(stat === 'DHT' && schemaStats.length >= 7));
  const large: Stats = {};
  for (const stat of stats) large[stat] = caps[stat];
  return { stats, large, small };
}

/** 自訂屬性中某屬性屬於「大」或「小」，數值不符規則時為 undefined */
export function relicTierOf(rule: RelicRule, stat: Stat, value: number | undefined): RelicTier | undefined {
  if (!rule.stats.includes(stat) || value === undefined) return undefined;
  return value === rule.large[stat] ? 'large' : value === rule.small ? 'small' : undefined;
}

/** 自訂屬性是否完全符合規則（恰好兩大一小、沒有其他屬性） */
export function isRelicComplete(rule: RelicRule, customStats: Stats): boolean {
  let large = 0;
  let small = 0;
  for (const [ stat, value ] of Object.entries(customStats) as StatPairs) {
    const tier = relicTierOf(rule, stat, value);
    if (tier === 'large') large++; else if (tier === 'small') small++; else return false;
  }
  return large === relicLargeCount && small === relicSmallCount;
}

/** 將某屬性設為「大」「小」或不選，回傳新的自訂屬性；不符規則的既有數值會被移除，
 *  同一級距超出數量時移除最早選的屬性（依物件的插入順序） */
export function setRelicTier(rule: RelicRule, customStats: Stats, stat: Stat, tier: RelicTier | undefined): Stats {
  const entries = (Object.entries(customStats) as StatPairs)
    .filter(([ s, value ]) => s !== stat && relicTierOf(rule, s, value) !== undefined);
  if (tier !== undefined && rule.stats.includes(stat)) {
    const limit = tier === 'large' ? relicLargeCount : relicSmallCount;
    const sameTier = entries.filter(([ s, value ]) => relicTierOf(rule, s, value) === tier);
    for (const [ s ] of sameTier.slice(0, Math.max(0, sameTier.length - limit + 1))) {
      entries.splice(entries.findIndex(([ x ]) => x === s), 1);
    }
    entries.push([ stat, tier === 'large' ? rule.large[stat]! : rule.small ]);
  }
  return Object.fromEntries(entries);
}

/** 從指定屬性中列舉所有「兩大一小」的分配 */
export function relicAllocations(rule: RelicRule, stats: Stat[] = rule.stats): Stats[] {
  const allocations: Stats[] = [];
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      for (const small of stats) {
        if (small === stats[i] || small === stats[j]) continue;
        allocations.push({ [stats[i]]: rule.large[stats[i]], [stats[j]]: rule.large[stats[j]], [small]: rule.small });
      }
    }
  }
  return allocations;
}

const statSchemas: { [index: string]: Stat[] } = {
  tank: ['STR', 'CRT', 'DET', 'DHT', 'SKS', 'TEN', 'VIT'],
  healer: ['MND', 'CRT', 'DET', 'DHT', 'SPS', 'PIE', 'VIT'],
  dpsStr: ['STR', 'CRT', 'DET', 'DHT', 'SKS', 'VIT'],
  dpsDex: ['DEX', 'CRT', 'DET', 'DHT', 'SKS', 'VIT'],
  dpsInt: ['INT', 'CRT', 'DET', 'DHT', 'SPS', 'VIT'],
  crafting: ['CMS', 'CRL', 'CP'],
  gathering: ['GTH', 'PCP', 'GP'],
};

export interface SlotSchema {
  slot: number,
  name: string,
  shortName?: string,
  levelWeight?: number,
  uiGroup: string,
}
const slotSchemaCommon: SlotSchema[] = [
  { slot: 3, name: '頭部防具', uiGroup: 'left' },
  { slot: 4, name: '身體防具', uiGroup: 'left' },
  { slot: 5, name: '手部防具', uiGroup: 'left' },
  { slot: 7, name: '腿部防具', uiGroup: 'left' },
  { slot: 8, name: '腳部防具', uiGroup: 'left' },
  { slot: 9, name: '耳飾', uiGroup: 'right' },
  { slot: 10, name: '項鍊', uiGroup: 'right' },
  { slot: 11, name: '手鐲', uiGroup: 'right' },
  { slot: 12, name: '戒指', uiGroup: 'right' },
  { slot: -12, name: '戒指', uiGroup: 'right' },
  { slot: -1, name: '食物', levelWeight: 0, uiGroup: 'misc' },
];
const slotSchemaCombat = [
  { slot: 13, name: '武器', levelWeight: 2, uiGroup: 'weapon' },
  ...slotSchemaCommon,
];
const slotSchemaGathering = [
  { slot: 1, name: '主工具', shortName: '主手', uiGroup: 'weapon' },
  { slot: 2, name: '副工具', shortName: '副手', uiGroup: 'weapon' },
  ...slotSchemaCommon,
];
const slotSchemaCrafting = [
  ...slotSchemaGathering.slice(0, -1),
  { slot: 17, name: '靈魂水晶', shortName: '水晶', levelWeight: 0, uiGroup: 'misc' },
  slotSchemaGathering[slotSchemaGathering.length - 1],
  { slot: -2, name: '藥品', levelWeight: 0, uiGroup: 'misc' },
];

const defaultItemLevelCombat = [780, 795];
const defaultItemLevelCrafting = [750, 780];
const defaultItemLevelGathering = defaultItemLevelCrafting;

export interface JobSchema {
  name: string,
  stats: Stat[],
  slots: SlotSchema[],
  defaultItemLevel: [number, number],
  jobLevel: JobLevel,
  levelSyncable?: boolean,
  statModifiers?: {
    STR?: number,
    DEX?: number,
    INT?: number,
    MND?: number,
    VIT: number,
    hp: number,
    gcd?: number,
    gcdReason?: string,
  },
  mainStat?: 'STR' | 'DEX' | 'INT' | 'MND' | 'VIT',
  secondaryStat?: 'TEN' | 'PIE' | 'DHT',
  traitDamageMultiplier?: number,
  partyBonus?: number,
  skeletonGears?: boolean,  // consistent stats proportion in same slot, focus on materia melding than gear choosing
  toolMateriaDuplicates?: number,
}

export const jobSchemas = {
  /* eslint-disable @typescript-eslint/consistent-type-assertions */
  PLD: {
    name: '騎士',
    stats: statSchemas.tank,
    slots: [
      { slot: 1, name: '武器', uiGroup: 'weapon' },
      { slot: 2, name: '盾牌', uiGroup: 'weapon' },
      ...slotSchemaCommon,
    ],
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { STR: 100, VIT: 110, hp: 140 },
    mainStat: 'VIT',
    secondaryStat: 'TEN',
    traitDamageMultiplier: 1,
  } as JobSchema,
  WAR: {
    name: '戰士',
    stats: statSchemas.tank,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { STR: 105, VIT: 110, hp: 145 },
    mainStat: 'VIT',
    secondaryStat: 'TEN',
    traitDamageMultiplier: 1,
  } as JobSchema,
  DRK: {
    name: '暗黑騎士',
    stats: statSchemas.tank,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { STR: 105, VIT: 110, hp: 140 },
    mainStat: 'VIT',
    secondaryStat: 'TEN',
    traitDamageMultiplier: 1,
  } as JobSchema,
  GNB: {
    name: '絕槍戰士',
    stats: statSchemas.tank,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { STR: 100, VIT: 110, hp: 140 },
    mainStat: 'VIT',
    secondaryStat: 'TEN',
    traitDamageMultiplier: 1,
  } as JobSchema,
  WHM: {
    name: '白魔道士',
    stats: statSchemas.healer,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { MND: 115, VIT: 100, hp: 105 },
    mainStat: 'MND',
    secondaryStat: 'PIE',
    traitDamageMultiplier: 1.3,
  } as JobSchema,
  SCH: {
    name: '學者',
    stats: statSchemas.healer,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { MND: 115, VIT: 100, hp: 105 },
    mainStat: 'MND',
    secondaryStat: 'PIE',
    traitDamageMultiplier: 1.3,
  } as JobSchema,
  AST: {
    name: '占星術師',
    stats: statSchemas.healer,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { MND: 115, VIT: 100, hp: 105 },
    mainStat: 'MND',
    secondaryStat: 'PIE',
    traitDamageMultiplier: 1.3,
  } as JobSchema,
  SGE: {
    name: '賢者',
    stats: statSchemas.healer,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { MND: 115, VIT: 100, hp: 105 },
    mainStat: 'MND',
    secondaryStat: 'PIE',
    traitDamageMultiplier: 1.3,
  } as JobSchema,
  MNK: {
    name: '武僧',
    stats: statSchemas.dpsStr,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { STR: 110, VIT: 100, hp: 110, gcd: 80, gcdReason: '「疾風迅雷」狀態中' },
    mainStat: 'STR',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1,
  } as JobSchema,
  DRG: {
    name: '龍騎士',
    stats: statSchemas.dpsStr,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { STR: 115, VIT: 105, hp: 115 },
    mainStat: 'STR',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1,
  } as JobSchema,
  NIN: {
    name: '忍者',
    stats: statSchemas.dpsDex,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { DEX: 110, VIT: 100, hp: 108, gcd: 85, gcdReason: '「風遁」狀態中' },
    mainStat: 'DEX',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1,
  } as JobSchema,
  SAM: {
    name: '武士',
    stats: statSchemas.dpsStr,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { STR: 112, VIT: 100, hp: 109, gcd: 87, gcdReason: '「風花」狀態中' },
    mainStat: 'STR',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1,
  } as JobSchema,
  RPR: {
    name: '奪魂者',
    stats: statSchemas.dpsStr,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { STR: 115, VIT: 105, hp: 115 },
    mainStat: 'STR',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1,
  } as JobSchema,
  VPR: {
    name: '毒蛇劍士',
    stats: statSchemas.dpsDex,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { DEX: 110, VIT: 100, hp: 111, gcd: 85, gcdReason: '「疾速」狀態中' },
    mainStat: 'DEX',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1,
  } as JobSchema,
  BST: {
    name: '馴獸師',
    stats: statSchemas.dpsStr,
    slots: [
      { slot: 1, name: '武器', uiGroup: 'weapon' },
      { slot: 2, name: '盾牌', uiGroup: 'weapon' },
      ...slotSchemaCommon,
    ],
    defaultItemLevel: [130, 135],
    jobLevel: 50,
    levelSyncable: true,
    statModifiers: { STR: 110, VIT: 100, hp: 110 },
    mainStat: 'STR',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1,
    partyBonus: 1,  // TODO: 确认驯兽师终盘玩法组队情况
  } as JobSchema,
  BRD: {
    name: '吟遊詩人',
    stats: statSchemas.dpsDex,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { DEX: 115, VIT: 100, hp: 105 },
    mainStat: 'DEX',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1.2,
  } as JobSchema,
  MCH: {
    name: '機工士',
    stats: statSchemas.dpsDex,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { DEX: 115, VIT: 100, hp: 105 },
    mainStat: 'DEX',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1.2,
  } as JobSchema,
  DNC: {
    name: '舞者',
    stats: statSchemas.dpsDex,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { DEX: 115, VIT: 100, hp: 105 },
    mainStat: 'DEX',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1.2,
  } as JobSchema,
  BLM: {
    name: '黑魔道士',
    stats: statSchemas.dpsInt,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { INT: 115, VIT: 100, hp: 105 },
    mainStat: 'INT',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1.3,
  } as JobSchema,
  SMN: {
    name: '召喚士',
    stats: statSchemas.dpsInt,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { INT: 115, VIT: 100, hp: 105 },
    mainStat: 'INT',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1.3,
  } as JobSchema,
  RDM: {
    name: '赤魔道士',
    stats: statSchemas.dpsInt,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { INT: 115, VIT: 100, hp: 105 },
    mainStat: 'INT',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1.3,
  } as JobSchema,
  PCT: {
    name: '繪靈法師',
    stats: statSchemas.dpsInt,
    slots: slotSchemaCombat,
    defaultItemLevel: defaultItemLevelCombat,
    jobLevel: jobLevelMax,
    levelSyncable: true,
    statModifiers: { INT: 115, VIT: 100, hp: 105 },
    mainStat: 'INT',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1.3,
  } as JobSchema,
  BLU: {
    name: '青魔道士',
    stats: statSchemas.dpsInt,
    slots: [
      { slot: 13, name: '武器', levelWeight: 0, uiGroup: 'weapon' },
      ...slotSchemaCommon,
    ],
    defaultItemLevel: [520, 530],
    jobLevel: 80,
    levelSyncable: true,
    statModifiers: { INT: 115, VIT: 100, hp: 105 },
    mainStat: 'INT',
    secondaryStat: 'DHT',
    traitDamageMultiplier: 1.5,
    partyBonus: 1.01,
  } as JobSchema,
  CRP: {
    name: '木工師',
    stats: statSchemas.crafting,
    slots: slotSchemaCrafting,
    defaultItemLevel: defaultItemLevelCrafting,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 8,
  } as JobSchema,
  BSM: {
    name: '鍛造師',
    stats: statSchemas.crafting,
    slots: slotSchemaCrafting,
    defaultItemLevel: defaultItemLevelCrafting,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 8,
  } as JobSchema,
  ARM: {
    name: '甲冑師',
    stats: statSchemas.crafting,
    slots: slotSchemaCrafting,
    defaultItemLevel: defaultItemLevelCrafting,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 8,
  } as JobSchema,
  GSM: {
    name: '金工師',
    stats: statSchemas.crafting,
    slots: slotSchemaCrafting,
    defaultItemLevel: defaultItemLevelCrafting,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 8,
  } as JobSchema,
  LTW: {
    name: '皮革師',
    stats: statSchemas.crafting,
    slots: slotSchemaCrafting,
    defaultItemLevel: defaultItemLevelCrafting,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 8,
  } as JobSchema,
  WVR: {
    name: '裁縫師',
    stats: statSchemas.crafting,
    slots: slotSchemaCrafting,
    defaultItemLevel: defaultItemLevelCrafting,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 8,
  } as JobSchema,
  ALC: {
    name: '鍊金術師',
    stats: statSchemas.crafting,
    slots: slotSchemaCrafting,
    defaultItemLevel: defaultItemLevelCrafting,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 8,
  } as JobSchema,
  CUL: {
    name: '烹調師',
    stats: statSchemas.crafting,
    slots: slotSchemaCrafting,
    defaultItemLevel: defaultItemLevelCrafting,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 8,
  } as JobSchema,
  MIN: {
    name: '採掘師',
    stats: statSchemas.gathering,
    slots: slotSchemaGathering,
    defaultItemLevel: defaultItemLevelGathering,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 2,
  } as JobSchema,
  BTN: {
    name: '園藝師',
    stats: statSchemas.gathering,
    slots: slotSchemaGathering,
    defaultItemLevel: defaultItemLevelGathering,
    jobLevel: jobLevelMax,
    skeletonGears: true,
    toolMateriaDuplicates: 2,
  } as JobSchema,
  FSH: {
    name: '漁師',
    stats: statSchemas.gathering,
    slots: slotSchemaGathering,
    defaultItemLevel: defaultItemLevelGathering,
    jobLevel: jobLevelMax,
    skeletonGears: true,
  } as JobSchema,
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
};

export type Job = keyof typeof jobSchemas;

export const jobCategories = require('../data/out/jobCategories').default as { [index in Job]?: boolean }[];

export const statHighlight: { [index in Stat]?: boolean } = {
  PIE: true, TEN: true, DHT: true, CRT: true, DET: true, SKS: true, SPS: true,
};

export const materias: { [index in Stat]?: number[] } = {
  PIE: [1, 2, 3, 4, 6, 16, 8, 24, 12, 36, 18, 54],
  DHT: [1, 2, 3, 4, 6, 16, 8, 24, 12, 36, 18, 54],
  CRT: [1, 2, 3, 4, 6, 16, 8, 24, 12, 36, 18, 54],
  DET: [1, 2, 3, 4, 6, 16, 8, 24, 12, 36, 18, 54],
  SPS: [1, 2, 3, 4, 6, 16, 8, 24, 12, 36, 18, 54],
  SKS: [1, 2, 3, 4, 6, 16, 8, 24, 12, 36, 18, 54],
  TEN: [1, 2, 3, 4, 6, 16, 8, 24, 12, 36, 18, 54],
  CMS: [3, 4, 5, 6, 11, 16, 14, 21, 18, 27, 22, 33],
  CRL: [1, 2, 3, 4, 7, 10, 9, 13, 12, 18, 15, 23],
  CP: [1, 2, 3, 4, 6, 8, 7, 9, 8, 10, 9, 11],
  GTH: [3, 4, 5, 6, 10, 15, 12, 20, 14, 25, 20, 36],
  PCP: [3, 4, 5, 6, 10, 15, 12, 20, 14, 25, 20, 36],
  GP: [1, 2, 3, 4, 6, 8, 7, 9, 8, 10, 9, 11],
};
export type MateriaGrade = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
export const materiaGrades: MateriaGrade[] = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
export const materiaGradeRequiredLevels: number[] = [15, 30, 45, 70, 160, 290, 420, 420, 560, 560, 690, 690];
export const materiaGradeIsRestricted = Array.from(materiaGradeRequiredLevels, () => false);
for (const grade of [12, 10, 8, 6]) materiaGradeIsRestricted[grade] = true;
export const materiaSuccessRates: number[][] = [
  [90, 82, 70, 58, 17, 17, 17, 17, 17, 17, 17, 17],
  [48, 44, 38, 32, 10, 0, 10, 0, 10, 0, 10, 0],
  [28, 26, 22, 20, 7, 0, 7, 0, 7, 0, 7, 0],
  [16, 16, 14, 12, 5, 0, 5, 0, 5, 0, 5, 0],
];
export const materiaNames: { [index in Stat]?: string } = {
  CRT: '武略', DHT: '神眼', DET: '雄略', SKS: '戰技', SPS: '詠唱', TEN: '剛柔', PIE: '信力',
  CMS: '名匠', CRL: '巨匠', CP: '魔匠', GTH: '達識', PCP: '博識', GP: '器識',
};
export const materiaGradeNames: string[] = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾', '拾壹', '拾貳'];
export const materiaStatNames = { ...statNames, CP: 'CP', GP: 'GP' };
export function getMateriaName(stat: Stat, grade: MateriaGrade, useStat: boolean, maxLength=4) {
  return useStat ? materiaStatNames[stat].slice(0, 2) + materias[stat]![grade - 1] :
    materiaNames[stat]!.slice(0, maxLength - materiaGradeNames[grade - 1].length) + materiaGradeNames[grade - 1];
}

export const races = [
  '人族',
  '精靈族',
  '拉拉菲爾族',
  '貓魅族',
  '魯加族',
  '敖龍族',
  '硌獅族',
  '維艾拉族',
];

export const clans = [
  '中原之民', '高地之民',
  '森林之民', '黑影之民',
  '平原之民', '沙漠之民',
  '逐日之民', '護月之民',
  '北洋之民', '紅焰之民',
  '晨曦之民', '暮暉之民',
  '掠日之民', '迷蹤之民',
  '密林之民', '山林之民',
];

export const clanStats: { [index in Stat]?: number[] } = {
  STR: [22, 23, 20, 20, 19, 19, 22, 19, 22, 20, 19, 23, 23, 23, 20, 19].map(x => x - 20),
  DEX: [19, 20, 23, 20, 23, 21, 23, 22, 19, 18, 22, 20, 17, 17, 23, 20].map(x => x - 20),
  VIT: [20, 22, 19, 19, 19, 18, 20, 18, 23, 23, 19, 22, 23, 23, 18, 19].map(x => x - 20),
  INT: [23, 18, 22, 23, 22, 22, 19, 21, 18, 20, 20, 20, 17, 17, 21, 23].map(x => x - 20),
  MND: [19, 20, 19, 21, 20, 23, 19, 23, 21, 22, 23, 18, 23, 23, 21, 22].map(x => x - 20),
};

export const syncLevels = require('../data/out/syncLevels').default as { [index in JobLevel]: number[] };
export const syncLevelIsPopular: { [index: number]: boolean } = {
  345: true, 375: true, 475: true, 605: true, 635: true, 735: true, 795: true,  // Ultimate Raids
  300: true, 700: true,  // Field Operations
  /* 635: true, */665: true,/* 795: true */  // Criterion Dungeons
  695: true,  // Unreal Trials
};
export const syncLevelOfJobLevels = { 50: 130, 60: 270, 70: 400, 80: 530, 90: 660, 100: 790 };

export const bluMdmgAdditions = require('../data/out/bluMdmgAdditions').default as number[];

// ↓ 以下為不依賴 MobX 狀態的純計算，Store 與自動配裝（Web Worker）共用，確保兩邊結果一致

export function floor(value: number) {
  return Math.trunc(value + 1e-7);
}
export function ceil(value: number) {
  return Math.ceil(value - 1e-7);
}

/** 此孔洞是否可鑲嵌限制等級（偶數等級）的魔晶石 */
export function materiaCanRestricted(gear: Gear, index: number): boolean {
  return index <= gear.materiaSlot && gear.level >= 290;
}

/** 此孔洞可鑲嵌的最高等級魔晶石，與 Materia.meldableGrades[0] 相同 */
export function materiaTopGrade(gear: Gear, index: number): MateriaGrade | undefined {
  const canRestricted = materiaCanRestricted(gear, index);
  return materiaGrades.find(grade => gear.level >= materiaGradeRequiredLevels[grade - 1] &&
    (canRestricted || !materiaGradeIsRestricted[grade]));
}

/** 品級／等級同步後裝備的實際品級，未發生同步時為 undefined */
export function calcSyncedLevel(gear: Gear, jobLevel: JobLevel, targetSyncLevel?: number): number | undefined {
  let syncLevel = targetSyncLevel ?? Infinity;
  // 品級可變裝備，常駐同步至當前等級對應品級
  if (gear.equipLevelVariable) {
    syncLevel = Math.min(syncLevel, syncLevelOfJobLevels[jobLevel]);
  }
  // 先判定品級同步，目標品級低於此裝備品級時，同步至目標品級，不再進行後續判定
  //   如：700品級裝備在阿羅阿羅島中會被同步至665品級
  if (syncLevel < gear.level) {
    return syncLevel;
  }
  // 未發生直接的品級同步，但目標等級低於此裝備可裝備等級時，同步至目標等級對應品級
  //   如：700品級裝備在P12S中會被同步至660品級
  //       663HQ白裝在阿羅阿羅島中會被同步至660品級
  // 如果對應品級高於此裝備品級，雖裝備屬性值不變，但魔晶石仍然失效
  //   如：655HQ白裝在P12S中屬性值不變，魔晶石失效
  if (jobLevel < gear.equipLevel) {
    return Math.min(gear.level, syncLevelOfJobLevels[jobLevel]);
  }
}

export interface GearStatsOptions {
  mainStat?: Stat,
  secondaryStat?: Stat,
  customStats?: Stats,
  syncedLevel?: number,
  materiaStats: Stats,  // 各屬性魔晶石數值合計
}

/** 裝備的實際屬性值（套用自訂屬性、同步上限、魔晶石上限與額外加成） */
export function calcGearStats(gear: Gear, options: GearStatsOptions): Stats {
  const { mainStat, secondaryStat, customStats, syncedLevel, materiaStats } = options;
  const concretize = (stat: Stat): Stat => stat === 'main' ? mainStat! : stat === 'secondary' ? secondaryStat! : stat;
  const stats: Stats = {};
  for (const [ stat, value ] of Object.entries(gear.stats) as StatPairs) {
    stats[concretize(stat)] = value;
  }
  if (gear.customizable && customStats !== undefined) {
    Object.assign(stats, customStats);
  }
  if (syncedLevel !== undefined) {
    const caps = getCaps(gear, syncedLevel);
    for (const [ stat, value ] of Object.entries(stats) as StatPairs) {
      stats[stat] = Math.min(value, caps[stat]!);
    }
  } else if (gear.materiaSlot > 0) {
    const caps = getCaps(gear);
    for (const [ stat, value ] of Object.entries(materiaStats) as StatPairs) {
      const base = stats[stat] ?? 0;
      stats[stat] = Math.min(base + value, Math.max(base, caps[stat]!));
    }
  }
  if (gear.bonusStats !== undefined) {
    if (gear.bonusType === 9 && syncedLevel === 700 || gear.bonusType === 11) {
      for (const [ stat, value ] of Object.entries(gear.bonusStats) as StatPairs) {
        stats[concretize(stat)]! += value;
      }
    }
  }
  return stats;
}

/** 技速／詠速對應的 GCD 秒數（含職業特性的 GCD 縮短） */
export function calcGcd(job: Job, jobLevel: JobLevel, speed: number): number {
  const { sub, div } = jobLevelModifiers[jobLevel];
  const gcdModifier = jobLevel >= 80 && (jobSchemas[job] as JobSchema).statModifiers?.gcd || 100;
  return floor(floor((1000 - floor(130 * (speed - sub) / div)) * 2500 / 1000) * gcdModifier / 1000) / 100;
}

/** 暴擊、信念、直擊、堅韌造成的傷害倍率 */
export function calcSubStatDamage(job: Job, jobLevel: JobLevel, stats: Stats) {
  const { main, sub, div, det, detTrunc } = jobLevelModifiers[jobLevel];
  const { CRT, DET, DHT, TEN } = stats;
  const bluAetherialMimicry = job === 'BLU' ? 200 : 0;
  const crtChance = floor(200 * (CRT! - sub) / div + 50 + bluAetherialMimicry) / 1000;
  const crtDamage = floor(200 * (CRT! - sub) / div + 1400) / 1000;
  const detDamage = floor((140 * (DET! - main) / det + 1000) / detTrunc) * detTrunc / 1000;
  const dhtChance = floor(550 * (DHT! - sub) / div + bluAetherialMimicry) / 1000;
  const tenDamage = floor(112 * ((TEN ?? sub) - sub) / div + 1000) / 1000;
  const multiplier = detDamage * tenDamage * ((crtDamage - 1) * crtChance + 1) * (0.25 * dhtChance + 1);
  return { crtChance, crtDamage, detDamage, dhtChance, tenDamage, multiplier };
}

/** 每威力傷害期望，baseStats 用於青魔法師的魔法基本性能加成 */
export function calcDamage(job: Job, jobLevel: JobLevel, stats: Stats, baseStats: Stats) {
  const { statModifiers, mainStat, traitDamageMultiplier, partyBonus } = jobSchemas[job] as JobSchema;
  if (statModifiers === undefined || mainStat === undefined || traitDamageMultiplier === undefined) return;
  const levelMod = jobLevelModifiers[jobLevel];
  const { main } = levelMod;
  const { PDMG, MDMG } = stats;
  const attackMainStat = mainStat === 'VIT' ? 'STR' : mainStat;
  const subStatDamage = calcSubStatDamage(job, jobLevel, stats);
  const weaponDamage = floor(main * statModifiers[attackMainStat]! / 1000) +
    ((mainStat === 'MND' || mainStat === 'INT' ? MDMG : PDMG) ?? 0) +
    (job === 'BLU' ? bluMdmgAdditions[stats['INT']! - baseStats['INT']!] ?? 0 : 0);
  const mainDamage = floor((mainStat === 'VIT' ? levelMod.apTank : levelMod.ap) *
    (floor((stats[attackMainStat] ?? 0) * (partyBonus ?? 1.05)) - main) / main + 100) / 100;
  // 維持原本的乘法順序，避免浮點誤差造成顯示值與舊版不同
  const { crtChance, crtDamage, detDamage, dhtChance, tenDamage } = subStatDamage;
  const damage = 0.01 * weaponDamage * mainDamage * detDamage * tenDamage * traitDamageMultiplier *
    ((crtDamage - 1) * crtChance + 1) * (0.25 * dhtChance + 1);
  return { ...subStatDamage, weaponDamage, mainDamage, damage };
}
