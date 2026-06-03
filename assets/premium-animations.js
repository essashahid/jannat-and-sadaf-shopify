/**
 * Jannat & Sadaf — premium homepage animations.
 * Word-by-word hero reveal, gentle section fade-ups, magnetic CTA buttons.
 * Homepage only. Safety net guarantees nothing stays invisible.
 */
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!document.querySelector('.sakatelier-home')) return;

  // ---------- Hero word reveal ----------
  const heroHeading = document.querySelector('.sak-hero__heading');
  const heroLabel = document.querySelector('.sak-hero__label');
  const heroSub = document.querySelector('.sak-hero__sub');
  const heroActions = document.querySelector('.sak-hero__actions');

  function splitWords(el) {
    if (!el) return;
    const text = el.textContent.trim();
    if (!text) return;
    const words = text.split(/\s+/);
    el.innerHTML = words
      .map((w, i) => `<span class="reveal-word" style="--i:${i}"><span>${w}</span></span>`)
      .join(' ');
  }

  function triggerHeroReveal() {
    [heroLabel, heroHeading, heroSub, heroActions].forEach((el) => {
      if (!el) return;
      el.classList.remove('is-revealed');
    });
    if (heroHeading) splitWords(heroHeading);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        [heroLabel, heroHeading, heroSub, heroActions].forEach((el) => {
          if (el) el.classList.add('is-revealed');
        });
      });
    });
  }

  triggerHeroReveal();

  // Re-trigger reveal when the slide changes (hero JS swaps heading text)
  if (heroHeading) {
    let lastText = heroHeading.textContent;
    const mo = new MutationObserver(() => {
      const current = heroHeading.textContent;
      if (current !== lastText && current.indexOf('reveal-word') === -1) {
        lastText = current;
        triggerHeroReveal();
      }
    });
    mo.observe(heroHeading, { childList: true, characterData: true, subtree: true });
  }

  // ---------- Magnetic hero CTAs ----------
  document.querySelectorAll('.sak-hero__actions .sak-btn').forEach((btn) => {
    let raf = null;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;

    function tick() {
      currentX += (targetX - currentX) * 0.18;
      currentY += (targetY - currentY) * 0.18;
      btn.style.setProperty('--mx', currentX.toFixed(2) + 'px');
      btn.style.setProperty('--my', currentY.toFixed(2) + 'px');
      if (Math.abs(targetX - currentX) > 0.1 || Math.abs(targetY - currentY) > 0.1) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = null;
      }
    }

    btn.addEventListener('mousemove', (e) => {
      const rect = btn.getBoundingClientRect();
      targetX = (e.clientX - rect.left - rect.width / 2) * 0.18;
      targetY = (e.clientY - rect.top - rect.height / 2) * 0.18;
      if (!raf) raf = requestAnimationFrame(tick);
    });

    btn.addEventListener('mouseleave', () => {
      targetX = 0;
      targetY = 0;
      if (!raf) raf = requestAnimationFrame(tick);
    });
  });

  // ---------- Section reveal on scroll ----------
  const revealSelectors = [
    '.sak-tiles .sak-head',
    '.sak-tiles__card',
    '.sak-products .sak-head',
    '.sak-craft__media',
    '.sak-craft__content',
    '.sak-bts .sak-head',
    '.sak-bts__figure',
    '.sak-journal .sak-head',
    '.sak-journal__card',
    '.sak-trust__item',
  ];

  const targets = document.querySelectorAll(revealSelectors.join(','));

  if (targets.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-revealed');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
    );

    targets.forEach((el, i) => {
      el.classList.add('reveal');
      el.style.setProperty('--reveal-delay', `${(i % 4) * 80}ms`);
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        requestAnimationFrame(() => el.classList.add('is-revealed'));
      } else {
        observer.observe(el);
      }
    });

    // Safety net — nothing stays invisible past 2.5s
    setTimeout(() => {
      targets.forEach((el) => el.classList.add('is-revealed'));
    }, 2500);
  }
})();
