import { createHash } from 'crypto';
import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * Bunny Stream — hébergement des vidéos de l'Académie.
 *
 * Pourquoi Bunny plutôt que Cloudinary pour la vidéo :
 *  · encodage, lecteur et protections inclus, on ne paie que le stockage
 *    (dès 0,01 $/Go/mois) et la diffusion (dès 0,005 $/Go), minimum 1 $/mois ;
 *  · lecteur intégré sur player.mediadelivery.net avec lien signé
 *    (token + expiration) : sans lien valide, la vidéo ne se lit pas.
 *
 * Les PDF restent sur Cloudinary (le filigrane nominatif y est déjà branché).
 *
 * Documentation : https://bunny.net/docs/api-reference/stream/
 */

const API_BASE = 'https://video.bunnycdn.com';
const PLAYER_BASE = 'https://player.mediadelivery.net/embed';

export function bunnyConfigured(): boolean {
  return Boolean(env.BUNNY_STREAM_LIBRARY_ID && env.BUNNY_STREAM_API_KEY);
}

function exigerConfiguration(): void {
  if (!bunnyConfigured()) {
    throw new AppError(
      'Bunny Stream non configuré (BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY manquants sur Render).',
      503
    );
  }
}

function enTetes(extra: Record<string, string> = {}): Record<string, string> {
  return { AccessKey: env.BUNNY_STREAM_API_KEY, accept: 'application/json', ...extra };
}

async function lireErreur(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/** Crée l'entrée vidéo (vide) et renvoie son GUID. */
export async function creerVideo(titre: string): Promise<string> {
  exigerConfiguration();
  const res = await fetch(`${API_BASE}/library/${env.BUNNY_STREAM_LIBRARY_ID}/videos`, {
    method: 'POST',
    headers: enTetes({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title: titre.slice(0, 200) || 'Vidéo Académie NexAI' }),
  });
  if (!res.ok) {
    throw new AppError(`Bunny : création de la vidéo impossible (${res.status}) ${await lireErreur(res)}`, 502);
  }
  const data = (await res.json()) as { guid?: string };
  if (!data.guid) throw new AppError('Bunny : réponse sans identifiant de vidéo', 502);
  return data.guid;
}

/**
 * Paramètres d'envoi : sous-titres français générés automatiquement par
 * Bunny (utile pour l'accessibilité et pour les vidéos sans sous-titres).
 */
const PARAMS_UPLOAD = 'transcribeEnabled=true&transcribeLanguages=fr&sourceLanguage=fr';

/** Envoie un fichier déjà en mémoire (upload admin). Renvoie le GUID Bunny. */
export async function envoyerVideoBuffer(buffer: Buffer, titre: string): Promise<string> {
  const guid = await creerVideo(titre);
  const res = await fetch(
    `${API_BASE}/library/${env.BUNNY_STREAM_LIBRARY_ID}/videos/${guid}?${PARAMS_UPLOAD}`,
    {
      method: 'PUT',
      headers: enTetes({ 'Content-Type': 'application/octet-stream' }),
      body: buffer,
    }
  );
  if (!res.ok) {
    void supprimerVideo(guid);
    throw new AppError(`Bunny : envoi de la vidéo impossible (${res.status}) ${await lireErreur(res)}`, 502);
  }
  return guid;
}

/**
 * Envoie un fichier vidéo du disque (vidéos IA fabriquées par le serveur), en
 * flux : le fichier n'est jamais chargé entièrement en mémoire.
 */
export async function envoyerVideoFichier(chemin: string, titre: string): Promise<string> {
  const { createReadStream, promises: fsp } = await import('fs');
  const { Readable } = await import('stream');
  const taille = (await fsp.stat(chemin)).size;
  const guid = await creerVideo(titre);
  const init: RequestInit & { duplex: 'half' } = {
    method: 'PUT',
    headers: enTetes({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(taille) }),
    body: Readable.toWeb(createReadStream(chemin)) as unknown as RequestInit['body'],
    duplex: 'half',
  };
  const res = await fetch(`${API_BASE}/library/${env.BUNNY_STREAM_LIBRARY_ID}/videos/${guid}?${PARAMS_UPLOAD}`, init);
  if (!res.ok) {
    void supprimerVideo(guid);
    throw new AppError(`Bunny : envoi de la vidéo impossible (${res.status}) ${await lireErreur(res)}`, 502);
  }
  return guid;
}

/**
 * Transfère une vidéo depuis une URL publique (PeerTube) vers Bunny, en flux :
 * le fichier n'est jamais chargé entièrement en mémoire sur le serveur NexAI.
 */
export async function importerVideoDepuisUrl(url: string, titre: string): Promise<string> {
  exigerConfiguration();
  const source = await fetch(url, { redirect: 'follow' });
  if (!source.ok || !source.body) {
    throw new AppError(`Téléchargement de la vidéo source impossible (${source.status})`, 502);
  }
  const guid = await creerVideo(titre);
  const longueur = source.headers.get('content-length');
  const init: RequestInit & { duplex: 'half' } = {
    method: 'PUT',
    headers: enTetes({
      'Content-Type': 'application/octet-stream',
      ...(longueur ? { 'Content-Length': longueur } : {}),
    }),
    body: source.body as unknown as RequestInit['body'],
    duplex: 'half',
  };
  const res = await fetch(
    `${API_BASE}/library/${env.BUNNY_STREAM_LIBRARY_ID}/videos/${guid}?${PARAMS_UPLOAD}`,
    init
  );
  if (!res.ok) {
    void supprimerVideo(guid);
    throw new AppError(`Bunny : import de la vidéo impossible (${res.status}) ${await lireErreur(res)}`, 502);
  }
  return guid;
}

export interface EtatVideoBunny {
  /** 0 créée, 1 envoyée, 2 traitement, 3 encodage, 4 prête, 5 erreur, 6 envoi échoué */
  status: number;
  pret: boolean;
  duree: number;
  progression: number;
}

export async function etatVideo(guid: string): Promise<EtatVideoBunny> {
  exigerConfiguration();
  const res = await fetch(`${API_BASE}/library/${env.BUNNY_STREAM_LIBRARY_ID}/videos/${guid}`, {
    headers: enTetes(),
  });
  if (!res.ok) throw new AppError(`Bunny : vidéo introuvable (${res.status})`, 404);
  const v = (await res.json()) as { status?: number; length?: number; encodeProgress?: number };
  return {
    status: v.status ?? 0,
    pret: v.status === 4,
    duree: v.length ?? 0,
    progression: v.encodeProgress ?? 0,
  };
}

/** Suppression best-effort (ne lève jamais : nettoyage). */
export async function supprimerVideo(guid: string): Promise<void> {
  if (!bunnyConfigured() || !guid) return;
  try {
    await fetch(`${API_BASE}/library/${env.BUNNY_STREAM_LIBRARY_ID}/videos/${guid}`, {
      method: 'DELETE',
      headers: enTetes(),
    });
  } catch {
    /* nettoyage best-effort */
  }
}

/**
 * Lien de lecture signé : SHA256_HEX(clé_token + guid + expiration).
 * Sans clé de token configurée, le lien est renvoyé non signé — la
 * bibliothèque doit alors avoir l'authentification par token désactivée
 * (déconseillé en production : n'importe qui ayant le lien pourrait lire).
 *
 * Paramètres du lecteur : pas de lecture automatique au chargement de la
 * page, reprise là où l'élève s'était arrêté, vitesse de lecture réglable.
 */
export function lienLectureSigne(guid: string, ttlSecondes = env.BUNNY_STREAM_TOKEN_TTL): string {
  const base = `${PLAYER_BASE}/${env.BUNNY_STREAM_LIBRARY_ID}/${guid}`;
  const options = 'autoplay=false&preload=true&responsive=true&rememberPosition=true';
  if (!env.BUNNY_STREAM_TOKEN_KEY) return `${base}?${options}`;
  const expires = Math.floor(Date.now() / 1000) + ttlSecondes;
  const token = createHash('sha256')
    .update(env.BUNNY_STREAM_TOKEN_KEY + guid + String(expires))
    .digest('hex');
  return `${base}?token=${token}&expires=${expires}&${options}`;
}
