import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Widget } from "./components/Widget";
import "./styles.css";

const isWidget = new URLSearchParams(location.search).get("widget") === "1";
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>{isWidget ? <Widget /> : <App />}</StrictMode>,
  );
}
