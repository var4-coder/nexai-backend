import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * Reçus de paiement — Architecture v6, section 17.
 *
 * Réservé aux plans Agence et Pro Max. Volontairement SIMPLE : c'est un
 * justificatif de dépense à classer, pas une facture réglementaire. Aucune
 * mention légale/fiscale élaborée (numéro de TVA, mentions obligatoires par
 * pays…) — NexAI n'a pas vocation à produire un document comptable formel.
 */

export interface RecuData {
  /** Numéro de reçu lisible, ex. NEXAI-2026-000042 */
  numero: string;
  date: Date;
  /** Email du compte client */
  clientEmail: string;
  /** Nom de l'entreprise, si le client l'a renseigné */
  clientEntreprise?: string;
  /** Libellé de ce qui a été payé, ex. "Abonnement Pro Max — septembre 2026" */
  libelle: string;
  montantFcfa: number;
  /** Référence du paiement chez le prestataire (Chariow…) */
  referencePaiement?: string;
}

const NEXAI_BLEU = rgb(0.29, 0.553, 1); // #4A8DFF
const GRIS_TEXTE = rgb(0.35, 0.38, 0.44);
const NOIR = rgb(0.04, 0.04, 0.06);

/** Formate un montant en FCFA avec séparateurs de milliers. */
function formatFcfa(montant: number): string {
  return `${montant.toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ')} FCFA`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

/**
 * Génère le PDF du reçu. Retourne les octets bruts, à streamer directement
 * en réponse HTTP (jamais stocké : régénérable à tout moment à l'identique).
 */
export async function generateRecuPdf(data: RecuData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const M = 56; // marge
  let y = height - M;

  // ── En-tête ────────────────────────────────────────────────
  page.drawText('NexAI', { x: M, y: y - 8, size: 28, font: fontBold, color: NEXAI_BLEU });
  page.drawText('REÇU DE PAIEMENT', {
    x: width - M - fontBold.widthOfTextAtSize('REÇU DE PAIEMENT', 12),
    y: y - 2,
    size: 12,
    font: fontBold,
    color: GRIS_TEXTE,
  });
  y -= 44;

  page.drawLine({
    start: { x: M, y },
    end: { x: width - M, y },
    thickness: 2,
    color: NEXAI_BLEU,
  });
  y -= 36;

  // ── Métadonnées du reçu ────────────────────────────────────
  const ligne = (label: string, valeur: string, gras = false) => {
    page.drawText(label, { x: M, y, size: 10, font, color: GRIS_TEXTE });
    page.drawText(valeur, {
      x: M + 150,
      y,
      size: gras ? 12 : 10,
      font: gras ? fontBold : font,
      color: NOIR,
    });
    y -= 22;
  };

  ligne('Numéro de reçu', data.numero);
  ligne('Date', formatDate(data.date));
  if (data.referencePaiement) ligne('Référence paiement', data.referencePaiement);
  y -= 14;

  // ── Client ─────────────────────────────────────────────────
  page.drawText('CLIENT', { x: M, y, size: 9, font: fontBold, color: GRIS_TEXTE });
  y -= 20;
  if (data.clientEntreprise) ligne('Entreprise', data.clientEntreprise);
  ligne('Email', data.clientEmail);
  y -= 14;

  // ── Détail ─────────────────────────────────────────────────
  page.drawText('DÉTAIL', { x: M, y, size: 9, font: fontBold, color: GRIS_TEXTE });
  y -= 24;

  page.drawRectangle({
    x: M,
    y: y - 46,
    width: width - M * 2,
    height: 62,
    color: rgb(0.96, 0.97, 0.99),
  });
  page.drawText(data.libelle, { x: M + 16, y: y - 6, size: 11, font, color: NOIR });
  page.drawText('Montant payé', { x: M + 16, y: y - 30, size: 10, font, color: GRIS_TEXTE });
  const montantTxt = formatFcfa(data.montantFcfa);
  page.drawText(montantTxt, {
    x: width - M - 16 - fontBold.widthOfTextAtSize(montantTxt, 16),
    y: y - 34,
    size: 16,
    font: fontBold,
    color: NEXAI_BLEU,
  });
  y -= 86;

  // ── Pied de page ───────────────────────────────────────────
  const pied = [
    'NexAI — Plateforme de création de sites web par intelligence artificielle',
    'Ce document est un justificatif de paiement simple, destiné à votre comptabilité.',
  ];
  let yPied = M + 40;
  page.drawLine({
    start: { x: M, y: yPied + 22 },
    end: { x: width - M, y: yPied + 22 },
    thickness: 1,
    color: rgb(0.89, 0.91, 0.94),
  });
  for (const l of pied) {
    page.drawText(l, { x: M, y: yPied, size: 8, font, color: GRIS_TEXTE });
    yPied -= 13;
  }

  return pdf.save();
}

/**
 * Numéro de reçu lisible et stable, dérivé de l'identifiant de la
 * transaction — deux téléchargements du même paiement donnent toujours le
 * même numéro (jamais un compteur qui repartirait à zéro).
 */
export function buildNumeroRecu(transactionId: string, date: Date): string {
  const suffixe = transactionId.slice(-6).toUpperCase();
  return `NEXAI-${date.getFullYear()}-${suffixe}`;
}
