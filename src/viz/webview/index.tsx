import { createRoot } from "react-dom/client";

import "@xyflow/react/dist/style.css";
import "./base.css";
import { App } from "./App";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
