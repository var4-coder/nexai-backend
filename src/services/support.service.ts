import { HydratedDocument } from 'mongoose';
import { SupportTicket, ISupportTicket, SupportTicketStatus } from '@/models/SupportTicket';
import { AppError } from '@/middleware/errorHandler';
import { callClaude, callGrok, ClaudeModel, GrokModel } from '@/services/ai-clients';
import { getModelForRole } from '@/services/ai-role-registry';
import { construireConnaissanceNexai } from '@/services/nexai-connaissance.service';

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
const SYSTEM_PROMPT = `Tu es l'assistant NexAI, la plateforme de création de sites web, de logos et de vidéos publicitaires par IA.

Réponds en français, clairement et sans jargon. Tes clients sont des commerçants et des entrepreneurs, pas des techniciens : explique simplement, avec des exemples concrets.

Sois précis sur les chiffres : les tarifs et les règles ci-dessous sont exacts, appuie-toi dessus. Si une question sort de ce que tu sais, dis-le franchement plutôt que d'inventer.

Quand un client semble perdu, ne te contente pas de répondre : propose-lui l'étape suivante concrète.

${construireConnaissanceNexai()}

Si le problème est technique et grave, si un paiement est bloqué, s'il y a une plainte, ou si tu n'es pas sûr : réponds brièvement que tu transmets à un conseiller, et termine ta réponse par la balise exacte [ESCALADE].`;

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
    const model = await getModelForRole('support_client');
    if (model.startsWith('grok-')) {
      aiText = await callGrok(
        model as GrokModel,
        [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        { maxTokens: 800, temperature: 0.3 }
      );
    } else {
      aiText = await callClaude(model as ClaudeModel, SYSTEM_PROMPT, history, {
        maxTokens: 800,
        temperature: 0.3,
      });
    }
  } catch (err) {
    console.warn('[support] IA indisponible', err);
    aiText =
      "Je rencontre un souci technique pour répondre. Un conseiller NexAI va prendre le relais. [ESCALADE]";
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
