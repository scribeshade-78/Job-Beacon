/**
 * The service worker. It exists for ONE reason, and it is not optional.
 *
 * A CONTENT SCRIPT'S FETCH CARRIES THE PAGE'S ORIGIN. Fetching jobbeacon.in from a
 * content script running on greenhouse.io is a cross-origin request judged against
 * greenhouse's policy, not ours - so it fails unless JobBeacon happens to send permissive
 * CORS headers to every ATS on the internet. A service worker with host_permissions
 * fetches as the EXTENSION, which is a different and much narrower grant.
 *
 * THE TOKEN LIVES IN chrome.storage.local, NOT HERE IN CODE, and is never sent
 * anywhere except jobbeacon.in. There is no server-side exchange: the candidate pastes
 * a token, exactly as a CLI would.
 */
import type { CandidateProfile } from "./lib/types.js";

const API_BASE = "https://jobbeacon.in";

interface StoredSettings {
  apiToken?: string;
}

async function readToken(): Promise<string | null> {
  const stored = (await chrome.storage.local.get("apiToken")) as StoredSettings;
  const token = stored.apiToken?.trim();
  return token ? token : null;
}

/**
 * The candidate's profile, from the endpoint the web app already trusts.
 *
 * The extension holds a TOKEN, never a password and never a Supabase session: the
 * browser session that signs a candidate into jobbeacon.in is not readable from here
 * (different origin) and should not be, so the two are deliberately separate grants.
 */
async function fetchProfile(): Promise<CandidateProfile> {
  const token = await readToken();

  if (!token) {
    throw new Error("Not connected. Paste your JobBeacon API token in the popup.");
  }

  const response = await fetch(API_BASE + "/api/extension/profile", {
    headers: { Authorization: "Bearer " + token },
  });

  if (response.status === 401) {
    throw new Error("That token was refused. Generate a new one in JobBeacon.");
  }
  if (!response.ok) {
    throw new Error("JobBeacon answered HTTP " + response.status + ".");
  }

  return (await response.json()) as CandidateProfile;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FETCH_PROFILE") {
    return false;
  }

  fetchProfile()
    .then((profile) => sendResponse({ ok: true, profile }))
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );

  // Keeps the message channel open for the async reply above.
  return true;
});

/** Arms the toolbar icon per tab, so the popup can say whether filling is possible here. */
async function refreshBadge(tabId: number, url: string | undefined): Promise<void> {
  const supported = /greenhouse\.io|lever\.co|myworkdayjobs\.com|workday\.com/.test(url ?? "");
  await chrome.action.setBadgeText({ tabId, text: supported ? "" : "" });
}

chrome.tabs.onUpdated.addListener((tabId, _change, tab) => {
  void refreshBadge(tabId, tab.url);
});
