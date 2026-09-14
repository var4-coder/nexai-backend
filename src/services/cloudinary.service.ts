import { v2 as cloudinary } from 'cloudinary';
import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';

/**
 * Cloudinary — fichiers Boutique uniquement (signed URLs).
 * Les PDF Academy ne passent JAMAIS par une URL directe (Architecture §7.4 / §11).
 */
function ensureConfigured() {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new AppError('Cloudinary non configuré', 503);
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

/**
 * Génère une signed URL temporaire pour un produit Boutique déjà débloqué.
 * Le client peut re-télécharger illimitément tant que le produit est débloqué.
 * resource_type doit correspondre au type réel du fichier (pdf/archive → 'raw',
 * video → 'video', image → 'image') sinon Cloudinary renvoie un lien invalide.
 */
export function getSignedDownloadUrl(
  publicId: string,
  resourceType: 'raw' | 'video' | 'image' = 'image',
  expiresInSeconds = 3600
): string {
  ensureConfigured();
  const timestamp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return cloudinary.utils.private_download_url(publicId, '', {
    resource_type: resourceType,
    type: 'authenticated',
    expires_at: timestamp,
  });
}

/**
 * Pour les PDF/vidéos Academy hébergés sur Cloudinary : on ne renvoie JAMAIS
 * cette URL au client. Elle est uniquement utilisée en interne, côté serveur,
 * par la route de streaming (academy.routes.ts), avec une expiration très
 * courte (60s) — le temps de faire l'appel serveur→Cloudinary.
 */
export function getAcademyResourceUrl(
  publicId: string,
  resourceType: 'raw' | 'video' = 'raw'
): string {
  ensureConfigured();
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  return cloudinary.utils.private_download_url(publicId, resourceType === 'video' ? 'mp4' : '', {
    resource_type: resourceType,
    type: 'authenticated',
    expires_at: expiresAt,
  });
}

/**
 * Upload direct (depuis l'admin) d'un PDF Académie vers Cloudinary, en
 * ressource "authenticated" — jamais accessible par URL publique directe.
 */
export function uploadAcademyPdf(buffer: Buffer, filenameHint: string): Promise<string> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        type: 'authenticated',
        folder: 'nexai/academy/pdf',
        use_filename: true,
        unique_filename: true,
        filename_override: filenameHint,
      },
      (error, result) => {
        if (error || !result) return reject(error || new AppError('Échec upload Cloudinary', 502));
        resolve(result.public_id);
      }
    );
    upload.end(buffer);
  });
}

/**
 * Upload direct (depuis l'admin) d'une vidéo Académie hébergée sur Cloudinary
 * (alternative à un embed YouTube/Dailymotion externe — offre une vraie
 * protection via URL signée courte durée au lieu d'une URL publique figée).
 */
export function uploadAcademyVideo(buffer: Buffer, filenameHint: string): Promise<string> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        type: 'authenticated',
        folder: 'nexai/academy/video',
        use_filename: true,
        unique_filename: true,
        filename_override: filenameHint,
      },
      (error, result) => {
        if (error || !result) return reject(error || new AppError('Échec upload Cloudinary', 502));
        resolve(result.public_id);
      }
    );
    upload.end(buffer);
  });
}

/**
 * Upload de la vidéo publicitaire finale (montage ffmpeg) — ressource PUBLIQUE,
 * contrairement aux vidéos Académie protégées : le client doit pouvoir la
 * télécharger/partager librement, c'est un livrable, pas un contenu de formation.
 */
export function uploadVideoAd(buffer: Buffer, filenameHint: string): Promise<{ url: string; publicId: string }> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        type: 'upload', // public, pas "authenticated"
        folder: 'nexai/video-ads',
        use_filename: true,
        unique_filename: true,
        filename_override: filenameHint,
      },
      (error, result) => {
        if (error || !result) return reject(error || new AppError('Échec upload Cloudinary vidéo pub', 502));
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    upload.end(buffer);
  });
}

/**
 * Upload d'un fichier audio public (ressource "video" côté Cloudinary, comme
 * pour tout fichier audio/mp3) — utilisé pour héberger la narration TTS
 * ElevenLabs le temps de la génération vidéo (Option 1 voix off + Option 2
 * Avatar), car FalAI (avatar) exige une audio_url publique en entrée, tout
 * comme Alexya exige une image publique. Fichier temporaire de travail, pas
 * un livrable client — mais public par nécessité technique (pas de flux
 * d'upload signé côté FalAI).
 */
export function uploadNarrationAudio(buffer: Buffer, filenameHint: string): Promise<{ url: string; publicId: string }> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video', // Cloudinary héberge l'audio sous resource_type "video"
        type: 'upload',
        folder: 'nexai/video-ads/narration',
        use_filename: true,
        unique_filename: true,
        filename_override: filenameHint,
      },
      (error, result) => {
        if (error || !result) return reject(error || new AppError('Échec upload Cloudinary narration', 502));
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    upload.end(buffer);
  });
}

/**
 * Upload d'une pièce jointe envoyée depuis le chat (image ou fichier — jamais
 * de vocal). Ressource publique simple : l'IA doit pouvoir s'y référer et,
 * pour une image de logo propre au client, elle doit ensuite être réutilisable
 * telle quelle (voir routes/logos.routes.ts POST /importer).
 */
export function uploadChatAttachment(
  buffer: Buffer,
  filenameHint: string,
  kind: 'image' | 'file'
): Promise<{ url: string; publicId: string }> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: kind === 'image' ? 'image' : 'raw',
        type: 'upload',
        folder: 'nexai/chat-attachments',
        use_filename: true,
        unique_filename: true,
        filename_override: filenameHint,
      },
      (error, result) => {
        if (error || !result) return reject(error || new AppError('Échec upload de la pièce jointe', 502));
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    upload.end(buffer);
  });
}
/**
 * Upload d'une photo produit envoyée par le client pour compléter/personnaliser
 * une vidéo pub (voir product-image-sourcing.service.ts). Ressource publique
 * simple : réutilisée telle quelle comme image de référence pour Grok Imagine
 * (image-to-image), qui exige une URL publique en entrée — même contrainte
 * que le logo (uploadVideoStartFrameFromUrl) et la narration TTS.
 */
export function uploadVideoAdProductImage(
  buffer: Buffer,
  filenameHint: string
): Promise<{ url: string; publicId: string }> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        type: 'upload',
        folder: 'nexai/video-ads/product-images',
        use_filename: true,
        unique_filename: true,
        filename_override: filenameHint,
      },
      (error, result) => {
        if (error || !result) return reject(error || new AppError('Échec upload photo produit', 502));
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    upload.end(buffer);
  });
}

/**
 * Upload direct (depuis l'admin) d'un produit Boutique — PDF, vidéo, image ou
 * archive (zip). Ressource "authenticated" comme l'Académie : jamais
 * accessible par URL publique directe, seul le déblocage (achat) génère un
 * lien signé temporaire (voir boutique.routes.ts).
 */
export function uploadBoutiqueProduct(
  buffer: Buffer,
  filenameHint: string,
  type: 'pdf' | 'video' | 'image' | 'archive'
): Promise<string> {
  ensureConfigured();
  const resourceType = type === 'video' ? 'video' : type === 'image' ? 'image' : 'raw'; // pdf/archive → raw
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        type: 'authenticated',
        folder: `nexai/boutique/${type}`,
        use_filename: true,
        unique_filename: true,
        filename_override: filenameHint,
      },
      (error, result) => {
        if (error || !result) return reject(error || new AppError('Échec upload Cloudinary', 502));
        resolve(result.public_id);
      }
    );
    upload.end(buffer);
  });
}

export function deleteAcademyResource(publicId: string, resourceType: 'raw' | 'video' = 'raw'): Promise<void> {
  ensureConfigured();
  return cloudinary.uploader
    .destroy(publicId, { resource_type: resourceType, type: 'authenticated' })
    .then(() => undefined)
    .catch(() => undefined); // best-effort : on ne bloque jamais l'admin sur un échec de nettoyage
}

/** Même logique que deleteAcademyResource, ouverte aussi aux images (produits Boutique). */
export function deleteBoutiqueResource(publicId: string, resourceType: 'raw' | 'video' | 'image'): Promise<void> {
  ensureConfigured();
  return cloudinary.uploader
    .destroy(publicId, { resource_type: resourceType, type: 'authenticated' })
    .then(() => undefined)
    .catch(() => undefined);
}
