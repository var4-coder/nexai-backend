import { spawn } from 'child_process';
import { AppError } from '@/middleware/errorHandler';

/**
 * Contrôle qualité automatique d'une vidéo IA avant de la marquer "completed"
 * et de l'envoyer au client. Corrige un manque réel du pipeline : jusqu'ici,
 * le réglage MUSIC_VOLUME_PRO fixait un rapport voix/musique en confiance,
 * sans jamais vérifier le rendu final. Si ElevenLabs renvoyait une narration
 * anormalement basse, ou qu'un morceau mal masterisé ressortait plus fort que
 * prévu, rien ne l'interceptait avant la livraison.
 *
 * Deux familles de contrôles :
 * 1. Intégrité/format sur le fichier final (ffprobe) — durée, résolution/
 *    ratio, présence réelle de pistes vidéo ET audio non vides. Chaque
 *    critère est classé en deux catégories (voir `evaluateFinalVideoIntegrity`) :
 *      - PANNE DURE (bloquant) : fichier corrompu/illisible, aucune piste
 *        vidéo, aucune piste audio DU TOUT ou piste trop faible/silencieuse,
 *        durée très éloignée (>7s d'écart), ou ratio très décalé (>10%).
 *        Rien n'est livré, remboursement intégral automatique.
 *      - DÉFAUT MINEUR (non bloquant) : durée hors tolérance stricte mais
 *        dans une marge raisonnable (jusqu'à 7s), ratio légèrement décalé
 *        (jusqu'à 10%). La vidéo reste livrée, avec un badge "résultat
 *        perfectible" et une offre de relance corrective à prix réduit.
 * 2. Équilibre voix/musique (non bloquant, diagnostic) — mesure le volume
 *    moyen (dB) de la narration et de la musique de fond AVANT mixage, pour
 *    vérifier que la voix reste bien au-dessus de la musique une fois le
 *    facteur MUSIC_VOLUME_PRO appliqué. Le pipeline appelant peut s'en servir
 *    pour déclencher un remix avec une atténuation plus forte.
 */

const FFPROBE_TIMEOUT_MS = 15_000;
const FFMPEG_VOLUMEDETECT_TIMEOUT_MS = 20_000;

/** Tolérance stricte sur la durée totale livrée vs durée commandée : en-dessous, aucun défaut retenu. */
export const DURATION_TOLERANCE_SECONDS = 0.5;

/**
 * Au-delà de cet écart de durée, ce n'est plus un "défaut mineur" livrable
 * mais une panne dure (ex : segment manquant, montage tronqué) → remboursement.
 * Entre DURATION_TOLERANCE_SECONDS et ce seuil : défaut mineur, livré avec badge.
 */
export const DURATION_HARD_FAIL_SECONDS = 7;

/** Au-delà de cet écart de ratio (fraction, ex 0.05 = 5%), défaut mineur ; au-delà de RATIO_HARD_FAIL, panne dure (remboursement). */
export const RATIO_TOLERANCE = 0.05;
export const RATIO_HARD_FAIL = 0.1;

/** Écart minimum voix/musique visé (dB) — voix nettement au-dessus de la musique. */
export const MIN_VOICE_OVER_MUSIC_DB = 9;

/** En-dessous de ce volume moyen (dB), une piste audio est considérée comme vide/silencieuse (panne dure). */
const SILENT_TRACK_THRESHOLD_DB = -50;

/**
 * Entre SILENT_TRACK_THRESHOLD_DB et ce seuil, la piste est présente mais
 * anormalement faible (ex: narration TTS partiellement ratée) — considérée
 * comme panne dure : une vidéo à peine audible n'est pas un défaut cosmétique,
 * elle est remboursée plutôt que livrée avec un badge.
 */
const QUIET_TRACK_WARNING_DB = -35;

export interface MediaProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
}

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new AppError(`${cmd} : délai dépassé lors du contrôle qualité vidéo`, 500));
    }, timeoutMs);

    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      // ffprobe et ffmpeg -f null renvoient parfois un code non-nul même quand
      // la sortie utile est présente (ex: warnings) — on laisse l'appelant
      // décider selon le contenu, sauf absence totale de sortie.
      if (code !== 0 && !stdout && !stderr) {
        reject(new AppError(`${cmd} introuvable ou a échoué sans sortie (code ${code})`, 500));
        return;
      }
      resolve({ stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new AppError(`${cmd} introuvable : ${err.message}`, 500));
    });
  });
}

/**
 * Inspecte un fichier média via ffprobe : durée, dimensions, présence de
 * pistes vidéo/audio. Utilisé pour vérifier que le fichier livré au client
 * n'est ni corrompu, ni tronqué, ni sans son.
 */
export async function probeMediaFile(filePath: string): Promise<MediaProbeResult> {
  let stdout: string;
  try {
    const result = await runCommand(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      FFPROBE_TIMEOUT_MS
    );
    stdout = result.stdout;
  } catch (err) {
    throw new AppError(
      `Contrôle qualité : impossible d'analyser le fichier vidéo final (ffprobe) — ${(err as Error).message}`,
      500
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AppError('Contrôle qualité : fichier vidéo final illisible ou corrompu (sortie ffprobe invalide)', 500);
  }

  const streams: any[] = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const formatDuration = parseFloat(parsed?.format?.duration);
  const streamDuration = parseFloat(videoStream?.duration ?? audioStream?.duration);
  const durationSeconds = Number.isFinite(formatDuration)
    ? formatDuration
    : Number.isFinite(streamDuration)
      ? streamDuration
      : NaN;

  return {
    durationSeconds,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    hasVideoStream: Boolean(videoStream),
    hasAudioStream: Boolean(audioStream),
  };
}

/**
 * Mesure le volume moyen (dB) d'un fichier audio ou de la piste audio d'une
 * vidéo, via le filtre ffmpeg volumedetect. Retourne mean_volume en dB
 * (valeur négative ; plus proche de 0 = plus fort). Une piste réellement
 * silencieuse renvoie une valeur très négative (≤ -91 dB en pratique).
 */
export async function measureMeanVolumeDb(filePath: string): Promise<number> {
  const { stderr } = await runCommand(
    'ffmpeg',
    ['-i', filePath, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    FFMPEG_VOLUMEDETECT_TIMEOUT_MS
  );
  const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  if (!match) {
    throw new AppError(`Contrôle qualité : impossible de mesurer le volume audio de ${filePath}`, 500);
  }
  return parseFloat(match[1]);
}

export interface FinalVideoIntegrityParams {
  filePath: string;
  expectedDurationSeconds: number;
  expectedAspectRatio: '16:9' | '9:16';
}

export interface FinalVideoIntegrityReport {
  probe: MediaProbeResult;
  audioMeanVolumeDb: number;
  /** Pannes dures — si non vide, la vidéo ne doit PAS être livrée (remboursement). */
  blockingIssues: string[];
  /** Défauts mineurs — la vidéo est livrable, mais avec badge + offre de relance corrective. */
  minorIssues: string[];
}

/**
 * Contrôle exécuté juste avant de marquer une vidéo "completed" et de
 * l'uploader chez le client. Ne jette jamais lui-même — il classe chaque
 * défaut détecté en deux catégories, à charge de l'appelant (processVideoAd)
 * de décider quoi faire :
 *
 * PANNES DURES (blockingIssues — vidéo non livrée, remboursement intégral) :
 * - fichier illisible/corrompu
 * - piste vidéo absente
 * - piste audio absente, totalement silencieuse (≤ -50dB), OU anormalement
 *   faible (-50dB à -35dB — une vidéo à peine audible n'est pas livrable)
 * - durée très éloignée de la commande (> 7s d'écart)
 * - ratio d'image très éloigné du format commandé (> 10%)
 *
 * DÉFAUTS MINEURS (minorIssues — vidéo livrée avec badge + relance à prix
 * réduit proposée au client) :
 * - durée hors tolérance stricte (±0,5s) mais dans une marge raisonnable (≤7s)
 * - ratio légèrement décalé (au-delà de 5%, jusqu'à 10%)
 * - volume audio non mesurable techniquement (piste par ailleurs présente)
 *
 * Rien ici ne bloque pour un simple écart cosmétique imperceptible : seuls
 * des défauts réellement perceptibles remontent, dans l'une ou l'autre
 * catégorie.
 */
export async function evaluateFinalVideoIntegrity(
  params: FinalVideoIntegrityParams
): Promise<FinalVideoIntegrityReport> {
  const { filePath, expectedDurationSeconds, expectedAspectRatio } = params;
  const probe = await probeMediaFile(filePath);

  const blockingIssues: string[] = [];
  const minorIssues: string[] = [];

  if (!probe.hasVideoStream) {
    blockingIssues.push('aucune piste vidéo détectée dans le fichier final');
  }
  if (!probe.hasAudioStream) {
    blockingIssues.push('aucune piste audio détectée dans le fichier final');
  }

  if (!Number.isFinite(probe.durationSeconds)) {
    blockingIssues.push('durée du fichier final illisible');
  } else {
    const durationGap = Math.abs(probe.durationSeconds - expectedDurationSeconds);
    if (durationGap > DURATION_HARD_FAIL_SECONDS) {
      blockingIssues.push(
        `durée livrée (${probe.durationSeconds.toFixed(2)}s) très éloignée de la durée commandée (${expectedDurationSeconds}s)`
      );
    } else if (durationGap > DURATION_TOLERANCE_SECONDS) {
      minorIssues.push(
        `durée livrée (${probe.durationSeconds.toFixed(2)}s) légèrement hors tolérance vs durée commandée (${expectedDurationSeconds}s)`
      );
    }
  }

  if (probe.width && probe.height) {
    const ratio = probe.width / probe.height;
    const expectedRatio = expectedAspectRatio === '16:9' ? 16 / 9 : 9 / 16;
    const ratioGap = Math.abs(ratio - expectedRatio) / expectedRatio;
    if (ratioGap > RATIO_HARD_FAIL) {
      blockingIssues.push(
        `ratio livré (${probe.width}x${probe.height}) ne correspond pas du tout au format commandé (${expectedAspectRatio})`
      );
    } else if (ratioGap > RATIO_TOLERANCE) {
      minorIssues.push(
        `ratio livré (${probe.width}x${probe.height}) légèrement décalé vs le format commandé (${expectedAspectRatio})`
      );
    }
  } else {
    blockingIssues.push('dimensions vidéo illisibles');
  }

  // Piste audio "vide" ou anormalement faible : présente dans le conteneur
  // mais sans signal réel exploitable, ou nettement en-dessous de ce qu'on
  // attend (ex: narration TTS silencieusement échouée ou trop basse). Une
  // vidéo à peine audible n'est pas un défaut cosmétique livrable : les deux
  // cas remontent en panne dure (remboursement), pas seulement le silence total.
  let audioMeanVolumeDb = -Infinity;
  if (probe.hasAudioStream) {
    try {
      audioMeanVolumeDb = await measureMeanVolumeDb(filePath);
      if (audioMeanVolumeDb <= SILENT_TRACK_THRESHOLD_DB) {
        blockingIssues.push(`piste audio quasi silencieuse (${audioMeanVolumeDb.toFixed(1)} dB)`);
      } else if (audioMeanVolumeDb <= QUIET_TRACK_WARNING_DB) {
        blockingIssues.push(`piste audio anormalement faible (${audioMeanVolumeDb.toFixed(1)} dB)`);
      }
    } catch (err) {
      // Volume non mesurable mais piste présente et pistes vidéo/audio ok par
      // ailleurs : traité comme défaut mineur (diagnostic dégradé), pas
      // comme une panne — on ne prive pas le client d'une vidéo par ailleurs
      // valide à cause d'un outil de mesure qui a échoué.
      minorIssues.push(`volume audio du fichier final non mesurable (${(err as Error).message})`);
    }
  }

  return { probe, audioMeanVolumeDb, blockingIssues, minorIssues };
}

/**
 * Variante stricte : jette une AppError si des pannes dures sont détectées.
 * Les défauts mineurs éventuels sont retournés dans `minorIssues` sans faire
 * échouer l'appel (à l'appelant de les exploiter pour le badge/relance).
 */
export async function assertFinalVideoIntegrity(
  params: FinalVideoIntegrityParams
): Promise<FinalVideoIntegrityReport> {
  const report = await evaluateFinalVideoIntegrity(params);
  if (report.blockingIssues.length > 0) {
    throw new AppError(
      `Contrôle qualité vidéo échoué avant livraison : ${report.blockingIssues.join(' ; ')}`,
      500,
      { qcIssues: report.blockingIssues, probe: report.probe }
    );
  }
  return report;
}

export interface VoiceOverMusicBalanceParams {
  narrationPath: string;
  musicPath: string;
  /** Facteur linéaire appliqué à la musique avant mixage (ex: env.MUSIC_VOLUME_PRO). */
  musicVolumeFactor: number;
}

export interface VoiceOverMusicBalanceReport {
  ok: boolean;
  narrationMeanVolumeDb: number;
  musicMeanVolumeDb: number;
  /** Volume effectif de la musique une fois le facteur de mixage appliqué. */
  effectiveMusicDb: number;
  gapDb: number;
}

/**
 * Vérifie, AVANT mixage, que la narration restera nettement au-dessus de la
 * musique de fond une fois le facteur de mixage (MUSIC_VOLUME_PRO) appliqué.
 * Diagnostic uniquement (ne jette pas) : c'est à l'appelant (video-pipeline)
 * de décider de relancer le mix avec une atténuation plus forte si `ok` est
 * faux, plutôt que de faire échouer toute la génération pour ça.
 *
 * Le facteur de mixage étant une amplitude linéaire, son équivalent en dB
 * est 20*log10(facteur) (ex: 0.18 → environ -14.9 dB).
 */
export async function checkVoiceOverMusicBalance(
  params: VoiceOverMusicBalanceParams
): Promise<VoiceOverMusicBalanceReport> {
  const { narrationPath, musicPath, musicVolumeFactor } = params;

  const [narrationMeanVolumeDb, musicMeanVolumeDb] = await Promise.all([
    measureMeanVolumeDb(narrationPath),
    measureMeanVolumeDb(musicPath),
  ]);

  const factor = musicVolumeFactor > 0 ? musicVolumeFactor : 0.0001; // évite log10(0)
  const attenuationDb = 20 * Math.log10(factor);
  const effectiveMusicDb = musicMeanVolumeDb + attenuationDb;
  const gapDb = narrationMeanVolumeDb - effectiveMusicDb;

  return {
    ok: gapDb >= MIN_VOICE_OVER_MUSIC_DB,
    narrationMeanVolumeDb,
    musicMeanVolumeDb,
    effectiveMusicDb,
    gapDb,
  };
}
