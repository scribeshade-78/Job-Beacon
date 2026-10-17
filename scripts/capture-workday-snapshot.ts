/**
 * CAPTURE A REAL WORKDAY APPLICATION STEP, ONCE, BY HAND.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. The selectors in extension/src/lib/workdaySteps.ts name
 * Workday's application flow, which sits behind "Apply" and often behind account creation. Driving
 * that flow automatically - on every build, against a customer's tenant - would be ToS-sensitive,
 * captcha-fragile and tenant-specific, and the one place it must never end up is the Submit button.
 * So the flow is walked ONCE by a human, its DOM is captured and sanitised into a fixture, and the
 * test suite asserts the constants against that fixture forever after.
 *
 * THIS SCRIPT NEVER CLICKS. It opens a headed browser, waits for the operator to navigate, and on
 * Enter dumps the DOM. There is no page.click, no form fill, no submit, and no credentials.
 *
 * WHAT SURVIVES SANITISATION. Every data-automation-id value and the element carrying it, the
 * ancestor chain that gives those elements their structure, and the controls a human reads
 * (button/input/select/textarea/label/form/role=alert). Everything else is pruned, which is what
 * keeps the fixture a few hundred KB instead of a whole SPA.
 *
 * WHAT IS REMOVED. script/style/link/noscript/iframe/object/embed, every on* handler, every
 * URL-bearing attribute (src, srcset, href, action, formaction, nonce, integrity), every form
 * value, and emails / phone-like numbers / URLs in text. A fixture is committed to the repository,
 * so it must not carry a candidate's data or a session token.
 *
 *   npx tsx scripts/capture-workday-snapshot.ts \
 *     --url "https://<tenant>.wdX.myworkdayjobs.com/en-US/<site>" \
 *     --out extension/src/lib/__fixtures__/workday-step.html
 *
 * Then navigate to an application step in the opened window and press Enter.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium, type Browser } from "playwright";

const DEFAULT_OUT = "extension/src/lib/__fixtures__/workday-step.html";

const USAGE = [
  "Usage:",
  "  npx tsx scripts/capture-workday-snapshot.ts --url <workday-url> [--out <file>]",
  "",
  "  --url   A Workday tenant or job URL. The operator navigates to a step by hand.",
  "  --out   Where to write the sanitised fixture (default: " + DEFAULT_OUT + ").",
].join("\n");

/**
 * Launches a headed browser, preferring Playwright's bundled Chromium and falling back to the
 * system Chrome.
 *
 * WHY THE FALLBACK. The bundled browser is a separate download ("npx playwright install"), and a
 * machine that already has Chrome should not need it to capture one page. The bundled browser is
 * tried first so a fresh checkout on any OS behaves predictably; the fallback is what makes the
 * tool usable on a developer machine without that download.
 */
async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: false });
  } catch (bundledError) {
    const reason = bundledError instanceof Error ? bundledError.message.split("\n")[0] : String(bundledError);
    console.warn(
      "Bundled Chromium is unavailable (" + reason + "). Falling back to the system Chrome installation.",
    );
    return chromium.launch({ headless: false, channel: "chrome" });
  }
}

function fail(message: string): never {
  console.error("\n" + message + "\n");
  process.exitCode = 1;
  throw new Error(message);
}

function parseArgs(argv: readonly string[]): { url: string; out: string } {
  let url = "";
  let out = DEFAULT_OUT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--url") {
      url = argv[++index] ?? "";
    } else if (argument === "--out") {
      out = argv[++index] ?? "";
    } else if (argument === "--help" || argument === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      fail("Unknown argument: " + argument + "\n\n" + USAGE);
    }
  }

  if (!url) {
    fail("--url is required.\n\n" + USAGE);
  }

  if (!out) {
    fail("--out must not be empty.");
  }

  return { url, out };
}

async function main(): Promise<void> {
  const { url, out } = parseArgs(process.argv.slice(2));

  // Refusing a non-interactive stdin is the guard that stops this ever being wired into CI, where
  // nobody would be there to navigate and the capture would silently record a login page.
  if (!process.stdin.isTTY) {
    fail(
      "This capture needs an interactive terminal: it waits for you to navigate to an application step " +
        "and press Enter. It is deliberately not runnable unattended.",
    );
  }

  console.log(
    [
      "",
      "Opening a headed browser. THIS SCRIPT NEVER CLICKS ANYTHING.",
      "1. Navigate to a real Workday application step (a throwaway candidate account is fine).",
      "2. Make sure the step is fully rendered - the spinner gone, the form showing.",
      "3. Come back here and press Enter.",
      "",
      "Nothing is filled, submitted or saved by this tool. Ctrl+C aborts without writing.",
      "",
    ].join("\n"),
  );

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    await readline.question("Press Enter to capture the current page...\n");
    readline.close();

    // READ BEFORE MUTATING. The sanitiser below edits the live DOM, so the inventory of automation
    // ids has to be taken first or it would describe the pruned page instead of the real one.
    const automationIds = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: any }).document;
      const ids: string[] = [];

      doc.querySelectorAll("[data-automation-id]").forEach((element: any) => {
        const value = element.getAttribute("data-automation-id");
        if (typeof value === "string" && value.length > 0 && !ids.includes(value)) {
          ids.push(value);
        }
      });

      return ids.sort();
    });

    const html = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: any }).document;

      // 1. Anything executable or remotely linked goes first.
      doc
        .querySelectorAll("script, style, link, noscript, iframe, object, embed")
        .forEach((node: any) => node.remove());

      // 2. Handlers and URL-bearing attributes, everywhere.
      const URL_ATTRIBUTES = ["src", "srcset", "href", "action", "formaction", "nonce", "integrity"];

      doc.querySelectorAll("*").forEach((element: any) => {
        for (const attribute of Array.from(element.attributes ?? []) as any[]) {
          const name = String(attribute.name).toLowerCase();
          if (name.startsWith("on") || URL_ATTRIBUTES.includes(name)) {
            element.removeAttribute(attribute.name);
          }
        }
      });

      // 3. Never transport a candidate's answers into a committed file.
      doc.querySelectorAll("input, textarea, select, option").forEach((field: any) => {
        field.removeAttribute("value");
        if (String(field.tagName).toLowerCase() === "textarea") {
          field.textContent = "";
        }
      });

      // 4. Redact anything that still looks personal.
      const redact = (text: string): string =>
        text
          .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
          .replace(/\+?\d[\d\s().-]{6,}\d/g, "<number>")
          .replace(/https?:\/\/\S+/g, "<url>");

      const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
      const textNodes: any[] = [];

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      for (const node of textNodes) {
        const redacted = redact(String(node.nodeValue ?? ""));
        if (redacted !== node.nodeValue) {
          node.nodeValue = redacted;
        }
      }

      // 5. Keep the automation surface and the structural controls around it.
      const keep = new Set<any>();

      const mark = (element: any): void => {
        keep.add(element);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          keep.add(parent);
        }
      };

      doc.querySelectorAll("[data-automation-id]").forEach(mark);
      doc.querySelectorAll("button, input, select, textarea, label, form, [role=alert]").forEach(mark);

      // Bottom-up, so a wrapper emptied by its children's removal is removed on the same pass.
      const all = Array.from(doc.body.querySelectorAll("*"));

      for (let index = all.length - 1; index >= 0; index -= 1) {
        const element: any = all[index];

        if (keep.has(element)) {
          continue;
        }

        if (element.querySelector("[data-automation-id], button, input, select, textarea, label, form, [role=alert]")) {
          continue;
        }

        element.remove();
      }

      return doc.body.innerHTML;
    });

    const provenance = [
      "<!--",
      "  CAPTURED FROM A REAL WORKDAY PAGE, NOT FABRICATED.",
      "  source   : " + url,
      "  captured : " + new Date().toISOString(),
      "  tool     : scripts/capture-workday-snapshot.ts (headed browser, manual navigation, no automated clicks)",
      "  sanitised: scripts/styles/handlers/URLs removed; form values blanked; emails, numbers and URLs redacted;",
      "             pruned to the data-automation-id surface and the controls around it",
      "  observed automation ids: " + (automationIds.length > 0 ? automationIds.join(", ") : "(none)"),
      "-->",
    ].join("\n");

    const target = resolve(out);
    await mkdir(dirname(target), { recursive: true });
    const body = provenance + "\n" + html + "\n";
    await writeFile(target, body, "utf8");

    console.log("");
    console.log("Wrote " + Buffer.byteLength(body, "utf8") + " bytes to " + target);
    console.log("");
    console.log("Automation ids observed on the captured page:");

    if (automationIds.length === 0) {
      console.log("  (none - you may have captured a page that is not in the application flow)");
    } else {
      for (const id of automationIds) {
        console.log("  " + id);
      }
    }

    console.log("");
    console.log(
      "Compare that list with WORKDAY in extension/src/lib/workdaySteps.ts. A constant whose value is " +
        "absent from it is WRONG and must be corrected or removed, not kept as a guess.",
    );
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
