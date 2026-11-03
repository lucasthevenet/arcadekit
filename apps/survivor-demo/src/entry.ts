import "./app/style.css";
import { Runtime } from "foldkit";

import {
  Model,
  init,
  resources,
  subscriptions,
  update,
  view,
} from "./app/main";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  resources,
  container: document.querySelector("#root")!,
});

Runtime.run(application);
