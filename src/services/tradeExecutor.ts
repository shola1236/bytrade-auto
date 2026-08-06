import { Page } from "puppeteer";
import fs from "fs";
import path from "path";
import { sendCaptchaPrompt, waitForDoneCommand } from "./telegramBot";
import { currentSessionViewerUrl } from "./browser";

export type TradeOption = "BIG" | "SMALL" | "ODD" | "EVEN";

const SESSION_FILE = path.resolve(process.cwd(), "session_cookies.json");

export class TradeExecutor {
  /**
   * Attempts to restore saved session cookies from disk.
   */
  private async restoreSession(page: Page): Promise<boolean> {
    if (!fs.existsSync(SESSION_FILE)) return false;

    try {
      const cookieData = fs.readFileSync(SESSION_FILE, "utf-8");
      const cookies = JSON.parse(cookieData);
      if (Array.isArray(cookies) && cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log(`[SESSION] Successfully injected ${cookies.length} cookies from disk.`);
        return true;
      }
    } catch (error) {
      console.warn("[SESSION] Cookie restoration failed:", error);
    }
    return false;
  }

  /**
   * Saves active authenticated session cookies to disk.
   */
  public async saveSession(page: Page): Promise<void> {
    try {
      const cookies = await page.cookies();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
      console.log(`[SESSION] Saved ${cookies.length} session cookies to disk.`);
    } catch (error) {
      console.warn("[SESSION] Failed to save session cookies:", error);
    }
  }

  /**
   * Handles authentication with cookie session bypass and Telegram live-viewer fallback.
   */
  public async loginAndNavigate(page: Page, email: string, pass: string): Promise<void> {
    // 1. Try Session Bypass using Saved Cookies
    const hasCookies = await this.restoreSession(page);

    if (hasCookies) {
      console.log("[EXECUTOR] Testing saved cookie session on /#/game...");
      await page.goto("https://h5.bytrading.fit/#/game", { waitUntil: "networkidle2" });

      const isGameLoaded = await page
        .waitForSelector(".game-page-options-btn", { visible: true, timeout: 6000 })
        .catch(() => null);

      if (isGameLoaded) {
        console.log("[EXECUTOR] Cookie session valid! Landed directly on /#/game.");
        return;
      }
      console.warn("[SESSION] Saved session expired. Proceeding to fresh login flow...");
    }

    // 2. Navigate to Login Page
    console.log("[EXECUTOR] Navigating to /#/login...");
    await page.goto("https://h5.bytrading.fit/#/login", { waitUntil: "networkidle2" });

    const emailSelector = 'input[placeholder="Please enter your email address."]';
    const passSelector = 'input[type="password"]';
    const loginBtnSelector = ".login-page-btn";

    try {
      // Check if login inputs are accessible (i.e. not blocked by Cloudflare Turnstile)
      await page.waitForSelector(emailSelector, { visible: true, timeout: 8000 });
    } catch (err) {
      console.log("[CLOUDFLARE] Turnstile blocking input selector. Sending link to Telegram...");

      const liveUrl = currentSessionViewerUrl || "https://app.steel.dev";
      await sendCaptchaPrompt(liveUrl);

      // Pause bot execution until user solves captcha in Steel live viewer & sends /done in Telegram
      console.log("[CLOUDFLARE] Waiting for /done command from Telegram...");
      await waitForDoneCommand();
    }

    // Check if user already completed the full login manually inside the live session
    const isAlreadyLoggedIn = await page
      .waitForSelector(".game-page-options-btn", { visible: true, timeout: 3000 })
      .catch(() => null);

    if (!isAlreadyLoggedIn) {
      const emailInputExists = await page.$(emailSelector);

      if (emailInputExists) {
        await page.waitForSelector(emailSelector, { visible: true });
        await page.waitForSelector(passSelector, { visible: true });

        // Auto-fill credentials
        await page.type(emailSelector, email, { delay: 40 });
        await page.type(passSelector, pass, { delay: 40 });

        await page.waitForSelector(loginBtnSelector, { visible: true });
        await page.click(loginBtnSelector);

        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {});
      }

      // Direct routing to game page post-auth
      await page.goto("https://h5.bytrading.fit/#/game", { waitUntil: "networkidle2" });
      await page.waitForSelector(".game-page-options-btn", { visible: true, timeout: 15000 });
    }

    // 3. Save fresh authenticated cookies after successful login
    await this.saveSession(page);
    console.log("[EXECUTOR] Login completed & fresh session cookies stored.");
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

      // Type stake amount
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

      // Dispatch click on confirm button
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
