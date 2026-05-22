/**
 * Jannat & Sadaf - Luxury Scroll Animations
 * Handles fade-in-up animations for sections and product cards
 * using IntersectionObserver for performance
 */

(function () {
  'use strict';

  // Skip if user prefers reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  /**
   * Initialize scroll-triggered animations
   */
  function initScrollAnimations() {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('luxury-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.15,
        rootMargin: '0px 0px -50px 0px',
      }
    );

    // Animate all shopify sections
    document.querySelectorAll('.shopify-section').forEach((section) => {
      // Skip header, footer, and sakatelier home sections
      if (
        section.closest('#header-group') ||
        section.closest('.footer-group') ||
        section.closest('header-component') ||
        section.querySelector('.sakatelier-home')
      ) {
        return;
      }
      section.classList.add('luxury-animate');
      observer.observe(section);
    });

    // Animate product cards with stagger
    document.querySelectorAll('.product-grid').forEach((grid) => {
      const cards = grid.querySelectorAll('.product-grid__item');
      cards.forEach((card, index) => {
        card.classList.add('luxury-animate');
        const staggerIndex = (index % 4) + 1;
        card.classList.add(`luxury-stagger-${staggerIndex}`);
        observer.observe(card);
      });
    });

    // Animate collection cards with stagger
    document.querySelectorAll('.collection-card').forEach((card, index) => {
      card.classList.add('luxury-animate');
      const staggerIndex = (index % 4) + 1;
      card.classList.add(`luxury-stagger-${staggerIndex}`);
      observer.observe(card);
    });

    // Animate featured blog posts
    document.querySelectorAll('.featured-blog-posts-card').forEach((card, index) => {
      card.classList.add('luxury-animate');
      const staggerIndex = (index % 3) + 1;
      card.classList.add(`luxury-stagger-${staggerIndex}`);
      observer.observe(card);
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollAnimations);
  } else {
    initScrollAnimations();
  }

  // Re-initialize after Shopify section rendering (for theme editor)
  document.addEventListener('shopify:section:load', () => {
    // Small delay to let the DOM settle
    setTimeout(initScrollAnimations, 100);
  });
})();
