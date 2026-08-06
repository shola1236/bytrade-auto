import { Page, Frame } from "puppeteer";
import fs from "fs";
import path from "path";

const SESSION_FILE = path.resolve(process.cwd(), "session_cookies.json");

export class CloudflareBypassService {
  /**
   * Interacts with Cloudflare Turnstile challenge using focus + Spacebar technique.
   */
  public async solveTurnstileIfPresent(page: Page, timeoutMs: number = 15000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // 1. Check if Cloudflare Turnstile iframe exists on page
      const frames = page.frames();
      const turnstileFrame = frames.find((f: Frame) => {
        const url = f.url().toLowerCase();
        return url.includes("cloudflare") || url.includes("turnstile") || url.includes("challenges");
      });

      if (!turnstileFrame) {
        // No challenge iframe detected, page is clear
        return true;
      }

      console.log("[CLOUDFLARE] Turnstile challenge detected. Attaching spacebar focus technique...");

      try {
        // 2. Locate checkbox inside the Turnstile iframe
        const checkboxSelector = 'input[type="checkbox"], #challenge-stage, .mark, div[role="checkbox"]';
        
        await turnstileFrame.waitForSelector(checkboxSelector, { timeout: 3000 }).catch(() => {});
        const checkbox = await turnstileFrame.$(checkboxSelector);

        if (checkbox) {
          // Bounding box click + spacebar trigger sequence
          const box = await checkbox.boundingBox();
          if (box) {
            // Move mouse smoothly to center of checkbox
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
            await page.mouse.down();
            await page.mouse.up();

            // Focus and dispatch Spacebar press
            await checkbox.focus();
            await page.keyboard.press("Space");
            console.log("[CLOUDFLARE] Dispatched Spacebar press to Turnstile widget.");

            // Wait 2 seconds for verification token to resolve
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      } catch (err) {
        // Retry loop until timeout
      }

      // Check if page navigated or challenge dissolved
      const isCleared = await page.evaluate(() => {
        return !document.title.toLowerCase().includes("just a moment") &&
               !document.querySelector("iframe[src*='turnstile']");
      });

      if (isCleared) {
        console.log("[CLOUDFLARE] Verification cleared!");
        return true;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    return false;
  }

  /**
   * Saves authentication cookies to disk after successful login.
   */
  public async saveSessionCookies(page: Page): Promise<void> {
    const cookies = await page.cookies();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
    console.log("[SESSION] Saved authenticated session cookies to disk.");
  }

  /**
   * Loads saved cookies into the browser context to skip the /#/login page completely.
   */
  public async restoreSessionCookies(page: Page): Promise<boolean> {
    if (!fs.existsSync(SESSION_FILE)) {
      return false;
    }

    try {
      const cookieData = fs.readFileSync(SESSION_FILE, "utf-8");
      const cookies = JSON.parse(cookieData);
      await page.setCookie(...cookies);
      console.log("[SESSION] Injected saved session cookies.");
      return true;
    } catch (error) {
      console.warn("[SESSION] Failed to restore cookies:", error);
      return false;
    }
  }
}
