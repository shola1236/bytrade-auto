import fs from 'fs';
import path from 'path';
import { Page } from 'puppeteer-core';

const COOKIE_FILE = path.join(__dirname, '../../cookies.json');

/** Save current browser session cookies to disk */
export async function saveCookies(page: Page): Promise<void> {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    console.log(`[SESSION] Successfully saved ${cookies.length} cookies to disk.`);
  } catch (err) {
    console.error('[SESSION] Failed to save cookies:', err);
  }
}

/** Inject saved cookies into the page if available */
export async function loadCookies(page: Page): Promise<boolean> {
  try {
    if (!fs.existsSync(COOKIE_FILE)) {
      console.log('[SESSION] No saved cookies found.');
      return false;
    }

    const cookiesRaw = fs.readFileSync(COOKIE_FILE, 'utf-8');
    const cookies = JSON.parse(cookiesRaw);

    if (Array.isArray(cookies) && cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`[SESSION] Loaded ${cookies.length} cookies into browser context.`);
      return true;
    }
  } catch (err) {
    console.error('[SESSION] Failed to load cookies:', err);
  }
  return false;
}
