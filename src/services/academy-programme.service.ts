import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { callClaude } from '@/services/ai-clients';
import { aUnAbonnementActif } from '@/utils/abonnement';
import type { UserPlan } from '@/models/User';
import { AcademyDomaine } from '@/models/AcademyDomaine';
import { AcademyPack } from '@/models/AcademyPack';
import type { AcademyGenre, AcademyPartie } from '@/models/AcademyContent';
import { ACADEMY_MODULES, TEXTES_VENTE, trouverFormationDef, trouverModule } from '@/data/academy-modules';

// ─── Programme : création des 22 domaines et 60 formations ───────────────

let catalogueEnCours: Promise<void> | null = null;

/**
 * Copie en base les domaines et formations du programme (textes de base).
 * Idempotent : ne crée que ce qui manque, n'écrase JAMAIS un texte modifié
 * dans l'admin. Appelé au démarrage et avant chaque lecture du catalogue
 * (une seule exécution par processus, sauf échec).
 */
export function assurerCatalogue(): Promise<void> {
  if (!catalogueEnCours) {
    catalogueEnCours = (async () => {
      for (const m of ACADEMY_MODULES) {
        await AcademyDomaine.updateOne(
          { slug: m.slug },
          { $setOnInsert: { slug: m.slug, accroche: m.accroche, description: m.description } },
          { upsert: true }
        );
        for (const [i, f] of m.formations.entries()) {
          await AcademyPack.updateOne(
            { slug: f.slug },
            {
              $setOnInsert: {
                slug: f.slug,
                titre: f.titre,
                accroche: f.accroche,
                description: f.description,
                pratique: f.pratique,
                module: m.slug,
                ordre: i + 1,
                creditsCost: 0,
                access: 'gratuit',
                // Publiée d'office : une formation n'apparaît côté client
                // que lorsqu'elle contient au moins une leçon publiée.
                status: 'publié',
              },
            },
            { upsert: true }
          );
        }
      }
    })().catch((e) => {
      catalogueEnCours = null;
      throw e;
    });
  }
  return catalogueEnCours;
}

// ─── Règles d'accès (option C, validée le 25/09/2026) ─────────────────────

export type StatutAcademie = 'abonne' | 'essai' | 'libre';

/**
 *  · abonne : abonnement actif (Starter et +) ou administrateur → tout.
 *  · essai  : essai de 7 jours en cours → vidéos IA « bases » et « complet ».
 *  · libre  : essai terminé ou abonnement expiré → tout est visible, rien ne s'ouvre.
 */
export function statutAcademie(
  user: { plan: UserPlan; role?: string; planExpiresAt?: Date | null; trialEndsAt?: Date | null },
  maintenant = new Date()
): StatutAcademie {
  if (aUnAbonnementActif(user, maintenant)) return 'abonne';
  if (user.plan === 'trial') {
    // Même règle que credits.service : un essai sans date de fin est considéré en cours.
    if (!user.trialEndsAt || new Date(user.trialEndsAt).getTime() > maintenant.getTime()) return 'essai';
  }
  return 'libre';
}

export function estVerrouillee(
  lecon: { partie?: AcademyPartie | string; genre?: AcademyGenre | string },
  statut: StatutAcademie,
  formationReserveeAbonnes: boolean
): boolean {
  if (statut === 'abonne') return false;
  if (statut === 'libre') return true;
  // Essai : on comprend gratuitement, on pratique en payant.
  if (formationReserveeAbonnes) return true;
  return !(lecon.genre === 'ia' && (lecon.partie === 'bases' || lecon.partie === 'complet'));
}

/** Badge « pratique » d'une formation, calculé sur son contenu RÉEL (jamais promis à vide). */
export function badgePratique(genres: (string | undefined)[]): string | null {
  const reelle = genres.includes('reelle');
  const ia = genres.includes('pratique_ia');
  if (reelle && ia) return TEXTES_VENTE.pratiqueMixte;
  if (reelle) return TEXTES_VENTE.pratiqueReelle;
  if (ia) return TEXTES_VENTE.pratiqueIa;
  return null;
}

// ─── Images Pexels (domaines et formations) ───────────────────────────────

interface PhotoPexels {
  url: string;
  photographe: string;
}

/**
 * Recherche simple par mots-clés (anglais), orientation paysage. Pas de tri
 * par IA ici : 82 images en une fois doivent rester gratuites et rapides.
 * `rang` permet « Changer d'image » : on prend le résultat suivant.
 */
export async function chercherImagePexels(motsCles: string, rang = 0): Promise<PhotoPexels> {
  if (!env.PEXELS_API_KEY) throw new AppError('PEXELS_API_KEY manquante sur Render.', 503);
  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(motsCles)}&per_page=15&orientation=landscape`,
    { headers: { Authorization: env.PEXELS_API_KEY } }
  );
  if (!res.ok) throw new AppError(`Pexels : recherche impossible (${res.status})`, 502);
  const data = (await res.json()) as {
    photos?: { photographer?: string; src?: { large?: string; landscape?: string; large2x?: string } }[];
  };
  const photos = (data.photos || []).filter((p) => p.src?.large || p.src?.landscape);
  if (photos.length === 0) throw new AppError(`Pexels : aucune image pour « ${motsCles} »`, 404);
  const p = photos[rang % photos.length];
  return { url: (p.src?.large || p.src?.landscape) as string, photographe: p.photographer || 'Pexels' };
}

/** Rang actuel d'une image : pour passer à la suivante sans retomber sur la même. */
const rangsImages = new Map<string, number>();

export async function genererImages(opts: {
  cible?: { type: 'domaine' | 'formation'; slug: string };
  forcer?: boolean;
}): Promise<{ mises: number; echecs: string[] }> {
  await assurerCatalogue();
  const echecs: string[] = [];
  let mises = 0;

  const traiter = async (cle: string, motsCles: string, actuelle: string | undefined, appliquer: (p: PhotoPexels) => Promise<void>) => {
    if (actuelle && !opts.forcer && !opts.cible) return;
    const rang = opts.cible ? (rangsImages.get(cle) ?? 0) + (actuelle ? 1 : 0) : 0;
    try {
      const photo = await chercherImagePexels(motsCles, rang);
      rangsImages.set(cle, rang);
      await appliquer(photo);
      mises++;
    } catch (e) {
      echecs.push(`${cle} : ${(e as Error).message}`);
    }
  };

  for (const m of ACADEMY_MODULES) {
    if (!opts.cible || (opts.cible.type === 'domaine' && opts.cible.slug === m.slug)) {
      const d = await AcademyDomaine.findOne({ slug: m.slug });
      await traiter(`d:${m.slug}`, m.motsClesImage, d?.imageUrl, async (p) => {
        await AcademyDomaine.updateOne({ slug: m.slug }, { imageUrl: p.url, imagePhotographe: p.photographe });
      });
    }
    for (const f of m.formations) {
      if (!opts.cible || (opts.cible.type === 'formation' && opts.cible.slug === f.slug)) {
        const pack = await AcademyPack.findOne({ slug: f.slug });
        await traiter(`f:${f.slug}`, f.motsClesImage, pack?.imageUrl, async (p) => {
          await AcademyPack.updateOne({ slug: f.slug }, { imageUrl: p.url, imagePhotographe: p.photographe });
        });
      }
    }
  }
  return { mises, echecs };
}

// ─── Textes réécrits par Sonnet (sur demande de l'admin) ──────────────────

const CONSIGNE_TEXTES = [
  "Tu es le rédacteur de l'Académie NexAI : des formations au digital pour un public francophone",
  "(Afrique de l'Ouest et France), débutant à intermédiaire. Chaque formation se déroule en trois temps :",
  'les bases générales, puis la formation complète : le cours (vidéos animées expliquées par le formateur IA NexAI),',
  "la phase pratique (là où la vraie formation commence) et le Kit Expert (guides, modèles, check-lists). Ton style : clair, chaleureux, concret, qui donne envie",
  "sans jamais promettre de gains d'argent, de résultats garantis ni de chiffres inventés.",
  'Réponds UNIQUEMENT en JSON strict, sans texte autour.',
].join('\n');

function lireJson(texte: string): Record<string, string> {
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut < 0 || fin <= debut) throw new AppError('Réponse IA illisible', 502);
  return JSON.parse(texte.slice(debut, fin + 1)) as Record<string, string>;
}

export async function regenererTextes(cible: { type: 'domaine' | 'formation'; slug: string }) {
  await assurerCatalogue();
  if (cible.type === 'domaine') {
    const m = trouverModule(cible.slug);
    if (!m) throw new AppError('Domaine inconnu', 404);
    const actuel = await AcademyDomaine.findOne({ slug: m.slug });
    const r = lireJson(
      await callClaude(
        'claude-sonnet-5',
        CONSIGNE_TEXTES,
        [
          {
            role: 'user',
            content: `Domaine : « ${m.titre} ». Formations : ${m.formations.map((f) => f.titre).join(' ; ')}.
Texte actuel — accroche : « ${actuel?.accroche ?? ''} » ; description : « ${actuel?.description ?? ''} ».
Propose une version plus attirante : {"accroche": "une phrase de 12 mots maximum", "description": "2 phrases maximum"}`,
          },
        ],
        { maxTokens: 400 }
      )
    );
    if (!r.accroche || !r.description) throw new AppError('Réponse IA incomplète', 502);
    return AcademyDomaine.findOneAndUpdate(
      { slug: m.slug },
      { accroche: r.accroche.slice(0, 200), description: r.description.slice(0, 600) },
      { new: true }
    );
  }
  const def = trouverFormationDef(cible.slug);
  if (!def) throw new AppError('Formation inconnue', 404);
  const actuel = await AcademyPack.findOne({ slug: cible.slug });
  const r = lireJson(
    await callClaude(
      'claude-sonnet-5',
      CONSIGNE_TEXTES,
      [
        {
          role: 'user',
          content: `Formation : « ${actuel?.titre ?? def.formation.titre} » (domaine « ${def.module.titre} »).
Texte actuel — accroche : « ${actuel?.accroche ?? ''} » ; description : « ${actuel?.description ?? ''} » ; pratique : « ${actuel?.pratique ?? ''} ».
Propose une version plus attirante : {"accroche": "une phrase de 12 mots maximum", "description": "2 phrases maximum : ce que l'on apprend", "pratique": "1 phrase : ce que la pratique apporte concrètement"}`,
        },
      ],
      { maxTokens: 500 }
    )
  );
  if (!r.accroche || !r.description) throw new AppError('Réponse IA incomplète', 502);
  return AcademyPack.findOneAndUpdate(
    { slug: cible.slug },
    {
      accroche: r.accroche.slice(0, 200),
      description: r.description.slice(0, 800),
      ...(r.pratique ? { pratique: r.pratique.slice(0, 300) } : {}),
    },
    { new: true }
  );
}
