import { createRoot } from "react-dom/client";

import { App } from "./App";
import "@xyflow/react/dist/style.css";
import "./viz.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
