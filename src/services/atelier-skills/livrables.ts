import AdmZip from 'adm-zip';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { watermarkPdfBuffer } from '@/services/pdf-watermark.service';
import { lireSkillMd } from '@/services/atelier-skills/notation';

/**
 * Livrables d'un skill validé (cahier v1 §7, précisions de l'avenant v1.3 §7).
 * TOUT est assemblé par le code : l'en-tête de fiabilité, l'ordre du texte,
 * les chiffres de la preuve de validation, la mention de licence et le
 * filigrane. Les exemples avant/après sont copiés des sorties réelles.
 */

export const MENTION_LICENCE = 'Licence : usage personnel, revente interdite. © NexAI.';

/** Nom du skill normalisé (minuscules et tirets, 40 caractères max). */
export function slugSkill(nom: string): string {
  return (
    nom
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'skill-nexai'
  );
}

/** SKILL.md : en-tête YAML tout en haut, puis les 15 règles de fiabilité, puis le corps. */
export function assemblerSkillMd(skillMd: string, entete: string): { skillMd: string; nom: string; description: string; corps: string } {
  const { name, description, corps } = lireSkillMd(skillMd);
  const nom = slugSkill(name || 'skill-nexai');
  const desc = description.replace(/\s+/g, ' ').slice(0, 300);
  const yaml = `---\nname: ${nom}\ndescription: ${JSON.stringify(desc)}\n---`;
  return { skillMd: `${yaml}\n\n${entete.trim()}\n\n${corps.trim()}\n`, nom, description: desc, corps: corps.trim() };
}

/** Version à coller : les 15 règles en premières lignes, puis le corps (+ références à la suite). */
export function assemblerVersionACollee(corps: string, entete: string, references: { nom: string; contenu: string }[]): string {
  const refs = references.length
    ? `\n\n${references.map((r) => `--- Référence : ${r.nom} ---\n${r.contenu.trim()}`).join('\n\n')}`
    : '';
  return `${entete.trim()}\n\n${corps.trim()}${refs}\n`;
}

/** Consigne système du panel de test (P7) : 15 règles + corps sans YAML + références. */
export function consigneDeTest(skillMd: string, entete: string, references: { nom: string; contenu: string }[]): string {
  return assemblerVersionACollee(lireSkillMd(skillMd).corps, entete, references);
}

export function zipDuSkill(nom: string, skillMd: string, references: { nom: string; contenu: string }[]): Buffer {
  const zip = new AdmZip();
  zip.addFile(`${nom}/SKILL.md`, Buffer.from(skillMd, 'utf-8'));
  for (const r of references.slice(0, 2)) {
    const fichier = r.nom.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60) || 'reference.md';
    zip.addFile(`${nom}/references/${fichier.endsWith('.md') ? fichier : `${fichier}.md`}`, Buffer.from(r.contenu, 'utf-8'));
  }
  return zip.toBuffer();
}

// ─── PDF ──────────────────────────────────────────────────────────────────

/**
 * Les polices standard des PDF ne savent écrire que l'alphabet latin courant
 * (WinAnsi) : tout autre caractère est remplacé, pour qu'un émoji ou un
 * caractère rare ne fasse jamais échouer la génération.
 */
const EXTRA_WINANSI = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
function compatible(texte: string): string {
  return Array.from(
    texte
      .replace(/[‘’]/g, '’')
      .replace(/[“”]/g, '"')
      .replace(/ | /g, ' ')
      .replace(/\t/g, '  ')
  )
    .map((c) => {
      const code = c.charCodeAt(0);
      if (c === '\n') return c;
      if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255) || EXTRA_WINANSI.has(c)) return c;
      return '?';
    })
    .join('');
}

interface Bloc {
  titre?: string;
  texte?: string;
  /** Texte en police à chasse fixe (exemples copiés tels quels). */
  code?: string;
}

class Redacteur {
  private page!: PDFPage;
  private y = 0;
  private readonly marge = 50;
  private readonly largeur = 595.28;
  private readonly hauteur = 841.89;
  constructor(
    private doc: PDFDocument,
    private police: PDFFont,
    private gras: PDFFont,
    private fixe: PDFFont,
    private pied: string
  ) {
    this.nouvellePage();
  }
  private nouvellePage() {
    this.page = this.doc.addPage([this.largeur, this.hauteur]);
    this.y = this.hauteur - this.marge;
    this.page.drawText(compatible(this.pied), { x: this.marge, y: 25, size: 8, font: this.police, color: rgb(0.45, 0.45, 0.45) });
  }
  private lignes(texte: string, font: PDFFont, taille: number): string[] {
    const max = this.largeur - 2 * this.marge;
    const sortie: string[] = [];
    for (const para of compatible(texte).split('\n')) {
      let ligne = '';
      for (const mot of para.split(' ')) {
        const essai = ligne ? `${ligne} ${mot}` : mot;
        if (font.widthOfTextAtSize(essai, taille) <= max) ligne = essai;
        else {
          if (ligne) sortie.push(ligne);
          // Mot plus long qu'une ligne : coupé.
          let reste = mot;
          while (font.widthOfTextAtSize(reste, taille) > max && reste.length > 1) {
            let n = reste.length;
            while (n > 1 && font.widthOfTextAtSize(reste.slice(0, n), taille) > max) n--;
            sortie.push(reste.slice(0, n));
            reste = reste.slice(n);
          }
          ligne = reste;
        }
      }
      sortie.push(ligne);
    }
    return sortie;
  }
  ecrire(texte: string, opts: { taille?: number; font?: 'normal' | 'gras' | 'fixe'; espaceApres?: number } = {}) {
    const taille = opts.taille ?? 10.5;
    const font = opts.font === 'gras' ? this.gras : opts.font === 'fixe' ? this.fixe : this.police;
    const interligne = taille * 1.4;
    for (const l of this.lignes(texte, font, taille)) {
      if (this.y - interligne < this.marge) this.nouvellePage();
      this.y -= interligne;
      this.page.drawText(l, { x: this.marge, y: this.y, size: taille, font, color: rgb(0.1, 0.1, 0.12) });
    }
    this.y -= opts.espaceApres ?? 6;
  }
}

export async function pdfDocument(titre: string, blocs: Bloc[], pied: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(compatible(titre));
  doc.setProducer('NexAI');
  const police = await doc.embedFont(StandardFonts.Helvetica);
  const gras = await doc.embedFont(StandardFonts.HelveticaBold);
  const fixe = await doc.embedFont(StandardFonts.Courier);
  const r = new Redacteur(doc, police, gras, fixe, pied);
  r.ecrire(titre, { taille: 18, font: 'gras', espaceApres: 14 });
  for (const b of blocs) {
    if (b.titre) r.ecrire(b.titre, { taille: 13, font: 'gras', espaceApres: 4 });
    if (b.texte) r.ecrire(b.texte, { espaceApres: 10 });
    if (b.code) r.ecrire(b.code, { taille: 9, font: 'fixe', espaceApres: 10 });
  }
  const brut = Buffer.from(await doc.save());
  // Filigrane générique « NexAI » (cahier v1 §7 : pas de filigrane par acheteur en option 1).
  return watermarkPdfBuffer(brut, 'NexAI');
}

export interface DonneesGuide {
  titre: string;
  introduction: string;
  exemples: { intro: string; message: string; reponse: string }[];
  installation: { claude: string[]; chatgpt: string[]; telephone: string[] };
  limites: string[];
  preuveResume: string;
}

export function guidePdf(g: DonneesGuide): Promise<Buffer> {
  const etapes = (l: string[]) => l.slice(0, 3).map((e, i) => `${i + 1}. ${e}`).join('\n');
  return pdfDocument(
    g.titre,
    [
      { texte: g.introduction },
      { titre: 'Installer le skill en 3 étapes' },
      { titre: 'Avec Claude', texte: etapes(g.installation.claude) },
      { titre: 'Avec ChatGPT (ou une autre IA de discussion)', texte: etapes(g.installation.chatgpt) },
      { titre: 'Sur téléphone', texte: etapes(g.installation.telephone) },
      ...g.exemples.flatMap((e, i) => [
        { titre: `Exemple ${i + 1}`, texte: e.intro },
        { titre: 'Votre demande', code: e.message },
        { titre: 'Réponse obtenue', code: e.reponse },
      ]),
      { titre: 'Limites', texte: g.limites.map((l) => `- ${l}`).join('\n') || '- Aucune limite particulière constatée pendant les tests.' },
      { titre: 'Preuve de validation', texte: g.preuveResume },
      { texte: MENTION_LICENCE },
    ],
    `NexAI — ${MENTION_LICENCE}`
  );
}

export interface DonneesPreuve {
  nom: string;
  modelesTest: string[];
  noteClassement: number;
  noteFinale: number;
  scoreControle: number;
  scoreEntrainement: number;
  nbReponses: number;
  declenchement: { correctes: number; total: number };
  vetos: { id: string; present: boolean }[];
  alertes: string[];
  grilleVersion: number;
  date: Date;
}

/** Preuve de validation : uniquement des chiffres produits par le code. */
export function texteResumePreuve(p: DonneesPreuve): string {
  return [
    `Note finale : ${p.noteFinale.toFixed(1)} / 100 (note de classement du gagnant : ${p.noteClassement.toFixed(1)} / 100).`,
    `Score de contrôle sur des cas jamais vus : ${(p.scoreControle * 100).toFixed(0)} % (entraînement : ${(p.scoreEntrainement * 100).toFixed(0)} %).`,
    `Déclenchement : ${p.declenchement.correctes} réponses correctes sur ${p.declenchement.total}.`,
    `Grille de jugement v${p.grilleVersion}, ${p.date.toLocaleDateString('fr-FR')}.`,
  ].join('\n');
}

export function preuvePdf(p: DonneesPreuve): Promise<Buffer> {
  return pdfDocument(
    `Preuve de validation — ${p.nom}`,
    [
      { titre: 'Modèles de test', texte: `${p.modelesTest.length} modèles d'IA de niveaux différents (un avancé, un léger proche des IA gratuites), ${p.nbReponses} réponses notées.` },
      { titre: 'Résultats', texte: texteResumePreuve(p) },
      {
        titre: 'Vetos',
        texte: p.vetos.map((v) => `- ${v.id} : ${v.present ? 'PRÉSENT' : 'absent'}`).join('\n') || '- Aucun veto examiné.',
      },
      { titre: 'Alertes', texte: p.alertes.length ? p.alertes.map((a) => `- ${a}`).join('\n') : '- Aucune.' },
      { titre: 'Méthode', texte: 'Version finale = gagnant du test complété par des passages d’autres versions. Trois versions rédigées à l’aveugle, testées sur 8 cas, puis contrôle final sur des cas inédits et test de déclenchement. Note calculée par le code à partir des tests.' },
      { texte: MENTION_LICENCE },
    ],
    `NexAI — preuve de validation — ${MENTION_LICENCE}`
  );
}

export function ficheProduitTexte(f: {
  titre: string;
  accroche: string;
  description: string;
  a_qui_ca_s_adresse: string;
  ce_que_vous_recevez: string;
}): string {
  return [
    `Titre : ${f.titre}`,
    `Accroche : ${f.accroche}`,
    '',
    'Description :',
    f.description,
    '',
    'À qui ça s’adresse :',
    f.a_qui_ca_s_adresse,
    '',
    'Ce que vous recevez :',
    f.ce_que_vous_recevez,
    '',
    MENTION_LICENCE,
    '',
  ].join('\n');
}
