import { callClaude, ClaudeModel } from '@/services/ai-clients';
import { getModelForRole } from '@/services/ai-role-registry';
import { sourceMockupImage } from '@/services/site-image-sourcing.service';

/**
 * Automatisation "upload admin → brouillon prêt à publier" pour Academy et
 * Boutique (décision produit : l'admin ne fournit que le fichier + la
 * niche, tout le reste — titre-accroche, description, image — est généré
 * automatiquement). Rien de ce que produit cette fonction n'est visible
 * côté client tant que l'admin n'a pas cliqué "Publier" (status='brouillon').
 */

const SYSTEM_PROMPT_ACADEMY = `Tu rédiges les fiches de la NexAI Académie (formations PDF/vidéo pour des entrepreneurs
qui créent leur activité en ligne). À partir du contenu fourni et de la niche, propose :
- un TITRE court et accrocheur qui donne envie d'ouvrir la formation (pas un titre neutre/descriptif)
- une DESCRIPTION de 2-3 phrases qui explique clairement de quoi parle la formation et ce que le client va y apprendre
Règles : jamais de promesse de gains d'argent, de revenus chiffrés ni de résultat garanti (réécris ces titres s'ils en contiennent).
Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
{"title": "...", "description": "..."}`;

const SYSTEM_PROMPT_BOUTIQUE = `Tu rédiges les fiches produit de la Boutique NexAI (produits digitaux à débloquer par
crédits : PDF, vidéos, images, archives). À partir du contenu fourni et de la niche, propose :
- un TITRE-ACCROCHE qui donne explicitement envie au client de débloquer ce produit (pas un titre neutre)
- une DESCRIPTION de 2-3 phrases qui vend le contenu sans être trompeuse
Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
{"title": "...", "description": "..."}`;

interface AutoDraftResult {
  title: string;
  description: string;
  imageUrl?: string;
}

/**
 * Extrait le texte d'un buffer PDF. best-effort : si l'extraction échoue
 * (PDF scanné sans couche texte, fichier corrompu...), renvoie une chaîne
 * vide plutôt que de bloquer tout le flux d'automatisation.
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // Import différé : pdf-parse exécute du code de démonstration au chargement
    // du module si appelé sans argument ailleurs dans l'app — on l'isole ici.
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    return (data.text || '').slice(0, 12000); // borne raisonnable pour le prompt
  } catch (err) {
    console.warn('[academy-boutique-automation] Extraction PDF échouée, fallback sans texte', err);
    return '';
  }
}

async function generateTitleAndDescription(opts: {
  kind: 'academy' | 'boutique';
  niche: string;
  filename: string;
  extractedText: string;
}): Promise<{ title: string; description: string }> {
  const system = opts.kind === 'academy' ? SYSTEM_PROMPT_ACADEMY : SYSTEM_PROMPT_BOUTIQUE;
  const model = (await getModelForRole('titre_accroche_academy_boutique')) as ClaudeModel;

  const contentHint = opts.extractedText.trim()
    ? `Contenu extrait du fichier :\n${opts.extractedText}`
    : `Aucun texte n'a pu être extrait automatiquement (probablement une vidéo, ou un PDF scanné). Base-toi uniquement sur le nom du fichier et la niche.`;

  const userMessage = `Niche : ${opts.niche}\nNom du fichier : ${opts.filename}\n\n${contentHint}`;

  try {
    const raw = await callClaude(model, system, [{ role: 'user', content: userMessage }], {
      maxTokens: 400,
      temperature: 0.6,
    });
    const cleaned = raw.trim().replace(/^```json\s*|```$/g, '');
    const parsed = JSON.parse(cleaned) as { title?: string; description?: string };
    if (!parsed.title || !parsed.description) throw new Error('Champs manquants dans la réponse IA');
    return { title: parsed.title.trim(), description: parsed.description.trim() };
  } catch (err) {
    console.warn('[academy-boutique-automation] Génération titre/description échouée, repli sur nom de fichier', err);
    return {
      title: opts.filename.replace(/\.[a-z0-9]+$/i, ''),
      description: `Contenu ${opts.kind === 'academy' ? 'de formation' : 'Boutique'} — niche : ${opts.niche}.`,
    };
  }
}

/**
 * Régénère UNIQUEMENT titre + description pour une fiche qui existe déjà
 * (Academy ou Boutique), à la demande de l'admin (bouton dédié, jamais
 * automatique) — contrairement à `buildAutoDraft` (appelé une seule fois,
 * à l'upload). Aucun fichier n'est re-téléchargé/ré-analysé ici : le
 * contenu qui alimente le prompt est le titre + la description actuels de
 * la fiche, pas le PDF/la vidéo source. Utilisée pour retravailler en lot
 * des fiches déjà publiées, sans repasser par un nouvel upload.
 */
export async function regenerateTitleAndDescription(opts: {
  kind: 'academy' | 'boutique';
  niche: string;
  currentTitle: string;
  currentDescription?: string;
}): Promise<{ title: string; description: string }> {
  return generateTitleAndDescription({
    kind: opts.kind,
    niche: opts.niche || 'général',
    filename: opts.currentTitle,
    extractedText: opts.currentDescription
      ? `Titre actuel : ${opts.currentTitle}\nDescription actuelle : ${opts.currentDescription}\nPropose une version plus accrocheuse (ne recopie pas telle quelle).`
      : `Titre actuel : ${opts.currentTitle}`,
  });
}

/**
 * Cherche une image de couverture via Pexels (niche + titre généré). Double
 * tentative intégrée dans sourceMockupImage lui-même (voir
 * site-image-sourcing.service.ts) ; si tout échoue, renvoie undefined —
 * la fiche est alors créée SANS image plutôt qu'avec un lien cassé, jamais
 * l'inverse.
 */
async function findCoverImage(niche: string, title: string): Promise<string | undefined> {
  try {
    const { url } = await sourceMockupImage({
      niche,
      brandName: title,
      sectionHint: 'couverture de fiche produit / formation',
      orientation: 'landscape',
    });
    return url;
  } catch (err) {
    console.warn('[academy-boutique-automation] Aucune image Pexels trouvée, fiche livrée sans image', err);
    return undefined;
  }
}

export async function buildAutoDraft(opts: {
  kind: 'academy' | 'boutique';
  niche: string;
  filename: string;
  fileType: 'pdf' | 'video' | 'image' | 'archive';
  buffer: Buffer;
  /** Académie : pas de photo pour une leçon (habillage fait par le frontend). */
  sansImage?: boolean;
}): Promise<AutoDraftResult> {
  const extractedText = opts.fileType === 'pdf' ? await extractPdfText(opts.buffer) : '';

  const { title, description } = await generateTitleAndDescription({
    kind: opts.kind,
    niche: opts.niche,
    filename: opts.filename,
    extractedText,
  });

  const imageUrl = opts.sansImage ? undefined : await findCoverImage(opts.niche, title);

  return { title, description, imageUrl };
}
