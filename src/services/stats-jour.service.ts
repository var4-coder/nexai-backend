import crypto from 'crypto';
import { StatsJour, EmpreinteVisiteNexai } from '@/models/StatsJour';
import { coutAppelUsd, type UsageCache } from '@/services/cout-generation.service';

export const jourUtc = (d = new Date()) => d.toISOString().slice(0, 10);

// ── Coût IA réel : chaque appel est ajouté à un tampon, écrit en base toutes les 30 s ──
const tampon = new Map<string, { nombre: number; coutUsd: number; entree: number; sortie: number }>();
let minuterie: NodeJS.Timeout | null = null;

export function compterAppelIa(modele: string, entree: number, sortie: number, cache?: UsageCache) {
  compterAppelIaUsd(modele, coutAppelUsd(modele, entree, sortie, cache), entree + (cache?.lecture ?? 0) + (cache?.ecriture ?? 0), sortie);
}

/**
 * Même compteur, quand le coût est déjà calculé par l'appelant (Atelier
 * Skills : ses propres tarifs couvrent aussi OpenAI et DeepSeek).
 */
export function compterAppelIaUsd(modele: string, usd: number, entree: number, sortie: number) {
  const cle = `${jourUtc()}|${modele}`;
  const t = tampon.get(cle) ?? { nombre: 0, coutUsd: 0, entree: 0, sortie: 0 };
  t.nombre += 1;
  t.coutUsd += usd;
  t.entree += entree;
  t.sortie += sortie;
  tampon.set(cle, t);
  if (!minuterie) {
    minuterie = setTimeout(() => {
      minuterie = null;
      viderTamponIa().catch(() => {});
    }, 30_000);
    minuterie.unref?.();
  }
}

export async function viderTamponIa() {
  const lot = [...tampon.entries()];
  tampon.clear();
  for (const [cle, t] of lot) {
    const [jour, modele] = cle.split('|');
    await StatsJour.updateOne(
      { jour, type: 'ia', cle: modele },
      { $inc: { nombre: t.nombre, coutUsd: t.coutUsd, entree: t.entree, sortie: t.sortie } },
      { upsert: true }
    ).catch((e) => console.warn('[stats] coût IA non enregistré', (e as Error).message));
  }
}

/** Source d'une visite : paramètre utm_source, sinon site d'origine, sinon « direct ». */
export function sourceDe(utm?: string, referer?: string): string {
  const u = (utm || '').toLowerCase().trim();
  const r = (referer || '').toLowerCase();
  const brut = u || r;
  if (/facebook|fb|meta|instagram|ig\b/.test(brut)) return /instagram|ig\b/.test(brut) ? 'instagram' : 'facebook';
  if (/tiktok/.test(brut)) return 'tiktok';
  if (/google|gclid/.test(brut)) return 'google';
  if (/whatsapp|wa\.me/.test(brut)) return 'whatsapp';
  if (/youtube/.test(brut)) return 'youtube';
  if (u) return u.replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'autre';
  if (r && !/nexai/.test(r)) return 'autre site';
  return 'direct';
}

/** Visite d'une page publique de NexAI (aucune donnée personnelle conservée). */
export async function enregistrerVisiteNexai(p: { ip: string; userAgent: string; utm?: string; referer?: string }) {
  if (/bot|crawl|spider|preview|headless|lighthouse/i.test(p.userAgent)) return;
  const jour = jourUtc();
  const source = sourceDe(p.utm, p.referer);
  await StatsJour.updateOne({ jour, type: 'visite', cle: source }, { $inc: { nombre: 1 } }, { upsert: true });
  const e = crypto.createHash('sha256').update(`${jour}|${p.ip}|${p.userAgent}`).digest('hex').slice(0, 32);
  const nouveau = await EmpreinteVisiteNexai.create({ e }).then(() => true).catch(() => false);
  if (nouveau) await StatsJour.updateOne({ jour, type: 'visiteur', cle: source }, { $inc: { nombre: 1 } }, { upsert: true });
}
