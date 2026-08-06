import TelegramBot, { InlineKeyboardMarkup } from 'node-telegram-bot-api';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

let mainMessageId: number | null = null;
let doneResolver: (() => void) | null = null;
let waitingForBankrollInput: boolean = false;

// Engine State Tracking
let isEngineOnline = false;
let currentBankroll = 10;

// Callbacks attached from index.ts
let onStartupCallback: (() => Promise<void>) | null = null;
let onKillCallback: (() => Promise<void>) | null = null;
let onBankrollChangeCallback: ((amount: number) => void) | null = null;

export function registerEngineControls(controls: {
  onStartup: () => Promise<void>;
  onKill: () => Promise<void>;
  onBankrollChange: (amount: number) => void;
}) {
  onStartupCallback = controls.onStartup;
  onKillCallback = controls.onKill;
  onBankrollChangeCallback = controls.onBankrollChange;
}

export function waitForDoneCommand(): Promise<void> {
  return new Promise((resolve) => {
    doneResolver = resolve;
  });
}

// Helper: Edit existing dashboard or send a new one if missing
async function updateDashboard(text: string, keyboard: InlineKeyboardMarkup) {
  if (mainMessageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: CHAT_ID,
        message_id: mainMessageId,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      return;
    } catch (err: any) {
      // If message was deleted manually or failed to edit, fall back to sending new message
    }
  }

  const sent = await bot.sendMessage(CHAT_ID, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
  mainMessageId = sent.message_id;
}

// Main Menu View
function getMainMenuMarkup(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: isEngineOnline ? '🔴 Kill Session' : '🚀 Startup Session', callback_data: isEngineOnline ? 'action_kill' : 'action_startup' },
      ],
      [
        { text: `💰 Bankroll: $${currentBankroll}`, callback_data: 'menu_bankroll' },
        { text: '📊 Status', callback_data: 'action_status' },
      ],
    ],
  };
}

function getMainMenuText(): string {
  return (
    `🤖 *BYTBOT Control Center*\n\n` +
    `• *Status:* ${isEngineOnline ? '🟢 Online & Ready' : '🔴 Offline'}\n` +
    `• *Active Bankroll:* $${currentBankroll.toFixed(2)}\n\n` +
    `Select an option below:`
  );
}

// Bankroll Menu View
function getBankrollMenuMarkup(): InlineKeyboardMarkup {
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

// --- COMMAND HANDLERS ---

// Command 1: /start
bot.onText(/\/start/, async (msg) => {
  waitingForBankrollInput = false;
  // Delete user's /start text message to keep chat clean
  await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  await updateDashboard(getMainMenuText(), getMainMenuMarkup());
});

// Command 2: /done (Captcha Resolution)
bot.onText(/\/done/, async (msg) => {
  await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  if (doneResolver) {
    doneResolver();
    doneResolver = null;
    await updateDashboard(
      `✅ *Captcha Solved!*\nResuming automation...`,
      getMainMenuMarkup()
    );
  }
});

// --- INLINE BUTTON CLICK HANDLERS ---

bot.on('callback_query', async (query) => {
  const data = query.data;
  if (!data) return;

  await bot.answerCallbackQuery(query.id);

  if (data === 'menu_main') {
    waitingForBankrollInput = false;
    await updateDashboard(getMainMenuText(), getMainMenuMarkup());
  } else if (data === 'menu_bankroll') {
    waitingForBankrollInput = true;
    await updateDashboard(
      `💰 *Set Bankroll*\n\nSelect a quick preset below or reply directly to this chat with a custom number (e.g., \`15\` or \`25.50\`):`,
      getBankrollMenuMarkup()
    );
  } else if (data.startsWith('set_bankroll_')) {
    const amount = parseFloat(data.replace('set_bankroll_', ''));
    currentBankroll = amount;
    if (onBankrollChangeCallback) onBankrollChangeCallback(amount);
    waitingForBankrollInput = false;

    await updateDashboard(
      `✅ *Bankroll updated to $${amount.toFixed(2)}*\n\n` + getMainMenuText(),
      getMainMenuMarkup()
    );
  } else if (data === 'action_startup') {
    await updateDashboard(
      `⏳ *Booting Engine...*\nConnecting browser session & loading cookies...`,
      { inline_keyboard: [] }
    );
    try {
      if (onStartupCallback) await onStartupCallback();
      isEngineOnline = true;
      await updateDashboard(
        `✅ *Engine Session Ready!*\n\n` + getMainMenuText(),
        getMainMenuMarkup()
      );
    } catch (err: any) {
      isEngineOnline = false;
      await updateDashboard(
        `❌ *Startup Failed:* ${err.message}`,
        getMainMenuMarkup()
      );
    }
  } else if (data === 'action_kill') {
    await updateDashboard(`⏳ *Closing browser session...*`, {
      inline_keyboard: [],
    });
    try {
      if (onKillCallback) await onKillCallback();
      isEngineOnline = false;
      await updateDashboard(
        `🔴 *Engine Offline.*\n\n` + getMainMenuText(),
        getMainMenuMarkup()
      );
    } catch (err: any) {
      await updateDashboard(
        `⚠️ *Kill Error:* ${err.message}`,
        getMainMenuMarkup()
      );
    }
  } else if (data === 'action_status') {
    await updateDashboard(
      `📊 *System Status*\n\n` +
        `• Engine: ${isEngineOnline ? '🟢 RUNNING' : '🔴 OFF'}\n` +
        `• Bankroll: $${currentBankroll.toFixed(2)}\n`,
      {
        inline_keyboard: [[{ text: '« Back', callback_data: 'menu_main' }]],
      }
    );
  }
});

// --- TEXT INPUT LISTENER (Custom Bankroll Replies) ---

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return; // Ignore slash commands

  // Auto-delete the message the user typed to keep chat clean
  await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

  if (waitingForBankrollInput && msg.text) {
    const parsed = parseFloat(msg.text.replace('$', '').trim());
    if (!isNaN(parsed) && parsed > 0) {
      currentBankroll = parsed;
      if (onBankrollChangeCallback) onBankrollChangeCallback(parsed);
      waitingForBankrollInput = false;

      await updateDashboard(
        `✅ *Bankroll updated to $${parsed.toFixed(2)}*\n\n` + getMainMenuText(),
        getMainMenuMarkup()
      );
    }
  }
});

// Helper for trade executor to send Captcha Link inside the dashboard
export async function sendCaptchaPrompt(url: string) {
  await updateDashboard(
    `⚠️ *Cloudflare Verification Required*\n\n` +
      `Click below to view the browser screen and solve the captcha:\n\n` +
      `🔗 [Open Live Session](${url})\n\n` +
      `Once solved, send \`/done\` to resume.`,
    {
      inline_keyboard: [
        [{ text: '🌐 Open Browser Canvas', url }],
      ],
    }
  );
}
