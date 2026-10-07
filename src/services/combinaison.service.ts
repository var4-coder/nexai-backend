import mongoose from 'mongoose';
import { CombinaisonUsage, CombinaisonCycle } from '@/models/CombinaisonUsage';
import {
  allowlistDe,
  familleDe,
  idNicheLibrairie,
  type CombinaisonSite,
  type LibrairieComplete,
} from '@/services/library.service';

/**
 * CHOIX DE LA FAMILLE ET DE LA COMBINAISON D'UN SITE (Librairie v8, TH1–TH5).
 *
 * Décision du 02/10/2026 : « toute combinaison déjà faite pour une niche ne
 * doit pas être refaite ; c'est uniquement à l'épuisement de toutes les
 * combinaisons de la niche que ça reprend à zéro ».
 *
 * Combinaison = famille + ouverture (hero) + navigation + densité, prises
 * dans le kit de chaque famille du métier (`allowlist.familles_par_niche`).
 * Pour chaque métier :
 *   · on ne donne que des combinaisons pas encore utilisées dans le cycle ;
 *   · quand toutes l'ont été, le cycle suivant commence (tout redevient libre) ;
 *   · une relance ne reçoit jamais une combinaison déjà essayée pour ce site ;
 *   · l'attribution est atomique (index unique) : deux sites du même métier
 *     lancés en même temps n'obtiennent jamais la même combinaison.
 * Ordre de préférence parmi les combinaisons libres : familles les moins
 * utilisées dans le cycle (variété des couleurs et polices d'un client à
 * l'autre), puis familles dont les mots-clés (`choisir_si`) apparaissent
 * dans le brief, puis la note de la famille (ordre de la liste).
 */

export interface CombinaisonCandidate extends CombinaisonSite {
  cle: string;
  rang: number;
  motsCles: string[];
}

function intersection(a: unknown, b: unknown): string[] {
  const la = Array.isArray(a) ? (a as unknown[]).map(String) : [];
  if (!Array.isArray(b) || b.length === 0) return la;
  const sb = new Set((b as unknown[]).map(String));
  return la.filter((x) => sb.has(x));
}

/** Geste du métier → valeur de `data-geste` (kit/motion.js). */
function gesteDuMetier(lib: LibrairieComplete, idNiche: string): { geste: string; gesteComposant?: string } {
  const allow = allowlistDe(lib);
  const description = allow.geste_motion?.[idNiche];
  const kit = allow.gestes_motion_kit ?? {};
  const valeur = (description && kit[description]) || kit['défaut'] || 'entree';
  if (/^composant/i.test(valeur)) return { geste: 'aucun', gesteComposant: description };
  return { geste: ['entree', 'parallax', 'mots', 'aucun'].includes(valeur) ? valeur : 'entree' };
}

/** Toutes les combinaisons possibles d'un métier (ordre : meilleure famille d'abord). */
export function combinaisonsDuMetier(lib: LibrairieComplete, nicheSite: string): CombinaisonCandidate[] {
  const idNiche = idNicheLibrairie(nicheSite);
  const allow = allowlistDe(lib);
  const fiche = lib.docs.library_niches.find((n) => String(n._id) === idNiche);
  const ids: string[] =
    allow.familles_par_niche?.[idNiche] ?? (Array.isArray(fiche?.familles) ? (fiche!.familles as string[]) : []);
  const actives = Array.isArray(allow.familles_actives) ? new Set(allow.familles_actives) : null;
  const { geste, gesteComposant } = gesteDuMetier(lib, idNiche);

  const sortie: CombinaisonCandidate[] = [];
  ids.forEach((id, rang) => {
    if (actives && !actives.has(id)) return;
    const f = familleDe(lib, id);
    if (!f) return;
    const kitFamille = (f.kit ?? {}) as { heroes?: string[]; navs?: string[]; densites?: string[] };
    const heroes = intersection(kitFamille.heroes, allow.kit?.heroes);
    const navs = intersection(kitFamille.navs, allow.kit?.navs);
    const densites = intersection(kitFamille.densites, allow.kit?.densities);
    const style = String(f.style_id ?? '');
    const palette = String(f.palette_id ?? '');
    const motsCles = Array.isArray(f.choisir_si) ? (f.choisir_si as unknown[]).map(String) : [];
    for (const hero of heroes.length ? heroes : ['split'])
      for (const nav of navs.length ? navs : ['wordmark-left'])
        for (const densite of densites.length ? densites : ['medium'])
          sortie.push({
            famille: String(f._id),
            style,
            palette,
            hero,
            nav,
            densite,
            geste,
            ...(gesteComposant ? { gesteComposant } : {}),
            cle: `${f._id}|${hero}|${nav}|${densite}`,
            rang,
            motsCles,
          });
  });
  return sortie;
}

function normaliser(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function scoreMotsCles(motsCles: string[], texteBrief: string): number {
  let n = 0;
  for (const m of motsCles) {
    const mot = normaliser(m).trim();
    if (mot.length >= 3 && texteBrief.includes(mot)) n++;
  }
  return Math.min(n, 2);
}

/**
 * Classe les combinaisons libres. Le hasard ne départage que des
 * combinaisons équivalentes : il évite que tous les sites d'un métier aient
 * la même ouverture dans le même ordre.
 */
export function classerCombinaisons(
  libres: CombinaisonCandidate[],
  usagesParFamille: Map<string, number>,
  brief: Record<string, unknown>,
  hasard: () => number = Math.random
): CombinaisonCandidate[] {
  const texte = normaliser(JSON.stringify(brief ?? {}));
  const notes = new Map<string, number>();
  for (const c of libres) {
    if (notes.has(c.cle)) continue;
    const usages = usagesParFamille.get(c.famille) ?? 0;
    notes.set(c.cle, usages * 3 - scoreMotsCles(c.motsCles, texte) * 4 + c.rang * 0.3 + hasard());
  }
  return [...libres].sort((a, b) => notes.get(a.cle)! - notes.get(b.cle)!);
}

function erreurDoublon(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
}

/**
 * Choisit et RÉSERVE la combinaison d'un site. Renvoie null si le métier n'a
 * aucune famille (le codeur reçoit alors l'identité de secours de la fiche).
 * `exclure` : combinaisons déjà essayées pour ce site (relances).
 */
export async function choisirCombinaison(params: {
  lib: LibrairieComplete;
  nicheSite: string;
  siteId?: string;
  brief: Record<string, unknown>;
  exclure?: string[];
}): Promise<CombinaisonSite | null> {
  const toutes = combinaisonsDuMetier(params.lib, params.nicheSite);
  if (toutes.length === 0) return null;
  const idNiche = idNicheLibrairie(params.nicheSite);
  const exclues = new Set(params.exclure ?? []);
  // Si tout a déjà été essayé pour ce site (métier à très peu de
  // combinaisons), on ignore l'exclusion plutôt que de bloquer.
  const candidates = toutes.some((c) => !exclues.has(c.cle)) ? toutes.filter((c) => !exclues.has(c.cle)) : toutes;
  const sansBase = (): CombinaisonSite => {
    const c = classerCombinaisons(candidates, new Map(), params.brief)[0];
    const { cle: _c, rang: _r, motsCles: _m, ...combinaison } = c;
    return combinaison;
  };
  if (mongoose.connection.readyState !== 1) return sansBase();

  try {
    for (let essai = 0; essai < 6; essai++) {
      const cycleDoc = await CombinaisonCycle.findOneAndUpdate(
        { _id: idNiche },
        { $setOnInsert: { cycle: 1 } },
        { upsert: true, new: true }
      ).lean();
      const cycle = cycleDoc?.cycle ?? 1;
      const usages = await CombinaisonUsage.find({ niche: idNiche, cycle }, 'cle famille').lean();
      const utilisees = new Set(usages.map((u) => u.cle));
      const libres = candidates.filter((c) => !utilisees.has(c.cle));
      if (libres.length === 0) {
        // Toutes les combinaisons du métier ont servi dans ce cycle : on
        // recommence à zéro (cycle suivant), sauf si un autre site l'a déjà fait.
        await CombinaisonCycle.updateOne({ _id: idNiche, cycle }, { $inc: { cycle: 1 } });
        continue;
      }
      const parFamille = new Map<string, number>();
      for (const u of usages) parFamille.set(u.famille, (parFamille.get(u.famille) ?? 0) + 1);
      for (const choix of classerCombinaisons(libres, parFamille, params.brief).slice(0, 5)) {
        try {
          await CombinaisonUsage.create({
            niche: idNiche,
            cycle,
            cle: choix.cle,
            famille: choix.famille,
            hero: choix.hero,
            nav: choix.nav,
            densite: choix.densite,
            ...(params.siteId ? { siteId: params.siteId } : {}),
          });
          const { cle: _c, rang: _r, motsCles: _m, ...combinaison } = choix;
          return combinaison;
        } catch (err) {
          if (!erreurDoublon(err)) throw err;
          // Prise à l'instant par un autre site du même métier : suivante.
        }
      }
    }
  } catch (err) {
    console.warn('[combinaison] Réservation impossible, choix sans mémoire pour ce site', err);
  }
  return sansBase();
}

export function cleCombinaison(c: Pick<CombinaisonSite, 'famille' | 'hero' | 'nav' | 'densite'>): string {
  return `${c.famille}|${c.hero}|${c.nav}|${c.densite}`;
}
