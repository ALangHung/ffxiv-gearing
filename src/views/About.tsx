import * as mobxReact from 'mobx-react-lite';

declare const __VERSION__: string;
declare const __BUILD_DATE__: number;

export const About = mobxReact.observer(() => {
  return (
    <div className="about">
      <span className="about_name">最終幻想14配裝器</span>
      <span className="about_version" title={`發布於 ${new Date(__BUILD_DATE__).toLocaleString()}`}>{__VERSION__}</span>
      <span className="about_separator">·</span>
      <a
        className="about_link"
        href="https://github.com/Asvel/ffxiv-gearing/blob/master/CHANGELOG.md"
        target="_blank"
        children="更新紀錄"
      />
      <span className="about_separator">·</span>
      <a
        className="about_link"
        href="https://github.com/Asvel/ffxiv-gearing#license"
        target="_blank"
        children="授權條款"
      />
      <span className="about_separator">·</span>
      <a
        className="about_link"
        href="https://github.com/Asvel/ffxiv-gearing"
        target="_blank"
        children="原始碼"
      />
    </div>
  );
});
