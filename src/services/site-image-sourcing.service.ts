import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { callClaude, callClaudeVision } from '@/services/ai-clients';
import { verifyImageUrl } from '@/utils/verifyMedia';

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

interface PexelsPhoto {
  src: { large2x: string; large: string; landscape: string };
  photographer: string;
  url: string;
}

async function searchPexels(query: string, orientation: 'landscape' | 'portrait'): Promise<PexelsPhoto[]> {
  if (!env.PEXELS_API_KEY) {
    throw new AppError('PEXELS_API_KEY manquante — configure-la sur Render', 503);
  }

  const url = `${PEXELS_BASE}/search?query=${encodeURIComponent(query)}&per_page=6&orientation=${orientation}`;
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
    'claude-sonnet-5',
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
      'claude-sonnet-5',
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
}): Promise<{ url: string; sourceAttribution: string }> {
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
