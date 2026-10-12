# JobBeacon Auto-Apply (Chrome extension)

Assists with job application forms: reads your JobBeacon profile and fills the fields
it recognises. **It never submits.** You review and press submit yourself.

## Build

```bash
npm run build:extension      # from the repository root
```

Output lands in `dist/extension/`. Load it unpacked:

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `dist/extension`

## How it fits together

| File | Role |
|---|---|
| `src/content.ts` | Runs in the page. Fills fields. Sends nothing, fetches nothing. |
| `src/background.ts` | Service worker. Holds the token and calls JobBeacon. |
| `src/popup/` | React + Tailwind popup with the Auto-Fill button. |

The split is not stylistic. **A content script's `fetch` carries the page's origin**, so
calling jobbeacon.in from a content script running on greenhouse.io is judged against
greenhouse's CORS policy. The service worker fetches as the extension instead.

## Two things that are deliberately absent

**No submit.** Not a missing feature - a boundary. Auto-submitting an application cannot
be undone, and a form filled by pattern matching is exactly the kind of thing that is
confidently wrong.

**No password.** The extension holds an API token, never a Supabase session. The browser
session that signs you into jobbeacon.in is unreadable from here and should stay that
way.

## Not yet built

- `/api/extension/profile` does not exist yet - the popup will report an error until it does.
- Token generation in the JobBeacon UI.
- Workday's multi-page flow (its forms are wizard-shaped, so one page-fill is not enough).
- Screening questions (visa, salary, notice period) are **not** auto-answered by design.
