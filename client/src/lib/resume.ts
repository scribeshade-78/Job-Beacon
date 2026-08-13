import type { SupabaseClient } from "@supabase/supabase-js";

export type ResumeMimeType =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const ALLOWED_MIME_TYPES: readonly ResumeMimeType[] = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const GENERIC_FAILURE_MESSAGE = "Could not upload your resume. Please try again.";
const UNSUPPORTED_FILE_MESSAGE = "Only PDF and DOCX resumes are supported.";

export interface ResumeDocument {
  id: string;
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}

export type UploadResumeResult =
  | { kind: "success"; resume: ResumeDocument }
  | { kind: "error"; message: string };

function isSupportedMimeType(mimeType: string): mimeType is ResumeMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

type ResumeClient = Pick<SupabaseClient, "storage" | "from">;

/**
 * Client-side type check is a UX convenience, not the security boundary —
 * the "resumes" bucket's allowed_mime_types and the resume_documents
 * mime_type CHECK constraint (both server-side) are what actually enforce
 * this. Uploads the file to the candidate's own storage folder first, then
 * records it; a DB-insert failure after a successful upload leaves an
 * orphaned but harmless private object (nothing references it), which is
 * preferable to a DB row pointing at a file that was never uploaded.
 */
export async function uploadResume(
  client: ResumeClient,
  candidateId: string,
  file: { name: string; type: string; size: number },
  fileBody: Blob | ArrayBuffer,
): Promise<UploadResumeResult> {
  if (!isSupportedMimeType(file.type)) {
    return { kind: "error", message: UNSUPPORTED_FILE_MESSAGE };
  }

  const storagePath = `${candidateId}/${crypto.randomUUID()}-${file.name}`;

  try {
    const { error: uploadError } = await client.storage
      .from("resumes")
      .upload(storagePath, fileBody, { contentType: file.type });

    if (uploadError) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    const { data, error: insertError } = await client
      .from("resume_documents")
      .insert({
        candidate_id: candidateId,
        storage_path: storagePath,
        original_filename: file.name,
        mime_type: file.type,
        byte_size: file.size,
      })
      .select("id, storage_path, original_filename, mime_type, byte_size, created_at")
      .single();

    if (insertError || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return {
      kind: "success",
      resume: {
        id: data.id,
        storagePath: data.storage_path,
        originalFilename: data.original_filename,
        mimeType: data.mime_type,
        byteSize: data.byte_size,
        createdAt: data.created_at,
      },
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

export type ListResumesResult =
  | { kind: "success"; resumes: ResumeDocument[] }
  | { kind: "error"; message: string };

export async function listResumes(
  client: Pick<SupabaseClient, "from">,
): Promise<ListResumesResult> {
  try {
    const { data, error } = await client
      .from("resume_documents")
      .select("id, storage_path, original_filename, mime_type, byte_size, created_at")
      .order("created_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: "Could not load your resumes. Please try again." };
    }

    return {
      kind: "success",
      resumes: data.map((row) => ({
        id: row.id,
        storagePath: row.storage_path,
        originalFilename: row.original_filename,
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        createdAt: row.created_at,
      })),
    };
  } catch {
    return { kind: "error", message: "Could not load your resumes. Please try again." };
  }
}

export type SignedUrlResult = { kind: "success"; url: string } | { kind: "error"; message: string };

const SIGNED_URL_TTL_SECONDS = 60;

export async function getResumeSignedUrl(
  client: Pick<SupabaseClient, "storage">,
  storagePath: string,
): Promise<SignedUrlResult> {
  try {
    const { data, error } = await client.storage
      .from("resumes")
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

    if (error || !data) {
      return { kind: "error", message: "Could not open this resume. Please try again." };
    }

    return { kind: "success", url: data.signedUrl };
  } catch {
    return { kind: "error", message: "Could not open this resume. Please try again." };
  }
}

export type DeleteResumeResult = { kind: "success" } | { kind: "error"; message: string };

export async function deleteResume(
  client: Pick<SupabaseClient, "storage" | "from">,
  id: string,
  storagePath: string,
): Promise<DeleteResumeResult> {
  try {
    const { data, error: dbError } = await client
      .from("resume_documents")
      .delete()
      .eq("id", id)
      .select("id");

    if (dbError) {
      return { kind: "error", message: "Could not delete this resume. Please try again." };
    }

    // A DELETE that matches zero rows (e.g. the id doesn't exist, or RLS
    // silently filtered it because it belongs to someone else) resolves
    // with no error — checking the returned rows is the only way to tell
    // "nothing to delete" apart from "deleted", and reporting success for
    // the former would be misleading.
    if (!data || data.length === 0) {
      return { kind: "error", message: "Could not delete this resume. Please try again." };
    }

    // DB row is gone even if this fails — an orphaned private storage
    // object is preferable to silently failing the deletion the candidate
    // asked for and reporting success anyway.
    await client.storage.from("resumes").remove([storagePath]);

    return { kind: "success" };
  } catch {
    return { kind: "error", message: "Could not delete this resume. Please try again." };
  }
}
