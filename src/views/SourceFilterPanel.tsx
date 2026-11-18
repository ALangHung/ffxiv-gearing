import * as React from 'react';
import * as mobxReact from 'mobx-react-lite';
import classNames from 'clsx';
import { Button } from './@rmwc/button';
import { useStore } from './components/contexts';

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
  const [ collapsed, setCollapsed ] = React.useState<{ [group: string]: boolean }>({});
  return (
    <div className="source-filter card">
      <div className="source-filter_header">
        <span className="source-filter_title">裝備來源</span>
        <span className="source-filter_sub">取消勾選的來源，其裝備將不會顯示於下方列表（已選取的裝備除外）</span>
      </div>
      <div className="source-filter_actions">
        <Button
          className="source-filter_action"
          disabled={store.hiddenSources.length === 0}
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
          onClick={() => setCollapsed(Object.fromEntries(groups.map(g => [g.group, true])))}
          children="全部收合"
        />
      </div>
      <div className="source-filter_groups">
        {groups.length === 0 && (
          <div className="source-filter_empty">目前品級範圍內沒有可篩選的裝備</div>
        )}
        {groups.map(({ group, label, sources }) => {
          const keys = sources.map(s => s.key);
          const shownCount = keys.filter(key => !hidden.has(key)).length;
          const isCollapsed = collapsed[group] ?? false;
          return (
            <div key={group} className="source-filter_group">
              <div className="source-filter_group-header">
                <Checkbox
                  className="source-filter_group-checkbox"
                  checked={shownCount === keys.length}
                  indeterminate={shownCount > 0 && shownCount < keys.length}
                  onChange={() => store.setSourcesHidden(keys, shownCount === keys.length)}
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
                  {sources.map(({ key, source, count }) => (
                    <Checkbox
                      key={key}
                      checked={!hidden.has(key)}
                      onChange={checked => store.setSourcesHidden([key], !checked)}
                    >
                      {source || '未知來源'}
                      <span className="source-filter_count">{count}</span>
                    </Checkbox>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
