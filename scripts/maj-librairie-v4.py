"""
Mise à jour du contenu de la Librairie design — v4 (26/09/2026).

Script de maintenance (une seule exécution, gardé pour l'historique) :
  · ajoute REGLES_GENERATION.md (règles de fabrication aujourd'hui écrites
    en dur dans le code du codeur, désormais dans la Librairie) ;
  · réécrit JUDGES.md : décision en 2 temps (veto puis note /100), barèmes
    du juge code et du juge visuel, numéros de règles ;
  · retire les mentions de modèles figés (« Grok 4.6 ») et le script
    `lint-tokens.mjs` inexistant ;
  · `lang` = langue du client (et non « fr » imposé) ;
  · pose `seed_version` sur chaque document, pour que la mise à jour
    atteigne les bases déjà remplies sans écraser une modification admin.

Lancement : python3 scripts/maj-librairie-v4.py (depuis la racine backend).
"""
import json
import os

DIR = os.path.join(os.path.dirname(__file__), '..', 'seed-data', 'library')
SEED_VERSION = 4


def charger(nom):
    with open(os.path.join(DIR, nom), encoding='utf-8') as f:
        return json.load(f)


def sauver(nom, docs):
    with open(os.path.join(DIR, nom), 'w', encoding='utf-8') as f:
        json.dump(docs, f, ensure_ascii=False, indent=2)
        f.write('\n')


REGLES_GENERATION = """# REGLES_GENERATION.md — fabrication d'un site NexAI (codeur ET juges)

Ces règles valent pour toutes les niches. Chaque règle porte un numéro : le
juge cite ce numéro quand il la trouve violée, le réparateur corrige à partir
de ce numéro. Le codeur et les juges lisent EXACTEMENT le même texte.

## M — Mobile d'abord (la majorité des visiteurs sont sur téléphone)

- M1. `<meta name="viewport" content="width=device-width, initial-scale=1">` dans le `<head>`. **VETO** si absent.
- M2. Mise en page conçue pour 360 px de large, puis élargie avec `@media (min-width: 768px)` et `(min-width: 1024px)`.
- M3. Aucun débordement horizontal à 360 px : jamais de largeur fixe en px sur un conteneur, images en `max-width:100%`, tableaux et blocs de code dans un conteneur `overflow-x:auto`. **VETO** si la page déborde.
- M4. Unités relatives (%, rem, vw, `clamp()`) plutôt que des px figés ; grilles flex/grid qui repassent sur une colonne sous 768 px.
- M5. Zones tactiles ≥ 44×44 px (voir C2) et corps de texte ≥ 16 px.
- M6. Navigation utilisable au pouce : menu replié (bouton accessible avec `aria-expanded`) au-delà de 4 entrées.
- M7. Barre d'action fixe en bas d'écran sur mobile autorisée pour les niches locales (Appeler / WhatsApp / Itinéraire / Réserver) : 64 px de haut, cibles 44 px, ne cache aucun contenu (`padding-bottom` du body).

## H — Structure du document

- H1. Un document HTML autonome ; CSS dans `<style>`, JavaScript minimal sans dépendance externe.
- H2. Couleurs, espacements, rayons, ombres et polices passent UNIQUEMENT par les variables CSS déclarées dans `:root` à partir des tokens et de la palette de la niche (voir T1–T3).
- H3. Un seul `h1` par page, titres sans saut de niveau (voir C5).
- H4. WCAG 2.2 AA minimum (voir CONTRAST.md et C1–C6).

## R — Rédaction

- R1. Textes spécifiques au brief du client (structure PAS ou BAB, voir COPY.md) ; les formules vides sont interdites (voir COPY.md et S10).
- R2. Aucun chiffre, avis, note, diplôme, partenaire ou client inventé. Si l'information n'est pas dans le brief, le bloc n'est pas affiché, ou une AUTRE preuve réelle du brief le remplace. **VETO**.
- R3. Langue du site = langue du client (consigne de langue donnée en fin de consigne) ; vouvoiement par défaut (voir COPY.md).

## PAY — Paiement selon la clientèle visée (`brief.clientele`)

S'applique seulement si le brief indique une vente, une réservation payante, un don ou un abonnement.

- PAY1. `locale` (clients dans sa ville ou son pays) : bouton principal « Payer par Mobile Money » ou « Commander » (lien Chariow ou Maketou du client : Orange Money, MTN MoMo, Moov Money, Wave…), commande WhatsApp si un numéro est fourni, « paiement à la livraison / sur place » seulement si le brief le dit. Prix en FCFA (ou la devise locale du brief).
- PAY2. `digitale` (clients partout en Afrique ou dans le monde) : bouton principal « Payer par carte » (carte bancaire, PayPal… via le lien du client) ; prix en FCFA avec l'équivalent en euro ou en dollar si le brief le donne ; moyens acceptés écrits en clair.
- PAY3. `mixte` : les deux — Mobile Money d'abord pour les clients locaux, carte ensuite.
- PAY4. Clientèle non précisée : bouton neutre « Payer en ligne » + « Commander sur WhatsApp » si un numéro WhatsApp est fourni.
- PAY5. Les moyens de paiement sont écrits en texte : jamais de logo d'opérateur dessiné ou inventé.
"""

JUDGES = """# JUDGES.md — comment les juges NexAI décident (v4)

Les juges appliquent EXACTEMENT les règles données au codeur (bloc commun :
AI_RULES, REGLES_GENERATION, PERF, SCHEMA, CONTRAST, LAYOUTS, SLOP, COPY, SEO,
LEGAL, MEDIA et la fiche de la niche). Chaque erreur relevée cite le numéro de
la règle violée (ex. C1, M3, S3, PAY1). Une remarque qui ne correspond à
aucune règle numérotée est un simple conseil, jamais un veto.

## Décision en 2 temps

1. **VETO** — une seule règle marquée VETO violée = page refusée, quelle que
   soit la note. Le réparateur corrige les vetos en priorité.
2. **NOTE /100** — la page est notée avec le barème de son juge. La note sert
   au routage : réparation si < 80, IA Aide si < 70 (plans payants), rapport
   qualité, comparaison des codeurs (test A/B). Une page qui garde un veto
   voit sa note finale plafonnée à 59.

Un WARN seul n'est pas un veto. 3 WARN SLOP = 1 VETO (voir SLOP.md).

## Juge code — tests

| ID | Test | Gravité |
|---|---|---|
| M1 | viewport présent | VETO |
| M3 | aucun débordement horizontal à 360 px | VETO |
| T1 | Aucune couleur écrite hors des variables `:root` (hex/rgb/hsl) | MAJEUR |
| T2 | Espacements ∈ {0,4,8,16,24,32,48,64} px (tokens) | MAJEUR |
| T3 | Rayons = tokens de la niche | MAJEUR |
| T4 | Typo : 2 familles max, 2 poids max, corps 16 px | VETO |
| C1 | Paires texte/fond = PASS dans CONTRAST.md | VETO |
| C2 | Cibles ≥ 44×44 | VETO |
| C3 | `:focus-visible` visible (anneau 3 px), jamais `outline:none` seul | VETO |
| C4 | `label[for]` sur chaque champ ; erreur liée par `aria-describedby` | VETO |
| C5 | H1 unique, titres sans saut (h1→h2→h3) | VETO |
| C6 | Lien d'évitement, `lang` = langue du client, `title` unique | VETO |
| L1 | 1 CTA principal visible sans défiler, ordinateur ET mobile | VETO |
| L2 | 1 seul bouton principal dans le hero | VETO |
| L3 | Pied de page : mentions légales (+ confidentialité si formulaire, CGV si boutique) | WARN |
| N1 | JSON-LD du type de la niche (SCHEMA.md), un seul bloc | VETO |
| N2 | Nom/adresse/téléphone identiques en-tête, pied de page et schema (niche locale) | VETO |
| P1 | Image LCP : `fetchpriority=high`, pas lazy, width+height | VETO |
| P2 | Images sous la ligne de flottaison : `loading=lazy` + width/height | VETO |
| P3 | `font-display:swap`, ≤ 1 préchargement de police | VETO |
| P4 | `prefers-reduced-motion` respecté | VETO |
| P5 | Pas de JS bloquant dans le hero | WARN |
| A1 | Bouton / Nav / Formulaire / Pied de page = recettes de la Librairie | VETO |
| A2 | États survol / focus / désactivé / chargement sur boutons et champs | VETO |
| S1 | Aucun tell ★ de SLOP.md (dégradé violet, flou décoratif, halo…) | VETO |
| R2 | Aucun chiffre, avis, note ou client inventé | VETO |
| PAY1–PAY5 | Bloc paiement conforme à la clientèle visée | MAJEUR |

T1–T3 : vérifiés par le juge code (aucun script séparé). MAJEUR = pèse
fortement dans la note, sans bloquer la page à lui seul.

## Juge code — barème /100

| Critère | Points | Règles regardées |
|---|---|---|
| responsive | 18 | M1–M7, C2 |
| contraste_wcag | 12 | C1–C4 |
| hierarchie_visuelle | 12 | L1, L2, C5, LAYOUTS |
| distinctivite_anti_slop | 10 | S1–S21, W1–W10 |
| espacement_coherent | 8 | T2, rythme LAYOUTS |
| alignement_grille | 8 | grille 12 colonnes, conteneur |
| coherence_palette | 8 | T1, S11, palette de la niche |
| typographie | 6 | T4, S9, W9 |
| sensation_pro | 6 | ensemble |
| personnalite_niche | 6 | fiche niche, COPY, R1, PAY |
| performance_percue | 4 | P1–P5 |
| microinteractions_feedback | 2 | A2 |

## Juge visuel — tests (captures 390 px téléphone + 1 280 px ordinateur)

| ID | Test | Gravité |
|---|---|---|
| V1 | Vu en tout petit (test du plissement d'yeux) ≠ modèle « 3 cartes » | VETO |
| V2 | Métier reconnaissable en 1 seconde | VETO |
| V3 | Aucun tell ★ de SLOP.md | VETO |
| V4 | 1 H1 ≤ 12 mots, propre à ce client (test du changement de nom) | VETO |
| V5 | 1 CTA principal, contraste perçu nettement | VETO |
| V6 | Preuve de confiance dans les 2 premiers écrans | VETO si local/santé/restaurant/hôtel, WARN sinon |
| V7 | Rythme : écarts internes nettement plus petits que les écarts entre groupes | VETO si tout est équidistant |
| V8 | Photo/interface réelle dans la direction de la niche | VETO si banque d'images générique |
| V9 | Mobile 390 : CTA au pouce, 5 liens de menu max, aucun défilement horizontal | VETO |
| V10 | Fond, clair/sombre et arrondis conformes à la niche | VETO |

## Juge visuel — barème /100

| Critère | Points | Tests |
|---|---|---|
| mobile_390 | 25 | V9, M3 |
| premiere_impression_pro | 20 | V1, V3 |
| hierarchie_cta | 15 | V4, V5 |
| niche_reconnaissable | 10 | V2, V10 |
| photos_medias | 10 | V8 |
| rythme_espacement | 10 | V7 |
| preuve_confiance | 10 | V6 |

## Obligation de motivation (tous plans, tous juges)

Chaque juge renvoie, en plus de la note : la liste des VETO et WARN
déclenchés (numéros), une explication courte et actionnable par erreur, et
des conseils concrets. Ces motivations sont réutilisées par le réparateur,
l'IA Aide et les alertes de l'administration.
"""


def main():
    # ── library_rules : AI_RULES nettoyé + REGLES_GENERATION ajouté ──
    rules = charger('library_rules.json')
    for d in rules:
        if d['_id'] == 'ai_rules':
            d['content_md'] = d['content_md'].replace(
                'Statut: PROD — consommée par Grok 4.6 (générateur), Juge code, Juge visuel, Pexels/Imagine/Alexya.',
                'Statut: PROD — consommée par le Codeur, le Juge code, le Juge visuel (modèles réglés dans '
                "l'admin, Équipe IA) et les fournisseurs d'images.",
            ).replace(
                '1. Ce fichier (AI_RULES.md)\n',
                '1. Ce fichier (AI_RULES.md) + REGLES_GENERATION.md\n',
            )
    rules = [d for d in rules if d['_id'] != 'regles_generation']
    rules.insert(1, {
        '_id': 'regles_generation',
        'source_file': 'REGLES_GENERATION.md',
        'content_md': REGLES_GENERATION,
    })
    sauver('library_rules.json', rules)

    # ── library_judges : réécrit ──
    judges = charger('library_judges.json')
    judges[0]['content_md'] = JUDGES
    sauver('library_judges.json', judges)

    # ── MEDIA : pas de nom de modèle figé ──
    media = charger('library_media.json')
    for d in media:
        d['content_md'] = d['content_md'].replace('Juge visuel (Claude Sonnet 5)', 'Juge visuel')
    sauver('library_media.json', media)

    # ── LEGAL : L3 désormais actif (en WARN) ──
    legal = charger('library_legal.json')
    for d in legal:
        md = d['content_md']
        debut = md.find("## Note d'implémentation pour JUDGES.md")
        fin = md.find("## Ce qu'on ne fait jamais")
        if debut != -1 and fin != -1:
            md = (
                md[:debut]
                + "## Test L3 (JUDGES.md)\n\nActif en WARN : pied de page avec mentions légales "
                "(+ confidentialité si formulaire, + CGV si boutique). Il passera en VETO quand "
                "le générateur de pages légales sera branché.\n\n"
                + md[fin:]
            )
        md = md.replace(
            "Ce lien est un VETO\nimplicite : son absence casse C6 (title/lang) au sens large de conformité\n"
            "mais n'est pas encore un ID de test formel — voir note pour JUDGES.md\nci-dessous.",
            "Son absence est\nrelevée par le test L3 de JUDGES.md (voir ci-dessous).",
        )
        d['content_md'] = md
    sauver('library_legal.json', legal)

    # ── seed_version sur TOUS les documents de TOUS les fichiers ──
    for nom in sorted(os.listdir(DIR)):
        if not nom.endswith('.json'):
            continue
        docs = charger(nom)
        for d in docs:
            d['seed_version'] = SEED_VERSION
        sauver(nom, docs)
    print('Librairie v4 écrite.')


if __name__ == '__main__':
    main()
