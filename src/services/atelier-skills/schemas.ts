import { z } from 'zod';

/**
 * Schémas des sorties JSON (consignes v1.2 modifiées par l'avenant v1.3).
 * Une sortie non conforme compte comme un échec d'appel (2 nouvelles tentatives).
 * Les schémas sont volontairement tolérants sur les champs secondaires
 * (texte libre, listes facultatives) et stricts sur ce que le code utilise.
 */

const texte = z.string().trim();
const texteOpt = z.string().nullish().transform((v) => v ?? '');
const listeTextes = z.array(z.any()).nullish().transform((v) => (v ?? []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));

export const controleSchema = z
  .object({
    type: z.enum(['mots_max', 'mots_min', 'contient_question', 'sans_question', 'aucun_montant_non_fourni', 'langue', 'contient', 'ne_contient_pas', 'devise']),
    valeur: z.union([z.number(), z.string(), z.array(z.string())]).nullish(),
  })
  .nullish();

export const critereSchema = z.object({
  id: texte.min(1),
  description: texteOpt,
  mesure: z.enum(['oui_non', '0_5']).default('oui_non'),
  type: z.enum(['code', 'juge']).default('juge'),
  terrain: z.boolean().nullish().transform((v) => v === true),
  controle: controleSchema,
});
export type Critere = z.infer<typeof critereSchema>;

export const casSchema = z.object({
  id: texte.min(1),
  type: z.enum(['normal', 'incomplet', 'piege', 'limite']),
  message_utilisateur: texte.min(1),
  comportement_attendu: texteOpt,
  criteres: z.array(critereSchema).min(1),
});
export type Cas = z.infer<typeof casSchema>;

export const cadrageSchema = z.object({
  objectif: texte.min(1),
  utilisateur_type: texteOpt,
  criteres_de_succes: z.array(z.object({ id: texte, description: texteOpt, type: z.enum(['code', 'juge']).default('juge') })).min(4),
  cas_entrainement: z.array(casSchema).min(6),
  cas_controle: z.array(casSchema).min(4),
  cas_declenchement: z.array(z.object({ demande: texte.min(1), doit_activer: z.boolean() })).min(4),
  skills_distracteurs: z.array(z.object({ nom: texte.min(1), description: texte.min(1) })).min(2),
  cas_visibles_aux_redacteurs: z.array(texte).max(2).default([]),
  risques_du_domaine: listeTextes,
  faits_a_verifier: listeTextes,
});
export type Cadrage = z.infer<typeof cadrageSchema>;

export const dossierSchema = z.object({
  mode: z.string().optional(),
  faits: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]).transform(String),
        enonce: texte,
        source_nom: texteOpt,
        source_url: texteOpt,
        source_date: texteOpt,
        statut: z.enum(['CONFIRME', 'UNE_SOURCE', 'DOUTEUX']).catch('DOUTEUX'),
      })
    )
    .default([]),
  non_trouve: listeTextes,
  points_incertains: listeTextes,
});
export type Dossier = z.infer<typeof dossierSchema>;

const referencesSchema = z
  .array(z.object({ nom: texte.min(1), contenu: texteOpt }))
  .nullish()
  .transform((v) => (v ?? []).slice(0, 2));
const faitsUtilisesSchema = z.array(z.any()).nullish().transform((v) => v ?? []);

export const propositionSchema = z.object({
  skill_md: texte.min(200),
  references: referencesSchema,
  faits_utilises: faitsUtilisesSchema,
  choix_de_conception: listeTextes,
  hypotheses: listeTextes,
});
export type Proposition = z.infer<typeof propositionSchema>;

export const autoCritiqueSchema = z.object({
  verdict_global: z.enum(['publiable_en_l_etat', 'modifier']).catch('modifier'),
  changements: z
    .array(
      z.object({
        section: texteOpt,
        passage_actuel: texteOpt,
        nouveau_passage: texteOpt,
        probleme_corrige: texteOpt,
        preuve: texteOpt,
      })
    )
    .nullish()
    .transform((v) => (v ?? []).slice(0, 3)),
});

export const fusionSchema = z.object({
  skill_md: texte.min(200),
  references: referencesSchema,
  faits_utilises: faitsUtilisesSchema,
  journal_des_modifications: z
    .array(z.object({ changement: texteOpt, version_source: texteOpt, cas_corrige: texteOpt, raison: texteOpt }))
    .nullish()
    .transform((v) => v ?? []),
  vetos: z.array(z.object({ id: texte, present: z.boolean(), justification: texteOpt })).default([]),
  confiance: z.enum(['haute', 'moyenne', 'basse']).catch('moyenne'),
});
export type Fusion = z.infer<typeof fusionSchema>;

export const notationSchema = z.object({
  cas_id: z.union([z.string(), z.number()]).transform(String).optional(),
  notes: z.array(
    z.object({
      sortie: z.union([z.string(), z.number()]).transform(String),
      criteres: z.array(
        z.object({
          id: texte,
          valeur: z.union([z.string(), z.number(), z.boolean()]),
          justification: z.string().nullish(),
        })
      ),
      invention: z.boolean().default(false),
      invention_detail: z.string().nullish(),
      defaut_principal: z.string().nullish(),
    })
  ),
});
export type Notation = z.infer<typeof notationSchema>;

export const livrablesSchema = z.object({
  guide: z.object({
    titre: texte.min(1),
    introduction: texteOpt,
    intro_exemple_1: texteOpt,
    intro_exemple_2: texteOpt,
    installation: z.object({
      claude: listeTextes,
      chatgpt: listeTextes,
      telephone: listeTextes,
    }),
    limites: listeTextes,
  }),
  fiche_produit: z.object({
    titre: texte.min(1).transform((t) => t.slice(0, 70)),
    accroche: texteOpt.transform((t) => t.slice(0, 140)),
    description: texteOpt,
    a_qui_ca_s_adresse: texteOpt,
    ce_que_vous_recevez: texteOpt,
  }),
});
export type Livrables = z.infer<typeof livrablesSchema>;
