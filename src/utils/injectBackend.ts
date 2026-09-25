/**
 * Branche les blocs générés par le pipeline IA (identifiés par data-nexai-id,
 * voir data/library/components.ts) sur le backend public NexAI, pour que les
 * formulaires livrés aux clients envoient réellement leurs données quelque
 * part (MongoDB, via routes/public.routes.ts).
 *
 * Approche volontairement non-invasive : on n'essaie pas de réécrire le
 * balisage exact de chaque composant (trop fragile vu la diversité des
 * proposals générées). On injecte un unique <script> juste avant </body> qui
 * repère les éléments par data-nexai-id/data-nexai-type et attache un
 * handler générique. Fonctionne quelle que soit la structure HTML exacte
 * produite par l'IA pour peu qu'elle respecte ces attributs (contrat déjà
 * imposé par la librairie interne).
 */
export function injectPublicBackendScript(params: {
  html: string;
  siteId: string;
  publicApiKey: string;
  apiBaseUrl: string;
}): string {
  const { html, siteId, publicApiKey, apiBaseUrl } = params;
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/public/sites/${siteId}/submit`;

  const script = `
<script>
(function () {
  var NEXAI_ENDPOINT = ${JSON.stringify(endpoint)};
  var NEXAI_SITE_KEY = ${JSON.stringify(publicApiKey)};

  function nexaiSend(type, payload, formEl) {
    return fetch(NEXAI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nexai-site-key': NEXAI_SITE_KEY },
      body: JSON.stringify({ type: type, data: payload }),
    }).then(function (res) {
      if (!res.ok) throw new Error('nexai_submit_failed');
      return res.json();
    });
  }

  function nexaiFormToObject(form) {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      data[key] = value;
    });
    return data;
  }

  function nexaiSetFeedback(form, message, isError) {
    var el = form.querySelector('[data-nexai-feedback]');
    if (!el) {
      el = document.createElement('p');
      el.setAttribute('data-nexai-feedback', '');
      el.setAttribute('aria-live', 'polite');
      form.appendChild(el);
    }
    el.textContent = message;
    el.style.color = isError ? '#B91C1C' : '#15803D';
  }

  function nexaiWireForm(form, type) {
    // Honeypot anti-spam si présent (voir composant formulaire_contact)
    form.addEventListener('submit', function (evt) {
      evt.preventDefault();
      var honeypot = form.querySelector('input[name="website"], input[name="_honeypot"]');
      if (honeypot && honeypot.value) return; // bot probable, on ignore silencieusement
      var submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.setAttribute('disabled', 'true');
      nexaiSetFeedback(form, 'Envoi en cours...', false);
      nexaiSend(type, nexaiFormToObject(form), form)
        .then(function () {
          nexaiSetFeedback(form, 'Merci, votre message a bien été envoyé !', false);
          form.reset();
        })
        .catch(function () {
          nexaiSetFeedback(form, "Une erreur est survenue, réessayez dans un instant.", true);
        })
        .finally(function () {
          if (submitBtn) submitBtn.removeAttribute('disabled');
        });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-nexai-id="form-contact"], form[data-nexai-type="contact"]').forEach(function (f) {
      nexaiWireForm(f, 'contact');
    });
    document.querySelectorAll('form[data-nexai-type="reservation"]').forEach(function (f) {
      nexaiWireForm(f, 'reservation');
    });
    document.querySelectorAll('form[data-nexai-type="commande"]').forEach(function (f) {
      nexaiWireForm(f, 'commande');
    });
    nexaiAppliquerEtat();
  });

  // État du site selon l'abonnement de son propriétaire.
  //
  // Paiements : coupés AVANT tout achat quand l'abonnement est inactif.
  // Aucun acheteur ne paie donc jamais pour un argent qui ne pourrait pas
  // être reversé au commerçant.
  //
  // Mention NexAI : affichée tant que l'abonnement est inactif — c'est la
  // contrepartie de l'hébergement gratuit.
  //
  // En cas d'échec de l'appel, rien n'est modifié : une panne de NexAI ne
  // doit jamais empêcher un commerçant de vendre.
  function nexaiAppliquerEtat() {
    // Pas d'expression régulière ici : dans une chaîne à gabarit, les barres
    // obliques échappées disparaissent et produisent un commentaire JS qui
    // ferait planter tout le script. On découpe simplement la chaîne.
    var url = NEXAI_ENDPOINT.slice(0, NEXAI_ENDPOINT.lastIndexOf('/')) + '/etat';
    fetch(url, { headers: { 'x-nexai-site-key': NEXAI_SITE_KEY } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (etat) {
        if (!etat) return;
        // Lien servi en direct : il remplace celui inscrit dans la page. Le
        // lien d'origine reste en place si NexAI ne répond pas, pour que le
        // commerçant ne perde jamais une vente à cause d'une panne chez nous.
        // Seuls les liens http(s) sont acceptés.
        if (etat.paiementsActifs !== false && typeof etat.lienPaiement === 'string'
            && etat.lienPaiement.indexOf('http') === 0) {
          document.querySelectorAll('[data-nexai-payment-link]').forEach(function (el) {
            el.setAttribute('href', etat.lienPaiement);
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener');
          });
        }
        if (etat.paiementsActifs === false) {
          document.querySelectorAll('[data-nexai-payment-link]').forEach(function (el) {
            var note = document.createElement('p');
            note.textContent = 'Les commandes en ligne sont momentanément indisponibles. Contactez-nous directement pour passer commande.';
            note.style.cssText = 'margin:8px 0;padding:10px 14px;border-radius:8px;background:rgba(0,0,0,0.06);font-size:14px;line-height:1.5;';
            el.parentNode && el.parentNode.replaceChild(note, el);
          });
        }
        // Site suspendu pour dépassement d'hébergement : le contenu est
        // masqué, rien n'est supprimé. Il réapparaît tel quel dès que
        // l'hébergement est de nouveau couvert. Message neutre pour les
        // visiteurs : il ne met pas le commerçant dans l'embarras.
        if (etat.suspendu === true) {
          document.body.innerHTML =
            '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;text-align:center">' +
            '<div><p style="font-size:18px;font-weight:600;margin:0 0 8px">Ce site est momentanément indisponible.</p>' +
            '<p style="font-size:14px;opacity:0.7;margin:0">Merci de revenir un peu plus tard.</p></div></div>';
          return;
        }
        if (etat.modeLimite === true && !document.getElementById('nexai-mode-limite')) {
          var b = document.createElement('div');
          b.id = 'nexai-mode-limite';
          b.textContent = 'Ce site fonctionne en mode limité.';
          b.style.cssText = 'position:sticky;top:0;z-index:2147483647;padding:8px 12px;text-align:center;font-size:13px;background:#fff4e5;color:#6b4200;border-bottom:1px solid #f0d8b0;';
          document.body.insertBefore(b, document.body.firstChild);
        }
        if (etat.afficherMention === true && !document.getElementById('nexai-mention')) {
          var m = document.createElement('a');
          m.id = 'nexai-mention';
          m.href = 'https://nexai.fr/?ref=site';
          m.target = '_blank';
          m.rel = 'noopener';
          m.textContent = 'Propulsé par NexAI';
          m.style.cssText = 'display:block;text-align:center;padding:12px;font-size:12px;opacity:0.7;color:inherit;text-decoration:none;';
          document.body.appendChild(m);
        }
      })
      .catch(function () {});
  }
})();
</script>`;

  if (html.includes('</body>')) {
    return html.replace('</body>', `${script}\n</body>`);
  }
  return `${html}\n${script}`;
}

/**
 * Injecte le vrai lien de paiement dans le HTML livré, au moment du
 * déploiement (worker.ts), après validation (payment-link.service.ts).
 *
 * Le Codeur ne connaît jamais le lien réel : il génère un bouton de paiement
 * avec un repère fixe `data-nexai-payment-link` (attribut vide ou href="#"),
 * exactement comme il génère une image hero sans connaître son URL finale
 * (voir injectHeroImage dans ia-pipeline.service.ts). Cette fonction
 * remplace ce repère par la vraie URL, sur tous les éléments concernés
 * (liens <a> ou boutons avec data-nexai-payment-link).
 *
 * Non-invasif : si le Codeur n'a généré aucun bouton de paiement (site sans
 * besoin de paiement selon le brief), cette fonction ne change rien au HTML.
 */
export function injectPaymentLink(html: string, paymentLink: string): string {
  if (!html.includes('data-nexai-payment-link')) return html;
  const safeUrl = paymentLink.replace(/"/g, '&quot;');

  let result = html
    // <a data-nexai-payment-link href="#">Payer</a>  ou  <a href="#" data-nexai-payment-link>
    .replace(
      /(<a\b[^>]*\bdata-nexai-payment-link\b[^>]*\bhref=)(["'])[^"']*\2/gi,
      `$1"${safeUrl}"`
    )
    // <a data-nexai-payment-link>Payer</a> sans href du tout
    .replace(
      /(<a\b(?![^>]*\bhref=)[^>]*\bdata-nexai-payment-link\b[^>]*)(>)/gi,
      `$1 href="${safeUrl}" target="_blank" rel="noopener"$2`
    );

  // Boutons/éléments non-<a> marqués data-nexai-payment-link : on ajoute un petit
  // script qui les redirige vers le lien réel au clic (couvre <button>, <div>, etc.).
  const script = `
<script>
(function () {
  var NEXAI_PAYMENT_LINK = ${JSON.stringify(paymentLink)};
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-nexai-payment-link]').forEach(function (el) {
      if (el.tagName === 'A') {
        if (!el.getAttribute('href') || el.getAttribute('href') === '#') {
          el.setAttribute('href', NEXAI_PAYMENT_LINK);
        }
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
      } else {
        el.addEventListener('click', function () {
          window.open(NEXAI_PAYMENT_LINK, '_blank', 'noopener');
        });
      }
    });
  });
})();
</script>`;

  result = result.includes('</body>') ? result.replace('</body>', `${script}\n</body>`) : `${result}\n${script}`;
  return result;
}
