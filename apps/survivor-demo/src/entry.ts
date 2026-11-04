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
import { startArtPrototype } from "./prototype-art";

// PROTOTYPE (#24 art): ?art=<key>&showcase shows a crowded fight instead of the app.
if (!startArtPrototype()) {
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
}
