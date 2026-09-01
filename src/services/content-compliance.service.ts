import { callClaude } from '@/services/ai-clients';

/**
 * Garde-fou légal/fraude — NexAI ne génère jamais de site ou de vidéo pour
 * une activité manifestement illégale ou frauduleuse (contrefaçon, produits
 * réglementés/interdits sans autorisation évidente, faux documents, arnaques
 * financières / pyramides de Ponzi, phishing, contournement de sécurité,
 * usurpation d'identité de marque, etc.).
 *
 * Deux niveaux de défense, comme le reste du produit (voir
 * video-brief-quality.service.ts pour le même principe) :
 * - Chat (UX) : le Coach/Guide NexAI (chat.service.ts, ANTI_RULES) refuse
 *   déjà poliment en conversation et propose de changer de projet — c'est le
 *   chemin normal, le client ne va jamais jusqu'ici dans ce cas.
 * - Backend (garde-fou réel) : ré-appelé ici, juste avant tout débit de
 *   crédits (génération de site ou de vidéo) — un client qui contournerait
 *   le chat (appel direct à l'API avec un brief déjà écrit) reste bloqué de
 *   la même façon. Le chat n'est jamais la seule ligne de défense.
 *
 * On reste volontairement PEU AGRESSIF : l'immense majorité des briefs sont
 * des activités parfaitement légitimes (services locaux, e-commerce,
 * coaching, contenu…). Seuls les cas manifestement illégaux ou frauduleux
 * sont bloqués — pas de sur-interprétation, pas de refus sur un simple doute
 * ou un secteur simplement réglementé (ex: CBD légal, nutrition, finance
 * personnelle légitime ne doivent PAS être bloqués).
 */

export interface ComplianceResult {
  allowed: boolean;
  /** Raison courte (interne/log), en français. Vide si allowed=true. */
  reason: string;
  /** Message client, prêt à afficher : refus + proposition de changer de projet + mention du Coach business. */
  clientMessage: string;
}

function buildRefusalMessage(): string {
  return (
    "Je ne peux pas créer ce projet : il décrit une activité illégale ou frauduleuse, ce que NexAI ne peut pas accompagner. " +
    "On peut repartir sur une autre idée tout de suite si vous voulez — et si vous cherchez une activité rentable et légale, " +
    "le Coach business NexAI peut vous aider à en trouver une adaptée à votre profil."
  );
}

function parseComplianceJson(raw: string): { illegal: boolean; reason: string } | null {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.illegal !== 'boolean') return null;
    return { illegal: parsed.illegal, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    return null;
  }
}

/**
 * Classe une description d'activité (site ou vidéo pub) comme manifestement
 * illégale/frauduleuse ou non. Fail-open volontaire si le classifieur est
 * indisponible (panne Claude) : on ne bloque jamais un client légitime à
 * cause d'une panne d'infrastructure — mêmes principes que
 * analyzeVideoBriefCompleteness. Ce n'est donc pas une garantie juridique
 * absolue, seulement un filtre raisonnable sur les cas évidents.
 */
export async function assertBusinessCompliant(params: {
  description?: string;
  brandName?: string;
  niche?: string;
}): Promise<ComplianceResult> {
  const description = (params.description || '').trim();
  const brandName = (params.brandName || '').trim();

  if (!description && !brandName) {
    // Rien à analyser à ce stade — les autres garde-fous (brief incomplet)
    // bloqueront de toute façon avant d'arriver ici.
    return { allowed: true, reason: '', clientMessage: '' };
  }

  const system = `Tu es le filtre de conformité NexAI. Un client décrit une activité pour laquelle il veut un site web ou une publicité vidéo générée par IA. Ton seul rôle : dire si cette activité est MANIFESTEMENT illégale ou frauduleuse.

Bloque UNIQUEMENT les cas clairement problématiques : vente de biens/services illégaux (drogues, armes non autorisées, faux documents, contrefaçon assumée), arnaques financières explicites (pyramides de Ponzi, "argent facile garanti", faux investissements), phishing/usurpation d'identité de marque, contournement de sécurité/piratage à des fins malveillantes, blanchiment d'argent, exploitation de personnes.

Ne bloque JAMAIS un secteur simplement réglementé ou controversé mais légal en général (CBD légal, compléments alimentaires, coaching, finance personnelle légitime, contenu adulte pour adultes consentants dans un cadre légal, jeux d'argent avec licence, etc.) — dans le doute, LAISSE PASSER. Une description vague ou mal écrite n'est pas un motif de blocage.

Réponds UNIQUEMENT en JSON strict, sans texte autour :
{"illegal": boolean, "reason": string (courte, en français, vide si illegal=false)}`;

  const user = `Description de l'activité : "${description}"
Nom de marque : ${brandName || '(aucun)'}
Niche déclarée : ${params.niche || '(non précisée)'}`;

  try {
    const raw = await callClaude('claude-sonnet-5', system, [{ role: 'user', content: user }], {
      maxTokens: 200,
      temperature: 0,
    });
    const parsed = parseComplianceJson(raw);
    if (parsed) {
      if (!parsed.illegal) return { allowed: true, reason: '', clientMessage: '' };
      return {
        allowed: false,
        reason: parsed.reason || 'Activité manifestement illégale ou frauduleuse détectée.',
        clientMessage: buildRefusalMessage(),
      };
    }
  } catch (err) {
    console.warn('[content-compliance] Classifieur Claude indisponible, on laisse passer (fail-open)', err);
  }

  // Panne du classifieur ou réponse invalide : on ne bloque pas un client
  // légitime pour une raison d'infrastructure.
  return { allowed: true, reason: '', clientMessage: '' };
}
