// The default theme with the site's colours. custom.css is imported after the theme, so that
// its variables win over the theme's own.
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";

import "./custom.css";

export default { extends: DefaultTheme } satisfies Theme;
