import TelegramBot, { InlineKeyboardMarkup } from "node-telegram-bot-api";
import { StakeManager } from "./stakeCalculator";
import { DatabaseService } from "./database";

export class BotController {
  private bot: TelegramBot;
  private allowedUserId: number;
  private stakeManager: StakeManager;
  private db: DatabaseService;
  private isExecutionPaused: boolean = false;
  private awaitingBankrollInput: boolean = false;

  constructor(
    token: string,
    allowedUserId: number,
    stakeManager: StakeManager,
    db: DatabaseService
  ) {
    this.allowedUserId = allowedUserId;
    this.stakeManager = stakeManager;
    this.db = db;
    this.bot = new TelegramBot(token, { polling: true });

    this.registerHandlers();
  }

  /** Authorization Middleware Guard */
  private isOwner(userId?: number): boolean {
    if (userId !== this.allowedUserId) {
      console.warn(`[SECURITY] Blocked interaction from unauthorized ID: ${userId}`);
      return false;
    }
    return true;
  }

  /** Dynamic Main Dashboard Keyboard */
  private getMainMenuKeyboard(): InlineKeyboardMarkup {
    const pauseToggleText = this.isExecutionPaused
      ? "▶️ Resume Execution"
      : "⏸️ Pause Execution";

    return {
      inline_keyboard: [
        [
          { text: "📊 Status", callback_data: "action_status" },
          { text: "📈 View PnL", callback_data: "action_pnl" },
        ],
        [
          { text: "💰 Set Bankroll", callback_data: "action_set_bankroll" },
          { text: "🔄 Reset Stage 1", callback_data: "action_reset" },
        ],
        [{ text: pauseToggleText, callback_data: "action_toggle_pause" }],
      ],
    };
  }

  /** Command and Callback Listener Declarations */
  private registerHandlers(): void {
    // 1. /start Command -> Renders Main Control Menu
    this.bot.onText(/\/start/, (msg) => {
      if (!this.isOwner(msg.from?.id)) return;
      this.awaitingBankrollInput = false;

      this.bot.sendMessage(msg.chat.id, this.getDashboardText(), {
        parse_mode: "Markdown",
        reply_markup: this.getMainMenuKeyboard(),
      });
    });

    // 2. Interactive Menu Callbacks
    this.bot.on("callback_query", async (query) => {
      if (!this.isOwner(query.from.id)) {
        await this.bot.answerCallbackQuery(query.id, {
          text: "🚫 Unauthorized user.",
          show_alert: true,
        });
        return;
      }

      const chatId = query.message?.chat.id;
      const messageId = query.message?.message_id;
      if (!chatId || !messageId) return;

      switch (query.data) {
        // Fetch & Render Supabase PnL Metrics
        case "action_pnl": {
          this.awaitingBankrollInput = false;
          await this.bot.answerCallbackQuery(query.id);

          const stats = await this.db.getPnLStats();
          const todayIcon = stats.todayPnL >= 0 ? "🟢" : "🔴";
          const totalIcon = stats.totalPnL >= 0 ? "🟢" : "🔴";

          const pnlText =
            `📈 **Performance & PnL Report (Supabase)**\n\n` +
            `📅 **Today's Stats:**\n` +
            `• Net PnL: **${todayIcon} $${stats.todayPnL > 0 ? "+" : ""}${stats.todayPnL.toFixed(3)}**\n` +
            `• Trades Placed: **${stats.todayTrades}** (Wins: ${stats.todayWins})\n\n` +
            `🏆 **All-Time Summary:**\n` +
            `• Total Net PnL: **${totalIcon} $${stats.totalPnL > 0 ? "+" : ""}${stats.totalPnL.toFixed(3)}**\n` +
            `• Total Trades: **${stats.totalTrades}**\n` +
            `• Win Rate: **${stats.winRate}%**`;

          await this.bot.sendMessage(chatId, pnlText, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back to Menu", callback_data: "action_menu" }]],
            },
          });
          break;
        }

        // Display Active System State
        case "action_status": {
          this.awaitingBankrollInput = false;
          await this.bot.answerCallbackQuery(query.id);

          const statusText =
            `📊 **Current Operating State**\n\n` +
            `• Bankroll: **$${this.stakeManager.bankroll.toFixed(2)}**\n` +
            `• Active Stage: **Stage ${this.stakeManager.getStageNumber()} / 8**\n` +
            `• Next Stake: **$${this.stakeManager.getCurrentStake()}**\n` +
            `• Status: **${this.isExecutionPaused ? "⏸️ PAUSED" : "🟢 ACTIVE"}**`;

          await this.bot.sendMessage(chatId, statusText, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "« Back to Menu", callback_data: "action_menu" }]],
            },
          });
          break;
        }

        // Prompt Bankroll Selection Options
        case "action_set_bankroll": {
          this.awaitingBankrollInput = true;
          await this.bot.answerCallbackQuery(query.id);

          const promptText =
            `💰 **Set New Bankroll**\n\n` +
            `Select a quick preset below or **reply directly with a custom number** (e.g. \`25.50\`):`;

          await this.bot.sendMessage(chatId, promptText, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "$10", callback_data: "preset_10" },
                  { text: "$20", callback_data: "preset_20" },
                  { text: "$50", callback_data: "preset_50" },
                  { text: "$100", callback_data: "preset_100" },
                ],
                [{ text: "« Cancel", callback_data: "action_menu" }],
              ],
            },
          });
          break;
        }

        // Reset Progression to Stage 1
        case "action_reset": {
          this.awaitingBankrollInput = false;
          this.stakeManager.registerResult(true);
          await this.bot.answerCallbackQuery(query.id, { text: "Reset to Stage 1" });

          await this.bot.editMessageText(
            `🔄 **Stage Reset Complete**\nReturned to **Stage 1** ($${this.stakeManager.getCurrentStake()}).`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: "Markdown",
              reply_markup: this.getMainMenuKeyboard(),
            }
          );
          break;
        }

        // Toggle Pause/Resume State
        case "action_toggle_pause": {
          this.awaitingBankrollInput = false;
          this.isExecutionPaused = !this.isExecutionPaused;
          const statusMsg = this.isExecutionPaused
            ? "Execution Paused ⏸️"
            : "Execution Resumed 🟢";
          await this.bot.answerCallbackQuery(query.id, { text: statusMsg });

          await this.bot.editMessageText(this.getDashboardText(), {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: this.getMainMenuKeyboard(),
          });
          break;
        }

        // Return to Main Menu
        case "action_menu": {
          this.awaitingBankrollInput = false;
          await this.bot.answerCallbackQuery(query.id);
          await this.bot.sendMessage(chatId, this.getDashboardText(), {
            parse_mode: "Markdown",
            reply_markup: this.getMainMenuKeyboard(),
          });
          break;
        }

        // Process Preset Button Allocations
        case "preset_10":
        case "preset_20":
        case "preset_50":
        case "preset_100": {
          const val = parseFloat(query.data.replace("preset_", ""));
          this.applyBankrollUpdate(chatId, val);
          await this.bot.answerCallbackQuery(query.id, {
            text: `Bankroll set to $${val}`,
          });
          break;
        }
      }
    });

    // 3. Catch Custom Text Inputs (Bankroll entry)
    this.bot.on("message", (msg) => {
      if (!this.isOwner(msg.from?.id)) return;
      if (!this.awaitingBankrollInput || !msg.text || msg.text.startsWith("/")) return;

      const amount = parseFloat(msg.text.trim());
      if (isNaN(amount) || amount <= 0) {
        this.bot.sendMessage(
          msg.chat.id,
          "❌ Invalid number. Enter a positive bankroll amount (e.g. `20`):",
          { parse_mode: "Markdown" }
        );
        return;
      }

      this.applyBankrollUpdate(msg.chat.id, amount);
    });
  }

  /** Helper: Re-allocate Bankroll & Output Stage Breakdown */
  private applyBankrollUpdate(chatId: number, amount: number): void {
    this.awaitingBankrollInput = false;
    const plan = this.stakeManager.updateBankroll(amount);
    const breakdown = plan.stages
      .map((s, i) => `• Stage ${i + 1}: **$${s.toFixed(3)}**`)
      .join("\n");

    const text =
      `✅ **Bankroll Set to $${amount.toFixed(2)}**\n\n` +
      `${breakdown}\n\n` +
      `💼 *Allocated:* $${plan.allocated} | 🛡️ *Buffer:* $${plan.buffer}\n` +
      `🔄 Active Stage 1 Stake: **$${this.stakeManager.getCurrentStake()}**`;

    this.bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: this.getMainMenuKeyboard(),
    });
  }

  /** Helper: Main Control Panel Text */
  private getDashboardText(): string {
    return (
      `🤖 **BYTBOT Control Dashboard**\n\n` +
      `• Bankroll: **$${this.stakeManager.bankroll.toFixed(2)}**\n` +
      `• Active Stage: **Stage ${this.stakeManager.getStageNumber()} / 8**\n` +
      `• Next Stake Input: **$${this.stakeManager.getCurrentStake()}**\n` +
      `• Status: **${this.isExecutionPaused ? "⏸️ PAUSED" : "🟢 ACTIVE"}**\n\n` +
      `Select an option below:`
    );
  }

  public isPaused(): boolean {
    return this.isExecutionPaused;
  }

  public async notifyTradeSuccess(
    periodId: string,
    option: string,
    stage: number,
    amount: number
  ): Promise<void> {
    const text =
      `🚀 **Trade Order Executed**\n\n` +
      `• Period ID: **#${periodId}**\n` +
      `• Option: **${option}**\n` +
      `• Execution Level: **Stage ${stage}**\n` +
      `• Stake Amount: **$${amount.toFixed(3)}**`;

    await this.bot.sendMessage(this.allowedUserId, text, { parse_mode: "Markdown" });
  }

  public async notifyResultLog(
    periodId: string | undefined,
    isWin: boolean,
    newStage: number,
    nextStake: number
  ): Promise<void> {
    const statusIcon = isWin ? "🟢 WIN" : "🔴 LOSS";
    const periodText = periodId ? ` (#${periodId})` : "";

    const text =
      `📊 **Round Outcome Logged${periodText}**\n\n` +
      `• Result: **${statusIcon}**\n` +
      `• Next Stage: **Stage ${newStage} / 8**\n` +
      `• Next Stake Input: **$${nextStake.toFixed(3)}**`;

    await this.bot.sendMessage(this.allowedUserId, text, { parse_mode: "Markdown" });
  }

  public async notifyError(message: string): Promise<void> {
    const text = `⚠️ **System Warning / Execution Failed**\n\n\`${message}\``;
    await this.bot.sendMessage(this.allowedUserId, text, { parse_mode: "Markdown" });
  }
}
