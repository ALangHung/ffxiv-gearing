import * as mst from 'mobx-state-tree';

type GearDisplayName = 'name' | 'source';
type GearColorScheme = 'source' | 'rarity' | 'none';
type MateriaDisplayName = 'stat' | 'materia';
type AppTheme = 'light' | 'light-hs' | 'dark';
// 信念／直擊最佳化時可使用的禁斷孔數量，5 表示全部禁斷孔（滿禁斷）
export type MateriaOvermeldLimit = 0 | 1 | 2 | 5;

const storageKey = 'ffxiv-gearing.dt.setting';

export const Setting = mst.types
  .model({
    gearDisplayName: mst.types.optional(mst.types.string as mst.ISimpleType<GearDisplayName>, 'name'),
    gearColorScheme: mst.types.optional(mst.types.string as mst.ISimpleType<GearColorScheme>, 'source'),
    materiaDisplayName: mst.types.optional(mst.types.string as mst.ISimpleType<MateriaDisplayName>, 'stat'),
    displayMeldedStats: mst.types.optional(mst.types.boolean, true),
    hideObsoleteGears: mst.types.optional(mst.types.boolean, true),
    appTheme: mst.types.optional(mst.types.string as mst.ISimpleType<AppTheme>, 'light'),
    materiaOvermeldLimit: mst.types.optional(mst.types.number as mst.ISimpleType<MateriaOvermeldLimit>, 5),
    materiaGcdTarget: mst.types.optional(mst.types.number, 2.5),
    // 生產／採集職業魔晶石最佳化的目標數值（含食物、藥品加成），未設定的屬性不要求
    materiaStatTargets: mst.types.optional(mst.types.map(mst.types.number), {}),
  })
  .actions(self => ({
    afterCreate(): void {
      const snapshot = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      if (snapshot.highSaturation) {  // TODO: remove this when switch to next storageKey
        snapshot.appTheme = 'light-hs';
      }
      mst.applySnapshot(self, snapshot);
      mst.onSnapshot(self, snapshot => localStorage.setItem(storageKey, JSON.stringify(snapshot)));
    },
    setGearDisplayName(gearDisplayName: GearDisplayName): void {
      self.gearDisplayName = gearDisplayName;
    },
    setGearColorScheme(gearColorScheme: GearColorScheme): void {
      self.gearColorScheme = gearColorScheme;
    },
    setMateriaDisplayName(materiaDisplayName: MateriaDisplayName): void {
      self.materiaDisplayName = materiaDisplayName;
    },
    setDisplayMeldedStats(displayMeldedStats: boolean): void {
      self.displayMeldedStats = displayMeldedStats;
    },
    setHideObsoleteGears(hideObsoleteGears: boolean): void {
      self.hideObsoleteGears = hideObsoleteGears;
    },
    setAppTheme(appTheme: AppTheme): void {
      self.appTheme = appTheme;
    },
    setMateriaOvermeldLimit(materiaOvermeldLimit: MateriaOvermeldLimit): void {
      self.materiaOvermeldLimit = materiaOvermeldLimit;
    },
    setMateriaGcdTarget(materiaGcdTarget: number): void {
      self.materiaGcdTarget = materiaGcdTarget;
    },
    setMateriaStatTarget(stat: string, value: number | undefined): void {
      if (value === undefined) {
        self.materiaStatTargets.delete(stat);
      } else {
        self.materiaStatTargets.set(stat, value);
      }
    },
  }));

export interface ISetting extends mst.Instance<typeof Setting> {}
