import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Toaster } from "./components/Toaster";
import { Widget } from "./components/Widget";
import { reportUiDiag } from "./api";
import { bridgeNavigation, prepareDocument } from "./boot";
import "./styles.css";
import "./responsive.css";
import "./nav-rail.css";
import "./toaster.css";

const flags = prepareDocument(window, document, reportUiDiag);
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>{flags.widget ? <Widget /> : flags.toast ? <Toaster /> : <App />}</StrictMode>,
  );
}

bridgeNavigation(window, flags, () => import("@tauri-apps/api/event").then((module) => module.listen));
