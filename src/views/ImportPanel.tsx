import * as mobxReact from 'mobx-react-lite';

export const ImportPanel = mobxReact.observer(() => {
  return (
    <div className="import card">
      <div className="import_title">使用方法：</div>
      <div>將下方的連結加入瀏覽器書籤（較方便的方式是將下方連結拖曳至書籤列），</div>
      <div>然後開啟想匯入的配裝所在的頁面，點擊此書籤。</div>
      <a
        ref={r => r?.setAttribute('href', encodeURI(
          `javascript:void(document.body.appendChild(document.createElement('script')).src='`
          + window.location.origin + window.location.pathname + `import.js?'+Math.random())`))}
        className="import_bookmarklet"
        onClick={e => e.preventDefault()}
        children="匯入配裝"
      />
      <div className="import_title">目前支援從以下配裝器匯入：</div>
      <div>Ariyala&apos;s Final Fantasy XIV Toolkit (ffxiv.ariyala.com)</div>
      <div>FF14俺tools：装備シミュレータ (ffxiv.es.exdreams.net)</div>
      <div>Etro (etro.gg)</div>
      <div>FFXIV Teamcraft (ffxivteamcraft.com)</div>
      <div>XivGear (xivgear.app)</div>
      <div className="import_warn">此功能可能因上述網站的設計變動而失效，如果無法使用請回報。</div>
    </div>
  );
});
