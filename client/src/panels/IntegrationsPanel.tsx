import { useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { showToast } from "../components/ui/use-toast";
import { MailboxPanel } from "./MailboxPanel";
import { copyToClipboard } from "../lib/clipboard";
import { cn } from "../lib/utils";

/**
 * Mini-Phase 3 — Integrations Hub. Flattened in Mini-Phase 4 polish.
 *
 * There is deliberately NO outer <Card>. The tab strip sits directly on the
 * page background and each tab renders exactly one Card, so the Email tab can
 * render the imported <MailboxPanel/> — which brings its own Card — without
 * producing a card inside a card with two identical borders and two identical
 * shadows stacked 24px apart. Every tab therefore gets the same visual weight:
 * one Card each.
 *
 * The "Integrations" heading is a bare h2 rather than a CardTitle for the same
 * reason — it labels the section without reintroducing the box the strip was
 * just lifted out of. It is styled to match CardTitle so the page still reads
 * as one stack of labelled sections.
 *
 * UI ONLY, by explicit scope: no OAuth flow, no Express route, no MCP server is
 * built or called here.
 *
 * THE JOB BOARDS TAB IS GONE. It listed exactly two boards, Indeed and Naukri, both
 * placeholders with a "Not connected" badge and a Connect button that only raised a toast.
 * With both rows removed the tab had no content, and an empty tab is a worse answer than no
 * tab; the remaining tabs are Email and AI Assistants.
 *
 * The Email tab is the exception, and deliberately so: rather than build a
 * second, fake Gmail/Outlook connector next to the real one, it renders the
 * EXISTING <MailboxPanel/> — the shipped Google OAuth flow (server/mailbox/,
 * POST /api/mailbox/connect/start, GET /api/mailbox/oauth/callback) that already
 * covers both providers (mailbox_connections.provider is
 * check (provider in ('gmail','outlook'))).
 */

const INTEGRATION_TABS = [
  { id: "email", label: "Email" },
  { id: "aiAssistants", label: "AI Assistants" },
] as const;

type IntegrationTabId = (typeof INTEGRATION_TABS)[number]["id"];

/**
 * The configuration a terminal agent actually needs.
 *
 * This replaces an earlier placeholder URL (https://api.jobbeacon.local/mcp)
 * that was never a real address — nothing in this repository listened on it.
 * The MCP server speaks stdio: it is attached by a client process, not reached
 * at a URL, so showing an endpoint was simply wrong.
 *
 * IT INVOKES node DIRECTLY, NOT "npm run mcp" — and that is not a style
 * preference. Measured, not assumed: npm writes its own script banner
 *
 *   > jobbeacon@0.0.0 mcp
 *   > node --env-file-if-exists=.env --import=tsx server/mcp/index.ts
 *
 * to STDOUT before the server starts. stdout is the JSON-RPC channel, so a
 * strict MCP host fails on the very first line with a JSON parse error and
 * never completes the handshake — connecting with the npm form reproduces
 * exactly that. Going straight to node leaves stdout carrying protocol frames
 * only. (It also avoids needing a shell, which Node 24 requires for the npm
 * .cmd shim on Windows and which would otherwise re-quote these arguments.)
 *
 * cwd is a placeholder rather than this checkout's path on purpose — a machine
 * path baked into product copy is wrong for everyone else, and the reader is
 * the one who knows where their checkout lives.
 */
const MCP_CLIENT_CONFIG = `{
  "command": "node",
  "args": ["--env-file-if-exists=.env", "--import=tsx", "server/mcp/index.ts"],
  "cwd": "<absolute_path_to_jobbeacon>"
}`;

export function IntegrationsPanel() {
  const [tab, setTab] = useState<IntegrationTabId>("email");

  /**
   * The failure branch is real rather than theoretical — navigator.clipboard
   * only exists in a secure context and writeText can still be rejected by
   * permissions policy. Reporting success when the write failed would tell the
   * candidate something untrue about their clipboard, so a blocked write says
   * so and points at the manual fallback instead. The mechanism lives in
   * lib/clipboard.ts so both branches are unit-tested.
   */
  async function handleCopyMcpConfig() {
    const result = await copyToClipboard(MCP_CLIENT_CONFIG);

    if (result.kind === "success") {
      showToast({ title: "MCP client configuration copied to clipboard.", tone: "success" });
      return;
    }

    showToast({
      title: "Could not copy to the clipboard.",
      description: "Your browser blocked clipboard access — select the config and copy it manually.",
      tone: "error",
    });
  }

  return (
    <section className="space-y-4">
      <h2 id="integrations-heading" className="text-xl font-semibold text-black">
        Integrations
      </h2>

      {/* Same tablist treatment as AuthCard's log in / sign up switcher
          (role=tablist + role=tab + aria-selected). Two columns now that the Job Boards
          tab has been removed. */}
      <div
        role="tablist"
        aria-label="Integration categories"
        className="grid grid-cols-2 gap-1 rounded-control bg-ios-bg p-1"
      >
        {INTEGRATION_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`integrations-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`integrations-panel-${id}`}
            onClick={() => setTab(id)}
            className={cn(
              "h-9 rounded-[8px] text-sm font-semibold transition-colors",
              tab === id ? "bg-ios-card text-black shadow-control" : "text-ios-text-secondary hover:text-black",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "email" && (
        <div role="tabpanel" id="integrations-panel-email" aria-labelledby="integrations-tab-email" className="space-y-3">
          <p className="text-xs text-ios-text-secondary">
            Connect a mailbox so verification links and one-time codes sent to you can be picked up
            automatically.
          </p>

          {/* The real, shipped connector. It renders its own Card, which is the
              point of removing this panel's outer Card. */}
          <MailboxPanel />
        </div>
      )}

      {tab === "aiAssistants" && (
        <Card role="tabpanel" id="integrations-panel-aiAssistants" aria-labelledby="integrations-tab-aiAssistants">
          <CardHeader>
            <CardTitle>AI Assistants</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-ios-text-secondary">
              Attach an MCP-capable assistant (Claude Code, DeepSeek) to your JobBeacon pipeline. The
              server runs over stdio and currently exposes read tools plus one that queues
              applications — it never submits anything.
            </p>

            <div className="space-y-1.5">
              {/* A <pre> is not a labelable element, so the Label component's
                  htmlFor would point at nothing — this uses aria-labelledby
                  instead. tabIndex makes the scrollable block reachable and
                  scrollable by keyboard. */}
              <span id="mcp-client-config-label" className="text-sm font-medium text-black">
                MCP client configuration (stdio)
              </span>
              <pre
                aria-labelledby="mcp-client-config-label"
                tabIndex={0}
                className="overflow-x-auto rounded-control border border-ios-separator bg-ios-bg p-3 font-mono text-xs leading-relaxed text-black"
              >
                <code>{MCP_CLIENT_CONFIG}</code>
              </pre>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void handleCopyMcpConfig()}>
                  Copy config
                </Button>
                <span className="text-xs text-ios-text-secondary">
                  Replace cwd with the absolute path to your JobBeacon checkout.
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
