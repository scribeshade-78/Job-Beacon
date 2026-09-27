import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { History, MessageCircle, Plus, Send, X } from "lucide-react";
import {
  AGENT_MODEL_OPTIONS,
  AGENT_QUICK_PROMPTS,
  DEFAULT_AGENT_MODEL,
  type AgentActionProposal,
  type AgentModelId,
} from "../../../shared/agent";
import {
  appendAgentTurn,
  getActiveConversation,
  getAgentSnapshot,
  requestAgentAction,
  requestAgentChat,
  selectConversation,
  setProposalState,
  startNewConversation,
  subscribeAgentStore,
  toRequestMessages,
} from "../lib/agentChat";
import { cn } from "../lib/utils";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { Button } from "./ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "./ui/sheet";
import { Spinner } from "./ui/spinner";

/**
 * AI Career Copilot — the candidate-facing drawer.
 *
 * MOUNTED IN AppShell, so the button is reachable from every candidate page and
 * the transcript survives navigation between them: the store is module-level
 * and the drawer only unmounts its sheet content, not its state. It is NOT
 * mounted on the moderator, admin or employer shells, which render bare and
 * belong to other personas.
 *
 * THE TRANSCRIPT IS CLIENT-HELD AND SESSION-ONLY. Nothing is written to the
 * database — the store in lib/agentChat.ts lives in memory and is gone on
 * reload — which matches the server's no-persistence stance: there is no stored
 * copy of what a candidate asked, on either side.
 *
 * HUMAN-IN-THE-LOOP IS STRUCTURAL HERE, NOT A CONVENTION. A model response can
 * only ever add cards to the transcript; the single call that changes anything
 * (requestAgentAction) appears in exactly one place in this file, inside an
 * onClick. There is no effect, no render path and no auto-run that reaches it,
 * so an action cannot happen because a card appeared — only because it was
 * pressed. A card that has been decided is rendered without buttons, so it
 * cannot be pressed twice.
 *
 * A FAILED SEND KEEPS THE QUESTION. Dropping the candidate's text on error would
 * make them retype it; instead the turn stays in the transcript and the error is
 * shown with the reason the server gave.
 */

function ProposalCard({
  entryId,
  index,
  item,
  onApprove,
}: {
  entryId: string;
  index: number;
  item: { proposal: AgentActionProposal; state: string; message: string };
  onApprove: (entryId: string, index: number, proposal: AgentActionProposal) => void;
}) {
  return (
    <div className="mt-2 w-full rounded-card border border-ios-separator bg-ios-card p-3 text-left">
      <p className="text-sm font-semibold text-black">{item.proposal.title}</p>

      <ul className="mt-1 list-disc pl-5 text-sm text-ios-text-secondary">
        {item.proposal.lines.map((line, lineIndex) => (
          <li key={lineIndex}>{line}</li>
        ))}
      </ul>

      {item.state === "pending" && (
        <>
          <p className="mt-2 text-xs text-ios-text-secondary">
            Nothing has happened yet. This runs only if you approve it.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={() => onApprove(entryId, index, item.proposal)}>
              {item.proposal.confirmLabel}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setProposalState(entryId, index, "dismissed")}
            >
              Dismiss
            </Button>
          </div>
        </>
      )}

      {item.state === "executing" && (
        <p className="mt-2 flex items-center gap-2 text-sm text-ios-text-secondary">
          <Spinner className="h-4 w-4" />
          Working…
        </p>
      )}

      {item.state === "done" && <p className="mt-2 text-sm text-status-verified-fg">{item.message}</p>}

      {item.state === "failed" && <p className="mt-2 text-sm text-status-blocked-fg">{item.message}</p>}

      {item.state === "dismissed" && (
        <p className="mt-2 text-sm text-ios-text-secondary">Dismissed. Nothing was run.</p>
      )}
    </div>
  );
}

export function CopilotDrawer() {
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<AgentModelId>(DEFAULT_AGENT_MODEL);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const snapshot = useSyncExternalStore(subscribeAgentStore, getAgentSnapshot);
  const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeId) ?? null;
  const messageCount = active?.messages.length ?? 0;

  // Keeps the newest turn in view. Keyed on the count and the pending flag, so
  // it fires when a message arrives or the typing indicator appears.
  useEffect(() => {
    const element = scrollRef.current;

    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messageCount, sending]);

  function openDrawer() {
    // A drawer with no conversation has nothing to type into, so the first open
    // creates one rather than rendering an inert composer.
    if (getAgentSnapshot().activeId === null) {
      startNewConversation();
    }

    setOpen(true);
  }

  function beginNewChat() {
    startNewConversation();
    setShowHistory(false);
    setErrorMessage(null);
    setInput("");
  }

  async function accessToken(): Promise<string | null> {
    const { data } = await getSupabaseBrowserClient().auth.getSession();

    return data.session?.access_token ?? null;
  }

  async function send(text: string) {
    const content = text.trim();

    if (content === "" || sending) {
      return;
    }

    if (getAgentSnapshot().activeId === null) {
      startNewConversation();
    }

    appendAgentTurn("user", content);
    setInput("");
    setErrorMessage(null);
    setSending(true);

    try {
      const token = await accessToken();

      if (!token) {
        setErrorMessage("Your session has expired. Please sign in again.");
        return;
      }

      // Read back through the store rather than closing over a stale copy, so
      // the turn just appended is the one sent.
      const result = await requestAgentChat(toRequestMessages(getActiveConversation()), token, { model });

      if (result.kind === "success") {
        // Proposals ride along inert; nothing here runs them.
        appendAgentTurn("assistant", result.message, result.proposals);
      } else {
        setErrorMessage(result.message);
      }
    } finally {
      setSending(false);
    }
  }

  /**
   * THE ONLY CALL THAT CHANGES ANYTHING. It is reached from ProposalCard's
   * Approve button and from nowhere else — no effect, no render, no auto-run.
   */
  async function approve(entryId: string, index: number, proposal: AgentActionProposal) {
    setProposalState(entryId, index, "executing");

    const token = await accessToken();

    if (!token) {
      setProposalState(entryId, index, "failed", "Your session has expired. Please sign in again.");
      return;
    }

    const result = await requestAgentAction(proposal.tool, proposal.arguments, token);

    if (result.kind === "executed") {
      setProposalState(entryId, index, "done", result.summary);
    } else {
      setProposalState(entryId, index, "failed", result.message);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDrawer}
        aria-label="Open Career Copilot"
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-ios-blue-button text-white shadow-card transition-colors hover:bg-[#0055b0]"
      >
        <MessageCircle className="h-6 w-6" aria-hidden="true" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <div className="flex items-start justify-between gap-3 border-b border-ios-separator px-4 py-3">
            <div className="min-w-0">
              <SheetTitle>Career Copilot</SheetTitle>
              <SheetDescription className="truncate">
                Answers from your roles, confirmed facts, plans and fit scores.
              </SheetDescription>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowHistory((current) => !current)}
                aria-pressed={showHistory}
              >
                <History className="h-4 w-4" aria-hidden="true" />
                History
              </Button>
              <Button variant="ghost" size="sm" onClick={beginNewChat}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                New Chat
              </Button>
              <SheetClose
                aria-label="Close"
                className="flex h-9 w-9 items-center justify-center rounded-control text-ios-text-secondary hover:bg-ios-bg"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </SheetClose>
            </div>
          </div>

          {showHistory && (
            <div className="max-h-56 overflow-y-auto border-b border-ios-separator bg-ios-bg px-4 py-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ios-text-secondary">
                This session
              </p>
              {snapshot.conversations.length === 0 ? (
                <p className="text-sm text-ios-text-secondary">No conversations yet.</p>
              ) : (
                <ul className="space-y-1">
                  {snapshot.conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        onClick={() => {
                          selectConversation(conversation.id);
                          setShowHistory(false);
                        }}
                        aria-current={conversation.id === snapshot.activeId ? "true" : undefined}
                        className={cn(
                          "w-full truncate rounded-control px-3 py-2 text-left text-sm",
                          conversation.id === snapshot.activeId
                            ? "bg-ios-blue/10 text-ios-blue"
                            : "text-black hover:bg-ios-card",
                        )}
                      >
                        {conversation.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-ios-text-secondary">
                Conversations are kept for this page session only and are not saved.
              </p>
            </div>
          )}

          {messageCount === 0 ? (
            <div className="flex-1 overflow-y-auto px-4 py-5">
              <p className="text-sm text-ios-text-secondary">
                Ask about your job search, or start with one of these.
              </p>
              <div className="mt-4 flex flex-col gap-2">
                {AGENT_QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void send(prompt)}
                    disabled={sending}
                    className="rounded-control border border-ios-separator bg-ios-bg px-3 py-2.5 text-left text-sm text-black hover:bg-[#e8e8ed] disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {active?.messages.map((entry) => (
                <div
                  key={entry.id}
                  className={cn("flex flex-col", entry.role === "user" ? "items-end" : "items-start")}
                >
                  {entry.content.trim() !== "" && (
                    <div
                      className={cn(
                        "max-w-[85%] whitespace-pre-wrap rounded-card px-3 py-2 text-sm",
                        entry.role === "user" ? "bg-ios-blue-button text-white" : "bg-ios-bg text-black",
                      )}
                    >
                      {entry.content}
                    </div>
                  )}

                  {entry.proposals.map((item, index) => (
                    <ProposalCard
                      key={index}
                      entryId={entry.id}
                      index={index}
                      item={item}
                      onApprove={(proposalEntryId, proposalIndex, proposal) =>
                        void approve(proposalEntryId, proposalIndex, proposal)
                      }
                    />
                  ))}
                </div>
              ))}

              {sending && (
                <div className="flex justify-start">
                  <div className="rounded-card bg-ios-bg px-3 py-2">
                    <Spinner className="h-4 w-4 text-ios-text-secondary" />
                  </div>
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <p role="alert" className="border-t border-ios-separator bg-ios-bg px-4 py-2 text-sm text-status-blocked-fg">
              {errorMessage}
            </p>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
            className="border-t border-ios-separator px-4 py-3"
          >
            <label htmlFor="copilot-input" className="sr-only">
              Message the Career Copilot
            </label>
            <textarea
              id="copilot-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline, the convention every
                // chat composer uses.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
              rows={2}
              placeholder="Ask about your job search…"
              className="w-full resize-none rounded-control border border-ios-separator bg-ios-card px-3 py-2 text-sm text-black placeholder:text-ios-text-secondary focus:outline-none"
            />

            <div className="mt-2 flex items-center justify-between gap-2">
              <label htmlFor="copilot-model" className="sr-only">
                Model
              </label>
              <select
                id="copilot-model"
                value={model}
                onChange={(event) => setModel(event.target.value as AgentModelId)}
                className="h-9 rounded-control border border-ios-separator bg-ios-card px-2 text-sm text-black"
              >
                {AGENT_MODEL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>

              <Button type="submit" size="sm" disabled={sending || input.trim() === ""}>
                <Send className="h-4 w-4" aria-hidden="true" />
                Send
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
