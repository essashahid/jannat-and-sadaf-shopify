/**
 * Jannat & Sadaf — collection page entrance animations.
 * Motion One driven (Framer Motion vanilla sibling). Cards visible on
 * load animate in immediately; cards below the fold reveal on inView.
 * A 3s safety net force-shows any card that didn't animate, so products
 * can never get stuck invisible.
 */
(async function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!document.querySelector('.product-grid-container')) return;

  const html = document.documentElement;

  let motion;
  try {
    motion = await import('https://cdn.jsdelivr.net/npm/motion@10.18.0/+esm');
  } catch (err) {
    html.classList.remove('is-animating');
    return;
  }

  window.__motionReady = true;
  const { animate, inView, spring } = motion;

  // ---------- Collection heading & description ----------
  const heading =
    document.querySelector('.section h1') ||
    document.querySelector('.shopify-section h1');
  const description = heading
    ? heading.closest('.section')?.querySelector('p, .rte')
    : null;

  if (heading) {
    animate(
      heading,
      { opacity: [0, 1], y: [16, 0] },
      { duration: 0.9, easing: [0.22, 1, 0.36, 1] }
    );
  }
  if (description && description !== heading) {
    animate(
      description,
      { opacity: [0, 1], y: [12, 0] },
      { duration: 0.9, easing: [0.22, 1, 0.36, 1], delay: 0.15 }
    );
  }

  // ---------- Filter / sort bar ----------
  const filterRows = document.querySelectorAll(
    '.facets, .facets-wrapper, .facet-filters, [data-filters], .product-count, .facets__product-count, .facet-filters__sort'
  );
  filterRows.forEach((row, i) => {
    animate(
      row,
      { opacity: [0, 1], y: [10, 0] },
      { duration: 0.7, easing: [0.22, 1, 0.36, 1], delay: 0.25 + i * 0.05 }
    );
  });

  // ---------- Product cards ----------
  function animateCard(card, idx) {
    const staggerDelay = (idx % 4) * 0.06;
    animate(
      card,
      { opacity: [0, 1], y: [22, 0] },
      {
        duration: 1,
        easing: spring({ stiffness: 85, damping: 19, mass: 0.85 }),
        delay: staggerDelay,
      }
    );
    const img = card.querySelector('img');
    if (img) {
      animate(
        img,
        { clipPath: ['inset(0 100% 0 0)', 'inset(0 0 0 0)'] },
        {
          duration: 1.1,
          easing: [0.65, 0, 0.35, 1],
          delay: staggerDelay + 0.1,
        }
      );
    }
  }

  function setupCard(card, idx) {
    if (card.dataset.animated === 'true') return;
    card.dataset.animated = 'true';
    const rect = card.getBoundingClientRect();
    const inViewportNow = rect.top < window.innerHeight && rect.bottom > 0;
    if (inViewportNow) {
      animateCard(card, idx);
    } else {
      inView(
        card,
        () => animateCard(card, idx),
        { amount: 0.05 }
      );
    }
  }

  const cards = document.querySelectorAll('.product-grid__item');
  cards.forEach((card, i) => setupCard(card, i));

  // Watch for cards added by infinite scroll / filter changes
  const grid =
    document.querySelector('.product-grid') ||
    document.querySelector('results-list') ||
    document.querySelector('.collection-wrapper');
  if (grid) {
    const mo = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.addedNodes.forEach((node) => {
          if (
            node.nodeType === 1 &&
            node.classList &&
            node.classList.contains('product-grid__item')
          ) {
            setupCard(node, 0);
          }
        });
      });
    });
    mo.observe(grid, { childList: true, subtree: true });
  }

  // Safety net: 3s after load, force-reveal any card still hidden
  setTimeout(() => {
    document.querySelectorAll('.product-grid__item').forEach((card) => {
      if (card.dataset.animated !== 'true') {
        card.style.opacity = '1';
        card.style.transform = 'none';
        const img = card.querySelector('img');
        if (img) img.style.clipPath = 'inset(0 0 0 0)';
      }
    });
  }, 3000);
})();
