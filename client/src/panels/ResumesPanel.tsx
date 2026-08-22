import { useEffect, useState, type ChangeEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { deleteResume, getResumeSignedUrl, listResumes, uploadResume, type ResumeDocument } from "../lib/resume";
import { extractResumeFacts, listExtractedFacts, type ExtractedFact } from "../lib/resumeExtraction";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

interface ResumesPanelProps {
  candidateId: string;
}

export function ResumesPanel({ candidateId }: ResumesPanelProps) {
  const [resumes, setResumes] = useState<ResumeDocument[] | null>(null);
  const [factsByResumeId, setFactsByResumeId] = useState<Record<string, ExtractedFact[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [extractingId, setExtractingId] = useState<string | null>(null);

  async function refreshFacts() {
    const result = await listExtractedFacts(getSupabaseBrowserClient());

    if (result.kind !== "success") {
      return;
    }

    const grouped: Record<string, ExtractedFact[]> = {};
    for (const fact of result.facts) {
      (grouped[fact.sourceDocumentId] ??= []).push(fact);
    }
    setFactsByResumeId(grouped);
  }

  async function refresh() {
    const result = await listResumes(getSupabaseBrowserClient());

    if (result.kind === "success") {
      setResumes(result.resumes);
    } else {
      setError(result.message);
    }

    await refreshFacts();
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setBusy(true);
    setError(null);

    const result = await uploadResume(
      getSupabaseBrowserClient(),
      candidateId,
      { name: file.name, type: file.type, size: file.size },
      file,
    );

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refresh();
    }

    setBusy(false);
  }

  async function handleView(storagePath: string) {
    const result = await getResumeSignedUrl(getSupabaseBrowserClient(), storagePath);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  async function handleDelete(id: string, storagePath: string) {
    setBusy(true);
    const result = await deleteResume(getSupabaseBrowserClient(), id, storagePath);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refresh();
    }

    setBusy(false);
  }

  async function handleExtract(resumeId: string) {
    setError(null);
    setExtractingId(resumeId);

    const { data } = await getSupabaseBrowserClient().auth.getSession();
    const accessToken = data.session?.access_token;

    if (!accessToken) {
      setError("Your session has expired. Please sign in again.");
      setExtractingId(null);
      return;
    }

    const result = await extractResumeFacts(resumeId, accessToken);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refreshFacts();
    }

    setExtractingId(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle id="resumes-title">Resumes</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="resumes-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        <input
          type="file"
          accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          disabled={busy}
          onChange={(event) => void handleFileChange(event)}
          aria-label="Upload resume"
          className="text-sm text-ios-text-secondary file:mr-3 file:rounded-control file:border-0 file:bg-ios-blue-button file:px-3.5 file:py-2 file:text-sm file:font-semibold file:text-white disabled:opacity-50"
        />
        <ul className="mt-4 space-y-3">
          {resumes?.map((resume) => {
            const facts = factsByResumeId[resume.id] ?? [];
            const extracting = extractingId === resume.id;

            return (
              <li key={resume.id} className="border-b border-ios-separator pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2 text-sm text-black">
                  <span className="flex-1">{resume.originalFilename}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleView(resume.storagePath)}
                  >
                    View
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || extracting}
                    onClick={() => void handleExtract(resume.id)}
                  >
                    {extracting ? "Extracting…" : "Extract facts"}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleDelete(resume.id, resume.storagePath)}
                  >
                    Delete
                  </Button>
                </div>

                {facts.length > 0 && (
                  <ul className="mt-2 space-y-1 rounded-control bg-ios-bg p-3 text-sm text-ios-text-secondary">
                    {facts.map((fact) => (
                      <li key={fact.id}>
                        <span className="font-medium text-black">{fact.factType}:</span> {fact.factValue}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
