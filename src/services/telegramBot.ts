import TelegramBot, { InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { StakeManager } from './stakeCalculator';
import { DatabaseService } from './database';

let doneResolver: (() => void) | null = null;
let activeBotInstance: BotController | null = null;

/** Helper function used by tradeExecutor to pause for captcha completion */
export function waitForDoneCommand(): Promise<void> {
  return new Promise((resolve) => {
    doneResolver = resolve;
  });
}

/** Helper function used by tradeExecutor to send live captcha session link */
export async function sendCaptchaPrompt(url: string) {
  if (activeBotInstance) {
    await activeBotInstance.showCaptchaPrompt(url);
  }
}

export class BotController {
  private bot: TelegramBot;
  private allowedUserId: number;
  private stakeManager: StakeManager;
  private db: DatabaseService;

  private mainMessageId: number | null = null;
  private waitingForBankrollInput: boolean = false;
  private isEngineOnline: boolean = false;
  private paused: boolean = false;

  private onStartupCallback: (() => Promise<void>) | null = null;
  private onKillCallback: (() => Promise<void>) | null = null;

  constructor(token: string, allowedUserId: number, stakeManager: StakeManager, db: DatabaseService) {
    this.bot = new TelegramBot(token, { polling: true });
    this.allowedUserId = allowedUserId;
    this.stakeManager = stakeManager;
    this.db = db;

    activeBotInstance = this;
    this.initListeners();
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public registerEngineControls(controls: {
    onStartup: () => Promise<void>;
    onKill: () => Promise<void>;
  }) {
    this.onStartupCallback = controls.onStartup;
    this.onKillCallback = controls.onKill;
  }

  // --- UI DASHBOARD MARKUP VIEWS ---

  private getMainMenuMarkup(): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          {
            text: this.isEngineOnline ? '🔴 Kill Session' : '🚀 Startup Session',
            callback_data: this.isEngineOnline ? 'action_kill' : 'action_startup',
          },
        ],
        [
          { text: `💰 Bankroll: $${this.stakeManager.getBankroll()}`, callback_data: 'menu_bankroll' },
          { text: this.paused ? '▶️ Resume Trades' : '⏸️ Pause Trades', callback_data: 'action_toggle_pause' },
        ],
        [
          { text: '📊 Status', callback_data: 'action_status' },
        ],
      ],
    };
  }

  private getMainMenuText(): string {
    return (
      `🤖 *BYTBOT Control Center*\n\n` +
      `• *Status:* ${this.isEngineOnline ? '🟢 Online & Ready' : '🔴 Offline'}\n` +
      `• *Trading:* ${this.paused ? '⏸️ Paused' : '▶️ Active'}\n` +
      `• *Active Bankroll:* $${this.stakeManager.getBankroll().toFixed(2)}\n\n` +
      `Select an option below:`
    );
  }

  private getBankrollMenuMarkup(): InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: '$10', callback_data: 'set_bankroll_10' },
          { text: '$20', callback_data: 'set_bankroll_20' },
          { text: '$50', callback_data: 'set_bankroll_50' },
          { text: '$100', callback_data: 'set_bankroll_100' },
        ],
        [{ text: '« Back', callback_data: 'menu_main' }],
      ],
    };
  }

  private async updateDashboard(text: string, keyboard: InlineKeyboardMarkup) {
    if (this.mainMessageId) {
      try {
        await this.bot.editMessageText(text, {
          chat_id: this.allowedUserId,
          message_id: this.mainMessageId,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        return;
      } catch (err) {
        // Message manually deleted or expired; send fresh dashboard below
      }
    }

    const sent = await this.bot.sendMessage(this.allowedUserId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    this.mainMessageId = sent.message_id;
  }

  // --- BOT LISTENERS & EVENT HANDLERS ---

  private initListeners() {
    // Command 1: /start
    this.bot.onText(/\/start/, async (msg) => {
      if (msg.from?.id !== this.allowedUserId) return;
      this.waitingForBankrollInput = false;
      await this.bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      await this.updateDashboard(this.getMainMenuText(), this.getMainMenuMarkup());
    });

    // Command 2: /done (Captcha Resume)
    this.bot.onText(/\/done/, async (msg) => {
      if (msg.from?.id !== this.allowedUserId) return;
      await this.bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      if (doneResolver) {
        doneResolver();
        doneResolver = null;
        await this.updateDashboard(
          `✅ *Captcha Solved!*\nResuming automation...`,
          this.getMainMenuMarkup()
        );
      }
    });

    // Inline Button Clicks
    this.bot.on('callback_query', async (query) => {
      if (query.from.id !== this.allowedUserId) return;
      const data = query.data;
      if (!data) return;

      await this.bot.answerCallbackQuery(query.id);

      if (data === 'menu_main') {
        this.waitingForBankrollInput = false;
        await this.updateDashboard(this.getMainMenuText(), this.getMainMenuMarkup());
      } else if (data === 'menu_bankroll') {
        this.waitingForBankrollInput = true;
        await this.updateDashboard(
          `💰 *Set Bankroll*\n\nSelect a quick preset below or reply directly to this chat with a custom number (e.g. \`15\` or \`25.50\`):`,
          this.getBankrollMenuMarkup()
        );
      } else if (data.startsWith('set_bankroll_')) {
        const amount = parseFloat(data.replace('set_bankroll_', ''));
        this.stakeManager.setBankroll(amount);
        this.waitingForBankrollInput = false;
        await this.updateDashboard(
          `✅ *Bankroll updated to $${amount.toFixed(2)}*\n\n` + this.getMainMenuText(),
          this.getMainMenuMarkup()
        );
      } else if (data === 'action_toggle_pause') {
        this.paused = !this.paused;
        await this.updateDashboard(this.getMainMenuText(), this.getMainMenuMarkup());
      } else if (data === 'action_startup') {
        await this.updateDashboard(
          `⏳ *Booting Engine...*\nConnecting browser session & loading cookies...`,
          { inline_keyboard: [] }
        );
        try {
          if (this.onStartupCallback) await this.onStartupCallback();
          this.isEngineOnline = true;
          await this.updateDashboard(
            `✅ *Engine Session Ready!*\n\n` + this.getMainMenuText(),
            this.getMainMenuMarkup()
          );
        } catch (err: any) {
          this.isEngineOnline = false;
          await this.updateDashboard(
            `❌ *Startup Failed:* ${err.message}`,
            this.getMainMenuMarkup()
          );
        }
      } else if (data === 'action_kill') {
        await this.updateDashboard(`⏳ *Closing browser session...*`, {
          inline_keyboard: [],
        });
        try {
          if (this.onKillCallback) await this.onKillCallback();
          this.isEngineOnline = false;
          await this.updateDashboard(
            `🔴 *Engine Offline.*\n\n` + this.getMainMenuText(),
            this.getMainMenuMarkup()
          );
        } catch (err: any) {
          await this.updateDashboard(
            `⚠️ *Kill Error:* ${err.message}`,
            this.getMainMenuMarkup()
          );
        }
      } else if (data === 'action_status') {
        await this.updateDashboard(
          `📊 *System Status*\n\n` +
            `• Engine: ${this.isEngineOnline ? '🟢 RUNNING' : '🔴 OFF'}\n` +
            `• Trading: ${this.paused ? '⏸️ PAUSED' : '▶️ ACTIVE'}\n` +
            `• Bankroll: $${this.stakeManager.getBankroll().toFixed(2)}\n` +
            `• Current Stage: ${this.stakeManager.getStageNumber()}\n`,
          {
            inline_keyboard: [[{ text: '« Back', callback_data: 'menu_main' }]],
          }
        );
      }
    });

    // Custom Text Replies (Bankroll Input)
    this.bot.on('message', async (msg) => {
      if (msg.from?.id !== this.allowedUserId) return;
      if (msg.text?.startsWith('/')) return; // Ignore commands

      await this.bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

      if (this.waitingForBankrollInput && msg.text) {
        const parsed = parseFloat(msg.text.replace('$', '').trim());
        if (!isNaN(parsed) && parsed > 0) {
          this.stakeManager.setBankroll(parsed);
          this.waitingForBankrollInput = false;

          await this.updateDashboard(
            `✅ *Bankroll updated to $${parsed.toFixed(2)}*\n\n` + this.getMainMenuText(),
            this.getMainMenuMarkup()
          );
        }
      }
    });
  }

  // --- EXTERNAL TELEGRAM NOTIFICATIONS ---

  public async showCaptchaPrompt(url: string) {
    await this.updateDashboard(
      `⚠️ *Cloudflare Verification Required*\n\n` +
        `Click below to view the browser screen and solve the captcha:\n\n` +
        `🔗 [Open Live Session](${url})\n\n` +
        `Once solved, send \`/done\` to resume.`,
      {
        inline_keyboard: [[{ text: '🌐 Open Browser Canvas', url }]],
      }
    );
  }

  public async notifyTradeSuccess(periodId: string, option: string, stageNum: number, activeStake: number): Promise<void> {
    await this.bot.sendMessage(
      this.allowedUserId,
      `🎯 *Trade Order Executed*\n\n` +
        `• Period: \`#${periodId}\`\n` +
        `• Option: *${option}*\n` +
        `• Stage: *${stageNum}*\n` +
        `• Stake: *$${activeStake.toFixed(2)}*`,
      { parse_mode: 'Markdown' }
    );
  }

  public async notifyResultLog(periodId: string, isWin: boolean, newStage: number, nextStake: number): Promise<void> {
    const outcomeText = isWin ? '✅ *WIN*' : '❌ *LOSS*';
    await this.bot.sendMessage(
      this.allowedUserId,
      `📊 *Round Result Settled*\n\n` +
        `• Period: \`#${periodId}\`\n` +
        `• Outcome: ${outcomeText}\n` +
        `• Next Stage: *${newStage}* ($${nextStake.toFixed(2)})`,
      { parse_mode: 'Markdown' }
    );
  }

  public async notifyError(message: string): Promise<void> {
    await this.bot.sendMessage(
      this.allowedUserId,
      `⚠️ *Error Alert*\n${message}`,
      { parse_mode: 'Markdown' }
    );
  }
}
