import { SiteRuntime } from '@/models/SiteRuntime';
import { SiteNiche, PaymentProvider } from '@/models/Site';

/**
 * Provisionnement runtime au moment du « Lancer mon site ».
 * Remplace l'ancien provisioning Supabase : même contrat (mêmes capacités par
 * niche, même moment d'appel — une seule fois au lancement, voir jobs/worker.ts),
 * mais stocké dans MongoDB comme le reste de la plateforme.
 */

/** Capacités dynamiques activées selon la niche (Partie D.8) */
export const CAPACITES_PAR_NICHE: Record<SiteNiche, string[]> = {
  hotellerie_evenementiel: ['formulaire_contact', 'reservation'],
  sante_bienetre: ['formulaire_contact', 'reservation'],
  immobilier_architecture: ['formulaire_contact', 'listing_biens'],
  services_locaux: ['formulaire_contact', 'reservation'],
  business_vitrine: ['formulaire_contact'],
  ecommerce_mode: ['formulaire_contact', 'commande_panier'],
  portfolio_creatif: ['formulaire_contact'],
  tech_startup_saas: ['formulaire_contact'],
  restaurant_gastronomie: ['formulaire_contact', 'reservation', 'menu_interactif'],
  education_formation: ['formulaire_contact', 'reservation'],
};

export interface ProvisionResult {
  runtimeId: string;
  capacites: string[];
}

/**
 * Crée l'enregistrement runtime pour un site client.
 * Appelé une seule fois au lancement (idempotent : si déjà provisionné, on
 * met simplement à jour et on renvoie l'id existant plutôt que d'échouer).
 */
export async function provisionSiteRuntime(params: {
  siteId: string;
  niche: SiteNiche;
  paymentMode: 'lien_personnel' | 'chariow';
  paymentLink?: string;
  paymentProvider?: PaymentProvider;
  domainName?: string;
}): Promise<ProvisionResult> {
  const capacites = CAPACITES_PAR_NICHE[params.niche] ?? ['formulaire_contact'];

  const runtime = await SiteRuntime.findOneAndUpdate(
    { siteId: params.siteId },
    {
      siteId: params.siteId,
      niche: params.niche,
      capacites,
      paymentMode: params.paymentMode,
      paymentLink: params.paymentLink,
      paymentProvider: params.paymentProvider,
      domainName: params.domainName,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    runtimeId: String(runtime._id),
    capacites,
  };
}
