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
import type { IGear } from '../stores';
import { useStore } from './components/contexts';

export const MateriaOverallPanel = mobxReact.observer(() => {
  const store = useStore();
  const materiaDetDhtOptimizationAvailable = !store.isViewing && store.schema.mainStat !== undefined;
  let activeTab = store.materiaOverallActiveTab;
  if (activeTab >= 1 && !materiaDetDhtOptimizationAvailable) {
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
          {materiaDetDhtOptimizationAvailable && <Tab>配裝最佳化</Tab>}
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
      {activeTab === 2 && (
        <GearOptimization />
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

const GearOptimization = mobxReact.observer(() => {
  const store = useStore();
  const { gearOptimization: state, schema } = store;
  const overmeldLimit = store.setting.materiaOvermeldLimit;
  const unavailableReason = store.gearOptimizationUnavailableReason;
  const speedStat: G.Stat = schema.stats.includes('SPS') ? 'SPS' : 'SKS';
  const speedName = G.statNames[speedStat];
  const running = state.status === 'running';
  const [ now, setNow ] = React.useState(Date.now());
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  const result = state.status === 'done' && state.job === store.job ? state.result : undefined;
  const currentDamage = store.equippedEffects?.damage;
  const useStatName = store.setting.materiaDisplayName === 'stat';
  const applied = result !== undefined &&
    result.gears.every(({ slot, id }) => store.equippedGears.get(slot.toString())?.id === id) &&
    (result.foodId === undefined || store.equippedGears.get('-1')?.id === result.foodId) &&
    currentDamage === result.damage;
  return (
    <div className="materia-det-dht-optimization gear-optimization">
      <div className="materia-det-dht-optimization_introduce">
        <p>在目前的品級範圍、裝備來源篩選與食物品級上限內，自動選擇裝備、魔晶石與食物，找出每威力傷害期望最高的配置。</p>
        <p>{`魔晶石只鑲嵌暴擊、信念、直擊與${speedName}（${speedName}只鑲嵌到達成 GCD 目標所需的量），不鑲嵌堅韌；` +
            '裝備上已鑲嵌的其他屬性魔晶石維持不變。'}</p>
        <p>幻境武器的自訂屬性不參與最佳化，沿用已填入的數值。品級範圍較寬且 GCD 目標較低時計算量較大，可能需要數秒。</p>
      </div>
      <div className="materia-det-dht-optimization_option">
        <span className="materia-det-dht-optimization_option-title">GCD</span>
        <MateriaGcdInput />
        <span className="materia-det-dht-optimization_option-sub">與信念／直擊分配最佳化共用此設定</span>
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
      <div className="materia-det-dht-optimization_option gear-optimization_actions">
        {running ? (
          <>
            <span className="gear-optimization_running">
              {`處理中…（已經過 ${Math.max(0, Math.floor((now - state.startTime) / 1000))} 秒）`}
            </span>
            <Button className="gear-optimization_button" onClick={store.cancelGearOptimization} children="取消" />
          </>
        ) : (
          <Button
            className="gear-optimization_button"
            raised
            disabled={unavailableReason !== undefined}
            onClick={store.startGearOptimization}
            children="開始最佳化"
          />
        )}
        {!running && unavailableReason !== undefined && (
          <span className="materia-det-dht-optimization_option-sub">{unavailableReason}</span>
        )}
      </div>
      {state.status === 'error' && state.job === store.job && (
        <div className="materia-det-dht-optimization_summary -warning">{`最佳化失敗：${state.error}`}</div>
      )}
      {result !== undefined && (
        <>
          <div className={classNames('materia-det-dht-optimization_summary', result.gcdUnmet && '-warning')}>
            {`每威力傷害期望 ${result.damage.toFixed(2)}`}
            {currentDamage !== undefined && !applied && (
              <span className="gear-optimization_compare">
                {`（目前 ${currentDamage.toFixed(2)}，${result.damage >= currentDamage ? '+' : ''}` +
                  `${((result.damage / currentDamage - 1) * 100).toFixed(2)}%）`}
              </span>
            )}
            <div className="gear-optimization_stats">
              {`暴擊 ${result.stats['CRT']}　信念 ${result.stats['DET']}　直擊 ${result.stats['DHT']}　` +
                `${speedName} ${result.stats[speedStat] ?? '-'}　GCD ${result.gcd.toFixed(2)}`}
            </div>
            {result.gcdUnmet && (
              <div>
                {`在目前的篩選範圍內無法達到 GCD ${store.setting.materiaGcdTarget.toFixed(2)}，已改為${speedName}最大化的配置`}
              </div>
            )}
          </div>
          <table className="gear-optimization_gears table">
            <tbody>
            {schema.slots.map(({ slot, name }) => {
              if (slot === -1) {
                const food = result.foodId === undefined ? undefined : store.gears.get(result.foodId.toString());
                return (
                  <tr key={slot}>
                    <td className="gear-optimization_slot">{name}</td>
                    <td colSpan={2}>{food?.name ?? '-'}</td>
                  </tr>
                );
              }
              const item = result.gears.find(g => g.slot === slot);
              if (item === undefined) return null;
              const gear = store.gears.get(item.id.toString()) as IGear | undefined;
              if (gear === undefined) return null;
              const materias = gear.materias.map((materia, i) => {
                const stat = item.materiaStats === undefined ? materia.stat : item.materiaStats[i];
                if (stat === undefined) return undefined;
                const grade = item.materiaStats !== undefined && result.managedStats.includes(stat) ?
                  G.materiaTopGrade(gear.data, i) : materia.grade;
                return grade === undefined ? undefined : G.getMateriaName(stat, grade, useStatName);
              }).filter(Boolean);
              return (
                <tr key={slot}>
                  <td className="gear-optimization_slot">{name}</td>
                  <td className={classNames('gear-optimization_gear', gear.isEquipped && '-equipped')}>
                    {gear.name}
                  </td>
                  <td className="gear-optimization_materias">{materias.join(' ')}</td>
                </tr>
              );
            })}
            </tbody>
          </table>
          <div className="materia-det-dht-optimization_tip gear-optimization_footer">
            <span>{`計算耗時 ${(result.elapsed / 1000).toFixed(1)} 秒，結果依執行當時的條件計算。`}</span>
            {applied ? (
              <span className="gear-optimization_applied">已套用此配置</span>
            ) : (
              <Button
                className="gear-optimization_button"
                raised
                onClick={store.applyGearOptimization}
                children="套用此配置"
              />
            )}
          </div>
        </>
      )}
    </div>
  );
});
