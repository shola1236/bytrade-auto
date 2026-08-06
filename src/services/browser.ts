import Steel from 'steel-sdk';
import puppeteer from 'puppeteer-core';

export let currentSessionViewerUrl: string | null = null;

export async function initBrowser() {
  const steel = new Steel({ apiKey: process.env.STEEL_API_KEY });

  // Create session
  const session = await steel.sessions.create({ stealth: true });

  // Save the live interactive URL
  currentSessionViewerUrl = session.sessionViewerUrl || `https://app.steel.dev/sessions/${session.id}`;

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://connect.steel.dev?sessionId=${session.id}&apiKey=${process.env.STEEL_API_KEY}`,
  });

  return browser;
}
