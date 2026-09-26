"""
Librairie v5 (26/09/2026) — avis d'EXEMPLE dans l'aperçu (décision admin).

  · REGLES_GENERATION.md : nouvelle règle R4 (avis d'exemple balisés
    data-origin="generated" + badge « Exemple », retirés à la mise en ligne).
  · JUDGES.md : R2 précisé (un avis d'exemple correctement balisé n'est pas
    un veto ; un avis inventé SANS balisage l'est) + test R4.
  · seed_version 5 sur ces deux documents seulement : la mise à jour atteint
    les bases déjà remplies, sans toucher un document modifié dans l'admin.

Lancement : python3 scripts/maj-librairie-v5.py (depuis la racine backend).
"""
import json
import os

DIR = os.path.join(os.path.dirname(__file__), '..', 'seed-data', 'library')
V = 5


def charger(nom):
    with open(os.path.join(DIR, nom), encoding='utf-8') as f:
        return json.load(f)


def sauver(nom, docs):
    with open(os.path.join(DIR, nom), 'w', encoding='utf-8') as f:
        json.dump(docs, f, ensure_ascii=False, indent=2)
        f.write('\n')


R4 = """- R4. Avis d'EXEMPLE (aperçu seulement) : si le brief ne fournit AUCUN avis réel, la section avis peut montrer 2 ou 3 avis d'exemple pour que le client voie son site complet. Chaque avis d'exemple : attribut `data-origin="generated"` sur son bloc, badge visible « Exemple », signature « prénom · aperçu seulement », AUCUNE note chiffrée ni étoile. Ajouter dans le CSS : `html[data-env="production"] [data-origin="generated"]{display:none!important}`. Ces blocs sont retirés automatiquement à la mise en ligne. Un avis réel fourni par le client n'a jamais `data-origin`."""

R2_JUGE_ANCIEN = "| R2 | Aucun chiffre, avis, note ou client inventé | VETO |"
R2_JUGE_NOUVEAU = (
    "| R2 | Aucun chiffre, avis, note ou client inventé (un avis d'exemple balisé selon R4 n'est PAS une violation) | VETO |\n"
    "| R4 | Avis d'exemple : `data-origin=\"generated\"` + badge « Exemple » + aucune note chiffrée | VETO si un avis d'exemple n'est pas balisé |"
)


def main():
    rules = charger('library_rules.json')
    for d in rules:
        if d['_id'] == 'regles_generation':
            md = d['content_md']
            if '- R4.' not in md:
                ancre = '\n## PAY'
                md = md.replace(ancre, '\n' + R4 + '\n' + ancre, 1) if ancre in md else md + '\n' + R4 + '\n'
            d['content_md'] = md
            d['seed_version'] = V
    sauver('library_rules.json', rules)

    judges = charger('library_judges.json')
    for d in judges:
        if R2_JUGE_ANCIEN in d['content_md']:
            d['content_md'] = d['content_md'].replace(R2_JUGE_ANCIEN, R2_JUGE_NOUVEAU)
        d['seed_version'] = V
    sauver('library_judges.json', judges)
    print('Librairie v5 écrite.')


if __name__ == '__main__':
    main()
