import * as mobxReact from 'mobx-react-lite';
import { Radio } from './@rmwc/radio';
import { useStore } from './components/contexts';

export const SettingPanel = mobxReact.observer(() => {
  const store = useStore();
  return (
    <div className="setting card">
      <div className="setting_section">
        <span className="setting_title">主題</span>
        <span className="setting_sub">如果醒目標示的顏色難以辨識，可以選用高飽和主題</span>
      </div>
      <div className="setting_controls">
        <Radio
          label="淺色"
          checked={store.setting.appTheme === 'light'}
          onChange={() => store.setting.setAppTheme('light')}
        />
        <Radio
          label="淺色（高飽和）"
          checked={store.setting.appTheme === 'light-hs'}
          onChange={() => store.setting.setAppTheme('light-hs')}
        />
        <Radio
          label="深色"
          checked={store.setting.appTheme === 'dark'}
          onChange={() => store.setting.setAppTheme('dark')}
        />
      </div>
      <div className="setting_section">
        <span className="setting_title">裝備名稱顯示方式</span>
        <span className="setting_sub">國服尚未實裝的裝備一律顯示為取得途徑</span>
      </div>
      <div className="setting_controls">
        <Radio
          label="顯示裝備名稱"
          checked={store.setting.gearDisplayName === 'name'}
          onChange={() => store.setting.setGearDisplayName('name')}
        />
        <Radio
          label="顯示取得途徑"
          checked={store.setting.gearDisplayName === 'source'}
          onChange={() => store.setting.setGearDisplayName('source')}
        />
      </div>
      <div className="setting_section">
        <span className="setting_title">裝備顏色配置</span>
      </div>
      <div className="setting_controls">
        <Radio
          label="區分競品"
          checked={store.setting.gearColorScheme === 'source'}
          onChange={() => store.setting.setGearColorScheme('source')}
        />
        <Radio
          label="依稀有度上色"
          checked={store.setting.gearColorScheme === 'rarity'}
          onChange={() => store.setting.setGearColorScheme('rarity')}
        />
        <Radio
          label="不上色"
          checked={store.setting.gearColorScheme === 'none'}
          onChange={() => store.setting.setGearColorScheme('none')}
        />
      </div>
      <div className="setting_section">
        <span className="setting_title">魔晶石顯示方式</span>
      </div>
      <div className="setting_controls">
        <Radio
          label="顯示增益的屬性"
          checked={store.setting.materiaDisplayName === 'stat'}
          onChange={() => store.setting.setMateriaDisplayName('stat')}
        />
        <Radio
          label="顯示魔晶石本身的名稱"
          checked={store.setting.materiaDisplayName === 'materia'}
          onChange={() => store.setting.setMateriaDisplayName('materia')}
        />
      </div>
      <div className="setting_section">
        <span className="setting_title">顯示包含魔晶石增益的裝備屬性</span>
      </div>
      <div className="setting_controls">
        <Radio
          label="是，顯示實際生效的屬性"
          checked={store.setting.displayMeldedStats}
          onChange={() => store.setting.setDisplayMeldedStats(true)}
        />
        <Radio
          label="否，顯示裝備的原始屬性"
          checked={!store.setting.displayMeldedStats}
          onChange={() => store.setting.setDisplayMeldedStats(false)}
        />
      </div>
      <div className="setting_section">
        <span className="setting_title">隱藏已廢棄的裝備</span>
        <span className="setting_sub">部分粉色稀有度的裝備、未強化的舊點數裝備</span>
      </div>
      <div className="setting_controls">
        <Radio
          label="隱藏"
          checked={store.setting.hideObsoleteGears}
          onChange={() => store.setting.setHideObsoleteGears(true)}
        />
        <Radio
          label="顯示"
          checked={!store.setting.hideObsoleteGears}
          onChange={() => store.setting.setHideObsoleteGears(false)}
        />
      </div>
    </div>
  );
});
