/**
 * Jannat & Sadaf — premium homepage animations powered by Motion One.
 * Hero word reveal, magnetic CTAs, section fade-ups, image wipes.
 * Loads Motion One via CDN ESM. Inline init script in the section adds
 * `.is-animating` to <html> synchronously so initial hidden states apply
 * before paint; this script flips `window.__motionReady` once the lib
 * loads so the FOUC fallback timer doesn't strip the class.
 */
(async function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!document.querySelector('.sakatelier-home')) return;

  const html = document.documentElement;

  let motion;
  try {
    motion = await import('https://cdn.jsdelivr.net/npm/motion@10.18.0/+esm');
  } catch (err) {
    html.classList.remove('is-animating');
    return;
  }

  window.__motionReady = true;
  const { animate, inView, stagger, spring } = motion;

  // ---------- Hero word reveal + supporting elements ----------
  const heroHeading = document.querySelector('.sak-hero__heading');
  const heroLabel = document.querySelector('.sak-hero__label');
  const heroSub = document.querySelector('.sak-hero__sub');
  const heroActions = document.querySelector('.sak-hero__actions');
  const heroLink = document.querySelector('.sak-hero__link');

  function splitWords(el) {
    const text = el.textContent.trim();
    if (!text) return [];
    const words = text.split(/\s+/);
    el.innerHTML = words
      .map((w) => `<span class="reveal-word"><span>${w}</span></span>`)
      .join(' ');
    return Array.from(el.querySelectorAll('.reveal-word > span'));
  }

  function playHero() {
    if (heroLabel) {
      animate(
        heroLabel,
        { opacity: [0, 1], y: [14, 0] },
        { duration: 0.9, easing: [0.22, 1, 0.36, 1] }
      );
    }
    if (heroHeading) {
      const wordEls = splitWords(heroHeading);
      if (wordEls.length) {
        animate(
          wordEls,
          { y: ['110%', '0%'] },
          {
            duration: 1.1,
            easing: spring({ stiffness: 70, damping: 17, mass: 0.9 }),
            delay: stagger(0.08, { start: 0.1 }),
          }
        );
      }
    }
    if (heroSub) {
      animate(
        heroSub,
        { opacity: [0, 1], y: [14, 0] },
        { duration: 0.9, easing: [0.22, 1, 0.36, 1], delay: 0.6 }
      );
    }
    if (heroActions) {
      animate(
        heroActions,
        { opacity: [0, 1], y: [14, 0] },
        { duration: 0.9, easing: [0.22, 1, 0.36, 1], delay: 0.8 }
      );
    }
    if (heroLink) {
      animate(
        heroLink,
        { opacity: [0, 1], y: [14, 0] },
        { duration: 0.9, easing: [0.22, 1, 0.36, 1], delay: 0.45 }
      );
    }
  }

  playHero();

  // Re-trigger hero reveal on slide change (the hero JS swaps heading text)
  if (heroHeading) {
    let lastText = heroHeading.textContent;
    const mo = new MutationObserver(() => {
      // Skip mutations caused by our own splitWords innerHTML write
      if (heroHeading.querySelector('.reveal-word')) return;
      const text = heroHeading.textContent;
      if (text !== lastText) {
        lastText = text;
        // Reset visibility states before replay
        [heroLabel, heroSub, heroActions].forEach((el) => {
          if (el) el.style.opacity = '0';
        });
        playHero();
      }
    });
    mo.observe(heroHeading, { childList: true, characterData: true, subtree: true });
  }

  // ---------- Magnetic CTAs with spring physics ----------
  document.querySelectorAll('.sak-hero__actions .sak-btn').forEach((btn) => {
    btn.addEventListener('mousemove', (e) => {
      const rect = btn.getBoundingClientRect();
      const x = (e.clientX - rect.left - rect.width / 2) * 0.22;
      const y = (e.clientY - rect.top - rect.height / 2) * 0.22;
      animate(
        btn,
        { x, y },
        { easing: spring({ stiffness: 260, damping: 18, mass: 0.5 }) }
      );
    });
    btn.addEventListener('mouseleave', () => {
      animate(
        btn,
        { x: 0, y: 0 },
        { easing: spring({ stiffness: 200, damping: 22, mass: 0.6 }) }
      );
    });
  });

  // ---------- Section reveal on scroll ----------
  const fadeSelectors = [
    '.sak-tiles .sak-head',
    '.sak-tiles__card',
    '.sak-products .sak-head',
    '.sak-spotlight__media',
    '.sak-spotlight__content',
    '.sak-craft__media',
    '.sak-craft__content',
    '.sak-bts .sak-head',
    '.sak-bts__figure',
    '.sak-journal .sak-head',
    '.sak-journal__card',
    '.sak-trust__item',
  ];
  const fadeTargets = document.querySelectorAll(fadeSelectors.join(','));
  const wipeParents = ['sak-tiles__card', 'sak-journal__card', 'sak-bts__figure'];

  fadeTargets.forEach((el, i) => {
    const staggerDelay = (i % 4) * 0.08;
    const reveal = () => {
      animate(
        el,
        { opacity: [0, 1], y: [28, 0] },
        {
          duration: 1.1,
          easing: spring({ stiffness: 80, damping: 19, mass: 0.85 }),
          delay: staggerDelay,
        }
      );
      const hasWipe = wipeParents.some((c) => el.classList.contains(c));
      if (hasWipe) {
        const img = el.querySelector('img');
        if (img) {
          animate(
            img,
            { clipPath: ['inset(0 100% 0 0)', 'inset(0 0 0 0)'] },
            {
              duration: 1.3,
              easing: [0.65, 0, 0.35, 1],
              delay: staggerDelay + 0.15,
            }
          );
        }
      }
    };

    // Already in viewport on load? Reveal immediately.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      reveal();
    } else {
      inView(el, () => {
        reveal();
      }, { amount: 0.12 });
    }
  });
})();
