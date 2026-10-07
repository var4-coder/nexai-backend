/* NexAI — couche de mouvement GSAP : UN SEUL geste par page (testé le 02/10, 0 défaut avec et sans JS).
   Charger AVANT ce fichier, depuis le domaine NexAI (jamais un CDN) : gsap.min.js puis ScrollTrigger.min.js (GSAP 3.13+).
   Le geste est choisi par le backend dans allowlist.geste_motion[niche] et déclaré sur <html data-geste="…"> :
     entree   = entrée du haut de page (titre, phrase, bouton) — défaut
     parallax = « parallax photo du hero » : la PHOTO du haut de page glisse de ±6 % au défilement (jamais le texte)
     mots     = « révélation titres mot par mot » : le H1 du haut de page seulement
     aucun    = « aucun geste lourd (vitesse) » : ne rien charger (ni GSAP, ni ce fichier)
   Repère du haut de page : data-nexai-id="hero" (AI_RULES).
   Ordre : gsap.min.js et ScrollTrigger.min.js en defer, puis ce fichier EN LIGNE (il attend DOMContentLoaded, qui suit les scripts defer).
   Contrat : page complète sans JS ; opacity et transform seulement ; 0,4–0,9 s ; une seule fois ; coupé si prefers-reduced-motion. */
(function () {
  var geste = document.documentElement.getAttribute('data-geste') || 'entree';
  if (geste === 'aucun') return;
  document.documentElement.classList.add('js');
  addEventListener('DOMContentLoaded', function () {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !window.gsap) return;
    var hero = document.querySelector('[data-nexai-id="hero"], .hero');
    if (!hero) return;
    if (geste === 'parallax') {
      if (!window.ScrollTrigger) return;
      gsap.registerPlugin(ScrollTrigger);
      var img = hero.querySelector('img');
      if (!img) return;
      gsap.fromTo(img, { yPercent: -6, scale: 1.12 }, { yPercent: 6, ease: 'none',
        scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });
    } else if (geste === 'mots') {
      var h1 = hero.querySelector('h1');
      if (!h1 || h1.children.length) return; /* titre simple uniquement */
      var mots = h1.textContent.trim().split(/\s+/);
      h1.setAttribute('aria-label', h1.textContent.trim());
      h1.innerHTML = mots.map(function (m) { return '<span aria-hidden="true" style="display:inline-block">' + m + '</span>'; }).join(' ');
      gsap.from(h1.children, { yPercent: 40, opacity: 0, duration: .6, stagger: .05, ease: 'power2.out' });
    } else {
      gsap.from(hero.querySelectorAll('h1, h1 + p, .btn, [data-cta]'), { y: 24, opacity: 0, duration: .8, stagger: .08, ease: 'power2.out' });
    }
  });
})();
