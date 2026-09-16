import { User } from '@/models/User';
import { AppConfig } from '@/models/AppConfig';
import { AppError } from '@/middleware/errorHandler';
import { env } from '@/config/env';
import { generateVerificationCode, hashValue, compareValue } from '@/utils/crypto';
import { sendAdminEmailChangeCode } from '@/services/brevo.service';

/**
 * Sécurité du compte administrateur — Administration → Compte & Sécurité.
 *
 * Règle demandée par le porteur de projet :
 *   - Le PREMIER changement d'email se fait sans code. L'email initial vient
 *     de la variable ADMIN_EMAIL (une adresse de travail, pas la vraie) :
 *     exiger un code enverrait celui-ci sur une boîte inaccessible.
 *   - TOUS les changements suivants exigent un code envoyé au NOUVEL email,
 *     ce qui prouve que l'admin y a réellement accès.
 *
 * Faille corrigée au passage : une fois l'email admin changé, l'ancienne
 * adresse ne doit plus jamais conférer le rôle admin. Sans cela, n'importe
 * qui s'inscrivant avec l'ancienne adresse (connue, car présente dans la
 * configuration) obtiendrait les droits d'administration.
 */

const CLE_EMAIL_ADMIN = 'admin_email_actuel';
const CLE_PREMIER_FAIT = 'admin_email_premier_changement_fait';
const CLE_CODE = 'admin_email_code_en_cours';
const CODE_TTL_MINUTES = 15;

/** Email admin effectif : celui enregistré en base, sinon la variable d'env. */
export async function getAdminEmailActuel(): Promise<string> {
  const doc = await AppConfig.findOne({ key: CLE_EMAIL_ADMIN });
  return (doc?.value || env.ADMIN_EMAIL || '').toLowerCase();
}

/**
 * Détermine si une adresse donne droit au rôle admin à l'inscription.
 * Utilisé par auth.service.ts à la place d'une comparaison directe avec
 * env.ADMIN_EMAIL — sinon l'ancienne adresse resterait une porte d'entrée.
 */
export async function emailEstAdmin(email: string): Promise<boolean> {
  const actuel = await getAdminEmailActuel();
  return Boolean(actuel) && email.toLowerCase().trim() === actuel;
}

/** Le premier changement (sans code) a-t-il déjà eu lieu ? */
export async function premierChangementFait(): Promise<boolean> {
  const doc = await AppConfig.findOne({ key: CLE_PREMIER_FAIT });
  return doc?.value === 'true';
}

export async function getStatutSecurite() {
  return {
    emailActuel: await getAdminEmailActuel(),
    codeRequisAuProchainChangement: await premierChangementFait(),
    explication: (await premierChangementFait())
      ? "Un code de confirmation sera envoyé au nouvel email pour valider le changement."
      : "Premier changement : aucun code requis. Les changements suivants en exigeront un.",
  };
}

/**
 * Étape 1 — demande de changement.
 * Premier changement : appliqué immédiatement.
 * Suivants : envoie un code au nouvel email, sans rien modifier encore.
 */
export async function demanderChangementEmail(
  nouvelEmail: string,
  adminUserId: string
): Promise<{ applique: boolean; codeEnvoye: boolean; message: string }> {
  const email = nouvelEmail.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AppError('Adresse email invalide.', 400);
  }

  const actuel = await getAdminEmailActuel();
  if (email === actuel) {
    throw new AppError("C'est déjà l'adresse du compte administrateur.", 400);
  }

  // L'adresse ne doit pas déjà appartenir à un autre compte, sinon deux
  // comptes revendiqueraient le rôle admin.
  const occupe = await User.findOne({ email, _id: { $ne: adminUserId } });
  if (occupe) {
    throw new AppError('Cette adresse est déjà utilisée par un autre compte.', 409);
  }

  const premierFait = await premierChangementFait();

  if (!premierFait) {
    await appliquerNouvelEmail(email, adminUserId);
    await AppConfig.findOneAndUpdate(
      { key: CLE_PREMIER_FAIT },
      { value: 'true' },
      { upsert: true }
    );
    return {
      applique: true,
      codeEnvoye: false,
      message:
        "Email administrateur mis à jour. À partir de maintenant, tout nouveau changement exigera un code de confirmation.",
    };
  }

  const code = generateVerificationCode();
  const codeHash = await hashValue(code);
  await AppConfig.findOneAndUpdate(
    { key: CLE_CODE },
    {
      value: JSON.stringify({
        email,
        codeHash,
        expire: Date.now() + CODE_TTL_MINUTES * 60 * 1000,
      }),
    },
    { upsert: true }
  );

  // Le code part vers le NOUVEL email : c'est ce qui prouve que l'admin
  // y a réellement accès avant de basculer le compte.
  await sendAdminEmailChangeCode(email, code, CODE_TTL_MINUTES);

  return {
    applique: false,
    codeEnvoye: true,
    message: `Un code de confirmation a été envoyé à ${email}. Il est valable ${CODE_TTL_MINUTES} minutes.`,
  };
}

/** Étape 2 — confirmation par le code reçu sur le nouvel email. */
export async function confirmerChangementEmail(
  code: string,
  adminUserId: string
): Promise<{ emailActuel: string }> {
  const doc = await AppConfig.findOne({ key: CLE_CODE });
  if (!doc?.value) {
    throw new AppError('Aucun changement d\u2019email en attente.', 400);
  }

  let demande: { email: string; codeHash: string; expire: number };
  try {
    demande = JSON.parse(doc.value);
  } catch {
    throw new AppError('Demande illisible. Relancez le changement.', 400);
  }

  if (Date.now() > demande.expire) {
    await AppConfig.deleteOne({ key: CLE_CODE });
    throw new AppError('Code expiré. Relancez le changement.', 400);
  }

  const ok = await compareValue(code.trim(), demande.codeHash);
  if (!ok) throw new AppError('Code incorrect.', 400);

  await appliquerNouvelEmail(demande.email, adminUserId);
  await AppConfig.deleteOne({ key: CLE_CODE });

  return { emailActuel: demande.email };
}

/**
 * Bascule effective : met à jour le compte ET la référence en base.
 * L'ancienne adresse perd définitivement tout droit d'administration.
 */
async function appliquerNouvelEmail(email: string, adminUserId: string) {
  const admin = await User.findById(adminUserId);
  if (!admin) throw new AppError('Compte administrateur introuvable.', 404);

  admin.email = email;
  admin.role = 'admin';
  admin.plan = 'pro_max'; // le compte admin reste sur l'accès complet
  admin.emailVerifiedAt = new Date();
  await admin.save();

  await AppConfig.findOneAndUpdate(
    { key: CLE_EMAIL_ADMIN },
    { value: email },
    { upsert: true }
  );

  console.log(`[securite-admin] Email administrateur basculé vers ${email}`);
}
