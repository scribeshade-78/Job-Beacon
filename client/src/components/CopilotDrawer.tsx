import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "wouter";
import { History, MessageCircle, Plus, Send, Sparkles, X } from "lucide-react";
import {
  AGENT_MODEL_OPTIONS,
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
import { listSelectedRoles } from "../lib/candidateSelectedRoles";
import {
  pageForPath,
  suggestCopilotPrompts,
  type CopilotSignals,
  type CopilotSuggestion,
} from "../lib/copilotPrompts";
import { listExtractedFacts } from "../lib/resumeExtraction";
import { cn } from "../lib/utils";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { Button } from "./ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "./ui/sheet";
import { Spinner } from "./ui/spinner";

/**
 * AI Career Copilot — the candidate-facing drawer.
 *
 * MOUNTED IN AppShell, so the button is reachable from every candidate page and
 * the transcript survives navigation between them: the store is module-level and
 * the drawer only unmounts its sheet content, not its state. It is NOT mounted on
 * the moderator, admin or employer shells, which render bare and belong to other
 * personas.
 *
 * THE TRANSCRIPT IS CLIENT-HELD AND SESSION-ONLY. Nothing is written to the
 * database — the store in lib/agentChat.ts lives in memory and is gone on reload
 * — which matches the server's no-persistence stance: there is no stored copy of
 * what a candidate asked, on either side.
 *
 * HUMAN-IN-THE-LOOP IS STRUCTURAL HERE, NOT A CONVENTION. A model response can
 * only ever add cards to the transcript; the single call that changes anything
 * (requestAgentAction) appears in exactly one place in this file, inside an
 * onClick. There is no effect, no render path and no auto-run that reaches it, so
 * an action cannot happen because a card appeared — only because it was pressed.
 * A card that has been decided is rendered without buttons, so it cannot be
 * pressed twice.
 *
 * A FAILED SEND KEEPS THE QUESTION. Dropping the candidate's text on error would
 * make them retype it; instead the turn stays in the transcript and the error is
 * shown with the reason the server gave.
 *
 * SUGGESTED PROMPTS ARE CONDITIONAL AND HONEST. Which ones appear is decided by
 * lib/copilotPrompts.ts from the current route and two readable facts — target
 * roles and extracted resume facts — and a suggestion is either a question the
 * assistant can actually answer from its injected context, or a prerequisite with
 * a link to the page that resolves it. Nothing here fakes a working action.
 */

function SuggestionPill({
  label,
  disabled,
  onSend,
}: {
  label: string;
  disabled: boolean;
  onSend: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={disabled}
      className={cn(
        "rounded-full border border-blue-200 bg-white px-3.5 py-1.5 text-xs font-medium text-blue-700",
        "transition-colors hover:border-blue-600 hover:bg-blue-600 hover:text-white",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      {label}
    </button>
  );
}

/**
 * A prompt the account cannot support yet, shown instead of a button that would
 * fail. It states what is missing and links to where it is fixed; it is never
 * sendable, so it can never produce an answer the assistant had no data for.
 */
function PrerequisitePill({
  suggestion,
  onNavigate,
}: {
  suggestion: CopilotSuggestion;
  onNavigate: () => void;
}) {
  const prerequisite = suggestion.prerequisite;

  if (!prerequisite) {
    return null;
  }

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3">
      <p className="text-xs font-semibold text-slate-700">{suggestion.label}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{prerequisite.message}</p>
      <Link
        href={prerequisite.href}
        onClick={onNavigate}
        className="mt-2 inline-block text-xs font-semibold text-blue-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        {prerequisite.linkLabel}
      </Link>
    </div>
  );
}

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
    <div className="mt-2 w-full rounded-xl border border-blue-200 bg-blue-50/40 p-3.5 text-left">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-600">Proposed action</p>

      <p className="mt-1 text-sm font-semibold text-slate-900">{item.proposal.title}</p>

      {/* Server-built from the database, not from the model's words: these lines
          name the real destination and the information involved. */}
      {/* NO DECORATIVE GLYPH. A bullet at the content edge pushes its own text
          ~14px right of every other line in the card (the eyebrow, the title and
          the safety sentence all start at the card's content edge), which reads
          as an accidental indent. As separate <li> lines with the card's own
          spacing the jobs stay distinct AND align with the content above and
          below. */}
      <ul className="mt-1.5 space-y-1 text-sm text-slate-600">
        {item.proposal.lines.map((line, lineIndex) => (
          <li key={lineIndex} className="min-w-0">
            {line}
          </li>
        ))}
      </ul>

      {item.state === "pending" && (
        <>
          <p className="mt-2.5 text-xs text-slate-500">
            Nothing has happened yet. This runs only if you approve it.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <Button
              size="sm"
              className="bg-blue-600 font-semibold text-white hover:bg-blue-700 active:bg-blue-800"
              onClick={() => onApprove(entryId, index, item.proposal)}
            >
              {item.proposal.confirmLabel}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              onClick={() => setProposalState(entryId, index, "dismissed")}
            >
              Dismiss
            </Button>
          </div>
        </>
      )}

      {item.state === "executing" && (
        <p className="mt-2.5 flex items-center gap-2 text-sm text-slate-500">
          <Spinner className="h-4 w-4" />
          Working…
        </p>
      )}

      {item.state === "done" && (
        <p className="mt-2.5 text-sm font-medium text-emerald-700">{item.message}</p>
      )}

      {item.state === "failed" && <p className="mt-2.5 text-sm text-red-600">{item.message}</p>}

      {item.state === "dismissed" && (
        <p className="mt-2.5 text-sm text-slate-500">Dismissed. Nothing was run.</p>
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
  const [signals, setSignals] = useState<CopilotSignals | null>(null);
  const [signalsAttempted, setSignalsAttempted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [location] = useLocation();

  const snapshot = useSyncExternalStore(subscribeAgentStore, getAgentSnapshot);
  const active = snapshot.conversations.find((conversation) => conversation.id === snapshot.activeId) ?? null;
  const messageCount = active?.messages.length ?? 0;

  const suggestions = suggestCopilotPrompts(pageForPath(location), signals);
  const currentModelLabel =
    AGENT_MODEL_OPTIONS.find((option) => option.id === model)?.label ?? DEFAULT_AGENT_MODEL;

  // Keeps the newest turn in view. Keyed on the count and the pending flag, so it
  // fires when a message arrives or the typing indicator appears.
  useEffect(() => {
    const element = scrollRef.current;

    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messageCount, sending]);

  /**
   * Read the two facts the prompt selection depends on, ONCE, and only when the
   * drawer is first opened.
   *
   * Not on mount: a candidate who never opens the Copilot should not pay for two
   * queries on every page. Not on every open either, because neither fact changes
   * while the page is loaded in a way the drawer needs to chase.
   *
   * A failure leaves `signals` null, which the prompt module reads as "unknown"
   * and answers by claiming no prerequisite it cannot prove.
   */
  useEffect(() => {
    if (!open || signalsAttempted) {
      return;
    }

    setSignalsAttempted(true);

    let cancelled = false;

    void (async () => {
      const client = getSupabaseBrowserClient();
      const [roles, facts] = await Promise.all([listSelectedRoles(client), listExtractedFacts(client)]);

      if (cancelled) {
        return;
      }

      if (roles.kind === "success" && facts.kind === "success") {
        setSignals({ targetRoleCount: roles.roles.length, extractedFactCount: facts.facts.length });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, signalsAttempted]);

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

      // Read back through the store rather than closing over a stale copy, so the
      // turn just appended is the one sent.
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
      <Sheet open={open} onOpenChange={setOpen}>
        {/* SheetTrigger AS CHILD, AND IT IS THE FOCUS FIX. Radix restores focus on
            close to the element it was opened from — but only to its own Trigger.
            While the launcher was a plain button outside the Root, Radix had no
            trigger to return to and focus fell to <body>, so a keyboard user lost
            their place after every Escape. asChild merges Radix's props onto this
            same button, so the launcher IS the trigger and keeps its styling,
            aria-label and its own onClick. */}
        <SheetTrigger asChild>
          <button
            type="button"
            onClick={openDrawer}
            aria-label="Open Career Copilot"
            className={cn(
              "fixed right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full",
              "bottom-[calc(1.5rem+env(safe-area-inset-bottom))]",
              "bg-blue-600 text-white shadow-lg transition-colors hover:bg-blue-700 active:bg-blue-800",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2",
            )}
          >
            <MessageCircle className="h-6 w-6" aria-hidden="true" />
          </button>
        </SheetTrigger>

        <SheetContent>
          <div className="flex items-center justify-between gap-2 border-b border-blue-100 bg-white px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <SheetTitle className="truncate">Career Copilot</SheetTitle>
                <span className="mt-0.5 inline-block max-w-full truncate rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                  {currentModelLabel}
                </span>
                <SheetDescription className="sr-only">
                  Ask about your job search. Answers use your target roles, confirmed facts, application plans
                  and fit scores.
                </SheetDescription>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => setShowHistory((current) => !current)}
                aria-pressed={showHistory}
                aria-label="History"
                title="History"
                className="flex h-9 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-blue-50 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <History className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">History</span>
              </button>

              <button
                type="button"
                onClick={beginNewChat}
                aria-label="New Chat"
                title="New Chat"
                className="flex h-9 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-blue-50 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">New Chat</span>
              </button>

              <SheetClose
                aria-label="Close"
                title="Close"
                className="flex h-9 w-9 items-center justify-center rounded-control text-slate-500 transition-colors hover:bg-blue-50 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </SheetClose>
            </div>
          </div>

          {showHistory && (
            <div className="max-h-56 overflow-y-auto border-b border-blue-100 bg-blue-50/40 px-4 py-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                This session
              </p>
              {snapshot.conversations.length === 0 ? (
                <p className="text-sm text-slate-500">No conversations yet.</p>
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
                          "w-full truncate rounded-control px-3 py-2 text-left text-sm transition-colors",
                          conversation.id === snapshot.activeId
                            ? "bg-blue-600 text-white"
                            : "text-slate-700 hover:bg-white",
                        )}
                      >
                        {conversation.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-slate-500">
                Conversations are kept for this page session only and are not saved.
              </p>
            </div>
          )}

          {messageCount === 0 ? (
            <div className="flex-1 overflow-y-auto px-4 py-5">
              <p className="text-sm text-slate-500">
                Ask about your job search, or start with one of these.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {suggestions.map((suggestion) =>
                  suggestion.prompt === null ? (
                    <PrerequisitePill
                      key={suggestion.label}
                      suggestion={suggestion}
                      onNavigate={() => setOpen(false)}
                    />
                  ) : (
                    <SuggestionPill
                      key={suggestion.label}
                      label={suggestion.label}
                      disabled={sending}
                      onSend={() => void send(suggestion.prompt ?? "")}
                    />
                  ),
                )}
              </div>
            </div>
          ) : (
            <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {active?.messages.map((entry) =>
                entry.role === "user" ? (
                  <div key={entry.id} className="flex justify-end">
                    {/* wrap-anywhere = overflow-wrap: anywhere. A pasted URL, a long
                        id or an unbroken token has no break opportunity at all, so
                        without this it renders thousands of pixels wide and is
                        clipped at the panel edge with no way to read it. Deliberately
                        NOT break-words: that is overflow-wrap: break-word, which
                        wraps the token for display but does not let the browser count
                        the break toward min-content sizing. anywhere does, so the box
                        can shrink below the token's intrinsic width. */}
                    <div className="max-w-[85%] whitespace-pre-wrap wrap-anywhere rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2.5 text-sm text-white shadow-sm">
                      {entry.content}
                    </div>
                  </div>
                ) : (
                  <div key={entry.id} className="flex items-start gap-2">
                    {/* OPTICAL, NOT BOX, ALIGNMENT. The bubble has 12px of top padding
                        and a 20px line-height, so its first line of text is centred
                        22px down; a 24px avatar flush with the bubble's top would sit
                        ~10px high against the words it introduces. mt-2.5 is that
                        10px, which puts the avatar's centre on the first line. */}
                    <span
                      className="mt-2.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white"
                      aria-hidden="true"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      {entry.content.trim() !== "" && (
                        <div className="max-w-[85%] whitespace-pre-wrap wrap-anywhere rounded-2xl rounded-tl-sm border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-slate-800">
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
                  </div>
                ),
              )}

              {sending && (
                <div className="flex items-start gap-2">
                  <span
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white"
                    aria-hidden="true"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                  <div className="rounded-2xl rounded-tl-sm border border-blue-100 bg-blue-50/60 px-4 py-3">
                    <Spinner className="h-4 w-4 text-blue-600" />
                  </div>
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <p role="alert" className="border-t border-blue-100 bg-red-50 px-4 py-2 text-sm text-red-600">
              {errorMessage}
            </p>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
            className="border-t border-blue-100 bg-white px-4 py-3"
          >
            <div className="rounded-2xl border border-blue-200 bg-white px-3 py-2 transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-200">
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
                className="w-full resize-none border-0 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
              />

              <div className="mt-1.5 flex items-center justify-between gap-2">
                <label htmlFor="copilot-model" className="sr-only">
                  Model
                </label>
                <select
                  id="copilot-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value as AgentModelId)}
                  className="h-7 rounded-full border border-blue-200 bg-white px-2 text-xs font-medium text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  {AGENT_MODEL_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <Button
                  type="submit"
                  size="sm"
                  disabled={sending || input.trim() === ""}
                  className="bg-blue-600 font-semibold text-white hover:bg-blue-700 active:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-600"
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                  Send
                </Button>
              </div>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
