import * as mobx from 'mobx';
import * as mst from 'mobx-state-tree';
import * as G from '../game';
import * as share from '../share';
import type { OptimizerGear, OptimizerInput, OptimizerResult } from '../optimizer';
import { optimizerReportEnabled, optimizerReportApp, optimizerReportClient, newOptimizerRunId,
  sendOptimizerReport, SLOW_THRESHOLD } from '../optimizerReport';
import { serializeOptimizerInput } from '../optimizerReportFormat';
import type { OptimizerReportRow } from '../optimizerReportFormat';
import { floor, ceil, Setting, Promotion, GearUnion, GearUnionReference,
  gearData, gearDataOrdered, gearDataLoading, loadGearDataOfGearId, loadGearDataOfLevelRange } from '.';
import type { IGear, IFood, IGearUnion, IMateria } from '.';

const clanStorageKey = 'ffxiv-gearing.dt.clan';
const tiersShownStorageKey = 'ffxiv-gearing.dt.tiers-shown';

export type Mode = 'edit' | 'view';

export type FilterFocus = 'no' | 'melded' | 'comparable';

const expansionNames: { [index: number]: string } = {
  2: '重生之境', 3: '蒼穹之禁城', 4: '紅蓮之狂潮', 5: '暗影之逆焰', 6: '曉月之終途', 7: '黃金遺產',
};

/** 裝備來源篩選所使用的版本分組，有標記版本者取「主版本.次版本」，否則依可裝備等級歸入資料片 */
export function sourcePatchGroupOf(gear: G.Gear): string {
  if (gear.patch !== undefined) return gear.patch.slice(0, 3);
  const { equipLevel } = gear;
  const major = equipLevel <= 50 ? 2 : Math.min(7, Math.ceil((equipLevel - 50) / 10) + 2);
  return `${major}.x`;
}

export function sourceFilterKeyOf(gear: G.Gear): string {
  return `${sourcePatchGroupOf(gear)}|${gear.source ?? ''}`;
}

function sourcePatchGroupOrder(group: string): number {
  const [ major, minor ] = group.split('.');
  return minor === 'x' ? Number(major) - 0.001 : Number(group);
}

function sourcePatchGroupLabel(group: string): string {
  const [ major, minor ] = group.split('.');
  return minor === 'x' ? `${expansionNames[Number(major)] ?? major + '.x'}（未標記版本）` : `${group} 版本`;
}

export type GearOptimizationState =
  { status: 'idle' } |
  { status: 'running', job: G.Job, startTime: number } |
  { status: 'done', job: G.Job, result: OptimizerResult } |
  { status: 'error', job: G.Job, error: string };

/** 最近一次配裝最佳化的輸入與時間，供問題回報使用 */
interface GearOptimizationRun {
  id: string,
  input: OptimizerInput,
  startTime: number,
  finishTime?: number,
  /** 已自動回報 slow 或 error（附計算輸入）；slow 之後的結果會再補送 */
  reported?: boolean,
  /** 計算超過 SLOW_THRESHOLD 時回報 slow 的計時器 */
  slowTimer?: ReturnType<typeof setTimeout>,
}

/**
 * 自動回報配裝最佳化的問題（見 src/optimizerReport.ts）；失敗時只記錄於主控台。
 * withInput 為 true 時附上計算輸入並標記此次計算已回報，否則為已回報計算的後續結果（完成、失敗、取消、關閉頁面）。
 */
function sendGearOptimizationReport(
  run: GearOptimizationRun,
  row: Pick<OptimizerReportRow, 'kind' | 'elapsed_ms' | 'error' | 'result'>,
  { withInput = false, keepalive = false } = {},
): void {
  if (!optimizerReportEnabled) return;
  if (withInput) run.reported = true;
  sendOptimizerReport({
    run_id: run.id,
    app: optimizerReportApp,
    client: optimizerReportClient(),
    ...row,
    ...(withInput ? { input: serializeOptimizerInput(run.input) } : {}),
  }, keepalive).catch(error => console.warn('配裝最佳化的問題回報送出失敗', error));
}

export interface SourceFilterGroup {
  group: string,
  label: string,
  sources: { key: string, source: string, count: number }[],
}

export const Store = mst.types
  .model('Store', {
    mode: mst.types.optional(mst.types.string as mst.ISimpleType<Mode>, 'edit'),
    job: mst.types.maybe(mst.types.string as mst.ISimpleType<G.Job>),
    jobLevel: mst.types.optional(mst.types.number as mst.ISimpleType<G.JobLevel>, 100),
    minLevel: mst.types.optional(mst.types.number, 0),
    maxLevel: mst.types.optional(mst.types.number, 0),
    minLevelIncoming: mst.types.maybe(mst.types.number),
    maxLevelIncoming: mst.types.maybe(mst.types.number),
    syncLevel: mst.types.maybe(mst.types.number),
    filterFocus: mst.types.optional(mst.types.string as mst.ISimpleType<FilterFocus>, 'no'),
    hiddenSources: mst.types.array(mst.types.string),
    foodMaxLevel: mst.types.maybe(mst.types.number),  // 食物最高品級，undefined 表示不限
    showAllMaterias: mst.types.optional(mst.types.boolean, false),
    showAllFoods: mst.types.optional(mst.types.boolean, false),
    showAllPotions: mst.types.optional(mst.types.boolean, false),
    duplicateToolMateria: mst.types.optional(mst.types.boolean, true),
    gears: mst.types.map(GearUnion),
    equippedGears: mst.types.map(GearUnionReference),
  })
  .volatile(() => ({
    setting: Setting.create(),
    promotion: Promotion.create(),
    clan: Number(localStorage.getItem(clanStorageKey)) || 0,
    tiersShown: localStorage.getItem(tiersShownStorageKey) === 'true',
    materiaOverallActiveTab: 0,
    autoSelectScheduled: false,
    gearOptimization: { status: 'idle' } as GearOptimizationState,
    gearOptimizationWorker: undefined as Worker | undefined,
    gearOptimizationRun: undefined as GearOptimizationRun | undefined,
  }))
  .views(self => ({
    get hiddenSourceSet(): Set<string> {
      return new Set(self.hiddenSources);
    },
    /** 符合職業與品級範圍，且屬於裝備來源篩選對象的裝備 */
    isSourceFilterable(gear: G.GearBase): boolean {
      return gear.slot > 0 && gear.slot !== 17 && !(gear.slot === 2 && self.job === 'FSH');
    },
    /**
     * 目前職業可用、食物最高品級以內、不被其他食物完全壓制的食物。
     * 必須先篩選職業再比較，否則共用食物會被多一項他職屬性（堅韌、信仰、詠唱速度）的專用食物壓制而消失。
     */
    get bestFoodIds(): Set<G.GearId> {
      const { job, foodMaxLevel } = self;
      const foods = gearDataOrdered.get()
        .filter(gear => gear.slot === -1 && gear.id !== 4745 && !!G.jobCategories[gear.jobCategory][job!] &&
          (foodMaxLevel === undefined || gear.level <= foodMaxLevel))
        .sort((a, b) => b.id - a.id);
      const bestFoods: G.GearBase[] = [];
      for (const food of foods) {
        if (!bestFoods.some(bestFood => (Object.keys(food.stats) as G.Stat[])
          .every(stat => food.stats[stat]! <= (bestFood.stats[stat] ?? -Infinity)))) {
          bestFoods.push(food);
        }
      }
      return new Set(bestFoods.map(food => food.id));
    },
    isGearInRange(gear: G.GearBase): boolean {
      const { job, minLevel, maxLevel, foodMaxLevel } = self;
      const maxJobLevel = G.jobSchemas[job!].jobLevel;
      return !!G.jobCategories[gear.jobCategory][job!] &&
        (gear.slot === -1 ? (foodMaxLevel === undefined || gear.level <= foodMaxLevel) &&  // Foods
          (self.showAllFoods || this.bestFoodIds.has(gear.id)) :
          gear.slot === -2 ? (self.showAllPotions || 'best' in gear) :  // Potions
            gear.slot === 17 || (gear.slot === 2 && job === 'FSH') ||  // Soul crystal and spearfishing gig
            (gear.level >= minLevel && gear.level <= maxLevel &&
              (gear as G.Gear).equipLevel <= maxJobLevel &&
              !(gear.obsolete && self.setting.hideObsoleteGears)));
    },
  }))
  .views(self => ({
    get sourceFilterGroups(): SourceFilterGroup[] {
      if (self.job === undefined || self.mode === 'view') return [];
      const groups = new Map<string, Map<string, number>>();
      for (const gear of gearDataOrdered.get()) {
        if (!self.isSourceFilterable(gear) || !self.isGearInRange(gear)) continue;
        const group = sourcePatchGroupOf(gear as G.Gear);
        const source = (gear as G.Gear).source ?? '';
        const sources = groups.get(group) ?? new Map<string, number>();
        sources.set(source, (sources.get(source) ?? 0) + 1);
        groups.set(group, sources);
      }
      return Array.from(groups.entries())
        .sort(([ a ], [ b ]) => sourcePatchGroupOrder(b) - sourcePatchGroupOrder(a))
        .map(([ group, sources ]) => ({
          group,
          label: sourcePatchGroupLabel(group),
          sources: Array.from(sources.entries(), ([ source, count ]) => ({ key: `${group}|${source}`, source, count })),
        }));
    },
    /** 是否符合目前的品級範圍、食物品級上限與裝備來源篩選（不含「已裝備的一律顯示」的例外） */
    isGearShown(gear: G.GearBase): boolean {
      const { hiddenSourceSet } = self;
      return self.isGearInRange(gear) &&
        !(hiddenSourceSet.size > 0 && self.isSourceFilterable(gear) &&
          hiddenSourceSet.has(sourceFilterKeyOf(gear as G.Gear)));
    },
    get filteredIds(): G.GearId[] {
      console.debug('filteredIds');
      if (self.job === undefined) return [];
      if (self.mode === 'view') {
        return Array.from(self.gears.keys(), id => Number(id) as G.GearId);
      }
      const unobservableEquippedGears = mobx.untracked(() => self.equippedGears.toJSON());
      const ret: G.GearId[] = [];
      for (const gear of gearDataOrdered.get()) {
        if (this.isGearShown(gear)) {
          ret.push(gear.id);
          if (gear.slot === 12) {
            ret.push(-gear.id as G.GearId);
          }
        } else {
          if (unobservableEquippedGears[gear.slot] === gear.id) {
            ret.push(gear.id);
          }
          if (unobservableEquippedGears[-gear.slot] === -gear.id) {
            ret.push(-gear.id as G.GearId);
          }
        }
      }
      return ret;
    },
  }))
  .views(self => ({
    get loadingStatus() {
      return gearDataLoading.get()
        ? self.minLevelIncoming !== undefined || self.maxLevelIncoming !== undefined
          ? 'appending'  // keep rendered when loading
          : 'loading'
        : 'ready';
    },
    get isViewing(): boolean {
      return self.mode === 'view';
    },
    get schema(): G.JobSchema {
      if (self.job === undefined) throw new ReferenceError();
      return G.jobSchemas[self.job];
    },
    get groupedGears(): { [index: number]: IGearUnion[] } {
      console.debug('groupedGears');
      const ret: { [index: number]: IGearUnion[] } = {};
      for (const gearId of self.filteredIds) {
        const gear = self.gears.get(gearId.toString())!;
        if (!gear.isFood && !gear.isMelded) {
          if (self.filterFocus === 'melded' && !gear.isEquipped) continue;
          if (self.filterFocus === 'comparable') continue;
        }
        if (!(gear.slot in ret)) {
          ret[gear.slot] = [];
        }
        ret[gear.slot].push(gear);
      }
      return ret;
    },
    get baseStats(): G.Stats {
      if (self.job === undefined) return {};
      const levelModifier = G.jobLevelModifiers[self.jobLevel];
      const stats: G.Stats = { PDMG: 0, MDMG: 0, DLY: 0 };
      for (const stat of this.schema.stats as G.Stat[]) {
        const baseStat = G.baseStats[stat] ?? 0;
        if (typeof baseStat === 'number') {
          stats[stat] = baseStat;
        } else {
          stats[stat] = floor(levelModifier[baseStat] * (this.schema.statModifiers[stat] ?? 100) / 100) +
            (G.clanStats[stat]?.[self.clan] ?? 0);
        }
      }
      return stats;
    },
    get equippedStatsWithoutFood(): G.Stats {
      if (self.job === undefined) return {};
      const stats: G.Stats = { ...this.baseStats };
      for (const gear of self.equippedGears.values()) {
        if (gear === undefined) continue;
        if (!gear.isFood) {
          for (const stat of Object.keys(gear.stats) as G.Stat[]) {
            const value = stats[stat];
            if (value === undefined) continue;
            stats[stat] = value + gear.stats[stat]!;
          }
        }
      }
      return stats;
    },
    get equippedStats(): G.Stats {
      console.debug('equippedStats');
      if (self.job === undefined) return {};
      const stats = { ...this.equippedStatsWithoutFood };
      for (const slot of ['-1', '-2']) {
        const equippedFood = self.equippedGears.get(slot) as IFood;
        if (equippedFood === undefined) continue;
        for (const stat of Object.keys(this.equippedStatsWithoutFood) as G.Stat[]) {
          stats[stat] += equippedFood.effectiveStats[stat] ?? 0;
        }
      }
      return stats;
    },
    get equippedLevel(): number {
      let level = 0;
      let weight = 0;
      for (const slot of this.schema.slots) {
        level += (self.equippedGears.get(slot.slot)?.level ?? 0) * (slot.levelWeight ?? 1);
        weight += (slot.levelWeight ?? 1);
      }
      return floor(level / weight);
    },
    get isMateriaNamesSameWidth(): boolean {
      let lastWidth = -1;
      for (const gear of self.equippedGears.values()) {
        if (gear === undefined || gear.isFood) continue;
        for (const { name } of gear.materias) {
          if (name.length === 0) continue;
          let width = 0;
          for (let i = 0; i < name.length; i++) {
            width += name.charCodeAt(i) < 0x100 ? 1 : 2;
          }
          if (lastWidth !== -1 && width !== lastWidth) return false;
          lastWidth = width;
        }
      }
      return true;
    },
    get materiaConsumption() {
      const consumption: { [index in G.Stat]?: { [index in G.MateriaGrade]?:
          { safe: number, expectation: number, confidence90: number, confidence99: number, rates: number[] } } } = {};
      for (const gear of self.equippedGears.values()) {
        if (gear === undefined || gear.isFood) continue;
        const duplicates = self.duplicateToolMateria &&
          (gear.slot === 1 || gear.slot === 2) && this.schema.toolMateriaDuplicates || 1;
        for (const materia of gear.materias) {
          if (materia.stat === undefined) continue;
          const consumptionStat = consumption[materia.stat] ??= {};
          const consumptionItem = consumptionStat[materia.grade!] ??=
            { safe: 0, expectation: 0, confidence90: 0, confidence99: 0, rates: [] };
          for (let i = 0; i < duplicates; i++) {
            if (materia.successRate === 100) {
              consumptionItem.safe += 1;
            } else {
              consumptionItem.expectation += 100 / materia.successRate!;
              consumptionItem.rates.push(materia.successRate! / 100);
            }
          }
        }
      }
      let advancedItemCount = 0;
      for (const consumptionOfStat of Object.values(consumption)) {
        for (const consumptionItem of Object.values(consumptionOfStat!)) {
          if (consumptionItem!.rates.length > 0) {
            advancedItemCount++;
          }
        }
      }
      const p90 = .90 ** (1 / advancedItemCount);
      const p99 = .99 ** (1 / advancedItemCount);
      const thresholds90: { pBelow: number, pAbove: number, increase: () => void }[] = [];
      const thresholds99: { pBelow: number, pAbove: number, increase: () => void }[] = [];
      for (const consumptionOfStat of Object.values(consumption)) {
        for (const consumptionItem of Object.values(consumptionOfStat!)) {
          consumptionItem!.expectation = consumptionItem!.safe + Math.round(consumptionItem!.expectation);
          const p = consumptionItem!.rates;
          if (p.length === 0) {
            consumptionItem!.confidence90 = consumptionItem!.confidence99 = consumptionItem!.safe;
            continue;
          }
          const pp: number[][] = p.map(pi => [1, 1 - pi]);  // pp[i][j] = (1 - p[i]) ** j, for caching
          const ps: Float64Array[] = [];  // ps[n][i]: success rate of using n materias to meld slots p[i..]
          let n = 1;
          let n90 = 0;
          while (true) {
            for (let i = 0; i < p.length; i++) {
              pp[i][n] = pp[i][n - 1] * pp[i][1];
            }
            ps[n] = new Float64Array(p.length);
            ps[n][p.length - 1] = 1 - pp[p.length - 1][n];
            for (let i = p.length - 2; i >= 0; i--) {
              if (p.length - i > n) break;
              ps[n][i] = 0;
              for (let j = 1; j <= n - (p.length - i) + 1; j++) {
                ps[n][i] += pp[i][j - 1] * p[i] * ps[n - j][i + 1];
              }
            }
            if (ps[n][0] > p90 && n90 === 0) n90 = n;
            if (ps[n][0] > p99) break;
            n++;
          }
          consumptionItem!.confidence90 = consumptionItem!.safe + n90 - 1;
          consumptionItem!.confidence99 = consumptionItem!.safe + n - 1;
          thresholds90.push({ pBelow: ps[n90 - 1][0], pAbove: ps[n90][0],
            increase: () => consumptionItem!.confidence90++ });
          thresholds99.push({ pBelow: ps[n - 1][0], pAbove: ps[n][0],
            increase: () => consumptionItem!.confidence99++ });
        }
      }
      for (const [ threshold, pTarget ] of [[thresholds90, .90], [thresholds99, .99]] as const) {
        threshold.sort((a, b) => a.pBelow - b.pBelow);
        let pOverall = 1;
        for (const entry of threshold) {
          pOverall *= entry.pBelow;
        }
        for (const entry of threshold) {
          entry.increase();
          pOverall = pOverall / entry.pBelow * entry.pAbove;
          if (pOverall > pTarget) break;
        }
      }
      return consumption;
    },
    get syncLevelText(): number | string | undefined {
      if (self.syncLevel !== undefined) {
        return self.syncLevel.toString();
      }
      if (self.jobLevel !== this.schema.jobLevel) {
        return self.jobLevel + '級';
      }
    },
    get clanText(): string {
      return `${G.races[floor(self.clan / 2)]} - ${G.clans[self.clan]}`;
    },
  }))
  .views(self => ({
    get equippedStatsText(): string {
      let stats = self.schema.stats;
      if (stats[0] === 'STR' || stats[0] === 'DEX') {
        stats = stats.concat('PDMG', 'DLY');
      }
      if (stats[0] === 'INT' || stats[0] === 'MND') {
        stats = stats.concat('MDMG');
      }
      return stats.map(stat => {
        const value = self.equippedStats[stat]!;
        return `${G.statNames[stat]} ${stat !== 'DLY' ? value : (value / 1000).toFixed(2)}`;
      }).join('\n');
    },
    get equippedEffects() {
      console.debug('equippedEffects');
      if (self.job === undefined) return;
      const { statModifiers, mainStat } = self.schema;
      const damageEffects = G.calcDamage(self.job, self.jobLevel, self.equippedStats, self.baseStats);
      if (statModifiers === undefined || mainStat === undefined || damageEffects === undefined) return;
      const levelMod = G.jobLevelModifiers[self.jobLevel];
      const { main, sub, div } = levelMod;
      const { TEN, SKS, SPS, VIT, PIE } = self.equippedStats;
      const { crtChance, crtDamage, detDamage, dhtChance, tenDamage, damage } = damageEffects;
      const tenMitigation = floor(200 * ((TEN ?? sub) - sub) / div) / 1000;
      const gcd = G.calcGcd(self.job, self.jobLevel, (SKS ?? SPS)!);
      const ssDamage = floor(130 * ((SKS ?? SPS)! - sub) / div + 1000) / 1000;
      const hp = levelMod.hp * statModifiers.hp +
        floor((mainStat === 'VIT' ? levelMod.vitTank : levelMod.vit) * (VIT! - main));
      const mp = floor(150 * ((PIE ?? main) - main) / div + 200);
      return { crtChance, crtDamage, detDamage, dhtChance, tenDamage, tenMitigation, damage, gcd, ssDamage, hp, mp };
    },
    get equippedTiers(): { [index in G.Stat]?: { prev: number, next: number } } | undefined {
      const { statModifiers } = self.schema;
      if (statModifiers === undefined) return;
      const { main, sub, div, det, detTrunc } = G.jobLevelModifiers[self.jobLevel];
      const { CRT, DET, DHT, TEN, SKS, SPS, PIE } = self.equippedStats;
      function calcTier(value: number, multiplier: number) {
        if (Number.isNaN(value)) return undefined;
        const quotient = floor(value / multiplier);
        const prev = ceil(quotient * multiplier) - 1 - value;
        const next = ceil((quotient + 1) * multiplier) - value;
        return { prev, next };
      }
      function calcGcdTier(value: number, multiplier: number, modifier: number) {
        if (Number.isNaN(value)) return undefined;
        const gcdc = floor(floor((1000 - floor(value / multiplier)) * 2.5) * modifier);
        const prev = ceil((floor(1000 - ceil((gcdc + 1) / modifier) / 2.5) + 1) * multiplier) - 1 - value;
        const next = ceil((floor(1000 - ceil(gcdc / modifier) / 2.5) + 1) * multiplier) - value;
        return { prev, next };
      }
      return {
        CRT: calcTier(CRT! - sub, div / 200),
        DET: calcTier(DET! - main, det / 140 * detTrunc),
        DHT: calcTier(DHT! - sub, div / 550),
        TEN: calcTier(TEN! - sub, div / 112),
        SKS: calcGcdTier(SKS! - sub, div / 130, (statModifiers.gcd ?? 100) / 1000),
        SPS: calcGcdTier(SPS! - sub, div / 130, (statModifiers.gcd ?? 100) / 1000),
        PIE: calcTier(PIE! - main, div / 150),
      };
    },
    get materiaOptimized() {
      console.debug('materiaOptimized');
      // 配置順序：先以技速／詠速魔晶石達成 GCD 目標，剩餘孔洞依增傷期望最佳化暴擊、信念、直擊的分配
      // 受管理的屬性（暴擊、信念、直擊、技速／詠速）會被重新分配，其他屬性的魔晶石維持不變
      // 禁斷孔數量限制：超出限制的孔洞不參與最佳化，其上受管理屬性的魔晶石會被移除
      type DamageStat = 'CRT' | 'DET' | 'DHT';
      type Triple = [number, number, number];  // CRT, DET, DHT
      interface GearOption { stats: Triple, materiaStats: (G.Stat | undefined)[], distance: number }
      interface Node { stats: Triple, distance: number, prev: number, option: number }
      const damageStats: DamageStat[] = ['CRT', 'DET', 'DHT'];

      const { setting } = self;
      const overmeldLimit = setting.materiaOvermeldLimit;
      const gcdTarget = setting.materiaGcdTarget;
      const speedStat: G.Stat = self.schema.stats.includes('SPS') ? 'SPS' : 'SKS';
      const managedStats: G.Stat[] = [...damageStats, speedStat];
      const isManaged = (stat: G.Stat | undefined) => stat !== undefined && managedStats.includes(stat);
      const isDamageStat = (stat: G.Stat | undefined): stat is DamageStat =>
        stat === 'CRT' || stat === 'DET' || stat === 'DHT';
      const isUsable = (materia: IMateria) => materia.index < materia.gear.materiaSlot + overmeldLimit;
      const originalStatOf = (materia: IMateria) =>
        (self.gears.get(materia.gear.id as any) as IGear).materias[materia.index].stat;

      const gcdOf = (speed: number) => G.calcGcd(self.job!, self.jobLevel, speed);
      const gcdMet = (speed: number) => Math.round(gcdOf(speed) * 100) <= Math.round(gcdTarget * 100);
      const damageOf = ([ CRT, DET, DHT ]: Triple) =>
        G.calcSubStatDamage(self.job!, self.jobLevel, { CRT, DET, DHT }).multiplier;

      let food: IFood | undefined;
      const foodStat = (stat: G.Stat, value: number) => {
        const foodMax = food?.stats?.[stat] ?? 0;
        return foodMax > 0 ? value + Math.min(foodMax, floor(value * (food!.statRates[stat] ?? 0) / 100)) : value;
      };

      const presetMateriaStats = new Map<G.GearId, (G.Stat | undefined)[]>();  // final stats of all equipped gears
      const optionGearIds: G.GearId[] = [];
      const gearOptionsList: GearOption[][] = [];
      const fixedStats: Triple = [
        self.baseStats['CRT'] ?? 0, self.baseStats['DET'] ?? 0, self.baseStats['DHT'] ?? 0,
      ];
      let speedTotal = 0;
      let gcdUnmet = false;

      mobx.runInAction(() => {  // this action only modifies the replica
        const replica = Store.create(mst.getSnapshot(self));
        replica.unprotect();

        const gears: IGear[] = [];
        for (const gear of replica.equippedGears.values()) {
          if (gear === undefined) continue;
          if (gear.isFood) {
            food = gear;
          } else {
            gears.push(gear);
          }
        }
        const gearStatTotal = (stat: G.Stat) =>
          gears.reduce((sum, gear) => sum + (gear.stats[stat] ?? 0), self.baseStats[stat] ?? 0);
        const meldTop = (materia: IMateria, stat: G.Stat) => materia.meld(stat, materia.meldableGrades[0]);
        const valueOf = (materia: IMateria) => G.materias['DET']![materia.meldableGrades[0] - 1];
        // prefer slots which already hold the stat, to minimize materia changes
        const sortSlots = (slots: IMateria[], stat: G.Stat) => slots.slice().sort((a, b) =>
          (b.canRestricted ? 1 : 0) - (a.canRestricted ? 1 : 0) ||
          (originalStatOf(b) === stat ? 1 : 0) - (originalStatOf(a) === stat ? 1 : 0) ||
          a.index - b.index);

        // step 0: clear all managed slots, collect usable slots as the pool
        const pools = new Map<IGear, IMateria[]>();
        for (const gear of gears) {
          const pool: IMateria[] = [];
          for (const materia of gear.materias) {
            if (isManaged(materia.stat) || materia.stat === undefined) {
              materia.meld(undefined);
              if (isUsable(materia) && materia.meldableGrades.length > 0) pool.push(materia);
            }
          }
          pools.set(gear, pool);
        }

        // step 1: meld minimal speed materias to reach the GCD target
        {
          interface Option { slots: IMateria[], gain: number, score: number }
          const gearOptions: Option[][] = [];
          for (const gear of gears) {
            const pool = pools.get(gear)!;
            const majors = sortSlots(pool.filter(m => m.canRestricted), speedStat);
            const minors = sortSlots(pool.filter(m => !m.canRestricted), speedStat);
            const baseSpeed = gear.stats[speedStat] ?? 0;
            const otherCap = damageStats.reduce((sum, s) => sum + Math.max(0, gear.currentMeldableStats[s] ?? 0), 0);
            const poolValue = pool.reduce((sum, m) => sum + valueOf(m), 0);
            const options: Option[] = [];
            for (let k1 = 0; k1 <= majors.length; k1++) {
              for (let k2 = 0; k2 <= minors.length; k2++) {
                const slots = majors.slice(0, k1).concat(minors.slice(0, k2));
                for (const m of slots) meldTop(m, speedStat);
                const gain = (gear.stats[speedStat] ?? 0) - baseSpeed;
                for (const m of slots) m.meld(undefined);
                if (slots.length > 0 && gain <= 0) continue;
                const points = slots.reduce((sum, m) => sum + valueOf(m), 0);
                // cost: potential loss of damage stats on this gear, then materia points as tie-breaker
                const cost = Math.min(poolValue, otherCap) - Math.min(poolValue - points, otherCap);
                options.push({ slots, gain, score: cost * 10000 + points });
              }
            }
            gearOptions.push(options);
          }

          const speedFixed = gearStatTotal(speedStat);
          const maxGain = gearOptions.reduce((sum, options) => sum + Math.max(...options.map(o => o.gain)), 0);
          let required = speedFixed;
          while (required <= speedFixed + maxGain && !gcdMet(foodStat(speedStat, required))) required++;
          let chosen: Option[];
          if (required > speedFixed + maxGain) {
            // GCD target unreachable, meld as much speed as possible
            gcdUnmet = true;
            chosen = gearOptions.map(options => options.reduce((a, b) =>
              b.gain > a.gain || (b.gain === a.gain && b.score < a.score) ? b : a));
          } else {
            const need = required - speedFixed;
            let dp = new Float64Array(need + 1).fill(Infinity);
            dp[0] = 0;
            const back: { prev: Int32Array, option: Int32Array }[] = [];
            for (const options of gearOptions) {
              const next = new Float64Array(need + 1).fill(Infinity);
              const prev = new Int32Array(need + 1).fill(-1);
              const option = new Int32Array(need + 1).fill(-1);
              for (let g = 0; g <= need; g++) {
                if (dp[g] === Infinity) continue;
                options.forEach((o, i) => {
                  const ng = Math.min(need, g + o.gain);
                  if (dp[g] + o.score < next[ng]) {
                    next[ng] = dp[g] + o.score;
                    prev[ng] = g;
                    option[ng] = i;
                  }
                });
              }
              back.push({ prev, option });
              dp = next;
            }
            chosen = [];
            let g = need;
            for (let i = gearOptions.length - 1; i >= 0; i--) {
              chosen[i] = gearOptions[i][back[i].option[g]];
              g = back[i].prev[g];
            }
          }
          gears.forEach((gear, i) => {
            for (const m of chosen[i].slots) meldTop(m, speedStat);
            pools.set(gear, pools.get(gear)!.filter(m => !chosen[i].slots.includes(m)));
          });
        }
        speedTotal = foodStat(speedStat, gearStatTotal(speedStat));

        // step 2: enumerate CRT/DET/DHT assignments of every gear
        // slots of the same kind (major/minor) share the same materia grade, so only the amounts matter
        const splits = (n: number): Triple[] => {
          const ret: Triple[] = [];
          for (let c = 0; c <= n; c++) {
            for (let d = 0; c + d <= n; d++) ret.push([c, d, n - c - d]);
          }
          return ret;
        };
        const assign = (slots: IMateria[], amounts: Triple, result: Map<IMateria, DamageStat>) => {
          const remaining = amounts.slice();
          for (const m of slots) {  // keep original materias as many as possible
            const originalStat = originalStatOf(m);
            if (isDamageStat(originalStat) && remaining[damageStats.indexOf(originalStat)] > 0) {
              result.set(m, originalStat);
              remaining[damageStats.indexOf(originalStat)]--;
            }
          }
          for (const m of slots) {
            if (result.has(m)) continue;
            const i = remaining.findIndex(x => x > 0);
            result.set(m, damageStats[i]);
            remaining[i]--;
          }
        };
        for (const gear of gears) {
          const pool = pools.get(gear)!;
          const preset = gear.materias.map(m => pool.includes(m) ? undefined : m.stat);
          presetMateriaStats.set(gear.id, preset);
          const statsOf = (): Triple => [gear.stats['CRT'] ?? 0, gear.stats['DET'] ?? 0, gear.stats['DHT'] ?? 0];
          if (pool.length === 0) {
            statsOf().forEach((v, i) => { fixedStats[i] += v; });
            continue;
          }
          const majors = pool.filter(m => m.canRestricted);
          const minors = pool.filter(m => !m.canRestricted);
          const options = new Map<string, GearOption>();
          for (const majorAmounts of splits(majors.length)) {
            for (const minorAmounts of splits(minors.length)) {
              const result = new Map<IMateria, DamageStat>();
              assign(majors, majorAmounts, result);
              assign(minors, minorAmounts, result);
              let distance = 0;
              for (const [ m, stat ] of result) {
                meldTop(m, stat);
                const originalStat = originalStatOf(m);
                if (originalStat !== undefined && originalStat !== stat) {
                  distance += 1000 + gear.materias.length - m.index;
                }
              }
              const stats = statsOf();
              const key = stats.join();
              if ((options.get(key)?.distance ?? Infinity) > distance) {
                options.set(key, { stats, distance, materiaStats: gear.materias.map(m => result.get(m) ?? m.stat) });
              }
            }
          }
          for (const m of pool) m.meld(undefined);
          // prune completely inferior options
          const optionList = Array.from(options.values());
          gearOptionsList.push(optionList.filter(o => !optionList.some(o2 => o2 !== o &&
            o2.stats[0] >= o.stats[0] && o2.stats[1] >= o.stats[1] && o2.stats[2] >= o.stats[2] &&
            (o2.stats.join() !== o.stats.join()))));
          optionGearIds.push(gear.id);
        }
      });

      // step 3: combine gears, keeping only the pareto front of total CRT/DET/DHT
      const keyOf = ([ c, d, h ]: Triple) => (c * 16384 + d) * 16384 + h;
      const paretoFront = (nodes: Node[]): Node[] => {
        nodes.sort((a, b) => b.stats[0] - a.stats[0] || b.stats[1] - a.stats[1] || b.stats[2] - a.stats[2]);
        const kept: Node[] = [];
        const stair: { d: number, h: number }[] = [];  // d strictly descending, h strictly ascending
        for (const node of nodes) {
          const [ , d, h ] = node.stats;
          let lo = 0;
          let hi = stair.length;  // first index with stair.d < d
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (stair[mid].d >= d) lo = mid + 1; else hi = mid;
          }
          if (lo > 0 && stair[lo - 1].h >= h) continue;  // dominated
          kept.push(node);
          let end = lo;
          while (end < stair.length && stair[end].h <= h) end++;
          if (lo > 0 && stair[lo - 1].d === d) {  // same d with smaller h, replace it
            stair.splice(lo - 1, end - lo + 1, { d, h });
          } else {
            stair.splice(lo, end - lo, { d, h });
          }
        }
        return kept;
      };
      const layers: Node[][] = [];
      let frontier: Node[] = [{ stats: fixedStats, distance: 0, prev: -1, option: -1 }];
      for (const options of gearOptionsList) {
        const candidates = new Map<number, Node>();
        frontier.forEach((node, prev) => {
          options.forEach((o, option) => {
            const stats: Triple = [
              node.stats[0] + o.stats[0], node.stats[1] + o.stats[1], node.stats[2] + o.stats[2],
            ];
            const key = keyOf(stats);
            const distance = node.distance + o.distance;
            const existing = candidates.get(key);
            if (existing === undefined || existing.distance > distance) {
              candidates.set(key, { stats, distance, prev, option });
            }
          });
        });
        frontier = paretoFront(Array.from(candidates.values()));
        layers.push(frontier);
      }

      // step 4: pick solutions by damage expectation
      const evaluated = frontier.map((node, index) => {
        const stats: Triple = [
          foodStat('CRT', node.stats[0]), foodStat('DET', node.stats[1]), foodStat('DHT', node.stats[2]),
        ];
        return { stats, damage: damageOf(stats), distance: node.distance, index };
      });
      const maxDamage = Math.max(...evaluated.map(e => e.damage));
      const best = new Map<number, typeof evaluated[number]>();
      for (const e of evaluated) {
        if (e.damage < maxDamage * 0.9997) continue;
        const key = keyOf(e.stats);
        if ((best.get(key)?.distance ?? Infinity) > e.distance) best.set(key, e);
      }
      const solutions = Array.from(best.values())
        .sort((a, b) => b.damage - a.damage || a.distance - b.distance)
        .slice(0, 10)
        .map(e => {
          const gearMateriaStats = new Map(presetMateriaStats);
          let index = e.index;
          for (let i = layers.length - 1; i >= 0; i--) {
            const node = layers[i][index];
            gearMateriaStats.set(optionGearIds[i], gearOptionsList[i][node.option].materiaStats);
            index = node.prev;
          }
          const [ CRT, DET, DHT ] = e.stats;
          return { CRT, DET, DHT, damageRatio: e.damage / maxDamage, gearMateriaStats };
        });

      return {
        solutions,
        managedStats,
        speedStat,
        speed: speedTotal,
        gcd: gcdOf(speedTotal),
        gcdUnmet,
      };
    },
    get share(): string {
      if (self.job === undefined) return '';
      const gears: G.Gearset['gears'] = [];
      for (const slot of self.schema.slots) {
        const gear = self.equippedGears.get(slot.slot.toString());
        if (gear === undefined) continue;
        gears.push({
          id: gear.data.id,
          materias: gear.isFood || gear.syncedLevel !== undefined ? [] :
            gear.materias.map(m => m.stat !== undefined ? [m.stat, m.grade!] : null),
          customStats: (gear as IGear).customStats?.toJSON(),
        });
      }
      return share.stringify({
        job: self.job,
        jobLevel: self.jobLevel,
        syncLevel: self.syncLevel,
        gears,
      });
    },
    get shareUrl(): string {
      return window.location.origin + window.location.pathname + '?' + this.share;
    },
    get garlandGroup(): string {
      if (self.job === undefined) return '';
      const parts = [self.schema.name, self.equippedLevel, ' ', (new Date()).toLocaleString(), '{'];
      for (const slot of self.schema.slots) {
        if (slot.slot === 17 || (slot.slot === 2 && self.job === 'FSH')) continue;
        const gear = self.equippedGears.get(slot.slot.toString());
        if (gear === undefined) continue;
        if (gear.data.id === parts.at(-2)) {  // same rings
          parts.splice(-1, 0, '+2');
        } else {
          parts.push('item/');
          parts.push(gear.data.id);
          parts.push('|');
        }
      }
      parts[parts.length - 1] = '}';
      return `#group/${encodeURI(parts.join(''))}`;
    },
    get title(): string | undefined {
      const suffix = '最終幻想14配裝器';
      if (self.job === undefined) return suffix;
      if (self.loadingStatus !== 'ready') return undefined;
      const glance = self.schema.mainStat !== undefined
        ? `il${self.equippedLevel}/${this.equippedEffects.gcd.toFixed(2)}s`
        : self.schema.stats.map(s => self.equippedStats[s]).join('/');
      return `${self.schema.name}(${glance}) - ${suffix}`;
    },
  }))
  .views(self => ({
    /** 無法執行配裝最佳化的原因，可執行時為 undefined */
    get gearOptimizationUnavailableReason(): string | undefined {
      if (self.job === undefined || self.isViewing) return '僅在編輯配裝時可用';
      const { schema } = self;
      if (schema.mainStat === undefined || schema.traitDamageMultiplier === undefined) return '此職業不適用';
      if (self.jobLevel !== schema.jobLevel) return '暫不支援等級同步';
      if (gearDataLoading.get()) return '裝備資料載入中';
      return undefined;
    },
    /** 配裝最佳化的輸入：目前篩選範圍內的裝備與食物，並帶入各裝備實例上已鑲嵌的魔晶石 */
    get gearOptimizationInput(): OptimizerInput {
      const job = self.job!;
      const slotGears = new Map<number, OptimizerGear[]>();
      for (const slot of self.schema.slots) {
        if (slot.slot > 0 || slot.slot === -12) slotGears.set(slot.slot, []);
      }
      const foods: OptimizerInput['foods'] = [];
      for (const id of self.filteredIds) {
        const gear = self.gears.get(id.toString());
        if (gear === undefined || !gearData.has(Math.abs(id))) continue;
        if (!self.isGearShown(gear.data)) continue;  // 只是因為已裝備而顯示的裝備不列入候選
        if (gear.isFood) {
          if (gear.slot === -1) foods.push({ data: gear.data, equipped: gear.isEquipped });
          continue;
        }
        slotGears.get(gear.slot)?.push({
          id: gear.id,
          data: gear.data,
          customStats: gear.customizable ? gear.customStats!.toJSON() : undefined,
          materias: gear.materias.map(m => ({ stat: m.stat, grade: m.grade })),
          equipped: gear.isEquipped,
        });
      }
      // 篩選後沒有任何候選的部位，維持目前的裝備
      for (const [ slot, gears ] of slotGears) {
        const equipped = self.equippedGears.get(slot.toString());
        if (gears.length === 0 && equipped !== undefined && !equipped.isFood) {
          gears.push({
            id: equipped.id,
            data: equipped.data,
            customStats: equipped.customizable ? equipped.customStats!.toJSON() : undefined,
            materias: equipped.materias.map(m => ({ stat: m.stat, grade: m.grade })),
            equipped: true,
          });
        }
      }
      return {
        job,
        jobLevel: self.jobLevel,
        syncLevel: self.syncLevel,
        baseStats: self.baseStats,
        slots: Array.from(slotGears, ([ slot, gears ]) => ({ slot, gears })),
        foods,
        gcdTarget: self.setting.materiaGcdTarget,
        overmeldLimit: self.setting.materiaOvermeldLimit,
      };
    },
  }))
  .actions(self => ({
    createGears(): void {
      console.debug('createGears');
      for (const gearId of self.filteredIds) {
        if (!self.gears.has(gearId.toString())) {
          self.gears.put(GearUnion.create({ id: gearId }));
        }
      }
    },
    setMode(mode: Mode): void {
      self.mode = mode;
    },
    setJob(job: G.Job): void {
      const oldSchema = self.job && G.jobSchemas[self.job];
      const newSchema = G.jobSchemas[job];
      self.job = job;
      if (newSchema.jobLevel !== oldSchema?.jobLevel || !newSchema.levelSyncable) {
        self.jobLevel = newSchema.jobLevel;
        self.syncLevel = undefined;
      }
      if (newSchema.defaultItemLevel !== oldSchema?.defaultItemLevel) {
        self.minLevel = newSchema.defaultItemLevel[0];
        self.maxLevel = newSchema.defaultItemLevel[1];
        self.minLevelIncoming = undefined;
        self.maxLevelIncoming = undefined;
      }
      for (const [ key, gear ] of self.equippedGears.entries()) {
        if (gear !== undefined && !gear.jobs[job]) {
          self.equippedGears.delete(key);
        }
      }
      self.autoSelectScheduled = newSchema.skeletonGears ?? false;
    },
    setMinLevel(level: number): void {
      self.minLevelIncoming = level;
    },
    setMaxLevel(level: number): void {
      self.maxLevelIncoming = level;
    },
    submitIncomingLevels(): void {
      if (self.minLevelIncoming !== undefined) {
        self.minLevel = self.minLevelIncoming;
        self.minLevelIncoming = undefined;
      }
      if (self.maxLevelIncoming !== undefined) {
        self.maxLevel = self.maxLevelIncoming;
        self.maxLevelIncoming = undefined;
      }
    },
    setSyncLevel(level: number | undefined, jobLevel: G.JobLevel | undefined): void {
      self.syncLevel = level;
      self.jobLevel = jobLevel ?? self.schema.jobLevel;
    },
    setFoodMaxLevel(level: number | undefined): void {
      self.foodMaxLevel = level;
    },
    setGearOptimization(state: GearOptimizationState): void {
      self.gearOptimization = state;
    },
    /** Worker 回傳結果時呼叫；若此 Worker 已被取消或被新的執行取代則忽略 */
    finishGearOptimization(worker: Worker, state: GearOptimizationState): void {
      if (self.gearOptimizationWorker !== worker) return;
      worker.terminate();
      self.gearOptimizationWorker = undefined;
      self.gearOptimization = state;
      const run = self.gearOptimizationRun;
      if (run === undefined) return;
      clearTimeout(run.slowTimer);
      run.finishTime = Date.now();
      const elapsed = run.finishTime - run.startTime;
      if (state.status === 'done') {
        if (!run.reported) return;
        const { damage, gcd, gcdUnmet } = state.result;
        sendGearOptimizationReport(run, { kind: 'done', elapsed_ms: elapsed, result: { damage, gcd, gcdUnmet } });
      } else if (state.status === 'error') {
        // 已回報 slow 的計算不再重複附上輸入
        sendGearOptimizationReport(run, { kind: 'error', elapsed_ms: elapsed, error: state.error },
          { withInput: !run.reported });
      }
    },
    setFilterFocus(filterFocus: FilterFocus) {
      self.filterFocus = filterFocus;
    },
    setSourcesHidden(keys: string[], hidden: boolean): void {
      const hiddenSources = new Set(self.hiddenSources);
      for (const key of keys) {
        if (hidden) {
          hiddenSources.add(key);
        } else {
          hiddenSources.delete(key);
        }
      }
      self.hiddenSources.replace(Array.from(hiddenSources));
    },
    showAllSources(): void {
      self.hiddenSources.clear();
    },
    setMateriaOverallActiveTab(activeTab: number) {
      self.materiaOverallActiveTab = activeTab;
    },
    applyMateriaOptimization(
      gearMateriaStats: Map<G.GearId, (G.Stat | undefined)[]>,
      managedStats: G.Stat[],
    ): void {
      for (const [ gearId, materiaStats ] of gearMateriaStats.entries()) {
        const gear = self.gears.get(gearId as any) as IGear;
        for (let i = 0; i < gear.materias.length; i++) {
          const materia = gear.materias[i];
          const stat = materiaStats[i];
          if (stat === undefined) {
            materia.meld(undefined);
          } else if (managedStats.includes(stat)) {
            materia.meld(stat, materia.meldableGrades[0]);
          }
        }
      }
    },
    toggleShowAllMaterias(): void {
      self.showAllMaterias = !self.showAllMaterias;
    },
    toggleShowAllFoods(): void {
      self.showAllFoods = !self.showAllFoods;
    },
    toggleShowAllPotions(): void {
      self.showAllPotions = !self.showAllPotions;
    },
    toggleDuplicateToolMateria(): void {
      self.duplicateToolMateria = !self.duplicateToolMateria;
    },
    startEditing(): void {
      self.mode = 'edit';
      let minLevel = Infinity;
      let maxLevel = -Infinity;
      for (const slot of self.schema.slots) {
        const gear = self.equippedGears.get(slot.slot.toString());
        if (gear !== undefined && slot.levelWeight !== 0 && gear.id !== 17726) {  // 17726: Spearfishing Gig
          if (gear.level < minLevel) minLevel = gear.level;
          if (gear.level > maxLevel) maxLevel = gear.level;
        }
      }
      self.minLevel = minLevel;
      self.maxLevel = maxLevel;
      self.minLevelIncoming = undefined;
      self.maxLevelIncoming = undefined;
    },
    equip(gear: IGearUnion): void {
      const key = gear.slot.toString();
      if (self.equippedGears.get(key) === gear) {
        self.equippedGears.delete(key);
      } else {
        self.equippedGears.set(key, gear);
      }
    },
    setClan(clan: number): void {
      self.clan = clan;
      localStorage.setItem(clanStorageKey, clan.toString());
    },
    toggleTiersShown(): void {
      self.tiersShown = !self.tiersShown;
      localStorage.setItem(tiersShownStorageKey, self.tiersShown.toString());
    },
    autoSelect(): void {
      if (self.loadingStatus === 'loading') return;
      if (!self.autoSelectScheduled) return;
      self.autoSelectScheduled = false;
      for (const [ slot, gears ] of Object.entries(self.groupedGears)) {
        if (self.equippedGears.get(slot) !== undefined) continue;
        let lastMeldable = gears[gears.length - 1];
        if (lastMeldable === undefined || lastMeldable.isFood || lastMeldable.slot === 17) continue;
        for (let i = gears.length - 1; i >= 0; i--) {
          if ((gears[i] as IGear).materiaAdvanced) {
            lastMeldable = gears[i];
            break;
          }
        }
        if (!lastMeldable.isEquipped) {
          this.equip(lastMeldable);
        }
      }
    },
    unprotect(): void {
      mst.unprotect(self);
    },
  }))
  .actions(self => ({
    cancelGearOptimization(): void {
      self.gearOptimizationWorker?.terminate();
      self.gearOptimizationWorker = undefined;
      if (self.gearOptimization.status === 'running') {
        const run = self.gearOptimizationRun;
        if (run !== undefined) {
          clearTimeout(run.slowTimer);
          run.finishTime = Date.now();
          if (run.reported) {
            sendGearOptimizationReport(run, { kind: 'cancelled', elapsed_ms: run.finishTime - run.startTime });
          }
        }
        self.setGearOptimization({ status: 'idle' });
      }
    },
    startGearOptimization(): void {
      if (self.gearOptimizationUnavailableReason !== undefined) return;
      this.cancelGearOptimization();
      const job = self.job!;
      const input = self.gearOptimizationInput;
      const worker = new Worker(new URL('../optimizer.worker.ts', import.meta.url));
      const startTime = Date.now();
      self.gearOptimizationWorker = worker;
      const run: GearOptimizationRun = { id: newOptimizerRunId(), input, startTime };
      self.gearOptimizationRun = run;
      if (optimizerReportEnabled) {
        run.slowTimer = setTimeout(() => {
          if (self.gearOptimizationRun !== run || self.gearOptimization.status !== 'running') return;
          sendGearOptimizationReport(run, { kind: 'slow', elapsed_ms: Date.now() - startTime }, { withInput: true });
        }, SLOW_THRESHOLD);
      }
      self.setGearOptimization({ status: 'running', job, startTime });
      const finish = (state: GearOptimizationState) => self.finishGearOptimization(worker, state);
      worker.onmessage = (e: MessageEvent<{ result?: OptimizerResult, error?: string }>) => {
        const { result, error } = e.data;
        finish(result !== undefined ? { status: 'done', job, result } : { status: 'error', job, error: error! });
      };
      worker.onerror = e => finish({ status: 'error', job, error: e.message || '計算過程發生錯誤' });
      worker.postMessage(input);
    },
    applyGearOptimization(): void {
      const state = self.gearOptimization;
      if (state.status !== 'done' || state.job !== self.job) return;
      const { result } = state;
      const gearMateriaStats = new Map<G.GearId, (G.Stat | undefined)[]>();
      for (const { slot, id, materiaStats } of result.gears) {
        const gear = self.gears.get(id.toString());
        if (gear === undefined) continue;
        self.equippedGears.set(slot.toString(), gear);
        if (materiaStats !== undefined) gearMateriaStats.set(id, materiaStats);
      }
      self.applyMateriaOptimization(gearMateriaStats, result.managedStats);
      if (result.foodId !== undefined) {
        const food = self.gears.get(result.foodId.toString());
        if (food !== undefined) self.equippedGears.set('-1', food);
      }
    },
  }))
  .actions(self => ({
    afterCreate(): void {
      for (const gearId of Object.values(self.equippedGears.toJSON())) {
        loadGearDataOfGearId(Math.abs(gearId as G.GearId));
      }
      self.submitIncomingLevels();  // if user refreshs during appending, we should switch to hard loading
      mobx.autorun(() => loadGearDataOfLevelRange(self.minLevel, self.maxLevel));
      mobx.autorun(() => {
        if (self.minLevelIncoming !== undefined || self.maxLevelIncoming !== undefined) {
          loadGearDataOfLevelRange(
            self.minLevelIncoming ?? self.minLevel,
            self.maxLevelIncoming ?? self.maxLevel,
          );
          mobx.when(() => !gearDataLoading.get(), self.submitIncomingLevels);
        }
      });
      mobx.reaction(() => self.filteredIds, self.createGears, { fireImmediately: true });
      mobx.reaction(() => self.autoSelectScheduled && self.groupedGears, self.autoSelect);
      // 已回報的計算在關閉頁面時仍未完成，補送 abandoned（keepalive 讓請求在頁面關閉後繼續送出）
      window.addEventListener('pagehide', () => {
        const run = self.gearOptimizationRun;
        if (run === undefined || self.gearOptimization.status !== 'running' || !run.reported) return;
        sendGearOptimizationReport(run, { kind: 'abandoned', elapsed_ms: Date.now() - run.startTime },
          { keepalive: true });
      });
    },
  }));

export interface IStore extends mst.Instance<typeof Store> {}
