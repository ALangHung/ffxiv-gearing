import * as mobxReact from 'mobx-react-lite';

declare const __VERSION__: string;
declare const __BUILD_DATE__: number;
declare const __COMMIT__: string;

const repository = 'https://github.com/ALangHung/ffxiv-gearing';
const upstream = 'https://github.com/Asvel/ffxiv-gearing';

// 版本號沿用上游的 CHANGELOG，後面加上本專案的 commit，以區分同一個上游版本下的不同建置
const version = __COMMIT__ ? `${__VERSION__}+${__COMMIT__.slice(0, 7)}` : __VERSION__;

export const About = mobxReact.observer(() => {
  return (
    <div className="about">
      <span className="about_name">最終幻想14配裝器</span>
      <span className="about_version" title={`發布於 ${new Date(__BUILD_DATE__).toLocaleString()}`}>{version}</span>
      <span className="about_separator">·</span>
      <a
        className="about_link"
        href={`${repository}/commits/master`}
        target="_blank"
        children="更新紀錄"
      />
      <span className="about_separator">·</span>
      <a
        className="about_link"
        href={repository}
        target="_blank"
        children="原始碼"
      />
      <span className="about_separator">·</span>
      <a
        className="about_link"
        href={`${repository}/blob/master/LICENSE.txt`}
        target="_blank"
        children="授權條款"
      />
      <span className="about_separator">·</span>
      <a
        className="about_link"
        href={upstream}
        target="_blank"
        children="原作 Asvel"
      />
    </div>
  );
});
