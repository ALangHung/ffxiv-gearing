import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as mobxReact from 'mobx-react-lite';
import * as PopperJS from '@popperjs/core';

export interface DropdownLabelProps {
  ref: (ref: HTMLElement | null) => void;
  expanded: boolean;
  toggle: () => void;
}

export interface DropdownPopperProps {
  toggle: () => void;
  labelElement: HTMLElement | null;
}

export interface DropdownProps {
  label: React.FunctionComponent<DropdownLabelProps>;
  popper: React.FunctionComponent<DropdownPopperProps>;
  placement: PopperJS.Placement;
  modifiers?: PopperJS.StrictModifiers[];
  strategy?: PopperJS.PositioningStrategy;
}

export const Dropdown = mobxReact.observer<DropdownProps>(props => {
  const [ expanded, setExpanded ] = React.useState(false);
  const [ labelElement, setLabelElement ] = React.useState<HTMLElement | null>(null);
  const toggle = React.useCallback((e?: UIEvent) => {
    setExpanded(expanded => !expanded);
    if (e) {
      e.stopPropagation();
    }
  }, []);
  return (
    <>
      {props.label({
        ref: setLabelElement,
        expanded,
        toggle,
      })}
      {expanded && (
        <DropdownPopper
          {...props}
          setExpanded={setExpanded}
          labelElement={labelElement}
          toggle={toggle}
        />
      )}
    </>
  );
});

const DropdownPopper = mobxReact.observer<DropdownProps & {
  setExpanded: (expanded: boolean) => void;
  labelElement: HTMLElement | null;
  toggle: () => void;
}>(props => {
  const { popper, placement, modifiers=[], strategy='absolute', setExpanded, labelElement, toggle } = props;
  const [ popperOptions ] = React.useState({ placement, modifiers, strategy });
  const [ popperElement, setPopperElement ] = React.useState<HTMLElement | null>(null);
  const popperContainer = document.getElementById('popper');
  React.useLayoutEffect(() => {
    if (labelElement === null || popperElement === null) return;
    // 固定在畫面上的按鈕（如上方導航列）展開的彈窗改用 fixed 定位：
    // absolute 定位的彈窗捲動時會先隨頁面移動，再由 popper 重新定位回按鈕下方，造成抖動
    const sticky = popperOptions.strategy !== 'fixed' && hasStickyAncestor(labelElement);
    if (popperOptions.strategy !== 'fixed' && !sticky) {
      popperOptions.modifiers.push({ name: 'flip', options: { padding: { bottom: 50 } }});
    }
    const popperInstance = PopperJS.createPopper(labelElement, popperElement,
      sticky ? { ...popperOptions, strategy: 'fixed' } : popperOptions);
    if (sticky) {
      // 高於導航列（.condition 的 z-index: 7），彈窗不會被導航列蓋住；其他 absolute 彈窗捲動時則會被導航列蓋住
      popperElement.style.zIndex = '8';  // for search: z-index: 8;
    } else if (popperOptions.strategy === 'fixed') {
      popperElement.style.zIndex = '7';  // for search: z-index: 7;
    }
    return () => popperInstance.destroy();
  }, [labelElement, popperElement, popperOptions]);
  React.useEffect(() => {
    onGlobalClick = e => {
      const target = e.target as Element;
      if (target && labelElement && popperElement) {
        if (!labelElement.contains(target) && !popperElement.contains(target)) {
          setExpanded(false);
          onGlobalClick = undefined;
          (e as any)._isClosingDropdown = true;
        }
      }
    };
    onGlobalKeyup = e => {
      const target = e.target as Element;
      // label (比如是一个 button) 有可能成为按键事件的 target
      if (target && (target.tagName === 'BODY' || target === labelElement) && e.key === 'Escape') {
        setExpanded(false);
        onGlobalKeyup = undefined;
      }
    };
  }, [labelElement, popperElement, setExpanded]);
  React.useEffect(() => () => {
    onGlobalClick = undefined;
    onGlobalKeyup = undefined;
  }, []);
  return popperContainer && ReactDOM.createPortal((
    <div
      ref={setPopperElement}
      onClick={e => e.stopPropagation()}
      children={React.createElement(popper, { toggle, labelElement })}
    />
  ), popperContainer);
});

function hasStickyAncestor(element: HTMLElement) {
  for (let e: HTMLElement | null = element; e !== null; e = e.parentElement) {
    if (getComputedStyle(e).position === 'sticky') return true;
  }
  return false;
}

let onGlobalClick: ((e: MouseEvent) => void) | undefined;
window.addEventListener('click', e => onGlobalClick?.(e), true);
let onGlobalKeyup: ((e: KeyboardEvent) => void) | undefined;
window.addEventListener('keyup', e => onGlobalKeyup?.(e), true);
