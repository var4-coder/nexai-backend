import crypto from 'crypto';
import { Types } from 'mongoose';
import { SiteVisit } from '@/models/SiteVisit';
import { Site } from '@/models/Site';
import { AppError } from '@/middleware/errorHandler';
import { env } from '@/config/env';

/**
 * Statistiques de visite des sites clients.
 *
 * Le script ci-dessous est injecté dans chaque site au moment de sa mise
 * en ligne. Il envoie une ligne par page vue, sans cookie ni donnée
 * personnelle — ce qui évite au client d'avoir à afficher un bandeau de
 * consentement, et le met en conformité par construction.
 */

/** Type d'appareil déduit du navigateur, sans bibliothèque externe. */
export function detecterAppareil(userAgent = ''): 'mobile' | 'ordinateur' | 'tablette' | 'inconnu' {
  const ua = userAgent.toLowerCase();
  if (!ua) return 'inconnu';
  if (/ipad|tablet|playbook|silk/.test(ua)) return 'tablette';
  if (/mobi|android|iphone|ipod|phone/.test(ua)) return 'mobile';
  return 'ordinateur';
}

/**
 * Empreinte anonyme, valable une journée.
 *
 * L'adresse IP n'est JAMAIS stockée : elle est combinée à la date et à un
 * secret, puis hachée. Impossible de remonter au visiteur, impossible de
 * le suivre d'un jour à l'autre ou d'un site à l'autre — mais suffisant
 * pour ne pas compter dix fois la même personne dans la journée.
 */
export function empreinteAnonyme(ip: string, userAgent: string, siteId: string): string {
  const jour = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`${ip}|${userAgent}|${siteId}|${jour}|${env.JWT_SECRET}`)
    .digest('hex')
    .slice(0, 32);
}

/** Domaine de provenance, sans l'URL complète (qui serait une donnée sensible). */
export function extraireSource(referer?: string): string | undefined {
  if (!referer) return undefined;
  try {
    const hote = new URL(referer).hostname.replace(/^www\./, '');
    return hote || undefined;
  } catch {
    return undefined;
  }
}

/** Enregistre une page vue. Ne lève jamais d'erreur bloquante. */
export async function enregistrerVisite(params: {
  siteId: string;
  chemin?: string;
  ip: string;
  userAgent: string;
  referer?: string;
  pays?: string;
}): Promise<void> {
  const site = await Site.findById(params.siteId).select('userId status');
  // Seuls les sites réellement en ligne sont comptabilisés.
  if (!site || site.status !== 'launched') return;

  const source = extraireSource(params.referer);

  await SiteVisit.create({
    siteId: site._id,
    userId: site.userId,
    chemin: (params.chemin || '/').slice(0, 200),
    empreinteJour: empreinteAnonyme(params.ip, params.userAgent, params.siteId),
    // Une visite venant du site lui-même n'est pas une source externe.
    source,
    appareil: detecterAppareil(params.userAgent),
    pays: params.pays?.slice(0, 2).toUpperCase(),
  });
}

export interface StatsVisites {
  pagesVues: number;
  visiteurs: number;
  parJour: { date: string; pagesVues: number; visiteurs: number }[];
  sources: { source: string; total: number }[];
  appareils: { appareil: string; total: number }[];
  pages: { chemin: string; total: number }[];
}

/**
 * Statistiques d'un client, tous sites ou un seul.
 * `jours` est borné à 90 — au-delà, les données sont purgées (voir le modèle).
 */
export async function getStatsVisites(
  userId: Types.ObjectId | string,
  options: { siteId?: string; jours?: number } = {}
): Promise<StatsVisites> {
  const jours = Math.min(Math.max(options.jours ?? 30, 1), 90);
  const depuis = new Date(Date.now() - jours * 24 * 60 * 60 * 1000);

  const filtre: Record<string, unknown> = { userId, createdAt: { $gte: depuis } };

  if (options.siteId) {
    const site = await Site.findById(options.siteId).select('userId');
    if (!site) throw new AppError('Site introuvable.', 404);
    if (String(site.userId) !== String(userId)) throw new AppError('Accès refusé.', 403);
    filtre.siteId = site._id;
  }

  const [totaux, parJour, sources, appareils, pages] = await Promise.all([
    SiteVisit.aggregate([
      { $match: filtre },
      { $group: { _id: null, pagesVues: { $sum: 1 }, visiteurs: { $addToSet: '$empreinteJour' } } },
      { $project: { pagesVues: 1, visiteurs: { $size: '$visiteurs' } } },
    ]),
    SiteVisit.aggregate([
      { $match: filtre },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          pagesVues: { $sum: 1 },
          visiteurs: { $addToSet: '$empreinteJour' },
        },
      },
      { $project: { date: '$_id', pagesVues: 1, visiteurs: { $size: '$visiteurs' }, _id: 0 } },
      { $sort: { date: 1 } },
    ]),
    SiteVisit.aggregate([
      { $match: { ...filtre, source: { $ne: null } } },
      { $group: { _id: '$source', total: { $sum: 1 } } },
      { $project: { source: '$_id', total: 1, _id: 0 } },
      { $sort: { total: -1 } },
      { $limit: 8 },
    ]),
    SiteVisit.aggregate([
      { $match: filtre },
      { $group: { _id: '$appareil', total: { $sum: 1 } } },
      { $project: { appareil: '$_id', total: 1, _id: 0 } },
      { $sort: { total: -1 } },
    ]),
    SiteVisit.aggregate([
      { $match: filtre },
      { $group: { _id: '$chemin', total: { $sum: 1 } } },
      { $project: { chemin: '$_id', total: 1, _id: 0 } },
      { $sort: { total: -1 } },
      { $limit: 10 },
    ]),
  ]);

  return {
    pagesVues: totaux[0]?.pagesVues ?? 0,
    visiteurs: totaux[0]?.visiteurs ?? 0,
    parJour,
    sources,
    appareils,
    pages,
  };
}

/**
 * Script de suivi injecté dans les sites au moment de la mise en ligne.
 *
 * Volontairement minimal (moins d'1 Ko) : il ne ralentit pas le site du
 * client, n'utilise aucun cookie, et échoue en silence si l'API NexAI est
 * momentanément indisponible — le site du client ne doit jamais souffrir
 * d'un problème côté statistiques.
 */
export function genererScriptSuivi(siteId: string): string {
  const base = env.PUBLIC_API_BASE_URL || '';
  return `<script>(function(){try{
var d=document,n=navigator;
function envoyer(){
  var u=${JSON.stringify(base)}+"/api/v1/public/visite";
  var c={siteId:${JSON.stringify(siteId)},chemin:location.pathname,referer:d.referrer||""};
  if(n.sendBeacon){n.sendBeacon(u,new Blob([JSON.stringify(c)],{type:"application/json"}));}
  else{fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(c),keepalive:true}).catch(function(){});}
}
if(d.readyState==="complete"){envoyer();}else{addEventListener("load",envoyer);}
}catch(e){}})();</script>`;
}

/** Insère le script juste avant </body>, ou en fin de document à défaut. */
export function injecterSuivi(html: string, siteId: string): string {
  const script = genererScriptSuivi(siteId);
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}\n</body>`);
  }
  return html + script;
}
