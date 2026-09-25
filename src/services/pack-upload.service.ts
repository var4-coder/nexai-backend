import AdmZip from 'adm-zip';
import { AppError } from '@/middleware/errorHandler';

/**
 * Préparation des fichiers d'un PACK (Académie ou Boutique).
 *
 * L'administrateur dispose de deux façons de constituer un pack :
 *  - déposer une archive ZIP contenant plusieurs PDF/vidéos/images ;
 *  - déposer directement plusieurs fichiers.
 *
 * Ce service ramène les deux cas à une même liste de fichiers prêts à être
 * envoyés sur Cloudinary, en écartant tout ce qui n'est pas exploitable.
 */

export type PackFileType = 'pdf' | 'video' | 'image';

export interface PackFile {
  /** Nom d'origine, réutilisé comme titre par défaut du contenu. */
  filename: string;
  buffer: Buffer;
  type: PackFileType;
}

/** Taille maximale cumulée d'une archive décompressée. */
const MAX_TOTAL_UNZIPPED_BYTES = 800 * 1024 * 1024;

/** Nombre maximal de fichiers retenus dans une archive. */
const MAX_FILES_PER_PACK = 200;

const EXTENSIONS: Record<string, PackFileType> = {
  '.pdf': 'pdf',
  '.mp4': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.webm': 'video',
  '.avi': 'video',
  '.mkv': 'video',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.gif': 'image',
};

/** Type de contenu déduit de l'extension, null si le format est ignoré. */
export function typeDepuisNom(nom: string): PackFileType | null {
  const i = nom.lastIndexOf('.');
  if (i === -1) return null;
  return EXTENSIONS[nom.slice(i).toLowerCase()] ?? null;
}

/** true si le fichier est une archive ZIP. */
export function estArchiveZip(mimetype: string, nom: string): boolean {
  return (
    mimetype === 'application/zip' ||
    mimetype === 'application/x-zip-compressed' ||
    mimetype === 'multipart/x-zip' ||
    nom.toLowerCase().endsWith('.zip')
  );
}

/**
 * Extrait les fichiers exploitables d'une archive ZIP.
 *
 * Les dossiers, les fichiers cachés (métadonnées macOS notamment) et les
 * formats non supportés sont ignorés silencieusement : une archive contient
 * presque toujours des fichiers parasites, les refuser bloquerait des imports
 * parfaitement valides.
 *
 * Les chemins contenant ".." sont écartés par sécurité (traversée de
 * répertoire), même si rien n'est écrit sur le disque ici.
 */
export function extraireArchive(buffer: Buffer): PackFile[] {
  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch {
    throw new AppError("Archive ZIP illisible ou corrompue.", 400);
  }

  const fichiers: PackFile[] = [];
  let total = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const nomComplet = entry.entryName;
    if (nomComplet.includes('..')) continue;

    const nom = nomComplet.split('/').pop() || nomComplet;
    // Fichiers cachés et métadonnées d'archivage.
    if (!nom || nom.startsWith('.') || nomComplet.startsWith('__MACOSX/')) continue;

    const type = typeDepuisNom(nom);
    if (!type) continue;

    const data = entry.getData();
    total += data.length;
    if (total > MAX_TOTAL_UNZIPPED_BYTES) {
      throw new AppError(
        "Archive trop volumineuse une fois décompressée. Répartissez son contenu en plusieurs packs.",
        400
      );
    }

    fichiers.push({ filename: nom, buffer: data, type });
    if (fichiers.length >= MAX_FILES_PER_PACK) break;
  }

  if (fichiers.length === 0) {
    throw new AppError(
      "Aucun fichier exploitable dans l'archive (PDF, vidéo ou image attendus).",
      400
    );
  }

  return fichiers;
}

/**
 * Normalise les fichiers reçus en multipart (dépôt multiple) en écartant les
 * formats non supportés.
 */
export function normaliserFichiersMultiples(
  files: { originalname: string; buffer: Buffer; mimetype: string }[]
): PackFile[] {
  const fichiers: PackFile[] = [];
  for (const f of files) {
    const type = typeDepuisNom(f.originalname);
    if (!type) continue;
    fichiers.push({ filename: f.originalname, buffer: f.buffer, type });
  }
  if (fichiers.length === 0) {
    throw new AppError(
      'Aucun fichier exploitable (PDF, vidéo ou image attendus).',
      400
    );
  }
  return fichiers;
}

/** Titre par défaut d'un contenu : nom du fichier sans extension, lisible. */
export function titreDepuisNomFichier(nom: string): string {
  const sansExt = nom.replace(/\.[^.]+$/, '');
  const propre = sansExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!propre) return 'Sans titre';
  return propre.charAt(0).toUpperCase() + propre.slice(1);
}
