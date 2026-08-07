import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { applyRuntimeProductTitle } from "./utils/runtimeConfig";

applyRuntimeProductTitle();
const app = mount(App, { target: document.getElementById("app")! });

export default app;
