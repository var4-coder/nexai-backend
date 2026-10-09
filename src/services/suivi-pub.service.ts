import { AppConfig } from '@/models/AppConfig';

/**
 * Suivi publicitaire du site NexAI : identifiant du pixel Meta (Facebook /
 * Instagram). Ce n'est pas un secret : il est visible dans le code de toute
 * page qui porte le pixel. Le pixel ne se charge que chez les visiteurs qui
 * ont accepté les cookies publicitaires (bandeau du site).
 */
const CLE = 'suivi_pub';

export interface SuiviPub {
  metaPixelId: string;
}

export async function lireSuiviPub(): Promise<SuiviPub> {
  const ligne = await AppConfig.findOne({ key: CLE }).lean();
  try {
    const v = ligne?.value ? JSON.parse(ligne.value) : {};
    return { metaPixelId: typeof v.metaPixelId === 'string' ? v.metaPixelId : '' };
  } catch {
    return { metaPixelId: '' };
  }
}

export async function enregistrerSuiviPub(s: SuiviPub): Promise<SuiviPub> {
  const propre = { metaPixelId: s.metaPixelId.trim() };
  await AppConfig.findOneAndUpdate({ key: CLE }, { key: CLE, value: JSON.stringify(propre) }, { upsert: true });
  return propre;
}
