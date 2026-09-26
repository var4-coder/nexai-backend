/**
 * Contenus d'EXEMPLE (avis générés pour l'aperçu) — décision admin 26/09/2026.
 *
 * Dans l'aperçu, le codeur peut montrer 2 ou 3 avis d'exemple pour que le
 * client voie son site complet. Chacun porte `data-origin="generated"` et un
 * badge visible « Exemple ». À la MISE EN LIGNE, ils sont retirés du HTML
 * (pas seulement masqués) : un visiteur ne peut jamais les voir, même en
 * lisant le code source de la page. `<html>` reçoit data-env="production",
 * ce qui active aussi la règle CSS de secours posée par le codeur.
 */

const BALISES_VIDES = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Retire chaque élément portant data-origin="generated" (avec tout son contenu). */
export function retirerContenuExemple(html: string): { html: string; retires: number } {
  let resultat = html;
  let retires = 0;
  const ouverture = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bdata-origin\s*=\s*["']generated["'][^>]*>/;

  for (let garde = 0; garde < 200; garde++) {
    const m = ouverture.exec(resultat);
    if (!m) break;
    const debut = m.index;
    const balise = m[1].toLowerCase();
    const finOuverture = debut + m[0].length;

    if (BALISES_VIDES.has(balise) || m[0].endsWith('/>')) {
      resultat = resultat.slice(0, debut) + resultat.slice(finOuverture);
      retires++;
      continue;
    }

    // Cherche la balise fermante correspondante en comptant l'imbrication.
    const re = new RegExp(`<(/?)${balise}\\b[^>]*>`, 'gi');
    re.lastIndex = finOuverture;
    let profondeur = 1;
    let fin = -1;
    let t: RegExpExecArray | null;
    while ((t = re.exec(resultat))) {
      if (t[0].endsWith('/>')) continue;
      profondeur += t[1] === '/' ? -1 : 1;
      if (profondeur === 0) {
        fin = t.index + t[0].length;
        break;
      }
    }
    // HTML mal fermé : on retire au moins la balise ouvrante pour ne jamais boucler.
    resultat = resultat.slice(0, debut) + (fin === -1 ? resultat.slice(finOuverture) : resultat.slice(fin));
    retires++;
  }

  // data-env="production" sur <html> (remplace une valeur existante).
  resultat = resultat.replace(/<html\b([^>]*)>/i, (_tout, attrs: string) => {
    const sans = attrs.replace(/\sdata-env\s*=\s*["'][^"']*["']/i, '');
    return `<html${sans} data-env="production">`;
  });

  return { html: resultat, retires };
}
