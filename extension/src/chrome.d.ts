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
    }
  }
  namespace runtime {
    interface MessageSender { tab?: { id?: number } }
    function sendMessage(message: unknown): Promise<{ ok: boolean; profile?: unknown; report?: unknown; error?: string }>;
    namespace onMessage {
      function addListener(
        listener: (
          message: { type?: string; profile?: unknown },
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
