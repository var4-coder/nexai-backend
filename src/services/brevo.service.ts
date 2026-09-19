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
        <p>Passez à l'abonnement Créateur+ pour le lancer aujourd'hui et en profiter tout de suite.</p>
      </div>
    `,
  });
}

/**
 * Provision de renouvellement interrompue faute de crédits.
 * Le domaine n'est pas encore perdu : on prévient plutôt que de couper.
 */
export async function sendDomainProvisioningInterruptedEmail(params: {
  to: string;
  prenom?: string;
  domainName: string;
  expiresAt: Date;
}): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: `Votre domaine ${params.domainName} risque d'expirer`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#0F172A">
        <h2 style="margin-bottom:8px">Action requise pour ${params.domainName}</h2>
        <p>Bonjour ${params.prenom || ''},</p>
        <p>Nous n'avons pas pu prélever les crédits qui maintiennent votre domaine
        <strong>${params.domainName}</strong> actif, faute de solde suffisant.</p>
        <p>Rechargez vos crédits depuis votre espace NexAI pour le conserver. Sans
        provision, il expirera le
        <strong>${params.expiresAt.toLocaleDateString('fr-FR')}</strong>.</p>
      </div>
    `,
  });
}

/** Rappel d'échéance (60, 30 puis 7 jours avant expiration). */
export async function sendDomainExpiryReminderEmail(params: {
  to: string;
  prenom?: string;
  domainName: string;
  daysLeft: number;
}): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: `${params.domainName} expire dans ${params.daysLeft} jours`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#0F172A">
        <h2 style="margin-bottom:8px">${params.domainName} arrive à échéance</h2>
        <p>Bonjour ${params.prenom || ''},</p>
        <p>Votre domaine <strong>${params.domainName}</strong> arrive à échéance dans
        ${params.daysLeft} jours.</p>
        <p>Tant que votre abonnement NexAI est actif et votre solde de crédits
        suffisant, le renouvellement se fait automatiquement, sans action de votre part.</p>
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

/**
 * Email de journal admin — Architecture v6, section 18 (Logs).
 * Chaque événement notable est aussi expédié à l'administrateur pour que
 * la traçabilité ne dépende pas d'une consultation active de l'interface.
 */
export async function sendAdminLogEmail(params: {
  to: string;
  categorie: string;
  niveau: string;
  message: string;
  contexte?: Record<string, unknown>;
  date: Date;
}): Promise<void> {
  const couleur = params.niveau === 'error' ? '#EF4444' : '#F59E0B';
  const contexteHtml = params.contexte
    ? `<pre style="background:#F4F6FA;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;">${escapeHtml(
        JSON.stringify(params.contexte, null, 2)
      )}</pre>`
    : '';

  await sendEmail({
    to: params.to,
    subject: `[NexAI ${params.niveau.toUpperCase()}] ${params.message.slice(0, 80)}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;">
        <div style="border-left:4px solid ${couleur};padding-left:16px;margin-bottom:20px;">
          <div style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.04em;">
            ${escapeHtml(params.categorie)} · ${escapeHtml(params.niveau)}
          </div>
          <div style="font-size:16px;font-weight:600;color:#0A0B0F;margin-top:6px;">
            ${escapeHtml(params.message)}
          </div>
          <div style="font-size:12px;color:#6B7280;margin-top:6px;">
            ${params.date.toLocaleString('fr-FR')}
          </div>
        </div>
        ${contexteHtml}
        <p style="font-size:12px;color:#6B7280;border-top:1px solid #E5E7EB;padding-top:14px;margin-top:20px;">
          Ceci est la base de données complète des actions NexAI — tout est traçable en cas de problème.
          Historique complet dans Administration → Logs.
        </p>
      </div>
    `,
  });
}

/** Échappe le HTML pour éviter toute injection via un message ou un contexte. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Email « vos propositions sont prêtes » — Architecture v6, section 4.
 * Envoyé à la fin de la génération asynchrone : récupère les clients qui
 * ont fermé l'onglet pendant l'attente (la génération prend plusieurs
 * minutes, beaucoup ne restent pas devant l'écran).
 */
export async function sendGenerationReadyEmail(params: {
  to: string;
  siteName?: string;
  nbPropositions: number;
  lienApercu: string;
}): Promise<void> {
  const titre = params.siteName ? `« ${escapeHtml(params.siteName)} »` : 'votre site';
  const pluriel = params.nbPropositions > 1;

  await sendEmail({
    to: params.to,
    subject: pluriel
      ? `Vos ${params.nbPropositions} propositions de site sont prêtes`
      : `Votre aperçu de site est prêt`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:560px;">
        <h2 style="color:#0A0B0F;font-size:20px;margin-bottom:8px;">
          ${pluriel ? 'Vos propositions sont prêtes' : 'Votre aperçu est prêt'}
        </h2>
        <p style="color:#454B57;font-size:15px;line-height:1.6;">
          NexAI Web a terminé la création de ${titre}.
          ${pluriel
            ? `Vous avez ${params.nbPropositions} versions à comparer — choisissez celle qui vous ressemble le plus.`
            : `Consultez votre aperçu dès maintenant.`}
        </p>
        <a href="${params.lienApercu}"
           style="display:inline-block;background:#4A8DFF;color:#0E1118;font-weight:700;
                  text-decoration:none;padding:13px 26px;border-radius:4px;margin:18px 0;
                  text-transform:uppercase;font-size:14px;letter-spacing:0.02em;">
          Voir ${pluriel ? 'mes propositions' : 'mon aperçu'}
        </a>
        <p style="color:#6B7280;font-size:13px;border-top:1px solid #E5E7EB;padding-top:14px;">
          Une question ? L'Assistance NexAI est disponible à tout moment depuis votre menu.
        </p>
      </div>
    `,
  });
}

/** Code de confirmation pour le changement d'email administrateur. */
export async function sendAdminEmailChangeCode(
  to: string,
  code: string,
  ttlMinutes: number
): Promise<void> {
  await sendEmail({
    to,
    subject: `Code de confirmation — changement d'email administrateur NexAI`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:520px;">
        <h2 style="color:#0A0B0F;font-size:19px;">Confirmation du changement d'email</h2>
        <p style="color:#454B57;font-size:15px;line-height:1.6;">
          Une demande de changement de l'adresse administrateur NexAI a été faite vers cette
          adresse. Saisissez ce code dans votre espace d'administration pour la valider :
        </p>
        <div style="font-size:30px;font-weight:800;letter-spacing:7px;color:#4A8DFF;
                    background:#F4F6FA;padding:16px;text-align:center;border-radius:6px;margin:20px 0;">
          ${escapeHtml(code)}
        </div>
        <p style="color:#6B7280;font-size:13px;">
          Ce code expire dans ${ttlMinutes} minutes.
          Si vous n'êtes pas à l'origine de cette demande, ignorez cet email :
          l'adresse administrateur restera inchangée.
        </p>
      </div>
    `,
  });
}

/** Alerte d'incident plateforme, envoyée à l'administrateur. */
export async function sendPlatformIncidentEmail(params: {
  to: string;
  gravite: string;
  composant: string;
  erreur: string;
  causeProbable: string;
  pisteCorrection: string;
}): Promise<void> {
  const couleur =
    params.gravite === 'critique' ? '#EF4444' : params.gravite === 'moyenne' ? '#F59E0B' : '#6B7280';

  await sendEmail({
    to: params.to,
    subject: `[NexAI ${params.gravite.toUpperCase()}] Incident ${params.composant}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;">
        <div style="border-left:4px solid ${couleur};padding-left:16px;margin-bottom:18px;">
          <div style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;">
            Incident ${escapeHtml(params.gravite)} · ${escapeHtml(params.composant)}
          </div>
          <div style="font-size:16px;font-weight:600;color:#0A0B0F;margin-top:6px;">
            ${escapeHtml(params.erreur.slice(0, 160))}
          </div>
        </div>
        <p style="font-size:13px;color:#6B7280;text-transform:uppercase;margin-bottom:4px;">Cause probable</p>
        <p style="color:#2B3140;font-size:14px;line-height:1.6;">${escapeHtml(params.causeProbable)}</p>
        <p style="font-size:13px;color:#6B7280;text-transform:uppercase;margin:16px 0 4px;">Piste de correction</p>
        <p style="color:#2B3140;font-size:14px;line-height:1.6;">${escapeHtml(params.pisteCorrection)}</p>
        <p style="font-size:13px;color:#6B7280;border-top:1px solid #E5E7EB;padding-top:14px;margin-top:20px;">
          Aucune modification n'a été appliquée. Ouvrez Administration → Sécurité &amp; Maintenance
          pour approuver ou refuser la réparation par votre agent.
        </p>
      </div>
    `,
  });
}
