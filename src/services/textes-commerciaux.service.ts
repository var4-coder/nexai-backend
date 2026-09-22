import { TexteCommercial, ITexteCommercial } from '@/models/TexteCommercial';
import { callClaude } from '@/services/ai-clients';
import { AppError } from '@/middleware/errorHandler';

/**
 * Mise à jour des textes commerciaux après un changement de tarif.
 *
 * Sonnet 5 relit chaque texte, repère ceux qui mentionnent une valeur
 * devenue fausse, et propose une version corrigée. Rien n'est publié : la
 * proposition attend la validation de l'administrateur, qui peut la
 * modifier avant.
 *
 * Ce garde-fou est volontaire. Un modèle qui réécrirait seul une vitrine
 * commerciale pourrait déformer une promesse — un prix, une inclusion, une
 * limite — sans que personne ne le voie avant les clients.
 */

const MODELE = 'claude-sonnet-5';

const CONSIGNE = `Tu mets à jour les textes commerciaux d'une plateforme de création de sites web.

On te donne un texte affiché aux clients, et les valeurs ACTUELLES de l'offre.

Ta tâche : si le texte mentionne un prix, un nombre de crédits, une durée ou
une inclusion qui ne correspond plus aux valeurs actuelles, réécris-le avec
les bonnes valeurs.

RÈGLES ABSOLUES :
- Ne change QUE ce qui est devenu faux. Garde le ton, le style, la longueur.
- N'invente aucune promesse, n'ajoute aucune fonctionnalité.
- Si le texte est toujours exact, ne propose rien.

Réponds UNIQUEMENT en JSON :
{"aChanger": false} ou {"aChanger": true, "nouveau": "...", "motif": "..."}`;

function lireJson<T>(brut: string): T | null {
  try {
    const n = brut.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const d = n.indexOf('{');
    const f = n.lastIndexOf('}');
    if (d === -1 || f === -1) return null;
    return JSON.parse(n.slice(d, f + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Fait relire tous les textes par Sonnet et enregistre les propositions.
 * Ne publie rien. Renvoie le nombre de textes pour lesquels une correction
 * est proposée.
 */
export async function proposerMiseAJourTextes(valeursActuelles: string): Promise<{
  analyses: number;
  propositions: number;
}> {
  const textes = await TexteCommercial.find({});
  let propositions = 0;

  for (const texte of textes) {
    try {
      const brut = await callClaude(
        MODELE,
        CONSIGNE,
        [
          {
            role: 'user',
            content:
              `VALEURS ACTUELLES DE L'OFFRE :\n${valeursActuelles}\n\n` +
              `TEXTE (${texte.emplacement}${texte.role ? ` — ${texte.role}` : ''}) :\n${texte.contenu}`,
          },
        ],
        { maxTokens: 1500, temperature: 0.2 }
      );

      const verdict = lireJson<{ aChanger?: boolean; nouveau?: string; motif?: string }>(brut);
      if (!verdict?.aChanger || !verdict.nouveau?.trim()) continue;

      texte.propositionContenu = verdict.nouveau.trim();
      texte.propositionMotif = verdict.motif?.trim() || 'Valeurs mises à jour.';
      texte.propositionLe = new Date();
      await texte.save();
      propositions += 1;
    } catch (err) {
      // Un texte qui échoue ne doit pas interrompre les autres.
      console.warn(`[textes] Analyse échouée pour « ${texte.cle} »`, err);
    }
  }

  return { analyses: textes.length, propositions };
}

/**
 * Publie une proposition, éventuellement corrigée par l'administrateur.
 * C'est le SEUL chemin qui modifie un texte visible par les clients.
 */
export async function validerProposition(
  cle: string,
  contenuCorrige?: string
): Promise<ITexteCommercial> {
  const texte = await TexteCommercial.findOne({ cle });
  if (!texte) throw new AppError('Texte introuvable.', 404);

  const nouveau = contenuCorrige?.trim() || texte.propositionContenu?.trim();
  if (!nouveau) throw new AppError('Aucune proposition à publier pour ce texte.', 400);

  texte.contenu = nouveau;
  texte.propositionContenu = null;
  texte.propositionMotif = null;
  texte.propositionLe = null;
  texte.majLe = new Date();
  texte.majPar = contenuCorrige ? 'admin' : 'sonnet';
  await texte.save();
  return texte;
}

/** Écarte une proposition sans rien publier. */
export async function rejeterProposition(cle: string): Promise<void> {
  await TexteCommercial.updateOne(
    { cle },
    { $set: { propositionContenu: null, propositionMotif: null, propositionLe: null } }
  );
}
