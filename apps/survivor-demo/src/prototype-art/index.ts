import { runShowcase } from "./showcase";
// PROTOTYPE (#24 art): the entry's hook. With ?art, the demo draws with that variant and shows
// the switcher bar (dev builds only); with &showcase, it shows a crowded fight instead of the app.
import { mountSwitcher } from "./switcher";
import { currentVariant, isShowcase } from "./variants";

export { currentVariant } from "./variants";

/** Returns true when the showcase replaces the app. */
export const startArtPrototype = (): boolean => {
  if (!import.meta.env.DEV || currentVariant === undefined) {
    return false;
  }
  mountSwitcher(currentVariant);
  if (isShowcase) {
    void runShowcase(currentVariant);
    return true;
  }
  return false;
};
