// Entry point for the Welcome React webview. Bundled by esbuild (browser/iife) to dist/welcome.js and
// loaded by WelcomePanel.html().
import { createRoot } from "react-dom/client";

import { Welcome } from "./Welcome";
import "./welcome.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Welcome />);
}
