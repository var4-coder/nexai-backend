import { Router, Request, Response, NextFunction } from 'express';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { AppError } from '@/middleware/errorHandler';
import { Skill, SkillGrid, SkillRequest, SkillRun, ETAPES_AFFICHEES } from '@/models/AtelierSkills';
import {
  calibrage,
  grilleActive,
  lancerExecution,
  purgerBrouillons,
  relancerExecution,
  reprendreExecution,
} from '@/services/atelier-skills/pipeline';
import { coutEstime, lireReglages, modifierReglages, POSTES, PRIX_DEFAUT } from '@/services/atelier-skills/reglages';
import { CONSIGNES_DEFAUT } from '@/services/atelier-skills/consignes';
import { logEvent } from '@/services/logs.service';

/**
 * Routes de l'Atelier Skills — admin uniquement (montées sous /admin/skills,
 * derrière requireAuth + requireRole('admin')). Cahier v1 §9.3 + avenant v1.3 §8.
 */
export const atelierSkillsRouter = Router();

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Identifiant invalide');

const demandeSchema = z.object({
  domaine: z.string().trim().min(2).max(120),
  tache: z.string().trim().min(10).max(2000),
  public: z.string().trim().max(500).default(''),
  langue: z.string().trim().max(40).default('fr'),
  contexte: z
    .object({
      pays: z.string().max(80).optional(),
      devise: z.string().max(20).optional(),
      canal: z.string().max(120).optional(),
      autre: z.string().max(500).optional(),
    })
    .default({}),
  produitPhare: z.boolean().default(false),
  voisins: z.array(z.object({ nom: z.string().trim().min(1).max(60), description: z.string().trim().min(1).max(300) })).max(10).default([]),
});

/** POST /requests — crée une demande et lance l'exécution. */
atelierSkillsRouter.post('/requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = demandeSchema.parse(req.body ?? {});
    const demande = await SkillRequest.create({ ...body, type: 'skill', creePar: req.auth?.email });
    const run = await lancerExecution(String(demande._id));
    await logEvent({ categorie: 'action_admin', niveau: 'info', message: `Atelier Skills : exécution lancée (${body.domaine})` }).catch(() => undefined);
    res.status(201).json({ requestId: String(demande._id), runId: String(run._id) });
  } catch (err) {
    next(err);
  }
});

/** GET /estimation?produitPhare=true — coût estimé avant lancement. */
atelierSkillsRouter.get('/estimation', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reglages = await lireReglages();
    const phare = req.query.produitPhare === 'true';
    res.json({ coutEstimeUSD: Math.round(coutEstime(reglages, phare) * 100) / 100, plafondUSD: reglages.plafondUSD });
  } catch (err) {
    next(err);
  }
});

/** GET /compteurs — pastille du tableau de bord : exécutions en échec + skills non déposés en boutique. */
atelierSkillsRouter.get('/compteurs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [echecs, nonDeposes] = await Promise.all([
      SkillRun.countDocuments({ statut: { $in: ['echec', 'plafond_atteint'] } }),
      Skill.countDocuments({ deposeEnBoutique: false }),
    ]);
    res.json({ echecs, nonDeposes, total: echecs + nonDeposes });
  } catch (err) {
    next(err);
  }
});

/** GET /runs — liste des exécutions (statut par étape, coût, durée). */
atelierSkillsRouter.get('/runs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const runs = await SkillRun.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .select('requestId statut etapeCourante etapes.nom etapes.statut etapes.coutUSD etapes.debut etapes.fin etapes.erreur coutTotalUSD verdict noteFinale noteClassement relances alertes createdAt updatedAt skillId purge')
      .lean();
    const demandes = await SkillRequest.find({ _id: { $in: runs.map((r) => r.requestId) } }).lean();
    res.json({
      etapesAffichees: ETAPES_AFFICHEES,
      runs: runs.map((r) => {
        const d = demandes.find((x) => String(x._id) === String(r.requestId));
        return { ...r, id: String(r._id), demande: d ? { domaine: d.domaine, tache: d.tache, type: d.type, produitPhare: d.produitPhare } : null };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /runs/:id — détail complet (sorties JSON lisibles, dossier de faits, désaccords, alertes). */
atelierSkillsRouter.get('/runs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    objectId.parse(req.params.id);
    const run = await SkillRun.findById(req.params.id).lean();
    if (!run) throw new AppError('Exécution introuvable', 404);
    const demande = await SkillRequest.findById(run.requestId).lean();
    res.json({ run, demande, etapesAffichees: ETAPES_AFFICHEES });
  } catch (err) {
    next(err);
  }
});

atelierSkillsRouter.post('/runs/:id/reprendre', async (req: Request, res: Response, next: NextFunction) => {
  try {
    objectId.parse(req.params.id);
    await reprendreExecution(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** POST /runs/:id/relancer — une seule fois, si verdict « à retravailler ». */
atelierSkillsRouter.post('/runs/:id/relancer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    objectId.parse(req.params.id);
    await relancerExecution(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

atelierSkillsRouter.get('/runs/:id/calibrage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    objectId.parse(req.params.id);
    res.json({ sorties: await calibrage(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** POST /runs/:id/purger — « Purger les brouillons » (cahier v1 §9.5). */
atelierSkillsRouter.post('/runs/:id/purger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    objectId.parse(req.params.id);
    await purgerBrouillons(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Grille ───────────────────────────────────────────────────────────────

atelierSkillsRouter.get('/grilles', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await grilleActive(); // crée la v0 amorce au premier affichage
    const grilles = await SkillGrid.find().sort({ version: -1 }).lean();
    res.json({ grilles });
  } catch (err) {
    next(err);
  }
});

atelierSkillsRouter.post('/grilles/:v/activer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const v = z.coerce.number().int().min(0).parse(req.params.v);
    const grille = await SkillGrid.findOne({ version: v });
    if (!grille) throw new AppError('Version de grille introuvable', 404);
    await SkillGrid.updateMany({ active: true }, { $set: { active: false } });
    grille.active = true;
    await grille.save();
    res.json({ ok: true, version: v });
  } catch (err) {
    next(err);
  }
});

/** POST /grilles/revision — lance une exécution du pipeline sur la grille (premier skill à produire). */
atelierSkillsRouter.post('/grilles/revision', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actuelle = await grilleActive();
    const demande = await SkillRequest.create({
      domaine: 'Grille de jugement',
      tache:
        'Rédiger la grille de jugement des skills NexAI : liste des vetos (invention, promesse, contenu illégal, échec au contrôle) et pondération des points calculés par le code à partir des tests, telle que décrite ci-après. Grille actuelle :\n' +
        actuelle.contenu.slice(0, 1700),
      public: 'Administrateur de l’atelier NexAI qui juge des skills vendus à de petits professionnels francophones d’Afrique',
      langue: 'fr',
      contexte: { pays: 'Afrique francophone', canal: 'Atelier NexAI' },
      produitPhare: false,
      voisins: [],
      type: 'grille',
      creePar: req.auth?.email,
    });
    const run = await lancerExecution(String(demande._id));
    res.status(201).json({ runId: String(run._id) });
  } catch (err) {
    next(err);
  }
});

// ─── Réglages ─────────────────────────────────────────────────────────────

atelierSkillsRouter.get('/reglages', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      reglages: await lireReglages(),
      postes: POSTES,
      prixDefaut: PRIX_DEFAUT,
      consignesDefaut: CONSIGNES_DEFAUT,
    });
  } catch (err) {
    next(err);
  }
});

atelierSkillsRouter.put('/reglages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z
      .object({
        postes: z.record(z.object({ modele: z.string().min(3).max(60), effort: z.enum(['low', 'medium', 'high', 'defaut']) })).optional(),
        seuils: z
          .object({
            note: z.number().min(0).max(100),
            controlePct: z.number().min(0).max(100),
            declenchementMin: z.number().int().min(0).max(12),
            egalite: z.number().min(0).max(20),
            ecartAvanceLeger: z.number().min(0).max(1),
            affinite: z.number().min(0).max(100),
            casEchoue: z.number().min(0).max(1),
          })
          .partial()
          .optional(),
        plafondUSD: z.number().min(0.5).max(50).optional(),
        nbCasEntrainement: z.number().int().min(4).max(8).optional(),
        nbCasControle: z.number().int().min(2).max(4).optional(),
        passages: z.number().int().min(1).max(2).optional(),
        modeRenforce: z.boolean().optional(),
        prix: z.record(z.object({ entree: z.number(), sortie: z.number(), cache: z.number() })).optional(),
        consignes: z.record(z.string().max(30_000)).optional(),
      })
      .parse(req.body ?? {});
    const reglages = await modifierReglages(body as Parameters<typeof modifierReglages>[0], req.auth?.email ?? 'admin');
    res.json({ reglages });
  } catch (err) {
    next(err);
  }
});

// ─── Skills validés ───────────────────────────────────────────────────────

atelierSkillsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const skills = await Skill.find()
      .sort({ createdAt: -1 })
      .select('-fichiers.guidePdf -fichiers.preuvePdf -fichiers.zip')
      .lean();
    res.json({ skills });
  } catch (err) {
    next(err);
  }
});

/** Un fichier binaire lu avec .lean() arrive en « Binary » MongoDB : converti en Buffer. */
function enBuffer(x: unknown): Buffer | undefined {
  if (!x) return undefined;
  if (Buffer.isBuffer(x)) return x;
  const b = (x as { buffer?: unknown }).buffer;
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) return Buffer.from(b as Uint8Array);
  if (x instanceof Uint8Array) return Buffer.from(x);
  return undefined;
}

const FICHIERS: Record<string, { type: string; extraire: (f: Record<string, unknown>) => Buffer | string | undefined }> = {
  'SKILL.md': { type: 'text/markdown; charset=utf-8', extraire: (f) => f.skillMd as string },
  'version-a-coller.txt': { type: 'text/plain; charset=utf-8', extraire: (f) => f.aColler as string },
  'guide.pdf': { type: 'application/pdf', extraire: (f) => enBuffer(f.guidePdf) },
  'preuve-de-validation.pdf': { type: 'application/pdf', extraire: (f) => enBuffer(f.preuvePdf) },
  'fiche-produit.txt': { type: 'text/plain; charset=utf-8', extraire: (f) => f.ficheProduit as string },
  'skill.zip': { type: 'application/zip', extraire: (f) => enBuffer(f.zip) },
};

function envoyerFichier(res: Response, nom: string, type: string, contenu: Buffer | string) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${nom.replace(/[^a-zA-Z0-9._-]/g, '-')}"`);
  res.send(typeof contenu === 'string' ? Buffer.from(contenu, 'utf-8') : contenu);
}

/** GET /:id/fichiers/:nom — un fichier (SKILL.md, version-a-coller.txt, guide.pdf…, references/<nom>). */
atelierSkillsRouter.get('/:id/fichiers/:nom', async (req: Request, res: Response, next: NextFunction) => {
  try {
    objectId.parse(req.params.id);
    const skill = await Skill.findById(req.params.id).lean();
    if (!skill) throw new AppError('Skill introuvable', 404);
    const f = skill.fichiers as unknown as Record<string, unknown>;
    const nom = req.params.nom;
    if (nom.startsWith('reference-')) {
      const ref = skill.fichiers.references?.[Number(nom.slice(10))];
      if (!ref) throw new AppError('Référence introuvable', 404);
      return envoyerFichier(res, ref.nom.endsWith('.md') ? ref.nom : `${ref.nom}.md`, 'text/markdown; charset=utf-8', ref.contenu);
    }
    const def = FICHIERS[nom];
    const contenu = def?.extraire(f);
    if (!def || !contenu) throw new AppError('Fichier introuvable', 404);
    envoyerFichier(res, nom === 'skill.zip' ? `${skill.slug}.zip` : nom, def.type, contenu);
  } catch (err) {
    next(err);
  }
});

/** GET /:id/zip — « Tout télécharger » : tous les livrables dans une archive. */
atelierSkillsRouter.get('/:id/zip', async (req: Request, res: Response, next: NextFunction) => {
  try {
    objectId.parse(req.params.id);
    const skill = await Skill.findById(req.params.id).lean();
    if (!skill) throw new AppError('Skill introuvable', 404);
    const f = skill.fichiers as unknown as Record<string, unknown>;
    const zip = new AdmZip();
    for (const [nom, def] of Object.entries(FICHIERS)) {
      const c = def.extraire(f);
      if (c) zip.addFile(`${skill.slug}-livrables/${nom === 'skill.zip' ? `${skill.slug}.zip` : nom}`, typeof c === 'string' ? Buffer.from(c, 'utf-8') : c);
    }
    (skill.fichiers.references ?? []).forEach((r) =>
      zip.addFile(`${skill.slug}-livrables/references/${r.nom.replace(/[^a-zA-Z0-9._-]/g, '-')}`, Buffer.from(r.contenu, 'utf-8'))
    );
    envoyerFichier(res, `${skill.slug}-livrables.zip`, 'application/zip', zip.toBuffer());
  } catch (err) {
    next(err);
  }
});

/** PATCH /:id — statut « déposé en boutique », renommage. */
atelierSkillsRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    objectId.parse(req.params.id);
    const body = z.object({ deposeEnBoutique: z.boolean().optional(), nom: z.string().trim().min(2).max(120).optional() }).parse(req.body ?? {});
    const skill = await Skill.findByIdAndUpdate(req.params.id, body, { new: true }).select('-fichiers.guidePdf -fichiers.preuvePdf -fichiers.zip');
    if (!skill) throw new AppError('Skill introuvable', 404);
    res.json({ skill });
  } catch (err) {
    next(err);
  }
});
