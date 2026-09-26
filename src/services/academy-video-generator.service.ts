import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { env } from '@/config/env';
import { AppError } from '@/middleware/errorHandler';
import { callClaude, dernierUsage, reinitialiserUsage } from '@/services/ai-clients';
import { coutAppelUsd } from '@/services/cout-generation.service';
import { synthesizeSpeech } from '@/services/tts.service';
import { bunnyConfigured, envoyerVideoFichier } from '@/services/bunny-stream.service';
import { AcademyVideoJob, IScript, VideoJobPartie, VideoJobVoix } from '@/models/AcademyVideoJob';
import { AcademyPack } from '@/models/AcademyPack';
import { AcademyContent } from '@/models/AcademyContent';
import { trouverModule } from '@/data/academy-modules';
import { logEvent } from '@/services/logs.service';

/**
 * GÉNÉRATEUR « PDF → VIDÉO IA » DE L'ACADÉMIE
 *
 * Différent (et 20 à 300 fois moins cher) que Vidéo IA : ici pas d'images
 * générées, mais des diapositives claires + une voix off de formateur.
 *
 *   1. SCRIPT  — Claude lit le PDF et écrit une EXPLICATION paragraphe par
 *                paragraphe (reformulation, exemples, transitions), jamais une
 *                lecture du PDF. L'admin relit / corrige avant la voix.
 *   2. DIAPOS  — une diapositive par scène (titre + points clés), rendue par
 *                Chromium aux couleurs NexAI.
 *   3. VOIX    — Gemini (défaut, ≈ 0,014 $/min) ou ElevenLabs (≈ 0,09 $/min).
 *   4. MONTAGE — ffmpeg : image fixe + voix par scène, fondus, assemblage.
 *   5. ENVOI   — Bunny Stream, puis leçon créée en BROUILLON dans la formation.
 */

// ─── 1. Script ────────────────────────────────────────────────────────────

const CONSIGNES_PARTIE: Record<VideoJobPartie, string> = {
  bases: `PARTIE 1 « LES BASES » — explication générale avant la vraie formation.
- Durée visée : 3 à 6 minutes de parole (450 à 900 mots de narration au total), 4 à 7 scènes.
- Ne garde que l'essentiel : de quoi on parle, pourquoi c'est utile, les grandes idées.
- Dis clairement au début que c'est une introduction générale avant la formation complète.
- Dernière scène : donne envie de continuer. Invite à suivre la formation complète, où tout est expliqué en détail,
  puis la pratique, où l'on apprend à le faire vraiment.`,
  complet: `PARTIE 2 « COMPRENDRE » — le cours complet expliqué.
- Couvre TOUT le contenu du document, dans l'ordre, paragraphe par paragraphe.
- Durée visée : 12 à 25 minutes de parole selon la longueur du document, 10 à 25 scènes.
- Tu expliques la méthode, le pourquoi et les étapes dans les grandes lignes. Tu NE montres JAMAIS une manipulation
  pas à pas dans un logiciel (clic par clic, réglage par réglage) : quand on arrive à ce moment, dis que la phase
  pratique le montre concrètement.
- Dernière scène : félicite, résume, puis donne envie de passer à la pratique (voir PRATIQUE ci-dessous) et
  présente la phase pratique comme le moment où la vraie formation commence, puis le Kit Expert (guides,
  modèles prêts à l'emploi, check-lists) à télécharger et garder, inclus dans l'abonnement Starter.`,
  pratique: `PARTIE 2 « PRATIQUER » — cas pratiques guidés.
- Construis 1 à 3 cas concrets et réalistes tirés du document : la situation de départ, la démarche, les étapes
  une par une, le résultat, les erreurs à éviter.
- Durée visée : 6 à 15 minutes de parole, 6 à 15 scènes.
- Parle comme un formateur qui accompagne : « à vous de jouer », « vérifiez que… ».
- Dernière scène : résume ce qu'on sait maintenant faire et invite à télécharger le Kit Expert pour garder les guides et les modèles.`,
};

function consigneScript(opts: {
  partie: VideoJobPartie;
  domaine: string;
  formation: string;
  pratiquesReelles: boolean;
}): string {
  const pratique = opts.pratiquesReelles
    ? "PHASE PRATIQUE : cette formation contient des vidéos pratiques présentées par un formateur réel, qui montre les étapes sur des cas concrets. Tu peux dire « un formateur réel », jamais « notre expert » ni « un formateur NexAI »."
    : "PHASE PRATIQUE : cette formation propose des cas pratiques guidés pas à pas par le formateur IA NexAI. N'évoque AUCUN formateur réel ou humain.";
  return `Tu es le formateur IA de l'Académie NexAI. Tu enregistres la voix off d'une vidéo de formation animée
(diapositives + ta voix) pour un public francophone (Afrique de l'Ouest et France), débutant à intermédiaire.
Domaine : « ${opts.domaine} ». Formation : « ${opts.formation} ».

RÈGLES D'ÉCRITURE
- Tu EXPLIQUES, tu ne LIS PAS. Pour chaque idée du document : reformule simplement, donne un exemple concret
  du quotidien de ton public, fais le lien avec ce qui précède (« maintenant que vous avez compris ça… »).
- Tu t'adresses au client (« vous »), avec un ton chaleureux, clair et motivant, comme en face à face.
- Si tu te présentes, dis « votre formateur IA NexAI » : ne prétends jamais être une personne humaine.
- Parle toujours de « la phase pratique » (jamais « la vidéo pratique » au singulier) et du « Kit Expert ».
- FIDÉLITÉ : n'affirme que ce qui est dans le document. Les exemples que tu ajoutes sont présentés comme des
  exemples (« par exemple », « imaginez »). Aucun chiffre, statistique ou nom inventé. Jamais de promesse de gains
  d'argent ni de résultat garanti.
- La narration est faite pour être DITE : phrases courtes, pas de listes, pas de symboles, pas d'emojis, pas de
  markdown, pas d'abréviations ; écris les sigles la première fois en entier.
- Chaque scène : un titre de diapositive (8 mots maximum), 2 à 5 points clés très courts (10 mots maximum
  chacun) affichés à l'écran, et la narration de la scène (60 à 220 mots).

${CONSIGNES_PARTIE[opts.partie]}

${pratique}

Réponds UNIQUEMENT avec un objet JSON strict :
{"titre": "titre de la vidéo (60 caractères maximum)",
 "description": "2 phrases qui donnent envie de regarder",
 "scenes": [{"titre": "…", "points": ["…", "…"], "narration": "…"}]}`;
}

function lireJson(texte: string): unknown {
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut < 0 || fin <= debut) throw new AppError('Script illisible (pas de JSON)', 502);
  return JSON.parse(texte.slice(debut, fin + 1));
}

export function normaliserScript(brut: unknown): IScript {
  const b = (brut || {}) as { titre?: unknown; description?: unknown; scenes?: unknown };
  const scenes = (Array.isArray(b.scenes) ? b.scenes : [])
    .map((s) => {
      const x = (s || {}) as { titre?: unknown; points?: unknown; narration?: unknown };
      return {
        titre: String(x.titre || '').trim().slice(0, 90),
        points: (Array.isArray(x.points) ? x.points : [])
          .map((p) => String(p).trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 5),
        narration: String(x.narration || '').trim().slice(0, 4000),
      };
    })
    .filter((s) => s.titre && s.narration);
  if (scenes.length === 0) throw new AppError('Le script ne contient aucune scène exploitable.', 422);
  return {
    titre: String(b.titre || 'Vidéo Académie NexAI').trim().slice(0, 120),
    description: String(b.description || '').trim().slice(0, 600),
    scenes: scenes.slice(0, 40),
  };
}

/** Extraction du texte source : PDF (couche texte) ou fichier texte. */
export async function extraireTexteSource(buffer: Buffer, nomFichier: string): Promise<string> {
  let texte = '';
  if (/\.pdf$/i.test(nomFichier)) {
    const pdfParse = (await import('pdf-parse')).default;
    texte = (await pdfParse(buffer)).text || '';
  } else {
    texte = buffer.toString('utf8');
  }
  texte = texte.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (texte.length < 200) {
    throw new AppError(
      'Texte illisible ou trop court. Un PDF scanné (image) doit d’abord être converti en PDF texte.',
      422
    );
  }
  // Borne haute : ~60 000 caractères ≈ 40 pages, suffisant pour une formation.
  return texte.slice(0, 60000);
}

export async function ecrireScript(jobId: string): Promise<void> {
  const job = await AcademyVideoJob.findById(jobId).select('+sourceTexte');
  if (!job) return;
  try {
    const pack = await AcademyPack.findById(job.packId);
    const module = trouverModule(job.module);
    const pratiquesReelles = Boolean(
      await AcademyContent.exists({ packId: job.packId, partie: 'pratique', genre: 'reelle', status: 'publié' })
    );
    reinitialiserUsage();
    const brut = await callClaude(
      'claude-sonnet-5',
      consigneScript({
        partie: job.partie,
        domaine: module?.titre ?? job.module,
        formation: pack?.titre ?? 'Formation',
        pratiquesReelles,
      }),
      [{ role: 'user', content: `DOCUMENT SOURCE :\n\n${job.sourceTexte}` }],
      { maxTokens: 16000, timeoutMs: 300_000 }
    );
    const u = dernierUsage;
    job.coutUsd += u ? coutAppelUsd(u.modele, u.entree, u.sortie, u.cache) : 0;
    job.script = normaliserScript(lireJson(brut));
    job.statut = 'script_pret';
    job.erreur = undefined;
    await job.save();
  } catch (e) {
    job.statut = 'erreur';
    job.etape = 'script';
    job.erreur = (e as Error).message.slice(0, 500);
    await job.save();
    throw e;
  }
}

// ─── 2. Diapositives ──────────────────────────────────────────────────────

function echapper(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LIBELLE_PARTIE: Record<VideoJobPartie, string> = {
  bases: 'Les bases',
  complet: 'Formation complète',
  pratique: 'Cas pratique',
};

function htmlDiapo(opts: {
  domaine: string;
  partie: VideoJobPartie;
  titre: string;
  points: string[];
  numero?: string;
  couverture?: boolean;
  /** Avancement dans la vidéo, de 0 à 100 (barre de progression en bas) */
  avancement?: number;
}): string {
  const points = opts.points.map((p) => `<li><span class="puce"></span>${echapper(p)}</li>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1920px;height:1080px;overflow:hidden;background:#0A0B0F;color:#F4F6FB;
font-family:"DejaVu Sans","Liberation Sans",Arial,sans-serif;position:relative}
.halo{position:absolute;right:-260px;top:-260px;width:900px;height:900px;border-radius:50%;
background:radial-gradient(circle,rgba(29,78,216,.45),rgba(29,78,216,0) 65%)}
.halo2{position:absolute;left:-300px;bottom:-380px;width:900px;height:900px;border-radius:50%;
background:radial-gradient(circle,rgba(53,214,140,.16),rgba(53,214,140,0) 65%)}
.haut{position:absolute;top:70px;left:110px;right:110px;display:flex;justify-content:space-between;
font-size:30px;color:#8B92A5;letter-spacing:.04em}
.marque b{color:#F4F6FB}.marque i{font-style:normal;color:#3B6CF6}
.cadre{position:absolute;left:110px;right:110px;top:${opts.couverture ? 330 : 210}px}
.etiquette{display:inline-block;background:rgba(29,78,216,.22);color:#9DB8FF;border:2px solid rgba(59,108,246,.5);
padding:10px 26px;border-radius:40px;font-size:30px;margin-bottom:${opts.couverture ? 40 : 34}px}
h1{font-size:${opts.couverture ? 96 : 76}px;line-height:1.1;font-weight:700;max-width:1500px}
ul{list-style:none;margin-top:70px;display:flex;flex-direction:column;gap:34px}
li{font-size:46px;line-height:1.25;display:flex;align-items:flex-start;gap:30px;max-width:1550px}
.puce{flex:0 0 22px;height:22px;border-radius:6px;background:#1D4ED8;margin-top:16px}
.bas{position:absolute;bottom:60px;left:110px;right:110px;height:6px;border-radius:3px;background:#23262F}
.bas span{display:block;height:100%;width:${Math.max(2, Math.min(100, opts.avancement ?? 0))}%;border-radius:3px;background:#1D4ED8}
</style></head><body><div class="halo"></div><div class="halo2"></div>
<div class="haut"><div class="marque"><b>Nex</b><i>AI</i> Académie · ${echapper(opts.domaine)}</div><div>${echapper(opts.numero || '')}</div></div>
<div class="cadre"><div class="etiquette">${echapper(LIBELLE_PARTIE[opts.partie])}</div>
<h1>${echapper(opts.titre)}</h1>${opts.couverture ? '' : `<ul>${points}</ul>`}</div>
<div class="bas"><span></span></div></body></html>`;
}

async function rendreDiapos(pages: string[], dossier: string): Promise<string[]> {
  const { chromium } = await import('playwright');
  const navigateur = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await navigateur.newPage({ viewport: { width: 1920, height: 1080 } });
    const fichiers: string[] = [];
    for (const [i, html] of pages.entries()) {
      await page.setContent(html, { waitUntil: 'load' });
      const f = path.join(dossier, `diapo-${String(i).padStart(3, '0')}.png`);
      await page.screenshot({ path: f });
      fichiers.push(f);
    }
    return fichiers;
  } finally {
    await navigateur.close();
  }
}

// ─── 3. Voix ──────────────────────────────────────────────────────────────

/** Enveloppe du PCM brut (16 bits, mono) dans un en-tête WAV. */
function pcmVersWav(pcm: Buffer, frequence = 24000): Buffer {
  const entete = Buffer.alloc(44);
  entete.write('RIFF', 0);
  entete.writeUInt32LE(36 + pcm.length, 4);
  entete.write('WAVE', 8);
  entete.write('fmt ', 12);
  entete.writeUInt32LE(16, 16);
  entete.writeUInt16LE(1, 20);
  entete.writeUInt16LE(1, 22);
  entete.writeUInt32LE(frequence, 24);
  entete.writeUInt32LE(frequence * 2, 28);
  entete.writeUInt16LE(2, 32);
  entete.writeUInt16LE(16, 34);
  entete.write('data', 36);
  entete.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([entete, pcm]);
}

async function voixGemini(texte: string): Promise<Buffer> {
  if (!env.GEMINI_API_KEY) throw new AppError('GEMINI_API_KEY manquante : la voix Gemini est indisponible.', 503);
  const entetes = { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY };
  const style = 'formateur chaleureux, clair et posé, qui explique à un débutant';
  const enWav = (b64: string) => {
    const audio = Buffer.from(b64, 'base64');
    return audio.subarray(0, 4).toString() === 'RIFF' ? audio : pcmVersWav(audio);
  };
  let derniereErreur = '';

  // 1. API « Interactions » : format documenté par Google pour les modèles
  //    de voix Gemini 3.8 (vérifié le 26/09/2026). Audio WAV 24 kHz.
  const interactions = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: entetes,
    body: JSON.stringify({
      model: env.GEMINI_TTS_MODEL,
      input: [
        {
          type: 'user_input',
          content: [{ type: 'text', text: texte, annotations: [{ type: 'speech_metadata', style }] }],
        },
      ],
      response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: env.GEMINI_TTS_VOICE }] },
    }),
  });
  if (interactions.ok) {
    const d = (await interactions.json()) as {
      steps?: { type?: string; content?: { type?: string; data?: string }[] }[];
    };
    const audios = (d.steps ?? [])
      .filter((st) => !st.type || st.type === 'model_output')
      .flatMap((st) => st.content ?? [])
      .filter((c) => c.data && (!c.type || c.type === 'audio'));
    const b64 = audios[audios.length - 1]?.data;
    if (b64) return enWav(b64);
    derniereErreur = 'réponse sans audio (Interactions)';
  } else {
    derniereErreur = `${interactions.status} ${(await interactions.text()).slice(0, 300)}`;
    if (interactions.status === 401 || interactions.status === 403) {
      throw new AppError(`Gemini : clé refusée (${derniereErreur})`, 502);
    }
  }

  // 2. Secours : ancien format generateContent (modèles de voix précédents).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_TTS_MODEL)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: entetes,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Lis ce texte comme un ${style} : ${texte}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_TTS_VOICE } } },
      },
    }),
  });
  if (res.ok) {
    const d = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
    const b64 = d.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (b64) return enWav(b64);
    derniereErreur += ' / réponse sans audio (generateContent)';
  } else {
    derniereErreur += ` / ${res.status} ${(await res.text()).slice(0, 200)}`;
  }
  throw new AppError(`Gemini : voix impossible (${derniereErreur})`, 502);
}

async function genererVoix(texte: string, voix: VideoJobVoix): Promise<{ audio: Buffer; extension: string }> {
  if (voix === 'elevenlabs') {
    // Voix fixe (pas de tirage au sort) : le même formateur sur toute l'Académie.
    const r = await synthesizeSpeech(texte, { voiceId: env.ELEVENLABS_VOICE_ID });
    return { audio: r.audioBuffer, extension: 'mp3' };
  }
  return { audio: await voixGemini(texte), extension: 'wav' };
}

function coutVoixUsd(voix: VideoJobVoix, texte: string, secondes: number): number {
  // ElevenLabs Multilingual : 0,10 $ / 1 000 caractères. Gemini Flash TTS : 9 $ / 1 M
  // jetons audio à 25 jetons par seconde (tarifs 2026, doublés au 01/01/2027).
  return voix === 'elevenlabs' ? (texte.length / 1000) * 0.1 : (secondes * 25 * 9) / 1e6;
}

// ─── 4. Montage ───────────────────────────────────────────────────────────

function executer(commande: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(commande, args);
    let sortie = '';
    let erreur = '';
    p.stdout.on('data', (d) => (sortie += d.toString()));
    p.stderr.on('data', (d) => (erreur += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(sortie) : reject(new Error(`${commande} a échoué (${code}) : ${erreur.slice(-400)}`))
    );
  });
}

async function dureeAudio(fichier: string): Promise<number> {
  const s = await executer('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', fichier,
  ]);
  const d = parseFloat(s.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('Durée audio illisible');
  return d;
}

/** Une scène = image fixe + voix, fondu d'entrée et de sortie, courte pause finale. */
async function monterScene(image: string, audio: string | null, duree: number, sortie: string): Promise<void> {
  const d = duree.toFixed(2);
  const fin = Math.max(0, duree - 0.4).toFixed(2);
  const args = ['-y', '-loop', '1', '-framerate', '25', '-i', image];
  if (audio) args.push('-i', audio);
  else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100');
  args.push(
    '-filter_complex',
    `[0:v]scale=1920:1080,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=${fin}:d=0.4[v];[1:a]aresample=44100,apad[a]`,
    '-map', '[v]', '-map', '[a]',
    '-t', d,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '24', '-r', '25',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '1', '-ar', '44100',
    sortie
  );
  await executer('ffmpeg', args);
}

async function assembler(scenes: string[], dossier: string, sortie: string): Promise<void> {
  const liste = path.join(dossier, 'liste.txt');
  await fs.writeFile(liste, scenes.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
  await executer('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', liste, '-c', 'copy', '-movflags', '+faststart', sortie]);
}

/**
 * Cœur de fabrication, sans base de données : diapositives → voix → montage.
 * Exporté pour pouvoir être testé seul (voix simulée) avant de payer une voix.
 */
export async function produireVideo(opts: {
  script: IScript;
  domaine: string;
  partie: VideoJobPartie;
  dossier: string;
  voix: (texte: string) => Promise<{ audio: Buffer; extension: string }>;
  progression?: (pourcentage: number, etape: string) => Promise<void>;
}): Promise<{ fichier: string; dureeTotale: number; durees: number[] }> {
  const { script, domaine, partie, dossier } = opts;
  const signaler = opts.progression ?? (async () => undefined);
  const total = script.scenes.length;

  // Diapositives : une couverture + une par scène.
  await signaler(3, 'diapositives');
  const pages = [
    htmlDiapo({ domaine, partie, titre: script.titre, points: [], couverture: true, avancement: 0 }),
    ...script.scenes.map((s, i) =>
      htmlDiapo({
        domaine,
        partie,
        titre: s.titre,
        points: s.points,
        numero: `${i + 1} / ${total}`,
        avancement: ((i + 1) / total) * 100,
      })
    ),
  ];
  const images = await rendreDiapos(pages, dossier);

  // Couverture : 3 secondes de silence.
  const morceaux: string[] = [];
  const couverture = path.join(dossier, 'scene-000.mp4');
  await monterScene(images[0], null, 3, couverture);
  morceaux.push(couverture);

  let dureeTotale = 3;
  const durees: number[] = [];
  for (const [i, scene] of script.scenes.entries()) {
    await signaler(8 + (i / total) * 80, `voix et montage ${i + 1}/${total}`);
    const { audio, extension } = await opts.voix(scene.narration);
    const fichierAudio = path.join(dossier, `voix-${i}.${extension}`);
    await fs.writeFile(fichierAudio, audio);
    const duree = (await dureeAudio(fichierAudio)) + 0.7;
    durees.push(duree);
    const sortie = path.join(dossier, `scene-${String(i + 1).padStart(3, '0')}.mp4`);
    await monterScene(images[i + 1], fichierAudio, duree, sortie);
    morceaux.push(sortie);
    dureeTotale += duree;
  }

  await signaler(90, 'assemblage');
  const fichier = path.join(dossier, 'video.mp4');
  await assembler(morceaux, dossier, fichier);
  return { fichier, dureeTotale, durees };
}

// ─── 5. Fabrication complète ──────────────────────────────────────────────

export async function fabriquerVideo(jobId: string): Promise<void> {
  const job = await AcademyVideoJob.findById(jobId);
  if (!job || !job.script) return;
  const dossier = await fs.mkdtemp(path.join(os.tmpdir(), 'nexai-academie-'));
  const maj = async (progression: number, etape: string) => {
    job.progression = Math.round(progression);
    job.etape = etape;
    await job.save();
  };

  try {
    if (!bunnyConfigured()) {
      throw new AppError('Configurez Bunny Stream (variables BUNNY_STREAM_*) avant de fabriquer une vidéo.', 503);
    }
    const pack = await AcademyPack.findById(job.packId);
    if (!pack) throw new AppError('Formation introuvable', 404);
    const domaine = trouverModule(job.module)?.titre ?? job.module;
    const script = job.script;
    const { fichier: finale, dureeTotale, durees } = await produireVideo({
      script,
      domaine,
      partie: job.partie,
      dossier,
      voix: (texte) => genererVoix(texte, job.voix),
      progression: maj,
    });
    const coutVoix = script.scenes.reduce((t, sc, i) => t + coutVoixUsd(job.voix, sc.narration, durees[i] ?? 0), 0);

    await maj(94, 'envoi sur Bunny');
    const guid = await envoyerVideoFichier(finale, script.titre);

    const ordre = (await AcademyContent.countDocuments({ packId: pack._id, partie: job.partie })) + 1;
    const content = await AcademyContent.create({
      title: script.titre,
      description: script.description,
      type: 'video',
      access: 'gratuit',
      status: 'brouillon',
      hosting: 'bunny',
      sourceUrl: guid,
      module: job.module,
      packId: pack._id,
      partie: job.partie,
      genre: job.partie === 'pratique' ? 'pratique_ia' : 'ia',
      role: 'seance',
      ordre,
      duree: Math.round(dureeTotale),
      fournisseur: 'NexAI — vidéo IA',
      attribution: { licence: 'nexai' },
    });

    job.coutUsd += coutVoix;
    job.contentId = content._id;
    job.dureeSecondes = Math.round(dureeTotale);
    job.statut = 'terminee';
    job.progression = 100;
    job.etape = 'terminée';
    job.erreur = undefined;
    await job.save();
    await logEvent({
      categorie: 'action_admin',
      niveau: 'info',
      message: `Académie : vidéo IA « ${script.titre} » fabriquée (${Math.round(dureeTotale / 60)} min, ≈ ${job.coutUsd.toFixed(2)} $) — brouillon à publier`,
    });
  } catch (e) {
    job.statut = 'erreur';
    job.erreur = (e as Error).message.slice(0, 500);
    await job.save();
    throw e;
  } finally {
    await fs.rm(dossier, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── Entrée : création d'un travail ───────────────────────────────────────

export async function creerTravail(opts: {
  buffer: Buffer;
  nomFichier: string;
  packId: string;
  partie: VideoJobPartie;
  voix: VideoJobVoix;
}) {
  const pack = await AcademyPack.findById(opts.packId);
  if (!pack || !pack.module) throw new AppError('Formation introuvable', 404);
  const sourceTexte = await extraireTexteSource(opts.buffer, opts.nomFichier);
  return AcademyVideoJob.create({
    packId: pack._id,
    module: pack.module,
    partie: opts.partie,
    voix: opts.voix,
    sourceNom: opts.nomFichier.slice(0, 200),
    sourceTexte,
    statut: 'script_en_cours',
  });
}
