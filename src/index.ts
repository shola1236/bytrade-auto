import dotenv from "dotenv";
dotenv.config();

import http from "http";
import https from "https";
import { Page, Browser } from "puppeteer";
import { CloudflareBypassService } from "./services/cloudflareBypass";
import { StakeManager } from "./services/stakeCalculator";
import { BotController } from "./services/telegramBot";
import { TradeExecutor } from "./services/tradeExecutor";
import { SignalListener } from "./services/signalListener";
import { DatabaseService } from "./services/database";
import { SignalData, ResultData } from "./types";

// Configuration & Environment Variables
const ALLOWED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const INITIAL_BANKROLL = Number(process.env.INITIAL_BANKROLL) || 20;

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH || "";
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || "";
const CHANNEL_ID = process.env.SIGNAL_CHANNEL_ID || "";

const ACCOUNT_EMAIL = process.env.PLATFORM_EMAIL || "";
const ACCOUNT_PASS = process.env.PLATFORM_PASSWORD || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

// Engine State Trackers
let browserInstance: Browser | null = null;
let activePage: Page | null = null;
let isEngineActive = false;

/**
 * Render Web Service Keep-Alive Server
 * Binds to process.env.PORT and pings itself every 10 minutes to prevent sleep.
 */
function startKeepAliveServer(): void {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("BYTBOT Engine Active");
  });

  server.listen(PORT, () => {
    console.log(`[SERVER] Health check endpoint listening on port ${PORT}`);
  });

  const pingUrl = RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const client = pingUrl.startsWith("https") ? https : http;

  setInterval(() => {
    client
      .get(pingUrl, (res) => {
        console.log(`[KEEP-ALIVE] Self-ping sent to ${pingUrl} | Status: ${res.statusCode}`);
      })
      .on("error", (err) => {
        console.error(`[KEEP-ALIVE] Ping error: ${err.message}`);
      });
  }, 10 * 60 * 1000);
}

/**
 * Launches browser instance and navigates/authenticates session.
 */
async function handleStartup(
  cfService: CloudflareBypassService,
  tradeExecutor: TradeExecutor
): Promise<void> {
  if (isEngineActive) {
    console.log("[SYSTEM] Startup skipped: Engine is already online.");
    return;
  }

  console.log("[BROWSER] Launching stealth browser session...");
  browserInstance = await cfService.launchStealthBrowser(true);
  activePage = await browserInstance.newPage();

  console.log("[BROWSER] Logging into platform & routing to trade terminal...");
  await tradeExecutor.loginAndNavigate(activePage, ACCOUNT_EMAIL, ACCOUNT_PASS);

  isEngineActive = true;
  console.log("[SYSTEM] Engine startup completed. Online and ready for trades.");
}

/**
 * Gracefully terminates active browser instance and cleans resources.
 */
async function handleKill(): Promise<void> {
  if (!isEngineActive && !browserInstance) {
    console.log("[SYSTEM] Kill skipped: Engine is already offline.");
    return;
  }

  console.log("[SYSTEM] Shutting down active browser session...");

  if (activePage) {
    await activePage.close().catch(() => {});
    activePage = null;
  }

  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }

  isEngineActive = false;
  console.log("[SYSTEM] Engine fully terminated. Status: Offline.");
}

async function bootstrap() {
  console.log("[SYSTEM] Initializing BYTBOT Core Architecture...");

  // 1. Initialize Health Check & Render Self-Ping
  startKeepAliveServer();

  // 2. Instantiate Database, Stake Engine, Trade & Cloudflare Services
  const stakeManager = new StakeManager(INITIAL_BANKROLL);
  const db = new DatabaseService(SUPABASE_URL, SUPABASE_KEY);
  const tradeExecutor = new TradeExecutor();
  const cfService = new CloudflareBypassService();

  // 3. Launch Telegram Control Bot
  const bot = new BotController(BOT_TOKEN, ALLOWED_USER_ID, stakeManager, db);

  // 4. Bind Manual Startup and Kill Handlers to Telegram Bot Controller
  bot.registerEngineControls({
    onStartup: () => handleStartup(cfService, tradeExecutor),
    onKill: () => handleKill(),
  });

  // 5. Initialize GramJS Signal Listener (Runs continuously in background)
  const signalListener = new SignalListener(API_ID, API_HASH, SESSION_STRING, CHANNEL_ID);

  await signalListener.start(
    // Incoming Trade Signal Event Handler
    async (signal: SignalData) => {
      if (!isEngineActive || !activePage) {
        console.log("[ACTION] Trade ignored: Engine is currently offline. Send /start -> Startup Session.");
        return;
      }

      if (bot.isPaused()) {
        console.log("[ACTION] Trade paused via Telegram menu. Skipping signal execution.");
        return;
      }

      const activeStake = stakeManager.getCurrentStake();
      const stageNum = stakeManager.getStageNumber();

      console.log(
        `[ACTION] Executing Stage ${stageNum} Trade: ${signal.option} @ $${activeStake} (#${signal.periodId})`
      );

      // Log trade entry in Supabase as PENDING
      await db.logTrade(signal.periodId, signal.option, stageNum, activeStake);

      // Execute order via browser automation
      const success = await tradeExecutor.executeOrder(activePage, signal.option, activeStake);

      if (success) {
        await bot.notifyTradeSuccess(signal.periodId, signal.option, stageNum, activeStake);
      } else {
        await bot.notifyError(`Trade execution failed for Period #${signal.periodId}`);
      }
    },

    // Incoming Round Outcome Event Handler
    async (result: ResultData) => {
      // Settle PENDING order in Supabase
      const settledTrade = await db.settleLatestTrade(result.isWin);

      // Advance or reset martingale stage
      const outcome = stakeManager.registerResult(result.isWin);

      console.log(
        `[RESULT] Round Outcome Logged (${result.isWin ? "WIN" : "LOSS"}) -> Next Stage: ${
          outcome.newStage
        } ($${outcome.nextStake})`
      );

      // Push result report to Telegram
      await bot.notifyResultLog(
        result.periodId || settledTrade?.periodId || "",
        result.isWin,
        outcome.newStage,
        outcome.nextStake
      );
    }
  );

  console.log("[SYSTEM] Telegram controller online. Use Telegram dashboard to trigger startup.");
}

bootstrap().catch((err) => {
  console.error("[CRITICAL ENGINE ERROR]", err);
  process.exit(1);
});
