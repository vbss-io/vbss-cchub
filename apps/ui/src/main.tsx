import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Toaster } from "./components/Toaster";
import { Widget } from "./components/Widget";
import "./styles.css";
import "./responsive.css";
import "./toaster.css";

document.documentElement.dataset.theme = localStorage.getItem("hub.theme") === "midnight" ? "midnight" : "dracula";
const params = new URLSearchParams(location.search);
const isWidget = params.get("widget") === "1";
const isToast = params.get("toast") === "1";
if (isToast) document.documentElement.classList.add("toast-window");
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>{isWidget ? <Widget /> : isToast ? <Toaster /> : <App />}</StrictMode>,
  );
}

if (!isWidget && !isToast && "__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<string>("hub:navigate", (event) => {
      location.hash = event.payload;
    });
  });
}
