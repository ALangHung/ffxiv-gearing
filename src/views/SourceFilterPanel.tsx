import * as React from 'react';
import * as mobxReact from 'mobx-react-lite';
import classNames from 'clsx';
import { Button } from './@rmwc/button';
import { useStore } from './components/contexts';
import type { SourceFilterSource } from '../stores/Store';

const Checkbox = ({ checked, indeterminate, onChange, className, children }: {
  checked: boolean,
  indeterminate?: boolean,
  onChange: (checked: boolean) => void,
  className?: string,
  children: React.ReactNode,
}) => {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    ref.current!.indeterminate = indeterminate ?? false;
  }, [indeterminate]);
  return (
    <label className={classNames('source-filter_checkbox', className, !checked && !indeterminate && '-off')}>
      <input ref={ref} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {children}
    </label>
  );
};

export const SourceFilterPanel = mobxReact.observer(() => {
  const store = useStore();
  const groups = store.sourceFilterGroups;
  const hidden = store.hiddenSourceSet;
  const hiddenGears = store.hiddenGearSet;
  const [ collapsed, setCollapsed ] = React.useState<{ [group: string]: boolean }>({});
  const [ expanded, setExpanded ] = React.useState<{ [key: string]: boolean }>({});
  /** 來源中目前顯示的裝備數 */
  const shownGearCountOf = ({ key, gears }: SourceFilterSource) =>
    hidden.has(key) ? 0 : gears.filter(gear => !hiddenGears.has(gear.id)).length;
  return (
    <div className="source-filter card">
      <div className="source-filter_header">
        <span className="source-filter_title">裝備來源</span>
        <span className="source-filter_sub">取消勾選的來源或裝備將不會顯示於下方列表（已選取的裝備除外），點選來源右側的箭頭可展開個別裝備</span>
      </div>
      <div className="source-filter_actions">
        <Button
          className="source-filter_action"
          disabled={store.hiddenSources.length === 0 && store.hiddenGears.length === 0}
          onClick={store.showAllSources}
          children="全部顯示"
        />
        <Button
          className="source-filter_action"
          onClick={() => store.setSourcesHidden(groups.flatMap(g => g.sources.map(s => s.key)), true)}
          children="全部隱藏"
        />
        <Button
          className="source-filter_action"
          disabled={groups.every(g => collapsed[g.group])}
          onClick={() => setCollapsed(Object.fromEntries(groups.map(g => [g.group, true])))}
          children="全部收合"
        />
        <Button
          className="source-filter_action"
          disabled={!groups.some(g => collapsed[g.group])}
          onClick={() => setCollapsed({})}
          children="全部展開"
        />
      </div>
      <div className="source-filter_groups">
        {groups.length === 0 && (
          <div className="source-filter_empty">目前品級範圍內沒有可篩選的裝備</div>
        )}
        {groups.map(({ group, label, sources }) => {
          const keys = sources.map(s => s.key);
          const shownGearCounts = sources.map(shownGearCountOf);
          const shownCount = shownGearCounts.filter(count => count > 0).length;
          const allShown = sources.every((source, i) => shownGearCounts[i] === source.count);
          const isCollapsed = collapsed[group] ?? false;
          return (
            <div key={group} className="source-filter_group">
              <div className="source-filter_group-header">
                <Checkbox
                  className="source-filter_group-checkbox"
                  checked={allShown}
                  indeterminate={shownCount > 0 && !allShown}
                  onChange={() => store.setSourcesHidden(keys, allShown)}
                >
                  {label}
                </Checkbox>
                <span
                  className="source-filter_group-toggle"
                  onClick={() => setCollapsed({ ...collapsed, [group]: !isCollapsed })}
                >
                  {`${shownCount}/${keys.length}`}
                  <span className={classNames('source-filter_group-arrow', isCollapsed && '-collapsed')}>▾</span>
                </span>
              </div>
              {!isCollapsed && (
                <div className="source-filter_sources">
                  {sources.map(sourceItem => {
                    const { key, source, count, gears } = sourceItem;
                    const shownGearCount = shownGearCountOf(sourceItem);
                    const isExpanded = expanded[key] ?? false;
                    return (
                      <div key={key} className={classNames('source-filter_source', isExpanded && '-expanded')}>
                        <div className="source-filter_source-header">
                          <Checkbox
                            checked={shownGearCount === count}
                            indeterminate={shownGearCount > 0 && shownGearCount < count}
                            onChange={() => store.setSourcesHidden([key], shownGearCount === count)}
                          >
                            {source || '未知來源'}
                          </Checkbox>
                          <span
                            className="source-filter_source-toggle"
                            title={isExpanded ? '收合裝備' : '展開裝備'}
                            onClick={() => setExpanded({ ...expanded, [key]: !isExpanded })}
                          >
                            {shownGearCount === count ? count : `${shownGearCount}/${count}`}
                            <span className={classNames('source-filter_group-arrow', !isExpanded && '-collapsed')}>▾</span>
                          </span>
                        </div>
                        {isExpanded && (
                          <div className="source-filter_gears">
                            {gears.map(gear => (
                              <Checkbox
                                key={gear.id}
                                className="source-filter_gear"
                                checked={!hidden.has(key) && !hiddenGears.has(gear.id)}
                                onChange={checked => store.setGearHidden(gear.id, !checked)}
                              >
                                <span className="source-filter_gear-name">{gear.name}</span>
                                <span className="source-filter_count">{`IL${gear.level}`}</span>
                              </Checkbox>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
