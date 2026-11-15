import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  readonly label: string;
  run(): void;
}

export interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly title?: string;
  readonly items: readonly MenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    setAt({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
    });
    element.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="viz-pop viz-context-menu"
      role="menu"
      aria-label={menu.title ?? "Diagram"}
      style={{ left: at.x, top: at.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = [...(ref.current?.querySelectorAll("button") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          buttons[(index + step + buttons.length) % buttons.length]?.focus();
        }
      }}
    >
      {menu.title && <div className="viz-pop__head viz-context-menu__title">{menu.title}</div>}
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="viz-context-menu__item"
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
