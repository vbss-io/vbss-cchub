import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Widget } from "./components/Widget";
import "./styles.css";
import "./responsive.css";

document.documentElement.dataset.theme = localStorage.getItem("hub.theme") === "midnight" ? "midnight" : "dracula";
const isWidget = new URLSearchParams(location.search).get("widget") === "1";
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>{isWidget ? <Widget /> : <App />}</StrictMode>,
  );
}

if (!isWidget && "__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<string>("hub:navigate", (event) => {
      location.hash = event.payload;
    });
  });
}
