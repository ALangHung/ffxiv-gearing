import * as mobxReact from 'mobx-react-lite';
import classNames from 'clsx';
import * as G from '../game';
import type { IGear } from '../stores';
import { Dropdown } from './components/Dropdown';

/** 幻境武器最終階段的屬性分配（兩大一小），放在沒有魔晶石孔的魔晶石欄位 */
export const RelicAllocation = mobxReact.observer<{ gear: IGear }>(({ gear }) => {
  const rule = gear.relicRule!;
  const complete = G.isRelicComplete(rule, gear.customStats!.toJSON());
  return (
    <Dropdown
      label={({ ref, expanded, toggle }) => (
        <span
          ref={ref}
          className={classNames('gears_relic', !complete && '-incomplete', expanded && '-active')}
          onClick={toggle}
          children={complete ? '調整屬性分配' : '分配屬性（兩大一小）'}
        />
      )}
      popper={() => <RelicPanel gear={gear} rule={rule} />}
      placement="bottom-start"
    />
  );
});

const RelicPanel = mobxReact.observer<{ gear: IGear, rule: G.RelicRule }>(({ gear, rule }) => {
  const customStats = gear.customStats!.toJSON();
  return (
    <table className="materias relic-panel table card">
      <tbody>
      {rule.stats.map(stat => {
        const tier = G.relicTierOf(rule, stat, customStats[stat]);
        return (
          <tr key={stat} className="materias_row">
            <td className="materias_stat-name">{G.statNames[stat]}</td>
            {(['large', 'small', undefined] as const).map(option => (
              <td
                key={option ?? 'none'}
                className={classNames('materias_grade', tier === option && '-selected')}
                onClick={() => gear.setRelicTier(stat, option)}
                children={option === 'large' ? rule.large[stat] : option === 'small' ? rule.small : '不選'}
              />
            ))}
          </tr>
        );
      })}
      <tr>
        <td className="relic-panel_tip" colSpan={4}>選兩種屬性為大、一種為小，超出時取代最早選的</td>
      </tr>
      </tbody>
    </table>
  );
});
