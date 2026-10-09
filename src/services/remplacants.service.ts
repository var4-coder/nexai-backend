import { AppConfig } from '@/models/AppConfig';

/**
 * Remplaçants automatiques Claude ⇄ Grok (décision du 09/10/2026).
 *
 * Quand un modèle échoue (panne, saturation, crédit épuisé, clé absente),
 * l'appel repart sur le modèle choisi ici pour sa FAMILLE, chez l'autre
 * fournisseur. Réglable dans l'admin (Équipe IA → Remplaçants automatiques) ;
 * « aucun » = pas de remplaçant (l'étape est sautée si elle n'est pas
 * indispensable, sinon le client voit « Service indisponible »).
 *
 * Exclus volontairement (ils ne passent jamais par ces remplaçants) :
 *  - les conversations et l'Assistance : leur remplaçant est réglé par
 *    conversation (Grok 4.6 par défaut) ;
 *  - la traduction : Grok 4.3, réglé à part ;
 *  - le codeur du site Premium : notre meilleure IA, jamais remplacée ;
 *  - le juge du code : sauté en cas de panne (un modèle ne juge jamais son propre travail).
 */

export const AUCUN = 'aucun';

export type Famille = 'haiku' | 'sonnet' | 'opus' | 'grok_fort' | 'grok_build' | 'grok_43';

export const FAMILLES: Record<Famille, { libelle: string; defaut: string; choix: string[] }> = {
  haiku: {
    libelle: 'Claude Haiku 4.5 (vérification de la demande, contrôles rapides)',
    defaut: 'grok-4.3',
    choix: ['grok-4.3', 'grok-4.6', AUCUN],
  },
  sonnet: {
    libelle: 'Claude Sonnet 5.5 (modification IA, logo, script vidéo, images, contrôle des activités, IA Aide…)',
    defaut: 'grok-4.7',
    choix: ['grok-4.7', 'grok-4.6', AUCUN],
  },
  opus: {
    libelle: 'Claude Opus 5.5 (juge visuel, IA Aide payante, agents qualité — jamais le site Premium)',
    defaut: 'grok-4.7',
    choix: ['grok-4.7', 'grok-4.6', AUCUN],
  },
  grok_fort: {
    libelle: 'Grok 4.7 / 4.6 / 4.5 (codeur du site Standard et de l’essai)',
    defaut: 'claude-sonnet-5-5',
    choix: ['claude-sonnet-5-5', AUCUN],
  },
  grok_build: {
    libelle: 'Grok Build (réparateur de code)',
    defaut: 'claude-sonnet-5-5',
    choix: ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', AUCUN],
  },
  grok_43: {
    libelle: 'Grok 4.3',
    defaut: 'claude-haiku-4-5-20251001',
    choix: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', AUCUN],
  },
};

export function familleDe(modele: string): Famille | null {
  if (modele.startsWith('claude-haiku')) return 'haiku';
  if (modele.startsWith('claude-opus') || modele.startsWith('claude-fable')) return 'opus';
  if (modele.startsWith('claude-')) return 'sonnet';
  if (modele === 'grok-build-0.1') return 'grok_build';
  if (modele === 'grok-4.3') return 'grok_43';
  if (modele.startsWith('grok-')) return 'grok_fort';
  return null;
}

const CLE = 'remplacants_automatiques';
let cache: { valeurs: Partial<Record<Famille, string>>; lu: number } | null = null;

async function lire(): Promise<Partial<Record<Famille, string>>> {
  if (cache && Date.now() - cache.lu < 30_000) return cache.valeurs;
  let valeurs: Partial<Record<Famille, string>> = {};
  try {
    const ligne = await AppConfig.findOne({ key: CLE }).lean();
    if (ligne?.value) valeurs = JSON.parse(ligne.value);
  } catch {
    valeurs = cache?.valeurs ?? {};
  }
  cache = { valeurs, lu: Date.now() };
  return valeurs;
}

function valide(f: Famille, v: string | undefined): string {
  const e = FAMILLES[f];
  return v && e.choix.includes(v) ? v : e.defaut;
}

/** Réglages pour l'admin. */
export async function listerRemplacants() {
  const v = await lire();
  return (Object.keys(FAMILLES) as Famille[]).map((f) => ({
    famille: f,
    libelle: FAMILLES[f].libelle,
    actif: valide(f, v[f]),
    defaut: FAMILLES[f].defaut,
    choix: FAMILLES[f].choix,
  }));
}

export async function reglerRemplacant(famille: Famille, modele: string) {
  if (!FAMILLES[famille]) throw new Error(`Famille inconnue : ${famille}`);
  if (!FAMILLES[famille].choix.includes(modele)) {
    throw new Error(`Remplaçant non autorisé pour ${famille} : ${modele}`);
  }
  const v = { ...(await lire()), [famille]: modele };
  await AppConfig.findOneAndUpdate({ key: CLE }, { key: CLE, value: JSON.stringify(v) }, { upsert: true });
  cache = null;
  return listerRemplacants();
}

/**
 * Remplaçant à utiliser pour ce modèle, ou null (aucun). `eviter` : modèle
 * qui ne doit pas servir de remplaçant (un modèle ne juge jamais son propre
 * travail) — on prend alors l'autre Grok.
 */
export async function remplacantPour(modele: string, eviter?: string): Promise<string | null> {
  const f = familleDe(modele);
  if (!f) return null;
  const r = valide(f, (await lire())[f]);
  if (r === AUCUN) return null;
  if (eviter && r === eviter) return r === 'grok-4.7' ? 'grok-4.6' : r === 'grok-4.6' ? 'grok-4.7' : null;
  return r;
}

/**
 * Remplaçant pour un appel avec images : forcément un Grok qui lit les
 * images. Si le codeur était Claude, c'est Grok 4.7 qui l'a remplacé
 * pendant la même panne : on l'évite aussi.
 */
export async function remplacantVisionPour(modele: string, eviter?: string): Promise<string | null> {
  let r = await remplacantPour(modele);
  if (!r || !r.startsWith('grok-')) return null;
  if (eviter && r === eviter) r = r === 'grok-4.7' ? 'grok-4.6' : 'grok-4.7';
  if (eviter?.startsWith('claude-') && r === 'grok-4.7') r = 'grok-4.6';
  return r;
}
