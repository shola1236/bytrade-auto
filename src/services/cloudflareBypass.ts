import puppeteer, { Browser, Page, Frame } from "puppeteer";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import path from "path";

puppeteerExtra.use(StealthPlugin());

export class CloudflareBypassService {
  private browser: Browser | null = null;

  /**
   * Launch local Puppeteer or connect to Steel.dev Cloud Browser
   */
  public async launchStealthBrowser(headless: boolean = true): Promise<Browser> {
    const steelApiKey = process.env.STEEL_API_KEY;

    // 1. Steel.dev Cloud Connection (Production / Render environment)
    if (steelApiKey) {
      console.log("[BROWSER] STEEL_API_KEY detected. Connecting to Steel.dev Cloud Browser...");
      
      this.browser = await puppeteer.connect({
        browserWSEndpoint: `wss://connect.steel.dev?apiKey=${steelApiKey}`,
        defaultViewport: { width: 1280, height: 800 },
      });

      return this.browser;
    }

    // 2. Local Stealth Puppeteer Fallback (Local Development)
    console.log("[BROWSER] STEEL_API_KEY not found. Launching local Puppeteer Stealth...");
    const userDataDir = path.resolve(process.cwd(), ".user_data");

    this.browser = (await puppeteerExtra.launch({
      headless,
      userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,800",
      ],
      defaultViewport: { width: 1280, height: 800 },
    })) as unknown as Browser;

    return this.browser;
  }

  /**
   * Fallback solver for Turnstile frames if encountered on-page
   */
  public async handleTurnstile(page: Page, timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const turnstileFrame = page.frames().find((f: Frame) => {
        const url = f.url().toLowerCase();
        return (
          url.includes("cloudflare") ||
          url.includes("turnstile") ||
          url.includes("challenges")
        );
      });

      if (!turnstileFrame) return true;

      try {
        const checkboxSelector =
          'input[type="checkbox"], #challenge-stage, .mark, div[role="checkbox"]';
        const checkbox = await turnstileFrame.$(checkboxSelector);

        if (checkbox) {
          const box = await checkbox.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
              steps: 5,
            });
            await page.mouse.down();
            await page.mouse.up();
            await checkbox.focus();
            await page.keyboard.press("Space");
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      } catch {}

      const isCleared = await page.evaluate(() => {
        return (
          !document.title.toLowerCase().includes("just a moment") &&
          !document.querySelector("iframe[src*='turnstile']")
        );
      });

      if (isCleared) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }

    return false;
  }
}
