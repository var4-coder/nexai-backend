import { Site } from '@/models/Site';
import { Types } from 'mongoose';
import { AppError } from '@/middleware/errorHandler';

/**
 * Analyse SEO des sites générés.
 *
 * Aucune donnée externe n'est nécessaire : le HTML produit est déjà stocké
 * dans la proposition retenue. On l'analyse directement, ce qui rend cette
 * fonction immédiate et sans coût d'API.
 *
 * Les règles suivent ce que le Codeur est censé produire (voir la librairie
 * de design) : le score mesure donc aussi la qualité réelle du pipeline.
 */

export interface PointSeo {
  code: string;
  libelle: string;
  /** 'ok' = respecté · 'attention' = améliorable · 'probleme' = manquant */
  etat: 'ok' | 'attention' | 'probleme';
  /** Ce que le client doit comprendre, sans jargon technique */
  explication: string;
  /** Poids dans le score final */
  poids: number;
}

export interface RapportSeo {
  siteId: string;
  nom: string;
  enLigne: boolean;
  score: number;
  points: PointSeo[];
  resume: string;
}

/** Extrait le contenu d'une balise, insensible à la casse. */
function extraire(html: string, motif: RegExp): string | null {
  const m = html.match(motif);
  return m ? m[1].trim() : null;
}

function analyserHtml(html: string): PointSeo[] {
  const points: PointSeo[] = [];

  // ── Titre de la page ──────────────────────────────────────────
  const titre = extraire(html, /<title[^>]*>([^<]*)<\/title>/i);
  if (!titre) {
    points.push({
      code: 'title',
      libelle: 'Titre de la page',
      etat: 'probleme',
      explication:
        "Aucun titre défini. C'est la première ligne que Google affiche dans ses résultats : sans elle, votre site est presque invisible.",
      poids: 20,
    });
  } else if (titre.length < 25 || titre.length > 65) {
    points.push({
      code: 'title',
      libelle: 'Titre de la page',
      etat: 'attention',
      explication: `Votre titre fait ${titre.length} caractères. L'idéal se situe entre 25 et 65 : plus court il manque d'informations, plus long Google le coupe.`,
      poids: 20,
    });
  } else {
    points.push({
      code: 'title',
      libelle: 'Titre de la page',
      etat: 'ok',
      explication: `« ${titre} » — longueur adaptée à l'affichage dans Google.`,
      poids: 20,
    });
  }

  // ── Description ───────────────────────────────────────────────
  const desc = extraire(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  if (!desc) {
    points.push({
      code: 'description',
      libelle: 'Description',
      etat: 'probleme',
      explication:
        "Aucune description. C'est le texte affiché sous le titre dans Google : il décide si le visiteur clique ou passe au suivant.",
      poids: 18,
    });
  } else if (desc.length < 70 || desc.length > 160) {
    points.push({
      code: 'description',
      libelle: 'Description',
      etat: 'attention',
      explication: `Votre description fait ${desc.length} caractères. Visez 70 à 160 pour qu'elle s'affiche entièrement.`,
      poids: 18,
    });
  } else {
    points.push({
      code: 'description',
      libelle: 'Description',
      etat: 'ok',
      explication: 'Description présente et de longueur adaptée.',
      poids: 18,
    });
  }

  // ── Titre principal H1 ────────────────────────────────────────
  const h1 = html.match(/<h1[^>]*>/gi)?.length ?? 0;
  points.push({
    code: 'h1',
    libelle: 'Titre principal (H1)',
    etat: h1 === 1 ? 'ok' : h1 === 0 ? 'probleme' : 'attention',
    explication:
      h1 === 1
        ? 'Un seul titre principal, comme attendu.'
        : h1 === 0
        ? "Aucun titre principal. Google ne comprend pas de quoi parle la page."
        : `${h1} titres principaux détectés. Un seul est recommandé, sinon le sujet de la page devient ambigu.`,
    poids: 14,
  });

  // ── Images et texte alternatif ────────────────────────────────
  const images = html.match(/<img[^>]*>/gi) ?? [];
  const sansAlt = images.filter((i) => !/\balt\s*=/i.test(i)).length;
  if (images.length === 0) {
    points.push({
      code: 'images',
      libelle: 'Images',
      etat: 'attention',
      explication: "Aucune image. Les pages illustrées retiennent nettement mieux l'attention.",
      poids: 10,
    });
  } else {
    points.push({
      code: 'images',
      libelle: 'Texte alternatif des images',
      etat: sansAlt === 0 ? 'ok' : 'attention',
      explication:
        sansAlt === 0
          ? `Vos ${images.length} images sont toutes décrites — bon pour Google et pour l'accessibilité.`
          : `${sansAlt} image(s) sur ${images.length} sans description. Google ne peut pas les interpréter.`,
      poids: 10,
    });
  }

  // ── Affichage mobile ──────────────────────────────────────────
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  points.push({
    code: 'mobile',
    libelle: 'Affichage mobile',
    etat: viewport ? 'ok' : 'probleme',
    explication: viewport
      ? "Votre site s'adapte aux téléphones."
      : "Réglage mobile absent : le site s'affichera mal sur téléphone, où se trouve la majorité de vos visiteurs.",
    poids: 16,
  });

  // ── Partage sur les réseaux sociaux ───────────────────────────
  const og = /<meta[^>]+property=["']og:(title|image|description)["']/i.test(html);
  points.push({
    code: 'partage',
    libelle: 'Aperçu lors du partage',
    etat: og ? 'ok' : 'attention',
    explication: og
      ? "Un aperçu soigné s'affiche quand votre lien est partagé sur WhatsApp ou Facebook."
      : "Sans ces informations, votre lien partagé apparaît sans image ni description — beaucoup moins engageant.",
    poids: 12,
  });

  // ── Langue déclarée ───────────────────────────────────────────
  const lang = /<html[^>]+lang\s*=/i.test(html);
  points.push({
    code: 'langue',
    libelle: 'Langue du site',
    etat: lang ? 'ok' : 'attention',
    explication: lang
      ? 'La langue est déclarée : Google sait à quel public proposer votre site.'
      : "Langue non déclarée. Google peut proposer votre site au mauvais public.",
    poids: 10,
  });

  return points;
}

function calculerScore(points: PointSeo[]): number {
  const total = points.reduce((s, p) => s + p.poids, 0);
  const obtenu = points.reduce(
    (s, p) => s + (p.etat === 'ok' ? p.poids : p.etat === 'attention' ? p.poids * 0.5 : 0),
    0
  );
  return total === 0 ? 0 : Math.round((obtenu / total) * 100);
}

function resumer(score: number, points: PointSeo[]): string {
  const problemes = points.filter((p) => p.etat === 'probleme').length;
  if (score >= 85) return 'Votre site est bien optimisé pour Google.';
  if (score >= 65) {
    return problemes > 0
      ? `Bon niveau, mais ${problemes} point(s) important(s) à corriger.`
      : 'Bon niveau — quelques réglages suffiraient à le rendre excellent.';
  }
  return `Plusieurs éléments essentiels manquent (${problemes} point(s) bloquant(s)). Utilisez « Améliorer avec l'IA » pour les corriger automatiquement.`;
}

/** Analyse un site précis. */
export async function analyserSeoSite(
  siteId: string,
  userId: Types.ObjectId | string
): Promise<RapportSeo> {
  const site = await Site.findById(siteId);
  if (!site) throw new AppError('Site introuvable.', 404);
  if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé.', 403);

  const props = site.proposals ?? [];
  const retenue = site.chosenProposalId
    ? props.find((p) => p.versionId === site.chosenProposalId)
    : props[0];
  const html = retenue?.htmlDemo;

  if (!html) {
    throw new AppError("Ce site n'a pas encore de contenu à analyser.", 409);
  }

  const points = analyserHtml(html);
  const score = calculerScore(points);

  return {
    siteId: String(site._id),
    nom: site.name ?? 'Site sans nom',
    enLigne: site.status === 'launched',
    score,
    points,
    resume: resumer(score, points),
  };
}

/** Analyse tous les sites du client, pour la vue d'ensemble. */
export async function analyserSeoTousSites(userId: Types.ObjectId | string) {
  const sites = await Site.find({
    userId,
    status: { $in: ['ready', 'launched'] },
  })
    .select('name status proposals chosenProposalId')
    .limit(50);

  const rapports: RapportSeo[] = [];
  for (const site of sites) {
    const props = site.proposals ?? [];
    const retenue = site.chosenProposalId
      ? props.find((p) => p.versionId === site.chosenProposalId)
      : props[0];
    if (!retenue?.htmlDemo) continue;

    const points = analyserHtml(retenue.htmlDemo);
    const score = calculerScore(points);
    rapports.push({
      siteId: String(site._id),
      nom: site.name ?? 'Site sans nom',
      enLigne: site.status === 'launched',
      score,
      points,
      resume: resumer(score, points),
    });
  }

  const moyenne =
    rapports.length === 0
      ? null
      : Math.round(rapports.reduce((s, r) => s + r.score, 0) / rapports.length);

  return { sites: rapports, scoreMoyen: moyenne };
}
