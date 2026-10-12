/**
 * The slice of the extension API this scaffold actually uses, declared locally.
 *
 * DELIBERATELY NOT @types/chrome: that package is ~100KB of typings for an API surface
 * we touch eight members of, and adding a dependency to a scaffold is a cost the next
 * person pays on every install. If the extension grows past this, replace this file
 * with the real typings rather than extending it forever.
 */
declare namespace chrome {
  namespace storage {
    namespace local {
      function get(keys: string | string[]): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
      // Used to drop the stored session on sign-out.
      function remove(keys: string | string[]): Promise<void>;
    }
  }
  namespace runtime {
    interface MessageSender { tab?: { id?: number } }
    interface MessageReply {
      ok: boolean;
      profile?: unknown;
      report?: unknown;
      session?: unknown;
      error?: string;
    }
    function sendMessage(message: unknown): Promise<MessageReply>;
    namespace onMessage {
      function addListener(
        listener: (
          // The message envelope the extension actually sends: a discriminator plus the
          // fields each variant carries. email/password only travel popup -> worker, and
          // the worker hands them straight to Supabase without keeping them.
          message: { type?: string; profile?: unknown; email?: string; password?: string },
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    }
  }
  namespace tabs {
    function query(query: { active: boolean; currentWindow: boolean }): Promise<{ id?: number; url?: string }[]>;
    function sendMessage(tabId: number, message: unknown): Promise<{ ok: boolean; report?: unknown; error?: string }>;
    namespace onUpdated {
      function addListener(
        listener: (tabId: number, change: unknown, tab: { url?: string }) => void,
      ): void;
    }
  }
  namespace action {
    function setBadgeText(details: { tabId: number; text: string }): Promise<void>;
  }
}
