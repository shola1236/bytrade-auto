import dotenv from "dotenv";
dotenv.config();

import http from "http";
import https from "https";
import { Page } from "puppeteer";
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

  // Determine target ping URL
  const pingUrl = RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const client = pingUrl.startsWith("https") ? https : http;

  // Ping every 10 minutes (600,000 ms)
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

async function bootstrap() {
  console.log("[SYSTEM] Starting BYTBOT Engine...");

  // 1. Initialize Health Check & Render Self-Ping
  startKeepAliveServer();

  // 2. Instantiate Database, Stake Engine & Browser Helpers
  const stakeManager = new StakeManager(INITIAL_BANKROLL);
  const db = new DatabaseService(SUPABASE_URL, SUPABASE_KEY);
  const tradeExecutor = new TradeExecutor();
  const cfService = new CloudflareBypassService();

  // 3. Launch Telegram Control Bot
  const bot = new BotController(BOT_TOKEN, ALLOWED_USER_ID, stakeManager, db);

  // 4. Launch Stealth Puppeteer Browser Session
  console.log("[BROWSER] Initializing Puppeteer Stealth Instance...");
  const browser = await cfService.launchStealthBrowser(true); // Headless mode for server hosting
  const page: Page = await browser.newPage();

  console.log("[BROWSER] Logging into platform & navigating to trade game UI...");
  await tradeExecutor.loginAndNavigate(page, ACCOUNT_EMAIL, ACCOUNT_PASS);

  // 5. Initialize GramJS Signal Listener
  const signalListener = new SignalListener(API_ID, API_HASH, SESSION_STRING, CHANNEL_ID);

  await signalListener.start(
    // Handle Incoming Trade Signal Event
    async (signal: SignalData) => {
      if (bot.isPaused()) {
        console.log("[ACTION] Trading paused via Telegram menu. Skipping signal execution.");
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
      const success = await tradeExecutor.executeOrder(page, signal.option, activeStake);

      if (success) {
        await bot.notifyTradeSuccess(signal.periodId, signal.option, stageNum, activeStake);
      } else {
        await bot.notifyError(`Trade execution failed for Period #${signal.periodId}`);
      }
    },

    // Handle Incoming Round Outcome Event
    async (result: ResultData) => {
      // Settle PENDING order in Supabase
      const settledTrade = await db.settleLatestTrade(result.isWin);

      // Advance or reset 8-stage martingale index
      const outcome = stakeManager.registerResult(result.isWin);

      console.log(
        `[RESULT] Round Outcome Logged (${result.isWin ? "WIN" : "LOSS"}) -> Next Stage: ${
          outcome.newStage
        } ($${outcome.nextStake})`
      );

      // Push result report to Telegram
      await bot.notifyResultLog(
        result.periodId || settledTrade?.periodId,
        result.isWin,
        outcome.newStage,
        outcome.nextStake
      );
    }
  );

  console.log("[SYSTEM] All engines running. Listening for channel updates...");
}

bootstrap().catch((err) => {
  console.error("[CRITICAL ENGINE ERROR]", err);
  process.exit(1);
});
