/**
 * Mega menu category rail.
 * Hovering (or focusing) a category on the left swaps the product preview on the right.
 */
(() => {
  const ACTIVE = 'is-active';

  const activate = (root, index) => {
    root.querySelectorAll('[data-shop-mega-trigger]').forEach((trigger) => {
      trigger.classList.toggle(ACTIVE, trigger.dataset.shopMegaTrigger === index);
    });
    root.querySelectorAll('[data-shop-mega-panel]').forEach((panel) => {
      panel.classList.toggle(ACTIVE, panel.dataset.shopMegaPanel === index);
    });
  };

  const bind = (root) => {
    if (root.dataset.shopMegaBound === 'true') return;
    root.dataset.shopMegaBound = 'true';

    const triggers = root.querySelectorAll('[data-shop-mega-trigger]');
    if (!triggers.length) return;

    const defaultIndex = triggers[0].dataset.shopMegaTrigger;

    triggers.forEach((trigger) => {
      const index = trigger.dataset.shopMegaTrigger;
      trigger.addEventListener('pointerenter', () => activate(root, index));
      trigger.addEventListener('focus', () => activate(root, index));
    });

    // Reset to the first category once the menu closes so it always opens consistently.
    const submenu = root.closest('.menu-list__submenu');
    const item = submenu?.closest('.menu-list__list-item');
    item?.addEventListener('pointerleave', () => activate(root, defaultIndex));
  };

  const bindAll = () => document.querySelectorAll('[data-shop-mega]').forEach(bind);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAll);
  } else {
    bindAll();
  }

  // The header can be re-rendered by the Section Rendering API.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      bindAll();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
