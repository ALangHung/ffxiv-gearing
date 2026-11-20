import * as React from 'react';
import * as mobx from 'mobx';
import * as mobxReact from 'mobx-react-lite';
import classNames from 'clsx';
import { Button } from './@rmwc/button';
import { TextField } from './@rmwc/textfield';
import { Badge } from './@rmwc/badge';
import { useStore } from './components/contexts';
import { RippleLazy } from './components/RippleLazy';
import { Icon } from './components/Icon';
import { Dropdown } from './components/Dropdown';
import { BadgeButton } from './components/BadgeButton';
import { JobSelector } from './JobSelector';
import { FilterPanel } from './FilterPanel';
import { SourceFilterPanel } from './SourceFilterPanel';
import { LevelSyncPanel } from './LevelSyncPanel';
import { MateriaOverallPanel } from './MateriaOverallPanel';
import { SharePanel } from './SharePanel';
import { ImportPanel } from './ImportPanel';
import { SettingPanel } from './SettingPanel';

declare const __PATCH__: string;

export const Condition = mobxReact.observer(() => {
  const store = useStore();
  const welcoming = store.job === undefined;
  const editing = !store.isViewing && store.job !== undefined;
  const viewing = store.isViewing && store.job !== undefined;
  return (
    <div className="condition card" style={store.job === undefined ? { width: '900px' } : {}}>
      {welcoming && (
        <span className="condition_job -empty">選擇一個職業開始配裝</span>
      )}
      {welcoming && (
        <a
          className={classNames('condition_tip', store.promotion.get('legacyLink') && '-highlight')}
          href="./ew/"
          children="此工具已適用《黃金遺產》資料片，如需使用《曉月之終途》版本請點擊此處"
          onClick={store.promotion.get('legacyLink') ? () => store.promotion.off('legacyLink') : undefined}
          onMouseLeave={store.promotion.get('legacyLink') ? () => store.promotion.off('legacyLink') : undefined}
        />
      )}
      {editing && (
        <Dropdown
          label={({ ref, toggle }) => (
            <RippleLazy>
              <span ref={ref} className="condition_job" onClick={toggle}>
                <Icon className="condition_job-icon" name={'jobs/' + store.job} />
                <span className="condition_job-name">{store.schema.name}</span>
              </span>
            </RippleLazy>
          )}
          popper={() => (
            <div className="job-select-panel card">
              <JobSelector />
              <div className="job-select-panel_tip">
                以滑鼠中鍵點擊職業（或右鍵選單－在新分頁中開啟連結）可新增一份空白配裝
              </div>
            </div>
          )}
          placement="bottom-start"
          modifiers={[{ name: 'offset', options: { offset: [-4, 0] } }]}
        />
      )}
      {viewing && (
        <span className="condition_job">
          <Icon className="condition_job-icon" name={'jobs/' + store.job} />
          <span className="condition_job-name">{store.schema.name}</span>
        </span>
      )}
      {editing && <span className="condition_divider" />}
      {editing && (
        <span className="condition_level">
          <span className="condition_level-value">
            <ConditionLevelInput
              value={store.minLevel}
              onChange={value => store.setMinLevel(value)}
            />
            <span className="condition_level-separator">-</span>
            <ConditionLevelInput
              value={store.maxLevel}
              onChange={value => store.setMaxLevel(value)}
            />
          </span>
          品級
        </span>
      )}
      {editing && (
        <Dropdown
          label={({ ref, toggle }) => (
            <Button ref={ref} className="condition_button condition_source-filter" onClick={toggle}>
              裝備來源
              {store.hiddenGearCount > 0 && (
                <span className="condition_source-filter-hidden">{`隱藏 ${store.hiddenGearCount}`}</span>
              )}
            </Button>
          )}
          popper={SourceFilterPanel}
          placement="bottom-start"
        />
      )}
      {editing && (
        <Dropdown
          label={({ ref, toggle }) => (
            <BadgeButton
              ref={ref}
              className="condition_button condition_filter"
              promotion="filter"
              onClick={toggle}
              children="篩選"
            />
          )}
          popper={FilterPanel}
          placement="bottom-start"
        />
      )}
      {(editing || viewing) && <span className="condition_divider" />}
      {viewing && store.schema.levelSyncable && store.syncLevelText !== undefined && (
        <>
          <span className="condition_text">
            <Icon className="condition_level-sync-icon" name="sync" />
            {store.syncLevelText}
          </span>
          <span className="condition_divider" />
        </>
      )}
      {editing && store.schema.levelSyncable && (
        <Dropdown
          label={({ ref, toggle }) => (
            <Button ref={ref} className="condition_button" onClick={toggle}>
              {store.syncLevelText !== undefined && <Icon className="condition_level-sync-icon" name="sync" />}
              {store.syncLevelText ?? '品級同步'}
            </Button>
          )}
          popper={LevelSyncPanel}
          placement="bottom-start"
        />
      )}
      {(editing || viewing) && (
        <Dropdown
          label={({ ref, toggle }) => (
            <Button ref={ref} className="condition_button badge-button" onClick={toggle}>
              最佳化
              <Badge
                className="badge-button_badge"
                exited={store.isViewing || !store.promotion.get('materiaDetDhtOptimization')}
              />
            </Button>
          )}
          popper={MateriaOverallPanel}
          placement="bottom-start"
        />
      )}
      {editing && (
        <span className="condition_level condition_food-level" title="食物只列出此品級以下的項目，配裝最佳化也只會從中挑選">
          食物上限
          <span className="condition_level-value">
            <FoodMaxLevelInput />
          </span>
          品級
        </span>
      )}
      <span className="condition_right">
        {editing && (
          <Dropdown
            label={({ ref, toggle }) => (
              <Button ref={ref} className="condition_button" onClick={toggle}>分享</Button>
            )}
            popper={SharePanel}
            placement="bottom-end"
          />
        )}
        {(welcoming || editing) && (
          <Dropdown
            label={({ ref, toggle }) => (
              <Button ref={ref} className="condition_button" onClick={toggle}>匯入</Button>
            )}
            popper={ImportPanel}
            placement="bottom-end"
          />
        )}
        {viewing && (
          <Button
            className="condition_button"
            onClick={() => {
              store.startEditing();
              window.history.pushState(null, document.title, window.location.href.replace(/\?.*$/, ''));
            }}
            children="編輯"
          />
        )}
        {(editing || viewing) && (
          <Dropdown
            label={({ ref, toggle }) => (
              <Button ref={ref} className="condition_button condition_setting" onClick={toggle}>設定</Button>
            )}
            popper={SettingPanel}
            placement="bottom-end"
          />
        )}
        <span className="condition_divider" />
        <span className="condition_text">資料版本 {__PATCH__}</span>
      </span>
      {welcoming && <JobSelector />}
      {welcoming && (
        <a
          href="https://www.bilibili.com/video/BV1pt4y1W7pX"
          title="【影片】如何自行配裝？高難度副本配裝原理詳解"
          target="_blank"
        >
          <img
            className="condition_welcome-promotion"
            src={require('../../img/BV1pt4y1W7pX.png')}
            srcSet={require('../../img/BV1pt4y1W7pX@2x.png') + ' 2x'}
            alt=""
          />
        </a>
      )}
    </div>
  );
});

const ConditionLevelInput = (() => {
  let anyInstanceFocused = false;
  let delayedChange: Function | null = null;
  return mobxReact.observer<{
    value: number,
    onChange: (value: number) => void,
  }>(({ value, onChange }) => {
    const [ inputValue, setInputValue ] = React.useState(value.toString());
    const [ prevValue, setPrevValue ] = React.useState(value);
    if (value !== prevValue) {
      setInputValue(value.toString());
      setPrevValue(value);
    }
    const inputRef = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
      const handleWheel = (e: WheelEvent) => {
        e.preventDefault();
        if (e.deltaY !== 0) {
          (e.target as HTMLInputElement).focus();
          const delta = e.deltaY < 0 ? 5 : -5;
          setInputValue(v => (parseInt(v, 10) + delta).toString());
        }
      };
      const input = inputRef.current!;
      input.addEventListener('wheel', handleWheel, { passive: false });
      return () => input.removeEventListener('wheel', handleWheel);
    }, []);
    const handleChange = () => onChange(parseInt(inputValue, 10) || 0);
    return (
      <TextField
        inputRef={inputRef}
        className="condition_level-input mdc-text-field--compact"
        type="number"
        step="5"
        value={inputValue}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          setInputValue(e.target.value);
        }}
        onFocus={e => {
          e.target.select();
          anyInstanceFocused = true;
        }}
        onBlur={() => {
          setTimeout(() => {
            if (!anyInstanceFocused) {
              mobx.runInAction(() => {
                delayedChange?.();
                delayedChange = null;
                handleChange();
              });
            } else {
              delayedChange = handleChange;
            }
          }, 0);
          anyInstanceFocused = false;
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    );
  });
})();

const FoodMaxLevelInput = mobxReact.observer(() => {
  const store = useStore();
  const value = store.foodMaxLevel;
  const [ inputValue, setInputValue ] = React.useState(value?.toString() ?? '');
  const [ prevValue, setPrevValue ] = React.useState(value);
  if (value !== prevValue) {
    setInputValue(value?.toString() ?? '');
    setPrevValue(value);
  }
  const submit = () => {
    const parsed = parseInt(inputValue, 10);
    const level = parsed > 0 ? parsed : undefined;
    setInputValue(level?.toString() ?? '');
    if (level !== value) store.setFoodMaxLevel(level);
  };
  return (
    <TextField
      className="condition_level-input condition_food-level-input mdc-text-field--compact"
      type="number"
      step="5"
      placeholder="不限"
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
