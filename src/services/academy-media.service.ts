import { uploadAcademyVideo, deleteAcademyResource } from '@/services/cloudinary.service';
import { bunnyConfigured, envoyerVideoBuffer, supprimerVideo } from '@/services/bunny-stream.service';
import type { AcademyHosting } from '@/models/AcademyContent';

/**
 * Point d'entrée unique pour stocker une VIDÉO de l'Académie.
 *
 * Bunny Stream dès qu'il est configuré ; sinon Cloudinary, comme avant.
 * Toutes les routes d'upload (upload simple, auto-upload, import de pack,
 * dépôt du fichier d'un candidat du catalogue) passent par ici : on ne
 * change de fournisseur qu'à un seul endroit.
 */
export async function stockerVideoAcademie(
  buffer: Buffer,
  nomFichier: string
): Promise<{ hosting: AcademyHosting; sourceUrl: string }> {
  if (bunnyConfigured()) {
    const titre = nomFichier.replace(/\.[a-z0-9]{2,4}$/i, '');
    return { hosting: 'bunny', sourceUrl: await envoyerVideoBuffer(buffer, titre) };
  }
  return { hosting: 'cloudinary', sourceUrl: await uploadAcademyVideo(buffer, nomFichier) };
}

/** Nettoyage best-effort du fichier stocké d'un contenu (ne lève jamais). */
export function supprimerMediaAcademie(
  hosting: AcademyHosting | string,
  sourceUrl: string,
  type: 'pdf' | 'video'
): void {
  if (!sourceUrl) return;
  if (hosting === 'bunny') {
    void supprimerVideo(sourceUrl);
  } else if (hosting === 'cloudinary') {
    void deleteAcademyResource(sourceUrl, type === 'video' ? 'video' : 'raw').catch(() => undefined);
  }
  // youtube / embed_externe : rien à supprimer chez nous.
}

/** Extrait l'ID YouTube (11 caractères) de toutes les formes d'URL courantes. */
export function extraireIdYoutube(entree: string): string | null {
  const s = entree.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const motifs = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const m of motifs) {
    const r = s.match(m);
    if (r) return r[1];
  }
  return null;
}
