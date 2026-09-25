/**
 * Scans syntaxiques du pipeline de génération — Architecture NexAI v6, section 4.
 *
 * IMPORTANT : un "Scan" n'est PAS un juge. C'est un contrôle automatisé
 * SANS appel IA (coût ~0$, exécution instantanée) :
 *   - Scan 1 : s'exécute AVANT le Juge Code, pour ne jamais faire juger par
 *     une IA (payante) du HTML syntaxiquement cassé.
 *   - Scan 2 : s'exécute APRÈS la réparation Grok Build, pour vérifier que
 *     le patch produit est propre avant de repasser aux juges.
 */

export interface ScanIssue {
  code: string;
  message: string;
}

export interface ScanResult {
  ok: boolean;
  issues: ScanIssue[];
  /** true si la génération a très probablement été coupée (max_tokens) */
  likelyTruncated?: boolean;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const TRUNCATION_CODES = new Set([
  'LIKELY_TRUNCATED',
  'NO_CLOSING_HTML',
  'TAG_NEVER_CLOSED',
  'CONTENT_TOO_SHORT',
  'ENDS_MID_TAG',
]);

/** True si au moins un issue indique une troncature probable. */
export function isLikelyTruncated(result: ScanResult): boolean {
  if (result.likelyTruncated) return true;
  return result.issues.some((i) => TRUNCATION_CODES.has(i.code));
}

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

function checkDocumentStructure(html: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const trimmed = html.trim();
  const lower = trimmed.toLowerCase();

  if (!lower.includes('<html')) {
    issues.push({ code: 'NO_HTML_TAG', message: 'Balise <html> absente.' });
  }
  if (!lower.includes('<body')) {
    issues.push({ code: 'NO_BODY_TAG', message: 'Balise <body> absente.' });
  }
  if (!lower.includes('<head')) {
    issues.push({ code: 'NO_HEAD_TAG', message: 'Balise <head> absente.' });
  }
  if (trimmed.length < 500) {
    issues.push({
      code: 'CONTENT_TOO_SHORT',
      message: `Contenu anormalement court (${trimmed.length} caractères) — génération probablement tronquée.`,
    });
  }

  const startsLikeHtml =
    /^<!doctype\s+html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed) ||
    lower.includes('<html');
  const hasClosingHtml = /<\/html\s*>/i.test(trimmed);

  if (startsLikeHtml && !hasClosingHtml && trimmed.length >= 500) {
    issues.push({
      code: 'NO_CLOSING_HTML',
      message:
        'Document commence comme du HTML mais ne se termine pas par </html> — troncature probable (max_tokens).',
    });
  }

  if (/<[a-zA-Z][^>]*$/.test(trimmed) || /<\/[a-zA-Z][^>]*$/.test(trimmed)) {
    issues.push({
      code: 'ENDS_MID_TAG',
      message: "Le HTML se termine au milieu d'une balise — coupure nette probable.",
    });
  }

  const styleOpen = (trimmed.match(/<style\b/gi) || []).length;
  const styleClose = (trimmed.match(/<\/style\s*>/gi) || []).length;
  const scriptOpen = (trimmed.match(/<script\b/gi) || []).length;
  const scriptClose = (trimmed.match(/<\/script\s*>/gi) || []).length;
  if (styleOpen > styleClose || scriptOpen > scriptClose) {
    issues.push({
      code: 'LIKELY_TRUNCATED',
      message: 'Bloc <style> ou <script> ouvert non refermé — génération interrompue en cours de bloc.',
    });
  }

  return issues;
}

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
  if (/^(je suis désolé|désolé|voici|bien sûr|d'accord)\b/i.test(html.trim())) {
    issues.push({
      code: 'CONVERSATIONAL_RESPONSE',
      message: 'Le modèle a répondu en conversation au lieu de produire du HTML.',
    });
  }
  return issues;
}

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
      break;
    }
  }
  return issues;
}

export function runScan1(html: string): ScanResult {
  const issues = [
    ...checkDocumentStructure(html),
    ...checkAiArtifacts(html),
    ...checkTagBalance(html),
  ];
  const likelyTruncated = issues.some((i) => TRUNCATION_CODES.has(i.code));
  return { ok: issues.length === 0, issues, likelyTruncated };
}

export function runScan2(html: string): ScanResult {
  const issues = [
    ...checkDocumentStructure(html),
    ...checkAiArtifacts(html),
    ...checkTagBalance(html),
    ...checkBrokenImages(html),
  ];
  const likelyTruncated = issues.some((i) => TRUNCATION_CODES.has(i.code));
  return { ok: issues.length === 0, issues, likelyTruncated };
}

export function formatScanIssues(result: ScanResult): string {
  return result.issues.map((i) => `[${i.code}] ${i.message}`).join('\n');
}
