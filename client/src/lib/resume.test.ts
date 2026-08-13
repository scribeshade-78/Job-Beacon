import { describe, expect, it, vi } from "vitest";
import { deleteResume, getResumeSignedUrl, listResumes, uploadResume } from "./resume";

const pdfFile = { name: "resume.pdf", type: "application/pdf", size: 1024 };

function createUploadClient(overrides: {
  uploadError?: { message: string } | null;
  insertResult?: { data: unknown; error: { message: string } | null };
}) {
  const upload = vi.fn().mockResolvedValue({ error: overrides.uploadError ?? null });
  const storage = { from: vi.fn(() => ({ upload })) };
  const single = vi.fn().mockResolvedValue(
    overrides.insertResult ?? {
      data: {
        id: "r1",
        storage_path: "candidate-1/x-resume.pdf",
        original_filename: "resume.pdf",
        mime_type: "application/pdf",
        byte_size: 1024,
        created_at: "2026-08-13T00:00:00Z",
      },
      error: null,
    },
  );
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));

  return { storage, from } as unknown as Parameters<typeof uploadResume>[0];
}

describe("uploadResume", () => {
  it("rejects unsupported file types before touching the network", async () => {
    const client = createUploadClient({});
    const result = await uploadResume(client, "candidate-1", { ...pdfFile, type: "image/png" }, new Blob());

    expect(result).toEqual({ kind: "error", message: "Only PDF and DOCX resumes are supported." });
  });

  it("returns success with the inserted resume on a clean upload", async () => {
    const client = createUploadClient({});
    const result = await uploadResume(client, "candidate-1", pdfFile, new Blob());

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.resume.originalFilename).toBe("resume.pdf");
    }
  });

  it("returns a generic error and never the raw message when storage upload fails", async () => {
    const client = createUploadClient({ uploadError: { message: "bucket quota exceeded, internal id 42" } });
    const result = await uploadResume(client, "candidate-1", pdfFile, new Blob());

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("quota");
      expect(result.message).not.toContain("42");
    }
  });

  it("returns a generic error when the metadata insert fails after a successful upload", async () => {
    const client = createUploadClient({
      insertResult: { data: null, error: { message: "permission denied for table resume_documents" } },
    });
    const result = await uploadResume(client, "candidate-1", pdfFile, new Blob());

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("permission denied");
    }
  });
});

describe("listResumes", () => {
  it("maps rows to ResumeDocument on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "r1",
          storage_path: "candidate-1/x.pdf",
          original_filename: "x.pdf",
          mime_type: "application/pdf",
          byte_size: 10,
          created_at: "2026-08-13T00:00:00Z",
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listResumes>[0];

    const result = await listResumes(client);

    expect(result).toEqual({
      kind: "success",
      resumes: [
        {
          id: "r1",
          storagePath: "candidate-1/x.pdf",
          originalFilename: "x.pdf",
          mimeType: "application/pdf",
          byteSize: 10,
          createdAt: "2026-08-13T00:00:00Z",
        },
      ],
    });
  });

  it("returns a generic error when the query rejects", async () => {
    const order = vi.fn().mockRejectedValue(new Error("connection refused at 10.0.0.5"));
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listResumes>[0];

    const result = await listResumes(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("10.0.0.5");
    }
  });
});

describe("getResumeSignedUrl", () => {
  it("returns the signed url on success", async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://example/signed" }, error: null });
    const storage = { from: vi.fn(() => ({ createSignedUrl })) };
    const client = { storage } as unknown as Parameters<typeof getResumeSignedUrl>[0];

    const result = await getResumeSignedUrl(client, "candidate-1/x.pdf");

    expect(result).toEqual({ kind: "success", url: "https://example/signed" });
  });

  it("returns a generic error when signing fails", async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: null, error: { message: "object not found" } });
    const storage = { from: vi.fn(() => ({ createSignedUrl })) };
    const client = { storage } as unknown as Parameters<typeof getResumeSignedUrl>[0];

    const result = await getResumeSignedUrl(client, "candidate-1/x.pdf");

    expect(result.kind).toBe("error");
  });
});

describe("deleteResume", () => {
  function createDeleteClient(selectResult: { data: unknown; error: { message: string } | null }) {
    const select = vi.fn().mockResolvedValue(selectResult);
    const eq = vi.fn(() => ({ select }));
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    const remove = vi.fn().mockResolvedValue({ error: null });
    const storage = { from: vi.fn(() => ({ remove })) };
    return { from, storage, remove } as unknown as Parameters<typeof deleteResume>[0] & { remove: typeof remove };
  }

  it("deletes the db row then removes the storage object", async () => {
    const client = createDeleteClient({ data: [{ id: "r1" }], error: null });

    const result = await deleteResume(client, "r1", "candidate-1/x.pdf");

    expect(result).toEqual({ kind: "success" });
    expect(client.remove).toHaveBeenCalledWith(["candidate-1/x.pdf"]);
  });

  it("returns a generic error when the db delete fails, without attempting storage removal", async () => {
    const client = createDeleteClient({ data: null, error: { message: "permission denied" } });

    const result = await deleteResume(client, "r1", "candidate-1/x.pdf");

    expect(result.kind).toBe("error");
    expect(client.remove).not.toHaveBeenCalled();
  });

  it("returns a generic error and skips storage removal when zero rows were affected", async () => {
    // No error, but an empty returned row set — e.g. the id doesn't exist,
    // or RLS silently filtered a delete for a resume that isn't the
    // caller's own. Reporting success here would be misleading.
    const client = createDeleteClient({ data: [], error: null });

    const result = await deleteResume(client, "someone-elses-id", "other-candidate/x.pdf");

    expect(result.kind).toBe("error");
    expect(client.remove).not.toHaveBeenCalled();
  });
});
