import { createRoot } from "react-dom/client";

import { UmlDiff } from "./UmlDiff";
import "./uml.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<UmlDiff />);
}
