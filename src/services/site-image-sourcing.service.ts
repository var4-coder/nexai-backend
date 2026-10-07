import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { callClaude, callClaudeVision } from '@/services/ai-clients';
import { verifyImageUrl } from '@/utils/verifyMedia';
import { prendreDuStock, estNicheDeSite } from '@/services/site-photo-stock.service';
import { cadrageAcceptable, descriptionSansCliche, ratioNumerique } from '@/services/photo-qualite.service';

/**
 * Rôle : "mockup" image sourcing pour les aperçus de site NON réalistes
 * (2 aperçus sur 3 en plan payant — le 3e utilise Grok Imagine, photo générée
 * avec logo intégré).
 *
 * Placé dans le pipeline APRÈS le Juge Visuel (Claude Sonnet 5), sur les
 * propositions déjà retenues (kept) — jamais avant, jamais confié au Codeur
 * (Grok), qui n'a pas d'outil de recherche image réel et ne ferait
 * qu'halluciner une URL.
 *
 * Source légale : Pexels API (licence commerciale libre, pas d'attribution
 * obligatoire). On ne scrape JAMAIS des images depuis des sites tiers
 * arbitraires trouvés en recherche web — risque de copyright direct sur un
 * produit livré à des clients payants.
 *
 * Clé : PEXELS_API_KEY (gratuite sur pexels.com/api)
 */

const PEXELS_BASE = 'https://api.pexels.com/v1';

export interface PexelsPhoto {
  id?: number;
  width?: number;
  height?: number;
  src: { original?: string; large2x: string; large: string; landscape: string; portrait?: string };
  photographer: string;
  photographer_id?: number;
  url: string;
  /** Description fournie par Pexels (sert au filtre « sujet » de MEDIA.md). */
  alt?: string;
  avg_color?: string;
}

export async function searchPexels(
  query: string,
  orientation: 'landscape' | 'portrait',
  perPage = 6
): Promise<PexelsPhoto[]> {
  if (!env.PEXELS_API_KEY) {
    throw new AppError('PEXELS_API_KEY manquante — configure-la sur Render', 503);
  }

  const url = `${PEXELS_BASE}/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}`;
  const res = await fetch(url, {
    headers: { Authorization: env.PEXELS_API_KEY },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AppError(`Pexels error ${res.status}: ${text.slice(0, 300)}`, 502);
  }

  const data = (await res.json()) as { photos?: PexelsPhoto[] };
  return data.photos || [];
}

/**
 * Claude Sonnet 5 construit une requête de recherche pertinente pour la
 * niche/section du site (pas de traduction littérale du brief — une vraie
 * requête stock-photo idiomatique en anglais, Pexels indexant en anglais).
 */
async function buildSearchQuery(brief: {
  niche: string;
  brandName?: string;
  description?: string;
  tone?: string;
  sectionHint: string; // ex: "hero", "services", "about"
}): Promise<string> {
  const raw = await callClaude(
    'claude-sonnet-5-5',
    'Tu es un directeur artistique. Tu réponds UNIQUEMENT avec une requête de recherche stock-photo en anglais, 3 à 6 mots, sans guillemets, sans ponctuation superflue. Pas de texte autour.',
    [
      {
        role: 'user',
        content: `Niche du site : ${brief.niche}\nSection à illustrer : ${brief.sectionHint}\nTon de marque : ${brief.tone || 'professionnel'}\nContexte : ${brief.description || ''}\n\nDonne la meilleure requête de recherche stock-photo (style photo propre, professionnelle, pas de texte incrusté, pas de personnes identifiables si évitable).`,
      },
    ],
    { maxTokens: 60, temperature: 0.4 }
  );
  return raw.replace(/["'.]/g, '').trim().slice(0, 100);
}

/**
 * Sélection visuelle réelle : Claude Sonnet 5 regarde les candidats Pexels
 * (jusqu'à 5, pour limiter coût/latence) et choisit celui qui correspond le
 * mieux au ton de marque. Fallback silencieux sur le 1er résultat Pexels si
 * la vision échoue (timeout, erreur API...) — on ne bloque jamais un aperçu
 * de site pour ça.
 */
async function pickBestPhotoVisually(
  photos: PexelsPhoto[],
  brief: { niche: string; brandName?: string; tone?: string; sectionHint: string }
): Promise<PexelsPhoto> {
  if (photos.length <= 1) return photos[0];

  const candidates = photos.slice(0, 5);
  try {
    const raw = await callClaudeVision(
      'claude-sonnet-5-5',
      'Tu es le Juge Visuel NexAI. Tu réponds UNIQUEMENT avec un chiffre (index 0-based de la meilleure image), rien d\'autre.',
      `Niche du site : ${brief.niche}. Marque : ${brief.brandName || 'N/A'}. Ton recherché : ${brief.tone || 'professionnel, premium'}. Section : ${brief.sectionHint}.\n\nParmi les ${candidates.length} images ci-dessus (dans l'ordre), laquelle correspond le mieux à un site vitrine pro pour cette marque ? Réponds uniquement l'index (0 à ${candidates.length - 1}).`,
      candidates.map((p) => p.src.large),
      { maxTokens: 10 }
    );
    const idx = parseInt(raw.trim(), 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < candidates.length) return candidates[idx];
  } catch (err) {
    console.warn('[site-image-sourcing] Sélection visuelle indisponible, fallback sur le tri Pexels', err);
  }
  return candidates[0];
}

export async function sourceMockupImage(brief: {
  niche: string;
  brandName?: string;
  description?: string;
  tone?: string;
  sectionHint: string;
  orientation?: 'landscape' | 'portrait';
}): Promise<{ url: string; sourceAttribution: string; pexelsUrl?: string }> {
  // 1) Stock NexAI (photos déjà copiées dans notre Cloudinary, 50 par niche, renouvelé automatiquement).
  //    Uniquement pour les niches de sites : les autres appelants (Academy, Boutique…) gardent la recherche live.
  if (estNicheDeSite(brief.niche) && (brief.orientation || 'landscape') === 'landscape') {
    try {
      const p = await prendreDuStock(brief.niche);
      if (p) return { url: p.url, sourceAttribution: `Photo par ${p.photographer} via Pexels`, pexelsUrl: p.pexelsUrl };
    } catch (err) {
      console.warn('[site-image-sourcing] stock indisponible, recherche Pexels en direct', err);
    }
  }
  const query = await buildSearchQuery(brief);
  const photos = await searchPexels(query, brief.orientation || 'landscape');

  if (photos.length === 0) {
    throw new AppError(`Pexels : aucun résultat pour "${query}"`, 502);
  }

  // Sélection visuelle réelle par Claude Sonnet 5 (Juge Visuel), avec fallback
  // sur le tri Pexels si la vision échoue.
  const chosen = await pickBestPhotoVisually(photos, brief);

  // Contrôle final : le client ne doit JAMAIS voir une image cassée. On
  // vérifie que l'URL choisie charge réellement ; si elle échoue, on
  // retente sur les autres candidats Pexels avant d'abandonner (le pipeline
  // livre alors le site sans image plutôt qu'avec un lien mort).
  const ordered = [chosen, ...photos.filter((p) => p !== chosen)];
  for (const candidate of ordered) {
    const url = candidate.src.large2x || candidate.src.large || candidate.src.landscape;
    if (await verifyImageUrl(url)) {
      return {
        url,
        sourceAttribution: `Photo par ${candidate.photographer} via Pexels`,
      };
    }
  }

  throw new AppError('Pexels : aucune image valide parmi les candidats', 502);
}

/**
 * Collecte automatique pour UN emplacement (MEDIA.md, étape c) : requête
 * construite depuis le style photo de la niche, puis filtre de qualité
 * (largeur, recadrage ≤ 25 % pour le ratio de l'emplacement, clichés), choix
 * visuel et vérification que l'image charge. Renvoie null si rien ne passe :
 * le codeur utilise alors la variante de section SANS photo.
 */
export async function chercherPhotoPourEmplacement(params: {
  niche: string;
  brandName?: string;
  description?: string;
  tone?: string;
  emplacement: string;
  ratio?: string;
  largeurMin: number;
  stylePhoto?: string;
}): Promise<{ url: string; photographer: string; pexelsUrl: string; width?: number; height?: number } | null> {
  const r = ratioNumerique(params.ratio) ?? 16 / 9;
  const orientation: 'landscape' | 'portrait' = r >= 1 ? 'landscape' : 'portrait';
  const query = await buildSearchQuery({
    niche: params.niche,
    brandName: params.brandName,
    description: params.description,
    tone: params.tone,
    sectionHint: `${params.emplacement}${params.stylePhoto ? ` — style photo attendu : ${params.stylePhoto}` : ''}`,
  });
  const photos = (await searchPexels(query, orientation, 30)).filter(
    (p) =>
      (p.width ?? 0) >= params.largeurMin &&
      cadrageAcceptable(p.width, p.height, params.ratio) &&
      descriptionSansCliche(p.alt)
  );
  if (photos.length === 0) return null;
  const chosen = await pickBestPhotoVisually(photos, { ...params, sectionHint: params.emplacement });
  for (const c of [chosen, ...photos.filter((p) => p !== chosen)].slice(0, 6)) {
    const url = c.src.large2x || c.src.large;
    if (await verifyImageUrl(url)) {
      return { url, photographer: c.photographer, pexelsUrl: c.url, width: c.width, height: c.height };
    }
  }
  return null;
}
