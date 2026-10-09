import { HydratedDocument } from 'mongoose';
import { SupportTicket, ISupportTicket, SupportTicketStatus } from '@/models/SupportTicket';
import { AppError } from '@/middleware/errorHandler';
import { callClaude, callGrok, ClaudeModel, GrokModel } from '@/services/ai-clients';
import { getModelForRole } from '@/services/ai-role-registry';
import { construireConnaissanceNexai } from '@/services/nexai-connaissance.service';
import { GUIDE_NEXAI } from '@/data/guide-nexai';
import { User } from '@/models/User';
import { AppConfig, CHAT_ADMIN_INSTRUCTIONS_KEY } from '@/models/AppConfig';
import { consigneLangue, consignePays, type Langue } from '@/constants/pays';
import { MESSAGE_RESEAU_INDISPONIBLE } from '@/utils/erreur-client';

const ESCALATE_RE =
  /\b(bug|erreur|crash|ne marche|ne fonctionne|rembours|arnaque|urgent|plainte|avocat|humain|conseiller|opérateur|operateur|scam|fraude)\b/i;

/**
 * Consigne de l'assistant support.
 *
 * La connaissance de l'offre est construite à partir des CONSTANTES du
 * backend (voir nexai-connaissance.service.ts) : un tarif modifié se
 * répercute ici tout seul. Avant, les montants étaient recopiés à la main
 * dans ce fichier — et ils étaient devenus faux.
 */
async function construireConsigneSupport(userId: string): Promise<string> {
  const u = await User.findById(userId).select('plan langue pays telephonePays role').lean();
  const langue = ((u?.langue as Langue) ?? 'fr') as Langue;
  let instructionsAdmin = '';
  try {
    const doc = await AppConfig.findOne({ key: CHAT_ADMIN_INSTRUCTIONS_KEY }).lean();
    instructionsAdmin = String(doc?.value || '').trim();
  } catch {
    /* sans instructions admin, l'assistant reste opérationnel */
  }
  const libellesPlans: Record<string, string> = {
    trial: 'Essai gratuit',
    starter: 'Starter',
    createur: 'Créateur+',
    agence: 'Agence',
    pro_max: 'Pro Max',
  };
  const plan = u?.role === 'admin' ? 'Administrateur (accès complet)' : libellesPlans[String(u?.plan)] ?? 'Essai gratuit';

  return `Tu es l'assistant NexAI (« Assistance NexAI »), la plateforme de création de sites web, de logos, de vidéos publicitaires, de Skills IA, avec une Académie et une Boutique.

Explique clairement et sans jargon. Tes clients sont des commerçants et des entrepreneurs, pas des techniciens : explique simplement, avec des exemples concrets, et indique toujours OÙ cliquer dans le menu (ex. « Sites → Domaines → Mes domaines »).

ABONNEMENT ACTUEL DU CLIENT : ${plan}. Tiens-en compte : si une fonction n'est pas incluse dans son abonnement, dis-le et indique l'abonnement qui la débloque.

Sois précis sur les chiffres : les tarifs et les règles ci-dessous sont exacts, appuie-toi dessus. Si une question sort de ce que tu sais, dis-le franchement plutôt que d'inventer.

Quand un client semble perdu, ne te contente pas de répondre : propose-lui l'étape suivante concrète.

${construireConnaissanceNexai()}

# GUIDE COMPLET DE NEXAI (le même que la page « Guide » du client)
${GUIDE_NEXAI}
${instructionsAdmin ? `\n# INSTRUCTIONS COMPLÉMENTAIRES DE L'ADMINISTRATEUR (à respecter)\n${instructionsAdmin}\n` : ''}
Si le problème est technique et grave, si un paiement est bloqué, s'il y a une plainte, ou si tu n'es pas sûr : réponds brièvement que tu transmets à un conseiller, et termine ta réponse par la balise exacte [ESCALADE].

${consignePays(u?.pays || u?.telephonePays)}

${consigneLangue(langue)}`;
}

function shouldEscalate(userText: string, aiText: string): boolean {
  if (ESCALATE_RE.test(userText)) return true;
  if (aiText.includes('[ESCALADE]')) return true;
  return false;
}

function cleanAiReply(text: string): string {
  return text.replace(/\[ESCALADE\]/gi, '').trim();
}

export async function getOrCreateThread(userId: string): Promise<HydratedDocument<ISupportTicket>> {
  let ticket = await SupportTicket.findOne({
    userId,
    status: { $in: ['open', 'ai', 'needs_human'] },
  }).sort({ updatedAt: -1 });

  if (!ticket) {
    ticket = await SupportTicket.create({
      userId,
      status: 'open',
      messages: [
        {
          role: 'assistant',
          content:
            "Bonjour ! Je suis l'assistant NexAI. Posez votre question (crédits, site, domaines, abonnement…). Si besoin, un conseiller prendra le relais ici.",
          createdAt: new Date(),
        },
      ],
    });
  }
  return ticket;
}

export async function sendUserMessage(
  userId: string,
  content: string
): Promise<{ ticket: ISupportTicket; escalated: boolean }> {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length < 2) {
    throw new AppError('Message trop court', 400);
  }
  if (trimmed.length > 4000) {
    throw new AppError('Message trop long (max 4000)', 400);
  }

  const ticket = await getOrCreateThread(userId);
  if (ticket.status === 'closed') {
    throw new AppError('Conversation clôturée — rouvrez un nouveau fil', 400);
  }

  ticket.messages.push({ role: 'user', content: trimmed, createdAt: new Date() });

  // Historique court pour le contexte IA
  const history = ticket.messages.slice(-8).map((m) => ({
    role: m.role === 'admin' ? ('assistant' as const) : (m.role as 'user' | 'assistant'),
    content: m.content,
  }));

  let aiText = '';
  try {
    // Le modèle actif pour ce rôle est basculable depuis l'admin ("Équipe
    // IA") entre Haiku 4.5 (défaut) et Grok 4.3 (alternative moins chère,
    // GA mai 2026) — voir ai-role-registry.ts.
    const SYSTEM_PROMPT = await construireConsigneSupport(userId);
    const model = await getModelForRole('support_client');
    if (model.startsWith('grok-')) {
      aiText = await callGrok(
        model as GrokModel,
        [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        { maxTokens: 1000, temperature: 0.3 }
      );
    } else {
      aiText = await callClaude(model as ClaudeModel, SYSTEM_PROMPT, history, {
        maxTokens: 1000,
        temperature: 0.3,
      });
    }
  } catch (err) {
    console.warn('[support] IA indisponible', err);
    aiText = `${MESSAGE_RESEAU_INDISPONIBLE} Un conseiller NexAI a été prévenu et vous répondra ici. [ESCALADE]`;
  }

  const escalated = shouldEscalate(trimmed, aiText);
  const reply = cleanAiReply(aiText) || 'Merci, un conseiller va examiner votre demande.';

  ticket.messages.push({ role: 'assistant', content: reply, createdAt: new Date() });
  ticket.status = (escalated ? 'needs_human' : 'ai') as SupportTicketStatus;
  if (!ticket.subject) {
    ticket.subject = trimmed.slice(0, 80);
  }
  await ticket.save();

  return { ticket, escalated };
}

export async function listTicketsForAdmin(status?: string) {
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  else filter.status = { $in: ['needs_human', 'open', 'ai'] };

  const tickets = await SupportTicket.find(filter)
    .populate('userId', 'email plan')
    .sort({ updatedAt: -1 })
    .limit(100);

  return tickets.map((t) => {
    const json = t.toJSON() as any;
    const u = t.userId as any;
    json.userEmail = u?.email || undefined;
    return json;
  });
}

export async function getTicketForAdmin(id: string) {
  const ticket = await SupportTicket.findById(id).populate('userId', 'email plan');
  if (!ticket) throw new AppError('Ticket introuvable', 404);
  const json = ticket.toJSON() as any;
  const u = ticket.userId as any;
  json.userEmail = u?.email || undefined;
  return json;
}

export async function adminReply(ticketId: string, content: string) {
  const trimmed = content.trim();
  if (!trimmed) throw new AppError('Message vide', 400);

  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new AppError('Ticket introuvable', 404);

  ticket.messages.push({ role: 'admin', content: trimmed, createdAt: new Date() });
  if (ticket.status === 'needs_human' || ticket.status === 'ai') {
    ticket.status = 'open'; // en cours côté humain
  }
  await ticket.save();
  return ticket;
}

export async function closeTicket(ticketId: string) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new AppError('Ticket introuvable', 404);
  ticket.status = 'closed';
  await ticket.save();
  return ticket;
}
