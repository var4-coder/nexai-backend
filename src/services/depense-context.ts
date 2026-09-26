import { AsyncLocalStorage } from 'async_hooks';
import { CompteurDepense, UsageCache } from '@/services/cout-generation.service';

/**
 * Compteur de dépense isolé PAR génération.
 *
 * Avant : une variable de module unique. Deux sites (ou deux aperçus)
 * traités en parallèle mélangeaient leurs tokens — le plafond devenait
 * faux. AsyncLocalStorage suit le contexte asynchrone de CHAQUE job.
 */
type ContexteDepense = {
  compteur: CompteurDepense;
};

const als = new AsyncLocalStorage<ContexteDepense>();

export function avecCompteurDepense<T>(compteur: CompteurDepense, fn: () => Promise<T>): Promise<T> {
  return als.run({ compteur }, fn);
}

export function compteurCourant(): CompteurDepense | null {
  return als.getStore()?.compteur ?? null;
}

/** Enregistre un appel IA dans le compteur du job en cours, s'il existe. */
export function enregistrerUsage(
  modele: string,
  tokensEntree: number,
  tokensSortie: number,
  cache?: UsageCache
): void {
  const c = compteurCourant();
  if (!c) return;
  c.ajouter(modele, tokensEntree, tokensSortie, cache);
}

/** true si le plafond de la commande en cours est atteint. */
export function plafondDepasse(): boolean {
  return compteurCourant()?.depasse === true;
}
