// PROTOTYPE (#24 art): the floating bar that switches art variants. Dev builds only.
import { ART_VARIANTS } from "./variants";
import type { ArtVariant } from "./variants";

const go = (variant: ArtVariant) => {
  const url = new URL(window.location.href);
  url.searchParams.set("art", variant.key);
  window.location.replace(url);
};

export const mountSwitcher = (current: ArtVariant) => {
  const index = ART_VARIANTS.indexOf(current);
  const step = (by: number) =>
    go(ART_VARIANTS[(index + by + ART_VARIANTS.length) % ART_VARIANTS.length]!);

  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:999px;background:#fff;color:#111;font:600 13px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45);max-width:calc(100vw - 32px)";
  const button = (label: string, by: number) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "border:0;background:#111;color:#fff;border-radius:999px;width:28px;height:28px;cursor:pointer;font:inherit";
    b.addEventListener("click", () => step(by));
    return b;
  };
  const label = document.createElement("span");
  label.textContent = `${current.key.toUpperCase()} (${current.name})`;
  label.style.cssText =
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  bar.append(button("←", -1), label, button("→", 1));
  document.body.append(bar);

  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest("input, textarea, [contenteditable]") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    if (event.key === "[") {
      step(-1);
    } else if (event.key === "]") {
      step(1);
    }
  });
};
