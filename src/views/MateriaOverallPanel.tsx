import * as React from 'react';
import * as mobx from 'mobx';
import * as mobxReact from 'mobx-react-lite';
import classNames from 'clsx';
import { Button } from './@rmwc/button';
import { Tab, TabBar } from './@rmwc/tabs';
import { Switch } from './@rmwc/switch';
import { Badge } from './@rmwc/badge';
import { Radio } from './@rmwc/radio';
import { TextField } from './@rmwc/textfield';
import type { MateriaOvermeldLimit } from '../stores/Setting';
import * as G from '../game';
import { useStore } from './components/contexts';

export const MateriaOverallPanel = mobxReact.observer(() => {
  const store = useStore();
  const materiaDetDhtOptimizationAvailable = !store.isViewing && store.schema.mainStat !== undefined;
  let activeTab = store.materiaOverallActiveTab;
  if (activeTab === 1 && !materiaDetDhtOptimizationAvailable) {
    activeTab = 0;
  }
  return (
    <div className="materia-overall card">
      <div className="materia-overall_tabbar">
        <TabBar
          activeTabIndex={activeTab}
          onActivate={e => {
            store.setMateriaOverallActiveTab(e.detail.index);
            if (activeTab === 1) {
              store.promotion.off('materiaDetDhtOptimization');
            }
          }}
        >
          <Tab>用量預估</Tab>
          {materiaDetDhtOptimizationAvailable && (
            <Tab>
              信念／直擊分配最佳化
              <Badge className="badge-button_badge" exited={!store.promotion.get('materiaDetDhtOptimization')} />
            </Tab>
          )}
        </TabBar>
      </div>
      {activeTab === 0 && (
        <table className="materia-consumption table">
          <thead>
          <tr>
            <th>魔晶石</th>
            <th>安全孔</th>
            <th>期望</th>
            <th>90%*</th>
            <th>99%*</th>
          </tr>
          </thead>
          <tbody>
          {(() => {
            const ret = [];
            const stats = store.schema.stats.filter(stat => stat in store.materiaConsumption);
            for (const stat of stats) {
              for (const grade of G.materiaGrades) {
                const consumptionItem = store.materiaConsumption[stat]![grade];
                if (consumptionItem === undefined) continue;
                ret.push((
                  <tr key={stat + grade}>
                    <td>{G.getMateriaName(stat, grade, store.setting.materiaDisplayName === 'stat')}</td>
                    <td>{consumptionItem.safe}</td>
                    <td>{consumptionItem.expectation}</td>
                    <td>{consumptionItem.confidence90}</td>
                    <td>{consumptionItem.confidence99}</td>
                  </tr>
                ));
              }
            }
            return ret;
          })()}
          {Object.keys(store.materiaConsumption).length === 0 && (
            <tr className="materia-consumption_empty">
              <td colSpan={5}>未鑲嵌魔晶石</td>
            </tr>
          )}
          <tr className="materia-consumption_tip">
            <td colSpan={5}>
              *以此整體成功率完成全部鑲嵌所需的數量
              {store.schema.toolMateriaDuplicates! > 1 && (
                <div
                  className={classNames(
                    'materia-consumption_tool-duplicates',
                    !store.duplicateToolMateria && '-disabled',
                  )}
                >
                  {`主副手的用量按照${store.schema.toolMateriaDuplicates}套計算`}
                  <Switch
                    className="materia-consumption_tool-duplicates-switch"
                    checked={store.duplicateToolMateria}
                    onChange={store.toggleDuplicateToolMateria}
                  />
                </div>
              )}
            </td>
          </tr>
          </tbody>
        </table>
      )}
      {activeTab === 1 && (
        <MateriaDetDhtOptimization />
      )}
    </div>
  );
});

const overmeldLimitOptions: { value: MateriaOvermeldLimit, label: string }[] = [
  { value: 5, label: '滿禁斷' },
  { value: 2, label: '禁斷+2' },
  { value: 1, label: '禁斷+1' },
  { value: 0, label: '不禁斷' },
];

const MateriaGcdInput = mobxReact.observer(() => {
  const store = useStore();
  const value = store.setting.materiaGcdTarget;
  const [ inputValue, setInputValue ] = React.useState(value.toFixed(2));
  const [ prevValue, setPrevValue ] = React.useState(value);
  if (value !== prevValue) {
    setInputValue(value.toFixed(2));
    setPrevValue(value);
  }
  const submit = () => {
    const parsed = Number(inputValue);
    const gcd = Number.isFinite(parsed) && parsed > 0 ? Math.min(2.5, Math.max(1.5, Math.round(parsed * 100) / 100)) : value;
    setInputValue(gcd.toFixed(2));
    if (gcd !== value) store.setting.setMateriaGcdTarget(gcd);
  };
  return (
    <TextField
      className="materia-det-dht-optimization_gcd-input mdc-text-field--compact"
      type="number"
      step="0.01"
      min="1.5"
      max="2.5"
      value={inputValue}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInputValue(e.target.value)}
      onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.select()}
      onBlur={submit}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
});

const MateriaDetDhtOptimization = mobxReact.observer(() => {
  const store = useStore();
  const { materiaOvermeldLimit: overmeldLimit, materiaGcdTarget: gcdTarget } = store.setting;
  const result = React.useMemo(
    () => mobx.untracked(() => store.materiaOptimized),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overmeldLimit, gcdTarget],
  );
  const { solutions, managedStats, speedStat } = result;
  const speedName = G.statNames[speedStat];
  const { equippedStats } = store;
  return (
    <div className="materia-det-dht-optimization">
      <div className="materia-det-dht-optimization_introduce">
        <p>{`根據增傷期望自動配置魔晶石：先以${speedName}魔晶石達成 GCD 目標，剩餘孔洞最佳化暴擊、信念、直擊的分配。`}</p>
        <p>{'直擊屬性對必定直擊型技能的固定增傷量與對一般技能的期望增傷量有小幅差距，' +
            '必定暴擊型技能與暴擊、直擊類團隊輔助也會影響屬性收益，這些因素未納入考量。'}</p>
        <p>{`選取的裝備中，已鑲嵌暴擊、信念、直擊、${speedName}魔晶石的孔洞和空置的孔洞將被視為可使用孔洞，` +
            '每個可使用孔洞都會鑲嵌此孔洞可鑲嵌的最高等級魔晶石，其他魔晶石維持不變。'}</p>
        <p>禁斷孔數量限制每件裝備最多使用幾個禁斷孔，使用方案時超出限制的禁斷孔上，上述屬性的魔晶石將被移除。</p>
      </div>
      <div className="materia-det-dht-optimization_option">
        <span className="materia-det-dht-optimization_option-title">GCD</span>
        <MateriaGcdInput />
        <span className="materia-det-dht-optimization_option-sub">
          {`${speedName}魔晶石只鑲嵌到 GCD 不高於此數值所需的量`}
        </span>
      </div>
      <div className="materia-det-dht-optimization_option">
        <span className="materia-det-dht-optimization_option-title">禁斷孔</span>
        {overmeldLimitOptions.map(({ value, label }) => (
          <Radio
            key={value}
            label={label}
            checked={overmeldLimit === value}
            onChange={() => store.setting.setMateriaOvermeldLimit(value)}
          />
        ))}
      </div>
      <div className={classNames('materia-det-dht-optimization_summary', result.gcdUnmet && '-warning')}>
        {`${speedName} ${result.speed}　GCD ${result.gcd.toFixed(2)}`}
        {result.gcdUnmet && <div>{`即使全部可使用孔洞都鑲嵌${speedName}魔晶石，仍無法達到 GCD ${gcdTarget.toFixed(2)}`}</div>}
      </div>
      <table className="materia-det-dht-optimization_solutions table">
        <thead>
        <tr>
          <th>暴擊</th>
          <th>信念</th>
          <th>直擊</th>
          <th>增傷差距</th>
          <th style={{ width: '99%' }} />
        </tr>
        </thead>
        <tbody>
        {solutions.map((solution, i) => (
          <tr key={i}>
            <td>{solution.CRT}</td>
            <td>{solution.DET}</td>
            <td>{solution.DHT}</td>
            <td>{i === 0 ? '最佳' : `${((solution.damageRatio - 1) * 100).toFixed(3)}%`}</td>
            <td>
              {(solution.CRT === equippedStats['CRT'] && solution.DET === equippedStats['DET'] &&
                solution.DHT === equippedStats['DHT'] && result.speed === equippedStats[speedStat]) ? (
                '已使用此方案'
              ) : (
                <Button
                  className="materia-det-dht-optimization_use-solution"
                  onClick={() => store.applyMateriaOptimization(solution.gearMateriaStats, managedStats)}
                  children="使用此方案"
                />
              )}
            </td>
          </tr>
        ))}
        </tbody>
      </table>
      <div className="materia-det-dht-optimization_tip">
        方案依增傷期望由高到低排序，最多列出差距小於萬分之三的前 10 個方案。
      </div>
    </div>
  );
});
