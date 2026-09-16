/**
 * Scans syntaxiques du pipeline de génération — Architecture NexAI v6, section 4.
 *
 * IMPORTANT : un "Scan" n'est PAS un juge. C'est un contrôle automatisé
 * SANS appel IA (coût ~0$, exécution instantanée) :
 *   - Scan 1 : s'exécute AVANT le Juge Code, pour ne jamais faire juger par
 *     une IA (payante) du HTML syntaxiquement cassé.
 *   - Scan 2 : s'exécute APRÈS la réparation Grok Build, pour vérifier que
 *     le patch produit est propre avant de repasser aux juges.
 *
 * L'ancien code confondait "Scan 1" avec le Juge Code lui-même — corrigé ici.
 * Les deux scans tournent dans TOUS les cas, essai gratuit compris.
 */

export interface ScanIssue {
  code: string;
  message: string;
}

export interface ScanResult {
  ok: boolean;
  issues: ScanIssue[];
}

/** Balises HTML auto-fermantes (void elements) — ne nécessitent jamais de fermeture. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Vérifie l'équilibrage des balises HTML (ouvertes/fermées, ordre correct).
 * Ignore le contenu de <script> et <style>, où des chevrons peuvent
 * légitimement apparaître sans être des balises.
 */
function checkTagBalance(html: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<!--[\s\S]*?-->/g, '');

  const stack: string[] = [];
  const tagRegex = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(withoutScripts)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const isSelfClosing = match[3] === '/';

    if (VOID_TAGS.has(tagName) || isSelfClosing) continue;

    if (!isClosing) {
      stack.push(tagName);
    } else {
      const lastOpen = stack.pop();
      if (lastOpen === undefined) {
        issues.push({
          code: 'TAG_CLOSED_NEVER_OPENED',
          message: `Balise fermante </${tagName}> sans balise ouvrante correspondante.`,
        });
      } else if (lastOpen !== tagName) {
        issues.push({
          code: 'TAG_MISMATCH',
          message: `Balise </${tagName}> ferme <${lastOpen}> — imbrication incorrecte.`,
        });
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = [...new Set(stack)].slice(0, 5).join(', ');
    issues.push({
      code: 'TAG_NEVER_CLOSED',
      message: `Balise(s) jamais fermée(s) : ${unclosed}.`,
    });
  }

  return issues;
}

/** Vérifie la structure minimale d'un document HTML livrable. */
function checkDocumentStructure(html: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const lower = html.toLowerCase();

  if (!lower.includes('<html')) {
    issues.push({ code: 'NO_HTML_TAG', message: 'Balise <html> absente.' });
  }
  if (!lower.includes('<body')) {
    issues.push({ code: 'NO_BODY_TAG', message: 'Balise <body> absente.' });
  }
  if (!lower.includes('<head')) {
    issues.push({ code: 'NO_HEAD_TAG', message: 'Balise <head> absente.' });
  }
  if (html.trim().length < 500) {
    issues.push({
      code: 'CONTENT_TOO_SHORT',
      message: `Contenu anormalement court (${html.trim().length} caractères) — génération probablement tronquée.`,
    });
  }
  return issues;
}

/**
 * Détecte les restes de formatage IA qui n'ont rien à faire dans un livrable
 * (fences markdown non nettoyées, texte d'excuse du modèle, placeholders).
 */
function checkAiArtifacts(html: string): ScanIssue[] {
  const issues: ScanIssue[] = [];

  if (/```/.test(html)) {
    issues.push({
      code: 'MARKDOWN_FENCE',
      message: 'Fences markdown (```) présentes dans le HTML livré.',
    });
  }
  if (/\{\{\s*[a-z_]+\s*\}\}|\[INSERT[^\]]*\]|LOREM IPSUM/i.test(html)) {
    issues.push({
      code: 'PLACEHOLDER_LEFT',
      message: 'Placeholder non remplacé détecté (variable de template, [INSERT...] ou lorem ipsum).',
    });
  }
  // Réponse conversationnelle du modèle au lieu de code pur
  if (/^(je suis désolé|désolé|voici|bien sûr|d'accord)\b/i.test(html.trim())) {
    issues.push({
      code: 'CONVERSATIONAL_RESPONSE',
      message: "Le modèle a répondu en conversation au lieu de produire du HTML.",
    });
  }
  return issues;
}

/** Détecte les images sans source exploitable (règle "jamais d'image cassée"). */
function checkBrokenImages(html: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const imgRegex = /<img\b[^>]*>/gi;
  const imgs = html.match(imgRegex) ?? [];

  for (const img of imgs) {
    const srcMatch = img.match(/\bsrc\s*=\s*["']([^"']*)["']/i);
    if (!srcMatch || !srcMatch[1].trim()) {
      issues.push({
        code: 'IMG_EMPTY_SRC',
        message: 'Balise <img> avec src vide ou absent — image cassée garantie côté client.',
      });
      break; // un seul signalement suffit, inutile de spammer
    }
  }
  return issues;
}

/**
 * SCAN 1 — avant le Juge Code.
 * Objectif : bloquer tôt le HTML manifestement cassé pour ne pas gaspiller
 * un appel IA de jugement dessus.
 */
export function runScan1(html: string): ScanResult {
  const issues = [
    ...checkDocumentStructure(html),
    ...checkAiArtifacts(html),
    ...checkTagBalance(html),
  ];
  return { ok: issues.length === 0, issues };
}

/**
 * SCAN 2 — après la réparation Grok Build.
 * Vérifie que le patch de réparation n'a pas introduit de nouveau problème
 * (et couvre en plus les images cassées, pertinentes une fois le HTML stabilisé).
 */
export function runScan2(html: string): ScanResult {
  const issues = [
    ...checkDocumentStructure(html),
    ...checkAiArtifacts(html),
    ...checkTagBalance(html),
    ...checkBrokenImages(html),
  ];
  return { ok: issues.length === 0, issues };
}

/** Format court des problèmes, à injecter dans le prompt de réparation. */
export function formatScanIssues(result: ScanResult): string {
  return result.issues.map((i) => `[${i.code}] ${i.message}`).join('\n');
}
