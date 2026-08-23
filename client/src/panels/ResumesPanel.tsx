import { useEffect, useState, type ChangeEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { StatusBadge, type StatusBadgeStatus } from "../components/ui/status-badge";
import { deleteResume, getResumeSignedUrl, listResumes, uploadResume, type ResumeDocument } from "../lib/resume";
import { extractResumeFacts, listExtractedFacts, type ExtractedFact } from "../lib/resumeExtraction";
import { confirmAllFacts, confirmFact, correctFact, rejectFact, reopenFact } from "../lib/factConfirmations";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

interface ResumesPanelProps {
  candidateId: string;
}

const FACT_STATUS_BADGE: Record<ExtractedFact["confirmationStatus"], StatusBadgeStatus> = {
  pending: "fact_pending",
  confirmed: "fact_confirmed",
  rejected: "fact_rejected",
};

export function ResumesPanel({ candidateId }: ResumesPanelProps) {
  const [resumes, setResumes] = useState<ResumeDocument[] | null>(null);
  const [factsByResumeId, setFactsByResumeId] = useState<Record<string, ExtractedFact[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [factBusyId, setFactBusyId] = useState<string | null>(null);
  const [bulkConfirmingResumeId, setBulkConfirmingResumeId] = useState<string | null>(null);
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

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

  async function handleConfirm(factId: string) {
    setError(null);
    setFactBusyId(factId);

    const result = await confirmFact(getSupabaseBrowserClient(), factId);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refreshFacts();
    }

    setFactBusyId(null);
  }

  async function handleReject(factId: string) {
    setError(null);
    setFactBusyId(factId);

    const result = await rejectFact(getSupabaseBrowserClient(), factId);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refreshFacts();
    }

    setFactBusyId(null);
  }

  async function handleReopen(factId: string) {
    setError(null);
    setFactBusyId(factId);

    const result = await reopenFact(getSupabaseBrowserClient(), factId);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refreshFacts();
    }

    setFactBusyId(null);
  }

  function handleStartEdit(fact: ExtractedFact) {
    setError(null);
    setEditingFactId(fact.id);
    setEditValue(fact.correctedValue ?? fact.factValue);
  }

  function handleCancelEdit() {
    setEditingFactId(null);
    setEditValue("");
  }

  async function handleSaveCorrection(factId: string) {
    const trimmed = editValue.trim();

    if (trimmed === "") {
      return;
    }

    setError(null);
    setFactBusyId(factId);

    const result = await correctFact(getSupabaseBrowserClient(), factId, trimmed);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setEditingFactId(null);
      setEditValue("");
      await refreshFacts();
    }

    setFactBusyId(null);
  }

  async function handleConfirmAll(resumeId: string, pendingFactIds: string[]) {
    setError(null);
    setBulkConfirmingResumeId(resumeId);

    const result = await confirmAllFacts(getSupabaseBrowserClient(), pendingFactIds);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refreshFacts();
    }

    setBulkConfirmingResumeId(null);
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
            const pendingFactIds = facts.filter((fact) => fact.confirmationStatus === "pending").map((fact) => fact.id);
            const bulkConfirming = bulkConfirmingResumeId === resume.id;

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
                  <div className="mt-2 space-y-2 rounded-control bg-ios-bg p-3">
                    {pendingFactIds.length > 0 && (
                      <Button
                        size="sm"
                        disabled={bulkConfirming}
                        onClick={() => void handleConfirmAll(resume.id, pendingFactIds)}
                      >
                        {bulkConfirming ? "Confirming…" : `Confirm all (${pendingFactIds.length})`}
                      </Button>
                    )}

                    <ul className="space-y-2 text-sm">
                      {facts.map((fact) => {
                        const factBusy = factBusyId === fact.id;
                        const editing = editingFactId === fact.id;

                        return (
                          <li key={fact.id} className="rounded-control border border-ios-separator bg-ios-card p-2.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1">
                                <span className="font-medium text-black">{fact.factType}:</span>{" "}
                                {fact.correctedValue !== null ? (
                                  <>
                                    <span className="text-ios-text-secondary line-through">{fact.factValue}</span>{" "}
                                    <span className="text-black">{fact.correctedValue}</span>
                                  </>
                                ) : (
                                  <span className="text-black">{fact.factValue}</span>
                                )}
                              </div>
                              <StatusBadge status={FACT_STATUS_BADGE[fact.confirmationStatus]} />
                            </div>

                            {editing ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <Input
                                  value={editValue}
                                  onChange={(event) => setEditValue(event.target.value)}
                                  disabled={factBusy}
                                  className="flex-1"
                                  aria-label={`Corrected value for ${fact.factType}`}
                                />
                                <Button
                                  size="sm"
                                  disabled={factBusy || editValue.trim() === ""}
                                  onClick={() => void handleSaveCorrection(fact.id)}
                                >
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={factBusy}
                                  onClick={handleCancelEdit}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {fact.confirmationStatus !== "confirmed" && (
                                  <Button size="sm" disabled={factBusy} onClick={() => void handleConfirm(fact.id)}>
                                    Confirm
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={factBusy}
                                  onClick={() => handleStartEdit(fact)}
                                >
                                  Correct
                                </Button>
                                {fact.confirmationStatus !== "rejected" && (
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={factBusy}
                                    onClick={() => void handleReject(fact.id)}
                                  >
                                    Reject
                                  </Button>
                                )}
                                {fact.confirmationStatus !== "pending" && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={factBusy}
                                    onClick={() => void handleReopen(fact.id)}
                                  >
                                    Un-confirm
                                  </Button>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
