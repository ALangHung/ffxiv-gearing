import * as mobxReact from 'mobx-react-lite';
import { Radio } from './@rmwc/radio';
import { useStore } from './components/contexts';

export const FilterPanel = mobxReact.observer(() => {
  const store = useStore();
  return (
    <div className="filter card">
      <div className="filter_section">
        <span className="filter_title">「聚焦」模式</span>
        <span className="filter_sub">隱藏大部分裝備，比較其中幾件</span>
      </div>
      <div className="filter_controls">
        <Radio
          label="不啟用"
          checked={store.filterFocus === 'no'}
          onChange={() => store.setFilterFocus('no')}
        />
        <Radio
          label="只顯示鑲嵌了魔晶石的裝備和已選取的裝備"
          checked={store.filterFocus === 'melded'}
          onChange={() => store.setFilterFocus('melded')}
        />
        <Radio
          label="只顯示鑲嵌了魔晶石的裝備，並隱藏僅有一件裝備可選擇的部位"
          checked={store.filterFocus === 'comparable'}
          onChange={() => store.setFilterFocus('comparable')}
        />
      </div>
    </div>
  );
});
