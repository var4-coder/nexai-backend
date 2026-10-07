import { PlatformSetting } from '@/models/PlatformSetting';

export type VendeurDomaine = 'godaddy' | 'porkbun';

const CLE = 'vendeur_domaine';

/** GoDaddy reste le vendeur tant que l'admin n'a pas basculé. */
export async function lireVendeurDomaine(): Promise<VendeurDomaine> {
  const ligne = await PlatformSetting.findOne({ cle: CLE }).select('valeur').lean<{ valeur?: string }>();
  return ligne?.valeur === 'porkbun' ? 'porkbun' : 'godaddy';
}

export async function ecrireVendeurDomaine(vendeur: VendeurDomaine): Promise<VendeurDomaine> {
  await PlatformSetting.findOneAndUpdate(
    { cle: CLE },
    { cle: CLE, valeur: vendeur },
    { upsert: true, new: true }
  );
  return vendeur;
}
