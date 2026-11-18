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
  { slot: -1, name: '食品', levelWeight: 0, uiGroup: 'misc' },
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
