import { beforeEach, describe, expect, it, vi } from "vitest";

const getText = vi.fn();
const destroy = vi.fn();
const PDFParseMock = vi.fn(function PDFParseFake() {
  return { getText, destroy };
});

const extractRawText = vi.fn();

vi.mock("pdf-parse", () => ({
  PDFParse: PDFParseMock,
}));

vi.mock("mammoth", () => ({
  default: { extractRawText },
}));

const { extractResumeText, UnsupportedResumeFormatError } = await import("./textExtraction.js");

describe("extractResumeText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts text from a PDF via pdf-parse and always calls destroy()", async () => {
    getText.mockResolvedValue({ text: "pdf resume text" });

    const buffer = Buffer.from("fake-pdf-bytes");
    const text = await extractResumeText(buffer, "application/pdf");

    expect(text).toBe("pdf resume text");
    expect(PDFParseMock).toHaveBeenCalledWith({ data: buffer });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("calls destroy() even when getText() throws", async () => {
    getText.mockRejectedValueOnce(new Error("parse failed"));

    await expect(extractResumeText(Buffer.from("x"), "application/pdf")).rejects.toThrow("parse failed");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("extracts text from a DOCX via mammoth", async () => {
    extractRawText.mockResolvedValue({ value: "docx resume text", messages: [] });

    const buffer = Buffer.from("fake-docx-bytes");
    const text = await extractResumeText(
      buffer,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(text).toBe("docx resume text");
    expect(extractRawText).toHaveBeenCalledWith({ buffer });
  });

  it("throws UnsupportedResumeFormatError for any other mime type", async () => {
    await expect(extractResumeText(Buffer.from("x"), "image/png")).rejects.toBeInstanceOf(
      UnsupportedResumeFormatError,
    );
  });
});
