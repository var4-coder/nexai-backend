import { z } from 'zod';
import { AppConfig } from '@/models/AppConfig';

/**
 * Informations légales de NexAI (mentions légales, CGV, confidentialité),
 * remplies par l'administrateur. Un champ vide n'apparaît PAS sur les pages
 * publiques (jamais de « à compléter » visible par les visiteurs). L'adresse
 * affiche « France · Sénégal » tant qu'aucune adresse n'est saisie.
 */
const CLE = 'infos_legales';

export const schemaInfosLegales = z.object({
  editeur: z.string().trim().max(160).default(''),
  formeJuridique: z.string().trim().max(160).default(''),
  capital: z.string().trim().max(80).default(''),
  adresse: z.string().trim().max(300).default(''),
  immatriculation: z.string().trim().max(160).default(''),
  tva: z.string().trim().max(80).default(''),
  email: z.string().trim().max(160).default(''),
  telephone: z.string().trim().max(60).default(''),
  directeurPublication: z.string().trim().max(160).default(''),
  hebergeur: z.string().trim().max(400).default(''),
  resiliation: z.string().trim().max(800).default(''),
  remboursementCredits: z.string().trim().max(800).default(''),
  mediateur: z.string().trim().max(500).default(''),
  droitApplicable: z.string().trim().max(500).default(''),
  conservationApresSuppression: z.string().trim().max(120).default(''),
});
export type InfosLegales = z.infer<typeof schemaInfosLegales> & { miseAJour: string | null };

/** Champs que la loi demande en pratique : signalés à l'admin s'ils manquent (jamais aux visiteurs). */
export const CHAMPS_ESSENTIELS: { cle: keyof z.infer<typeof schemaInfosLegales>; libelle: string }[] = [
  { cle: 'editeur', libelle: 'Éditeur (nom ou raison sociale)' },
  { cle: 'formeJuridique', libelle: 'Forme juridique' },
  { cle: 'adresse', libelle: 'Adresse du siège' },
  { cle: 'immatriculation', libelle: 'Immatriculation (SIRET, RCS, NINEA…)' },
  { cle: 'email', libelle: 'Email de contact' },
  { cle: 'directeurPublication', libelle: 'Directeur de la publication' },
  { cle: 'hebergeur', libelle: 'Hébergeur (nom, adresse, téléphone)' },
];

export async function lireInfosLegales(): Promise<InfosLegales> {
  const ligne = await AppConfig.findOne({ key: CLE }).lean();
  let brut: Record<string, unknown> = {};
  try {
    brut = ligne?.value ? JSON.parse(ligne.value) : {};
  } catch {
    brut = {};
  }
  const infos = schemaInfosLegales.parse(brut);
  return { ...infos, miseAJour: typeof brut.miseAJour === 'string' ? brut.miseAJour : null };
}

export async function enregistrerInfosLegales(entree: unknown): Promise<InfosLegales> {
  const infos = schemaInfosLegales.parse(entree ?? {});
  const miseAJour = new Date().toISOString();
  await AppConfig.findOneAndUpdate({ key: CLE }, { key: CLE, value: JSON.stringify({ ...infos, miseAJour }) }, { upsert: true });
  return { ...infos, miseAJour };
}
