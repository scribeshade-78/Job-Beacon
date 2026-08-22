import { useEffect, useState, type ChangeEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { deleteResume, getResumeSignedUrl, listResumes, uploadResume, type ResumeDocument } from "../lib/resume";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

interface ResumesPanelProps {
  candidateId: string;
}

export function ResumesPanel({ candidateId }: ResumesPanelProps) {
  const [resumes, setResumes] = useState<ResumeDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const result = await listResumes(getSupabaseBrowserClient());

    if (result.kind === "success") {
      setResumes(result.resumes);
    } else {
      setError(result.message);
    }
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
        <ul className="mt-4 space-y-2">
          {resumes?.map((resume) => (
            <li key={resume.id} className="flex flex-wrap items-center gap-2 text-sm text-black">
              <span className="flex-1">{resume.originalFilename}</span>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleView(resume.storagePath)}>
                View
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void handleDelete(resume.id, resume.storagePath)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
