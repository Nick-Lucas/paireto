const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const ZOOM_KEY = isMac ? "Meta" : "Control";

export const ZOOM_KEY_LABEL = isMac ? "⌘" : "Ctrl";
