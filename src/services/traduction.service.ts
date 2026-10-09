import crypto from 'crypto';
import { Traduction } from '@/models/Traduction';
import { callClaude, callGrok, type ClaudeModel, type GrokModel } from '@/services/ai-clients';
import { getModelForRole, getSecoursForRole } from '@/services/ai-role-registry';

export type LangueCible = 'en';

const NOMS: Record<LangueCible, string> = { en: 'English' };

const cleDe = (t: string) => crypto.createHash('sha1').update(t).digest('hex');

/** Lots en cours, partagés entre requêtes simultanées (un texte n'est jamais traduit deux fois en parallèle). */
const enVol = new Map<string, Promise<string | null>>();

async function traduireLot(textes: string[], langue: LangueCible): Promise<(string | null)[]> {
  const system = `You translate user-interface and catalogue texts of NexAI, a web platform for African entrepreneurs, from French into ${NOMS[langue]}.
Rules:
- Translate each item faithfully, natural and concise, same tone. Keep numbers, prices, currencies (FCFA, $), brand and product names (NexAI, Skill NexAI, Chariow, Wave, Orange Money, Créateur+, Pro Max, Starter), emojis, Markdown (**bold**, lists) and line breaks.
- If an item is already in ${NOMS[langue]} or is a proper name, return it unchanged.
- Answer ONLY with a JSON array of strings, same length and order as the input. No comments.`;
  const entree = JSON.stringify(textes);
  const modele = await getModelForRole('traduction_interface');
  const appeler = (m: string) =>
    m.startsWith('grok-')
      ? callGrok(m as GrokModel, [{ role: 'system', content: system }, { role: 'user', content: entree }], {
          maxTokens: 4000,
          temperature: 0.1,
        })
      : callClaude(m as ClaudeModel, system, [{ role: 'user', content: entree }], {
          maxTokens: 4000,
          temperature: 0.1,
        });
  // Un fournisseur en panne (crédit épuisé…) ne doit pas bloquer la
  // traduction : on bascule automatiquement sur l'autre.
  let brut: string;
  try {
    brut = await appeler(modele);
  } catch (e) {
    const secours = await getSecoursForRole('traduction_interface', modele);
    if (!secours) throw e;
    console.warn(`[traduction] ${modele} indisponible, bascule sur ${secours}`, (e as Error).message);
    brut = await appeler(secours);
  }
  const json = brut.slice(brut.indexOf('['), brut.lastIndexOf(']') + 1);
  const sortie = JSON.parse(json) as unknown[];
  return textes.map((_, i) => (typeof sortie[i] === 'string' && (sortie[i] as string).trim() ? (sortie[i] as string) : null));
}

/**
 * Traduit des textes français dans la langue demandée. Les traductions
 * connues sortent du cache ; les autres sont traduites par lots puis
 * mémorisées. En cas de panne de l'IA, renvoie null pour ces textes (le
 * client garde alors le texte d'origine, jamais un message d'erreur).
 */
export async function traduireTextes(textes: string[], langue: LangueCible): Promise<Record<string, string>> {
  const uniques = Array.from(new Set(textes.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 5000)));
  const resultat: Record<string, string> = {};
  if (uniques.length === 0) return resultat;

  const connus = await Traduction.find({ langue, cle: { $in: uniques.map(cleDe) } }).select('cle texte').lean();
  const parCle = new Map((connus as unknown as { cle: string; texte: string }[]).map((c) => [c.cle, c.texte]));
  const manquants: string[] = [];
  for (const t of uniques) {
    const deja = parCle.get(cleDe(t));
    if (deja) resultat[t] = deja;
    else manquants.push(t);
  }
  if (manquants.length === 0) return resultat;

  // Lots de ~40 textes / 6 000 caractères.
  const lots: string[][] = [];
  let courant: string[] = [];
  let taille = 0;
  for (const t of manquants) {
    if (courant.length >= 40 || taille + t.length > 6000) {
      lots.push(courant);
      courant = [];
      taille = 0;
    }
    courant.push(t);
    taille += t.length;
  }
  if (courant.length) lots.push(courant);

  await Promise.all(
    lots.map(async (lot) => {
      const promesses = lot.map((t) => {
        const k = `${langue}:${cleDe(t)}`;
        return enVol.get(k);
      });
      const aTraduire = lot.filter((_, i) => !promesses[i]);
      let traduit: (string | null)[] = [];
      if (aTraduire.length) {
        const p = traduireLot(aTraduire, langue).catch((e) => {
          console.warn('[traduction] lot non traduit', (e as Error).message);
          return aTraduire.map(() => null);
        });
        aTraduire.forEach((t, i) => enVol.set(`${langue}:${cleDe(t)}`, p.then((r) => r[i])));
        traduit = await p;
        aTraduire.forEach((t) => enVol.delete(`${langue}:${cleDe(t)}`));
        const docs = aTraduire
          .map((t, i) => ({ t, tr: traduit[i] }))
          .filter((x): x is { t: string; tr: string } => !!x.tr);
        if (docs.length) {
          await Traduction.insertMany(
            docs.map((d) => ({ cle: cleDe(d.t), langue, source: d.t, texte: d.tr.slice(0, 8000) })),
            { ordered: false }
          ).catch(() => undefined);
        }
        aTraduire.forEach((t, i) => {
          if (traduit[i]) resultat[t] = traduit[i]!;
        });
      }
      await Promise.all(
        lot.map(async (t, i) => {
          if (promesses[i]) {
            const r = await promesses[i];
            if (r) resultat[t] = r;
          }
        })
      );
    })
  );
  return resultat;
}
