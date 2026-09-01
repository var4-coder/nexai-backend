import { env } from '@/config/env';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

interface SendEmailParams {
  to: string;
  subject: string;
  htmlContent: string;
}

async function sendEmail({ to, subject, htmlContent }: SendEmailParams): Promise<void> {
  // En dev, sans clé configurée, on logge au lieu d'échouer pour ne pas
  // bloquer le développement local de l'auth.
  if (!env.BREVO_API_KEY) {
    console.warn(`⚠️  BREVO_API_KEY absent — email simulé (dev). Destinataire: ${to} | Sujet: "${subject}"`);
    return;
  }

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
      to: [{ email: to }],
      subject,
      htmlContent,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('❌ Échec envoi email Brevo', response.status, body);
    throw new Error("Échec de l'envoi de l'email");
  }
}

/**
 * Notifie le propriétaire d'un site quand un visiteur soumet un formulaire
 * (contact/réservation/commande) sur son site livré. Best-effort : une
 * erreur d'envoi ne doit jamais faire échouer l'enregistrement de la
 * soumission côté public.routes.ts (déjà en base à ce stade).
 */
export async function sendLeadNotificationEmail(
  to: string,
  siteLabel: string,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  const rows = Object.entries(data)
    .map(([k, v]) => `<tr><td style="padding:4px 8px;color:#64748B">${k}</td><td style="padding:4px 8px">${String(v)}</td></tr>`)
    .join('');
  await sendEmail({
    to,
    subject: `Nouvelle soumission (${type}) sur ${siteLabel}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0F172A">
        <h2 style="margin-bottom:8px">Nouveau message reçu sur ${siteLabel}</h2>
        <p style="color:#64748B;font-size:14px">Type : ${type}</p>
        <table style="border-collapse:collapse;margin-top:12px">${rows}</table>
      </div>
    `,
  });
}

/**
 * Pub 4 (Partie commerciale, relance différée) — envoyée à un client Starter
 * qui a trouvé une idée avec le Coach business mais n'a toujours pas créé de
 * site 48h plus tard. Un seul envoi par session (voir reminders.service.ts).
 */
export async function sendCoachBusinessReminderEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'Votre idée est prête, passez à l\u2019étape suivante',
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#0F172A">
        <h2 style="margin-bottom:8px">Votre idée est prête, passez à l'étape suivante</h2>
        <p>Vous avez trouvé une bonne idée avec le Coach business il y a 2 jours, mais votre site n'est pas encore en ligne.</p>
        <p>Passez à l'abonnement Créateur pour le lancer aujourd'hui et en profiter tout de suite.</p>
      </div>
    `,
  });
}

export async function sendVerificationCodeEmail(to: string, code: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'Votre code de vérification NexAI',
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#0F172A">
        <h2 style="margin-bottom:8px">Bienvenue sur NexAI</h2>
        <p>Voici votre code de vérification, valable 15 minutes :</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:24px 0">${code}</p>
        <p style="color:#64748B;font-size:14px">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetCodeEmail(to: string, code: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'Réinitialisation de votre mot de passe NexAI',
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#0F172A">
        <h2 style="margin-bottom:8px">Réinitialisation de mot de passe</h2>
        <p>Voici votre code de réinitialisation, valable 15 minutes :</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:24px 0">${code}</p>
        <p style="color:#64748B;font-size:14px">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email — votre mot de passe actuel reste inchangé.</p>
      </div>
    `,
  });
}
