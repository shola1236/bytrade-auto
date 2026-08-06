import { Page, Frame } from "puppeteer";
import fs from "fs";
import path from "path";

export type TradeOption = "BIG" | "SMALL" | "ODD" | "EVEN";

const SESSION_FILE = path.resolve(process.cwd(), "session_cookies.json");

export class TradeExecutor {
  /**
   * Attempts to restore saved cookies from disk.
   */
  private async restoreSession(page: Page): Promise<boolean> {
    if (!fs.existsSync(SESSION_FILE)) return false;

    try {
      const cookieData = fs.readFileSync(SESSION_FILE, "utf-8");
      const cookies = JSON.parse(cookieData);
      await page.setCookie(...cookies);
      console.log("[SESSION] Injected saved session cookies.");
      return true;
    } catch (error) {
      console.warn("[SESSION] Cookie restoration failed:", error);
      return false;
    }
  }

  /**
   * Saves active authenticated session cookies to disk.
   */
  private async saveSession(page: Page): Promise<void> {
    try {
      const cookies = await page.cookies();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
      console.log("[SESSION] Authenticated session saved to disk.");
    } catch (error) {
      console.warn("[SESSION] Failed to save session cookies:", error);
    }
  }

  /**
   * Detects and triggers spacebar focus execution on Cloudflare Turnstile if present.
   */
  public async handleTurnstile(page: Page, timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const frames = page.frames();
      const turnstileFrame = frames.find((f: Frame) => {
        const url = f.url().toLowerCase();
        return url.includes("cloudflare") || url.includes("turnstile") || url.includes("challenges");
      });

      if (!turnstileFrame) {
        return true; // No Turnstile widget blocking navigation
      }

      console.log("[CLOUDFLARE] Turnstile frame detected. Applying focus + spacebar sequence...");

      try {
        const checkboxSelector = 'input[type="checkbox"], #challenge-stage, .mark, div[role="checkbox"]';
        await turnstileFrame.waitForSelector(checkboxSelector, { timeout: 2000 }).catch(() => {});
        const checkbox = await turnstileFrame.$(checkboxSelector);

        if (checkbox) {
          const box = await checkbox.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
            await page.mouse.down();
            await page.mouse.up();

            await checkbox.focus();
            await page.keyboard.press("Space");
            console.log("[CLOUDFLARE] Dispatched Spacebar press to Turnstile element.");
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      } catch {
        // Retry loop until timeout
      }

      const isCleared = await page.evaluate(() => {
        return (
          !document.title.toLowerCase().includes("just a moment") &&
          !document.querySelector("iframe[src*='turnstile']")
        );
      });

      if (isCleared) {
        console.log("[CLOUDFLARE] Challenge screen passed.");
        return true;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    return false;
  }

  /**
   * Performs authentication and direct navigation to the game page.
   */
  public async loginAndNavigate(page: Page, email: string, pass: string): Promise<void> {
    // 1. Check for valid active session
    const hasCookies = await this.restoreSession(page);

    if (hasCookies) {
      console.log("[EXECUTOR] Attempting session bypass directly to /#/game...");
      await page.goto("https://h5.bytrading.fit/#/game", { waitUntil: "networkidle2" });
      await this.handleTurnstile(page);

      const isGameLoaded = await page
        .waitForSelector(".game-page-options-btn", { visible: true, timeout: 6000 })
        .catch(() => null);

      if (isGameLoaded) {
        console.log("[EXECUTOR] Authenticated session valid. Landed on /#/game.");
        return;
      }
      console.warn("[SESSION] Saved session invalid or expired. Falling back to login flow...");
    }

    // 2. Fresh Login Execution
    console.log("[EXECUTOR] Navigating to /#/login...");
    await page.goto("https://h5.bytrading.fit/#/login", { waitUntil: "networkidle2" });
    await this.handleTurnstile(page);

    const emailSelector = 'input[placeholder="Please enter your email address."]';
    const passSelector = 'input[type="password"]';
    const loginBtnSelector = ".login-page-btn";

    await page.waitForSelector(emailSelector, { visible: true });
    await page.waitForSelector(passSelector, { visible: true });

    // Type credentials with slight typing delay
    await page.type(emailSelector, email, { delay: 40 });
    await page.type(passSelector, pass, { delay: 40 });

    // Click div-based login button
    await page.waitForSelector(loginBtnSelector, { visible: true });
    await page.click(loginBtnSelector);

    // Direct routing to game page post-auth
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {});
    await page.goto("https://h5.bytrading.fit/#/game", { waitUntil: "networkidle2" });
    await this.handleTurnstile(page);

    await page.waitForSelector(".game-page-options-btn", { visible: true, timeout: 15000 });

    // Save active session for future launches
    await this.saveSession(page);
    console.log("[EXECUTOR] Login successful. Session stored.");
  }

  /**
   * Executes a 5Min trade order with option selection, stake entry, and modal confirmation.
   */
  public async executeOrder(page: Page, option: TradeOption, amount: number): Promise<boolean> {
    try {
      console.log(`[EXECUTOR] Preparing ${option} trade order for $${amount}...`);

      // 1. Verify 5Min timeframe loaded
      await page.waitForSelector(".game-timer-label", { visible: true });

      // 2. Select Prediction Option (Big, Small, Odd, Even)
      const targetLabelMap: Record<TradeOption, string> = {
        BIG: "Big",
        SMALL: "Small",
        ODD: "Odd",
        EVEN: "Even",
      };
      const targetText = targetLabelMap[option];

      const optionClicked = await page.evaluate((target) => {
        const items = Array.from(document.querySelectorAll(".game-page-options-item"));
        const match = items.find((item) => {
          const firstSpan = item.querySelector("span");
          return firstSpan && firstSpan.textContent?.trim() === target;
        });

        if (match) {
          (match as HTMLElement).click();
          return true;
        }
        return false;
      }, targetText);

      if (!optionClicked) {
        throw new Error(`Failed to locate option element matching "${targetText}".`);
      }

      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));

      // 3. Clear and Set Stake Field
      const inputSelector = ".game-page-options-input input";
      await page.waitForSelector(inputSelector, { visible: true });

      // Keyboard wipe
      await page.focus(inputSelector);
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");

      // DOM reset fallback
      await page.evaluate((sel) => {
        const input = document.querySelector(sel) as HTMLInputElement;
        if (input) input.value = "";
      }, inputSelector);

      // Type active stage stake amount
      await page.type(inputSelector, amount.toString(), { delay: 30 });

      // 4. Trigger Initial Trade Modal
      const tradeBtnSelector = ".game-page-options-btn";
      await page.waitForSelector(tradeBtnSelector, { visible: true });
      await page.click(tradeBtnSelector);

      // 5. Handle Modal Prompt Confirmation (.trade-page-confirm)
      const modalSelector = ".trade-page-confirm";
      const confirmBtnSelector = ".trade-page-confirm-btn";

      await page.waitForSelector(modalSelector, { visible: true, timeout: 5000 });
      await page.waitForSelector(confirmBtnSelector, { visible: true, timeout: 5000 });

      // Native dispatch click on confirm div button
      await page.evaluate((btnSel) => {
        const btn = document.querySelector(btnSel) as HTMLElement;
        if (btn) btn.click();
      }, confirmBtnSelector);

      console.log(`[ORDER CONFIRMED] Placed ${option} for $${amount}`);
      return true;
    } catch (error) {
      console.error("[EXECUTION ERROR] Order placement failed:", error);
      return false;
    }
  }
}
