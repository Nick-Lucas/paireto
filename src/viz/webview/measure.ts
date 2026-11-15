import { FONT_SIZES, type FontRole, type Measure } from "../layout/measure";

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

function fontFor(role: FontRole): string {
  const ui = cssVar("--vscode-font-family", "system-ui, sans-serif");
  const code = cssVar("--vscode-editor-font-family", "Menlo, Monaco, monospace");
  switch (role) {
    case "title":
      return `600 ${FONT_SIZES.title}px ${ui}`;
    case "code":
      return `400 ${FONT_SIZES.code}px ${code}`;
    case "small":
      return `400 ${FONT_SIZES.small}px ${ui}`;
    case "smallBold":
      return `600 ${FONT_SIZES.smallBold}px ${ui}`;
  }
}

export function createMeasure(): Measure {
  const context = document.createElement("canvas").getContext("2d");
  const fonts = new Map<FontRole, string>();
  const cache = new Map<string, number>();
  return (text, role) => {
    const key = `${role}\u0000${text}`;
    const known = cache.get(key);
    if (known !== undefined) {
      return known;
    }
    let font = fonts.get(role);
    if (!font) {
      font = fontFor(role);
      fonts.set(role, font);
    }
    let width = text.length * FONT_SIZES[role] * 0.62;
    if (context) {
      context.font = font;
      width = context.measureText(text).width;
    }
    const rounded = Math.ceil(width + 1);
    cache.set(key, rounded);
    return rounded;
  };
}
