import { Page } from "puppeteer";

export type TradeOption = "BIG" | "SMALL" | "ODD" | "EVEN";

export class TradeExecutor {
  /**
   * Performs authentication and direct navigation to the game page.
   */
  public async loginAndNavigate(
    page: Page,
    email: string,
    pass: string
  ): Promise<void> {
    console.log("[EXECUTOR] Navigating to login page...");
    await page.goto("https://h5.bytrading.fit/#/login", {
      waitUntil: "networkidle2",
    });

    // 1. Target exact native inputs
    const emailSelector = 'input[placeholder="Please enter your email address."]';
    const passSelector = 'input[type="password"]';
    const loginBtnSelector = ".login-page-btn";

    await page.waitForSelector(emailSelector, { visible: true });
    await page.waitForSelector(passSelector, { visible: true });

    // 2. Type credentials with human delay
    await page.type(emailSelector, email, { delay: 40 });
    await page.type(passSelector, pass, { delay: 40 });

    // 3. Click div-based login button
    await page.waitForSelector(loginBtnSelector, { visible: true });
    await page.click(loginBtnSelector);

    // 4. Navigate directly to game interface post-login
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {});
    await page.goto("https://h5.bytrading.fit/#/game", {
      waitUntil: "networkidle2",
    });

    // Verify game interface loaded
    await page.waitForSelector(".game-page-options-btn", { visible: true });
    console.log("[EXECUTOR] Successfully authenticated and landed on /#/game");
  }

  /**
   * Executes a 5Min trade order with full modal confirmation safety.
   */
  public async executeOrder(
    page: Page,
    option: TradeOption,
    amount: number
  ): Promise<boolean> {
    try {
      console.log(`[EXECUTOR] Preparing ${option} order for $${amount}...`);

      // 1. Verify we are in the active 5Min timeframe
      await page.waitForSelector(".game-timer-label", { visible: true });

      // 2. Map option label and locate exact target option div
      const targetLabelMap: Record<TradeOption, string> = {
        BIG: "Big",
        SMALL: "Small",
        ODD: "Odd",
        EVEN: "Even",
      };
      const targetText = targetLabelMap[option];

      // Locate option item by matching child span text inside .game-page-options-item
      const optionClicked = await page.evaluate((target) => {
        const items = Array.from(
          document.querySelectorAll(".game-page-options-item")
        );
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
        throw new Error(`Target trade option "${targetText}" could not be selected.`);
      }

      // Short delay for UI state update
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));

      // 3. Set Stake Input Field (.game-page-options-input input)
      const inputSelector = ".game-page-options-input input";
      await page.waitForSelector(inputSelector, { visible: true });

      // Clear input completely before typing
      await page.focus(inputSelector);
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");

      // Fallback input wipe via DOM value clear
      await page.evaluate((sel) => {
        const input = document.querySelector(sel) as HTMLInputElement;
        if (input) input.value = "";
      }, inputSelector);

      // Type exact decimal stake amount
      await page.type(inputSelector, amount.toString(), { delay: 30 });

      // 4. Click initial Trade button (.game-page-options-btn)
      const tradeBtnSelector = ".game-page-options-btn";
      await page.waitForSelector(tradeBtnSelector, { visible: true });
      await page.click(tradeBtnSelector);

      // 5. Handle Modal Prompt Confirmation (.trade-page-confirm)
      const modalSelector = ".trade-page-confirm";
      const confirmBtnSelector = ".trade-page-confirm-btn";

      // Wait for popup container to mount
      await page.waitForSelector(modalSelector, { visible: true, timeout: 5000 });
      await page.waitForSelector(confirmBtnSelector, { visible: true, timeout: 5000 });

      // Extra click safety via DOM evaluate to guarantee trigger on div
      await page.evaluate((btnSel) => {
        const btn = document.querySelector(btnSel) as HTMLElement;
        if (btn) btn.click();
      }, confirmBtnSelector);

      console.log(`[ORDER EXECUTED] ${option} locked at $${amount}`);
      return true;
    } catch (error) {
      console.error("[ORDER FAILED] Execution error:", error);
      return false;
    }
  }
}
