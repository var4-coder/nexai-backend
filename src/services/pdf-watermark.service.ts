import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';

/**
 * Ajoute un filigrane diagonal discret (email + date) sur chaque page d'un
 * PDF, généré à la volée à chaque visionnage (rien n'est stocké en dur avec
 * le filigrane — le fichier source reste propre sur Cloudinary).
 *
 * Effet dissuasif contre le partage de captures/exports : toute copie
 * diffusée porte l'identité de l'utilisateur qui l'a consultée.
 */
export async function watermarkPdfBuffer(original: Buffer, label: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(original, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const stamp = `${label} — ${new Date().toLocaleDateString('fr-FR')}`;

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = 11;
    const textWidth = font.widthOfTextAtSize(stamp, fontSize);

    // Filigrane diagonal répété en bas de page + centre, semi-transparent
    page.drawText(stamp, {
      x: width / 2 - textWidth / 2,
      y: height / 2,
      size: fontSize,
      font,
      color: rgb(0.6, 0.6, 0.6),
      opacity: 0.18,
      rotate: degrees(35),
    });
    page.drawText(stamp, {
      x: 20,
      y: 14,
      size: 8,
      font,
      color: rgb(0.4, 0.4, 0.4),
      opacity: 0.5,
    });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
