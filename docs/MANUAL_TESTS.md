# JobBeacon — Manual Test Checklist

## MP-F1 Smoke Test (DEFERRED — MUST run at MP-F2 start)

Founder decision: committed without live smoke test (unit+pgTAP all green; live OpenAI/Storage/E2E untested). This test becomes the blocking first step of MP-F2 — fact confirmation UI cannot be built without real extracted facts.

### Pre-checks

- [ ] Storage container running: `supabase status` → stopped → `supabase start`
- [ ] `.env` has `OPENAI_API_KEY` set (sk-... prefix, platform.openai.com API credits — ChatGPT Plus ≠ API access)
- [ ] Servers restart after .env change

### Test steps

- [ ] Login → Resumes → real resume upload (PDF/DOCX)
- [ ] "Extract facts" click → wait
- [ ] Facts preview shows real facts (full_name, skills, education, experience)
- [ ] Latency noted
- [ ] F12 console — no unexpected errors
- [ ] Second click — duplicates noted (expected: rows add — MP-F2 handles)
- [ ] Rate limit 6th click/15min → 429 (by design)

### Results record

- Extraction quality:
- Latency:
- Errors:
- Duplicates:

---

## Regression Tests (after every mini-phase)

### Auth

- [ ] Login / logout / session persist / wrong password error

### Navigation (UI phases)

- [ ] 10 sidebar sections navigate
- [ ] Mobile 375px drawer, no horizontal scroll
- [ ] No console errors

### Panels (data phases)

- [ ] Resumes upload/view/delete
- [ ] Automation authorize/pause/resume/stop
- [ ] Exclusions persist
- [ ] MFA section renders

### Known-expected console errors (NOT bugs)

- POST candidate_profiles 409 after login = idempotent design
- 42501 anon permission = old signup log (report only if reproduces on refresh)
- load_embeds.js = browser extension noise

---

## Future phases (placeholders)

- MP-F2: Fact confirmation flow test
- MP-R1: Role selection test
- MP-W1: Worker entrypoint (idempotency critical — never submit same application twice)
