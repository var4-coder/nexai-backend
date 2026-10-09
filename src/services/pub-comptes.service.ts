import crypto from 'crypto';
import { env } from '@/config/env';
import { AppConfig } from '@/models/AppConfig';
import { DepensePub } from '@/models/StatsJour';
import { AppError } from '@/middleware/errorHandler';
import { lireReglages } from '@/services/bilan.service';

/**
 * Comptes publicitaires (Meta Ads, TikTok Ads) : l'admin enregistre
 * l'identifiant du compte et un jeton d'accès en LECTURE ; NexAI lit chaque
 * jour la dépense réelle et la range dans le Bilan. Le jeton est chiffré en
 * base et n'est jamais renvoyé au navigateur.
 */

const CLE = 'pub_comptes';
export type Plateforme = 'meta' | 'tiktok';
type Compte = { identifiant: string; jetonChiffre: string; devise?: string; nom?: string; derniereSynchro?: string; erreur?: string };
type Comptes = Partial<Record<Plateforme, Compte>>;

const META_API = 'https://graph.facebook.com/v23.0';
const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';

const cle = () => crypto.createHash('sha256').update(`${env.JWT_SECRET}|comptes-pub`).digest();

function chiffrer(t: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle(), iv);
  const data = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function dechiffrer(t: string): string {
  const [iv, tag, data] = t.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', cle(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

async function lire(): Promise<Comptes> {
  const l = await AppConfig.findOne({ key: CLE }).lean();
  try {
    return l?.value ? JSON.parse(l.value) : {};
  } catch {
    return {};
  }
}

async function ecrire(c: Comptes) {
  await AppConfig.findOneAndUpdate({ key: CLE }, { key: CLE, value: JSON.stringify(c) }, { upsert: true });
}

/** Ce que l'admin voit (jamais le jeton). */
export async function statutComptes() {
  const c = await lire();
  const vue = (p: Plateforme) =>
    c[p]
      ? { configure: true, identifiant: c[p]!.identifiant, nom: c[p]!.nom, devise: c[p]!.devise, derniereSynchro: c[p]!.derniereSynchro ?? null, erreur: c[p]!.erreur ?? null }
      : { configure: false };
  return { meta: vue('meta'), tiktok: vue('tiktok') };
}

async function lireJson(res: Response) {
  const texte = await res.text();
  try {
    return JSON.parse(texte);
  } catch {
    return { brut: texte.slice(0, 300) };
  }
}

async function infosCompte(p: Plateforme, identifiant: string, jeton: string): Promise<{ nom?: string; devise?: string }> {
  if (p === 'meta') {
    const id = identifiant.replace(/^act_/, '');
    const r = await fetch(`${META_API}/act_${id}?fields=name,currency&access_token=${encodeURIComponent(jeton)}`);
    const j = await lireJson(r);
    if (!r.ok) throw new AppError(`Meta Ads refuse l'accès : ${j?.error?.message ?? r.status}`, 400);
    return { nom: j.name, devise: j.currency };
  }
  const r = await fetch(`${TIKTOK_API}/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([identifiant]))}`, {
    headers: { 'Access-Token': jeton },
  });
  const j = await lireJson(r);
  if (!r.ok || j?.code !== 0) throw new AppError(`TikTok Ads refuse l'accès : ${j?.message ?? r.status}`, 400);
  const info = j?.data?.list?.[0] ?? {};
  return { nom: info.name, devise: info.currency };
}

/** Enregistre (après vérification) l'identifiant et le jeton d'un compte publicitaire. */
export async function enregistrerCompte(p: Plateforme, identifiant: string, jeton: string) {
  const id = identifiant.trim();
  const infos = await infosCompte(p, id, jeton.trim());
  const c = await lire();
  c[p] = { identifiant: id, jetonChiffre: chiffrer(jeton.trim()), devise: infos.devise, nom: infos.nom };
  await ecrire(c);
  return statutComptes();
}

export async function retirerCompte(p: Plateforme) {
  const c = await lire();
  delete c[p];
  await ecrire(c);
  await DepensePub.deleteMany({ auto: p });
  return statutComptes();
}

/** Montant converti en FCFA selon la devise du compte publicitaire. */
async function versFcfa(montant: number, devise?: string): Promise<number> {
  const d = (devise || 'XOF').toUpperCase();
  if (d === 'XOF' || d === 'XAF') return Math.round(montant);
  if (d === 'EUR') return Math.round(montant * 655.957);
  const { fcfaParUsd } = await lireReglages();
  return Math.round(montant * fcfaParUsd); // USD (et autres devises : approximation en dollars)
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function depensesMeta(compte: Compte, du: string, au: string) {
  const id = compte.identifiant.replace(/^act_/, '');
  const jeton = dechiffrer(compte.jetonChiffre);
  const lignes: { jour: string; montant: number }[] = [];
  let url: string | null =
    `${META_API}/act_${id}/insights?fields=spend&level=account&time_increment=1&limit=100` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since: du, until: au }))}&access_token=${encodeURIComponent(jeton)}`;
  while (url) {
    const r: Response = await fetch(url);
    const j = await lireJson(r);
    if (!r.ok) throw new AppError(`Meta Ads : ${j?.error?.message ?? r.status}`, 502);
    for (const l of j.data ?? []) lignes.push({ jour: l.date_start, montant: Number(l.spend) || 0 });
    url = j.paging?.next ?? null;
  }
  return lignes;
}

async function depensesTiktok(compte: Compte, du: string, au: string) {
  const jeton = dechiffrer(compte.jetonChiffre);
  const q = new URLSearchParams({
    advertiser_id: compte.identifiant,
    report_type: 'BASIC',
    data_level: 'AUCTION_ADVERTISER',
    dimensions: JSON.stringify(['stat_time_day']),
    metrics: JSON.stringify(['spend']),
    start_date: du,
    end_date: au,
    page_size: '100',
  });
  const r = await fetch(`${TIKTOK_API}/report/integrated/get/?${q}`, { headers: { 'Access-Token': jeton } });
  const j = await lireJson(r);
  if (!r.ok || j?.code !== 0) throw new AppError(`TikTok Ads : ${j?.message ?? r.status}`, 502);
  return (j.data?.list ?? []).map((l: { dimensions?: { stat_time_day?: string }; metrics?: { spend?: string } }) => ({
    jour: String(l.dimensions?.stat_time_day ?? '').slice(0, 10),
    montant: Number(l.metrics?.spend) || 0,
  }));
}

/**
 * Lit les dépenses des 30 derniers jours sur chaque compte configuré et les
 * range dans le Bilan (une ligne « automatique » par jour et par plateforme,
 * remplacée à chaque synchronisation : jamais de doublon).
 */
export async function synchroniserDepenses() {
  const c = await lire();
  const au = iso(new Date());
  const du = iso(new Date(Date.now() - 29 * 86_400_000));
  const resultat: Record<string, { jours: number; totalFcfa: number } | { erreur: string }> = {};
  for (const p of ['meta', 'tiktok'] as Plateforme[]) {
    const compte = c[p];
    if (!compte) continue;
    try {
      const lignes = p === 'meta' ? await depensesMeta(compte, du, au) : await depensesTiktok(compte, du, au);
      const plateforme = p === 'meta' ? 'facebook' : 'tiktok';
      let total = 0;
      for (const l of lignes) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(l.jour)) continue;
        const fcfa = await versFcfa(l.montant, compte.devise);
        total += fcfa;
        await DepensePub.updateOne(
          { jour: l.jour, plateforme, auto: p },
          { $set: { montantFcfa: fcfa, note: `Importé de ${p === 'meta' ? 'Meta Ads' : 'TikTok Ads'}` } },
          { upsert: true }
        );
      }
      compte.derniereSynchro = new Date().toISOString();
      compte.erreur = undefined;
      resultat[p] = { jours: lignes.length, totalFcfa: total };
    } catch (err) {
      compte.erreur = (err as Error).message.slice(0, 200);
      resultat[p] = { erreur: compte.erreur };
    }
  }
  await ecrire(c);
  return resultat;
}

/** Synchronise si la dernière lecture date de plus d'une heure (appelé à l'ouverture du Bilan). */
export async function synchroniserSiAncien() {
  const c = await lire();
  const vieux = (['meta', 'tiktok'] as Plateforme[]).some((p) => {
    const s = c[p]?.derniereSynchro;
    return c[p] && (!s || Date.now() - new Date(s).getTime() > 3600_000);
  });
  if (vieux) await synchroniserDepenses().catch(() => {});
}
