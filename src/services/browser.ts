import Steel from 'steel-sdk';
import puppeteer, { Browser } from 'puppeteer-core';

export let currentSessionViewerUrl: string | null = null;
let activeBrowser: Browser | null = null;

export async function initBrowser(): Promise<Browser> {
  // Steel SDK automatically detects process.env.STEEL_API_KEY
  const steel = new Steel();

  // Create Steel browser session (Stealth is enabled automatically by Steel)
  const session = await steel.sessions.create();

  currentSessionViewerUrl =
    session.sessionViewerUrl || `https://app.steel.dev/sessions/${session.id}`;

  activeBrowser = await puppeteer.connect({
    browserWSEndpoint: `wss://connect.steel.dev?sessionId=${session.id}&apiKey=${process.env.STEEL_API_KEY}`,
  });

  return activeBrowser;
}

export async function getActivePage(browser: Browser) {
  const pages = await browser.pages();
  return pages.length > 0 ? pages[0] : await browser.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
  }
}
