import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export class UnsupportedResumeFormatError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported resume mime type for text extraction: ${mimeType}`);
    this.name = "UnsupportedResumeFormatError";
  }
}

/**
 * Extracts plain text from a resume file buffer. Only the two mime types
 * resume_documents.mime_type is CHECK-constrained to (the same allowlist
 * client/src/lib/resume.ts's ALLOWED_MIME_TYPES enforces client-side) are
 * ever stored, so no other format needs a branch here — the else branch is
 * defense-in-depth, not a real expected path.
 */
export async function extractResumeText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    const parser = new PDFParse({ data: buffer });

    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  throw new UnsupportedResumeFormatError(mimeType);
}
