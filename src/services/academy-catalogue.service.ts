import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { callClaude } from '@/services/ai-clients';
import { AcademyCandidate, IAcademyCandidate, ICandidateEvaluation } from '@/models/AcademyCandidate';
import { AcademyContent, AcademyLicence, IAcademyContent } from '@/models/AcademyContent';
import { AcademyPack } from '@/models/AcademyPack';
import { trouverModule } from '@/data/academy-modules';
import { bunnyConfigured, importerVideoDepuisUrl } from '@/services/bunny-stream.service';
import { stockerVideoAcademie } from '@/services/academy-media.service';
import { logEvent } from '@/services/logs.service';
import type { HydratedDocument } from 'mongoose';

/**
 * CATALOGUE PEERTUBE DE L'ACADÉMIE — vraies vidéos pratiques sous licence libre.
 *
 * YouTube a été retiré de l'Académie (décision du 25/09/2026).
 *
 * 1. RECHERCHE — par le moteur de recherche de PeerTube (SepiaSearch), pas par
 *    une IA. Uniquement des licences qui autorisent l'usage commercial : CC BY,
 *    CC BY-SA, CC BY-ND, domaine public (toute licence « NC » est exclue).
 * 2. NOTATION — Claude Sonnet 5 juge chaque vidéo à partir de ses sous-titres
 *    (quand ils existent), de son titre et de sa description.
 * 3. IMPORT — un clic : le serveur récupère le fichier chez PeerTube (quand
 *    l'instance autorise le téléchargement) et l'envoie sur Bunny. La vidéo
 *    arrive en BROUILLON dans la « Phase pratique » de la formation choisie,
 *    avec le crédit de son auteur. Rien n'est publié sans l'admin.
 *
 * Règle Creative Commons : pas de DRM sur ces vidéos, crédit obligatoire.
 */

// ─── Recherche ─────────────────────────────────────────────────────────────

const DUREE_MIN_SECONDES = 120; // pas de Shorts ni de teasers

interface CandidatBrut {
  source: 'youtube' | 'peertube';
  externalId: string;
  hote?: string;
  url: string;
  titre: string;
  description?: string;
  auteur: string;
  auteurUrl?: string;
  duree?: number;
  langue?: string;
  licence: IAcademyCandidate['licence'];
  miniatureUrl?: string;
}

/** Identifiants de licence PeerTube → licences acceptées (toutes commerciales). */
const LICENCES_PEERTUBE: Record<number, IAcademyCandidate['licence']> = {
  1: 'cc-by',
  2: 'cc-by-sa',
  3: 'cc-by-nd',
  7: 'cc0',
};

async function rechercherPeertube(requete: string, max: number): Promise<CandidatBrut[]> {
  const params = new URLSearchParams({
    search: requete,
    count: String(Math.min(Math.max(max, 1), 50)),
    durationMin: String(DUREE_MIN_SECONDES),
    sort: '-match',
  });
  for (const id of Object.keys(LICENCES_PEERTUBE)) params.append('licenceOneOf', id);
  params.append('languageOneOf', 'fr');

  const base = env.PEERTUBE_SEARCH_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/api/v1/search/videos?${params}`);
  if (!res.ok) throw new AppError(`PeerTube : recherche impossible (${res.status})`, 502);
  const data = (await res.json()) as {
    data?: {
      uuid?: string;
      shortUUID?: string;
      name?: string;
      description?: string;
      duration?: number;
      url?: string;
      thumbnailUrl?: string;
      thumbnailPath?: string;
      licence?: { id?: number };
      language?: { id?: string };
      account?: { name?: string; displayName?: string; host?: string; url?: string };
      channel?: { displayName?: string; host?: string; url?: string };
    }[];
  };

  const sortie: CandidatBrut[] = [];
  for (const v of data.data || []) {
    const licence = v.licence?.id ? LICENCES_PEERTUBE[v.licence.id] : undefined;
    if (!licence || !v.uuid) continue;
    const hote = v.account?.host || v.channel?.host;
    if (!hote) continue;
    sortie.push({
      source: 'peertube',
      externalId: v.uuid,
      hote,
      url: v.url || `https://${hote}/w/${v.shortUUID || v.uuid}`,
      titre: v.name || 'Sans titre',
      description: (v.description || '').slice(0, 3000),
      auteur: v.channel?.displayName || v.account?.displayName || v.account?.name || 'Chaîne PeerTube',
      auteurUrl: v.channel?.url || v.account?.url,
      duree: v.duration,
      langue: v.language?.id,
      licence,
      miniatureUrl: v.thumbnailUrl || (v.thumbnailPath ? `https://${hote}${v.thumbnailPath}` : undefined),
    });
  }
  return sortie;
}

export async function rechercherCandidats(opts: {
  module: string;
  requete?: string;
  max?: number;
}): Promise<{ trouves: number; nouveaux: number; erreurs: string[]; candidats: unknown[] }> {
  const mod = trouverModule(opts.module);
  if (!mod) throw new AppError('Module inconnu', 400);
  const requete = (opts.requete?.trim() || `formation ${mod.titre}`).slice(0, 200);
  const max = opts.max ?? 25;

  const bruts: CandidatBrut[] = [];
  const erreurs: string[] = [];
  try {
    bruts.push(...(await rechercherPeertube(requete, max)));
  } catch (e) {
    erreurs.push(`PeerTube : ${(e as Error).message}`);
  }

  let nouveaux = 0;
  const ids: string[] = [];
  for (const b of bruts) {
    const r = await AcademyCandidate.findOneAndUpdate(
      { source: b.source, externalId: b.externalId },
      { $setOnInsert: { ...b, module: mod.slug, requete, status: 'trouvee' } },
      { upsert: true, new: true, includeResultMetadata: true }
    );
    if (r.lastErrorObject && !r.lastErrorObject.updatedExisting) nouveaux++;
    if (r.value) ids.push(String(r.value._id));
  }

  const candidats = await AcademyCandidate.find({ _id: { $in: ids } }).sort({ createdAt: -1 });
  return { trouves: bruts.length, nouveaux, erreurs, candidats };
}

// ─── Évaluation ────────────────────────────────────────────────────────────

function consigneEvaluation(c: IAcademyCandidate): string {
  const mod = trouverModule(c.module);
  return [
    "Tu es responsable pédagogique de l'Académie NexAI, une plateforme de formation au digital",
    "pour un public francophone (Afrique de l'Ouest et France), débutant à intermédiaire.",
    `Tu évalues une vidéo candidate pour le module « ${mod?.titre ?? c.module} ».`,
    mod ? `Formations prévues dans ce module : ${mod.formations.map((f) => f.titre).join(' ; ')}.` : '',
    '',
    'Critères (notes entières de 0 à 10) :',
    '- pedagogie : structure claire, explications compréhensibles, exemples concrets, progression.',
    '- qualiteTechnique : son audible et propre, image lisible, écran partagé lisible.',
    '- pertinenceModule : la vidéo enseigne réellement une compétence de ce module.',
    '- actualite : outils et pratiques encore valables aujourd’hui (10 = à jour, 0 = obsolète).',
    '- global : note d’ensemble pour une académie payante et exigeante.',
    'Signale aussi :',
    '- enFrancais : la vidéo est-elle parlée en français ?',
    '- promotionDetectee : sponsor, placement de produit, vente insistante d’une formation ou de liens affiliés DANS la vidéo.',
    '- suspicionReupload : la chaîne semble ne PAS être l’auteur (extrait TV, cours d’un autre organisme, contenu d’un tiers) — la licence serait alors douteuse.',
    'verdict : "recommandee" (global ≥ 7, en français, sans promotion ni suspicion), "acceptable" (5–6), sinon "a_eviter".',
    'formationSuggeree : le titre EXACT de la formation prévue la plus adaptée (ou vide).',
    '',
    'Réponds UNIQUEMENT avec un objet JSON, sans texte autour :',
    '{"pedagogie":0,"qualiteTechnique":0,"pertinenceModule":0,"actualite":0,"global":0,',
    '"enFrancais":true,"promotionDetectee":false,"suspicionReupload":false,',
    '"verdict":"recommandee","resume":"2 phrases en français sur ce que la vidéo enseigne",',
    '"pointsForts":["…"],"pointsFaibles":["…"],"formationSuggeree":"…"}',
  ]
    .filter(Boolean)
    .join('\n');
}

function extraireJson(texte: string): Record<string, unknown> {
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut < 0 || fin <= debut) throw new AppError('Évaluation illisible (pas de JSON)', 502);
  return JSON.parse(texte.slice(debut, fin + 1)) as Record<string, unknown>;
}

function normaliserEvaluation(
  brut: Record<string, unknown>,
  moteur: 'gemini' | 'claude'
): ICandidateEvaluation {
  const note = (v: unknown) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
  const liste = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 5) : []);
  const verdict = ['recommandee', 'acceptable', 'a_eviter'].includes(String(brut.verdict))
    ? (brut.verdict as ICandidateEvaluation['verdict'])
    : 'a_eviter';
  return {
    moteur,
    pedagogie: note(brut.pedagogie),
    qualiteTechnique: note(brut.qualiteTechnique),
    pertinenceModule: note(brut.pertinenceModule),
    actualite: note(brut.actualite),
    global: note(brut.global),
    enFrancais: Boolean(brut.enFrancais),
    promotionDetectee: Boolean(brut.promotionDetectee),
    suspicionReupload: Boolean(brut.suspicionReupload),
    verdict,
    resume: String(brut.resume || '').slice(0, 600),
    pointsForts: liste(brut.pointsForts),
    pointsFaibles: liste(brut.pointsFaibles),
    formationSuggeree: brut.formationSuggeree ? String(brut.formationSuggeree).slice(0, 200) : undefined,
    evalueeLe: new Date(),
  };
}

interface DetailsPeertube {
  downloadEnabled?: boolean;
  description?: string;
  licence?: { id?: number };
  files?: { id?: number; fileDownloadUrl?: string; resolution?: { id?: number }; size?: number }[];
  streamingPlaylists?: {
    files?: { id?: number; fileDownloadUrl?: string; resolution?: { id?: number }; size?: number }[];
  }[];
}

async function detailsPeertube(c: IAcademyCandidate): Promise<DetailsPeertube> {
  const res = await fetch(`https://${c.hote}/api/v1/videos/${c.externalId}`);
  if (!res.ok) throw new AppError(`PeerTube : vidéo indisponible sur ${c.hote} (${res.status})`, 502);
  return (await res.json()) as DetailsPeertube;
}

async function sousTitresPeertube(c: IAcademyCandidate): Promise<string> {
  try {
    const res = await fetch(`https://${c.hote}/api/v1/videos/${c.externalId}/captions`);
    if (!res.ok) return '';
    const data = (await res.json()) as {
      data?: { language?: { id?: string }; captionPath?: string; fileUrl?: string }[];
    };
    const piste = (data.data || []).find((d) => d.language?.id === 'fr') || data.data?.[0];
    const url = piste?.fileUrl || (piste?.captionPath ? `https://${c.hote}${piste.captionPath}` : '');
    if (!url) return '';
    const vtt = await (await fetch(url)).text();
    // On garde le texte parlé, sans horodatages ni numéros de repère.
    return vtt
      .split('\n')
      .filter((l) => l.trim() && !l.includes('-->') && !/^WEBVTT|^\d+$|^NOTE/.test(l.trim()))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .slice(0, 15000);
  } catch {
    return '';
  }
}

/** PeerTube : Claude juge sur les sous-titres (+ titre et description). */
async function evaluerAvecClaude(c: IAcademyCandidate): Promise<ICandidateEvaluation> {
  const details = await detailsPeertube(c).catch(() => null);
  const transcription = await sousTitresPeertube(c);
  const contexte = [
    `Titre : ${c.titre}`,
    `Chaîne : ${c.auteur} (${c.hote})`,
    `Durée : ${c.duree ? Math.round(c.duree / 60) + ' min' : 'inconnue'}`,
    `Description : ${(details?.description || c.description || '').slice(0, 2500)}`,
    transcription
      ? `Transcription (sous-titres) : ${transcription}`
      : "Aucune transcription disponible : juge sur le titre et la description, et reste prudent (qualiteTechnique ≤ 5, verdict au mieux « acceptable »).",
  ].join('\n');
  const texte = await callClaude(
    'claude-sonnet-5',
    consigneEvaluation(c),
    [{ role: 'user', content: contexte }],
    { maxTokens: 1500 }
  );
  const evaluation = normaliserEvaluation(extraireJson(texte), 'claude');
  if (!transcription && evaluation.verdict === 'recommandee') evaluation.verdict = 'acceptable';
  return evaluation;
}

export async function evaluerCandidat(id: string): Promise<HydratedDocument<IAcademyCandidate>> {
  const c = await AcademyCandidate.findById(id);
  if (!c) throw new AppError('Candidat introuvable', 404);
  try {
    c.evaluation = await evaluerAvecClaude(c);
    if (c.status === 'trouvee') c.status = 'evaluee';
    c.derniereErreur = undefined;
  } catch (e) {
    c.derniereErreur = (e as Error).message.slice(0, 500);
    await c.save();
    throw e;
  }
  await c.save();
  return c;
}

// ─── Décisions de l'admin ──────────────────────────────────────────────────

async function verifierPack(packId?: string, module?: string): Promise<string> {
  if (!packId) throw new AppError('Choisissez la formation qui recevra cette vidéo pratique.', 400);
  const pack = await AcademyPack.findById(packId);
  if (!pack) throw new AppError('Formation (pack) introuvable', 404);
  if (module && pack.module && pack.module !== module) {
    throw new AppError('Cette formation appartient à un autre module', 400);
  }
  return String(pack._id);
}

function attributionDe(c: IAcademyCandidate): IAcademyContent['attribution'] {
  return {
    licence: c.licence as AcademyLicence,
    auteur: c.auteur,
    titreOriginal: c.titre,
    sourceUrl: c.url,
    plateforme: `PeerTube (${c.hote})`,
  };
}

/** Quand PeerTube n'autorise pas le téléchargement : message prêt à envoyer à l'auteur pour obtenir le fichier. */
export async function demanderFichierAuteur(id: string): Promise<{ message: string; candidat: unknown }> {
  const c = await AcademyCandidate.findById(id);
  if (!c) throw new AppError('Candidat introuvable', 404);
  if (c.status !== 'importee' || !c.seanceContentId) c.status = 'fichier_a_obtenir';
  await c.save();
  const message = [
    `Bonjour ${c.auteur},`,
    '',
    `Je gère l'Académie NexAI, une plateforme de formation au digital pour un public francophone.`,
    `Votre vidéo « ${c.titre} » (${c.url}) est publiée sous licence Creative Commons (${c.licence.toUpperCase()})`,
    `et nous aimerions l'intégrer à notre parcours « ${trouverModule(c.module)?.titre ?? c.module} »,`,
    'avec un crédit clair à votre nom, le titre original et un lien vers votre chaîne.',
    '',
    `Pour une qualité de lecture optimale, accepteriez-vous de nous transmettre le fichier vidéo original`,
    '(par exemple via un lien Google Drive ou WeTransfer) ?',
    '',
    'Merci pour votre travail et votre partage.',
    'Bien cordialement,',
    "L'équipe NexAI",
  ].join('\n');
  return { message, candidat: c };
}

/** Création du contenu « séance » après stockage du fichier. */
async function creerSeance(
  c: HydratedDocument<IAcademyCandidate>,
  stockage: { hosting: IAcademyContent['hosting']; sourceUrl: string },
  opts: { packId?: string; ordre?: number }
) {
  const packId = await verifierPack(opts.packId, c.module);
  const content = await AcademyContent.create({
    title: c.titre.slice(0, 160),
    description: c.evaluation?.resume || c.description?.slice(0, 500),
    type: 'video',
    access: 'payant',
    status: 'brouillon',
    hosting: stockage.hosting,
    sourceUrl: stockage.sourceUrl,
    role: 'seance',
    partie: 'pratique',
    genre: 'reelle',
    fournisseur: `PeerTube — ${c.auteur}`.slice(0, 200),
    module: c.module,
    packId,
    ordre: opts.ordre ?? (await AcademyContent.countDocuments({ packId, partie: 'pratique' })) + 1,
    duree: c.duree,
    imageUrl: c.miniatureUrl,
    attribution: attributionDe(c),
  });
  c.seanceContentId = content._id;
  c.status = 'importee';
  c.derniereErreur = undefined;
  await c.save();
  await logEvent({
    categorie: 'action_admin',
    niveau: 'info',
    message: `Académie : « ${c.titre} » (${c.licence.toUpperCase()}, ${c.auteur}) ajoutée en brouillon`,
  });
  return content;
}

/** Dépôt du fichier reçu de l'auteur. */
export async function deposerFichierCandidat(
  id: string,
  fichier: { buffer: Buffer; originalname: string },
  opts: { packId?: string; ordre?: number }
) {
  const c = await AcademyCandidate.findById(id);
  if (!c) throw new AppError('Candidat introuvable', 404);
  if (c.seanceContentId) throw new AppError('Le fichier de cette vidéo a déjà été importé.', 409);
  const stockage = await stockerVideoAcademie(fichier.buffer, fichier.originalname);
  return creerSeance(c, stockage, opts);
}

/** PeerTube → import direct sur Bunny, uniquement si l'instance autorise le téléchargement. */
export async function importerDepuisPeertube(id: string, opts: { packId?: string; ordre?: number }) {
  const c = await AcademyCandidate.findById(id);
  if (!c) throw new AppError('Candidat introuvable', 404);
  if (c.source !== 'peertube') throw new AppError('Import direct réservé aux vidéos PeerTube.', 400);
  if (c.seanceContentId) throw new AppError('Cette vidéo a déjà été importée.', 409);
  if (!bunnyConfigured()) {
    throw new AppError('Configurez Bunny Stream avant d’importer des vidéos (variables BUNNY_STREAM_* sur Render).', 503);
  }

  const d = await detailsPeertube(c);
  const licence = d.licence?.id ? LICENCES_PEERTUBE[d.licence.id] : undefined;
  if (!licence) {
    c.status = 'rejetee';
    c.derniereErreur = "La licence de la vidéo a changé et n'autorise plus un usage commercial.";
    await c.save();
    throw new AppError(c.derniereErreur, 409);
  }
  c.telechargementAutorise = d.downloadEnabled !== false;
  if (!c.telechargementAutorise) {
    c.derniereErreur = "L'instance PeerTube n'autorise pas le téléchargement de cette vidéo : demandez le fichier à l'auteur.";
    c.status = 'fichier_a_obtenir';
    await c.save();
    throw new AppError(c.derniereErreur, 409);
  }

  // 1) fichiers « web » (audio + vidéo dans un seul MP4) ; 2) sinon HLS, en
  // demandant à PeerTube de fusionner la meilleure piste vidéo ≤ 1080p et la
  // piste audio séparée (PeerTube récents).
  const web = (d.files || [])
    .filter((f) => f.fileDownloadUrl && (f.resolution?.id ?? 0) > 0 && (f.resolution?.id ?? 0) <= 1080)
    .sort((a, b) => (b.resolution?.id ?? 0) - (a.resolution?.id ?? 0));
  let url = web[0]?.fileDownloadUrl;
  if (!url) {
    const hls = (d.streamingPlaylists || []).flatMap((p) => p.files || []);
    const videos = hls
      .filter((f) => (f.resolution?.id ?? 0) > 0 && (f.resolution?.id ?? 0) <= 1080)
      .sort((a, b) => (b.resolution?.id ?? 0) - (a.resolution?.id ?? 0));
    const audio = hls.find((f) => (f.resolution?.id ?? -1) === 0);
    if (videos[0]?.id !== undefined && audio?.id !== undefined) {
      url = `https://${c.hote}/download/videos/generate/${c.externalId}?videoFileIds=${videos[0].id}&videoFileIds=${audio.id}`;
    } else {
      url = videos[0]?.fileDownloadUrl;
    }
  }
  if (!url) throw new AppError('Aucun fichier téléchargeable trouvé pour cette vidéo.', 502);

  try {
    const guid = await importerVideoDepuisUrl(url, c.titre);
    return await creerSeance(c, { hosting: 'bunny', sourceUrl: guid }, opts);
  } catch (e) {
    c.derniereErreur = (e as Error).message.slice(0, 500);
    await c.save();
    throw e;
  }
}

export async function rejeterCandidat(id: string) {
  const c = await AcademyCandidate.findByIdAndUpdate(id, { status: 'rejetee' }, { new: true });
  if (!c) throw new AppError('Candidat introuvable', 404);
  return c;
}

