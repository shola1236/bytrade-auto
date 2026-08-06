import { TelegramClient, events } from "telegram";
import { StringSession } from "telegram/sessions";
import { AssetType, TradeOption } from "../types";

export interface SignalData {
  periodId: string;
  asset: AssetType;
  option: TradeOption;
  rawText: string;
}

export interface ResultData {
  periodId?: string;
  isWin: boolean;
  rawText: string;
}

export class SignalListener {
  private client: TelegramClient;
  private channelId: string;

  constructor(
    apiId: number,
    apiHash: string,
    sessionString: string,
    channelId: string
  ) {
    this.channelId = channelId;
    const stringSession = new StringSession(sessionString);

    this.client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });
  }

  /**
   * Starts listening for incoming channel messages.
   */
  public async start(
    onSignal: (signal: SignalData) => Promise<void>,
    onResult: (result: ResultData) => void
  ): Promise<void> {
    await this.client.connect();
    console.log("[LISTENER] GramJS userclient connected successfully.");

    this.client.addEventHandler(async (event: events.NewMessageEvent) => {
      const message = event.message;
      if (!message || !message.text) return;

      const text = message.text;
      const peerId = message.peerId ? message.peerId.toString() : "";

      // Validate channel origin
      if (this.channelId && !peerId.includes(this.channelId.replace("-100", ""))) {
        return;
      }

      // Step 1: Check if previous round result exists in message
      const resultData = this.parseResult(text);
      if (resultData) {
        console.log(`[LISTENER] Round Result Detected -> ${resultData.isWin ? "WIN" : "LOSS"}`);
        onResult(resultData);
      }

      // Step 2: Check if active trade signal exists in message
      const signalData = this.parseSignal(text);
      if (signalData) {
        console.log(`[LISTENER] Active Signal Parsed -> Period: ${signalData.periodId} | Action: ${signalData.option}`);
        await onSignal(signalData);
      }
    }, new events.NewMessage());
  }

  /**
   * Parses active trade signal specifications.
   */
  private parseSignal(text: string): SignalData | null {
    // 1. Verify 5-Minute timeframe
    const isFiveMinute = /5\s*minute/i.test(text) || /5Min/i.test(text);
    if (!isFiveMinute) return null;

    // 2. Extract active Trade option (Big, Small, Odd, Even)
    const tradeMatch = text.match(/Trade:\s*(Big|Small|Odd|Even)/i);
    if (!tradeMatch) return null;

    const rawOption = tradeMatch[1].toUpperCase();
    let option: TradeOption | null = null;

    if (rawOption === "BIG") option = "BIG";
    else if (rawOption === "SMALL") option = "SMALL";
    else if (rawOption === "ODD") option = "ODD";
    else if (rawOption === "EVEN") option = "EVEN";

    if (!option) return null;

    // 3. Extract Period ID following "Next issue" or general "period ID:"
    let periodId = "";
    const nextIssueSection = text.split(/Next issue/i)[1] || text;
    const periodMatch = nextIssueSection.match(/period\s*ID:\s*(\d+)/i);

    if (periodMatch) {
      periodId = periodMatch[1];
    } else {
      // Fallback: Grab the last period ID in the message
      const allPeriodMatches = [...text.matchAll(/period\s*ID:\s*(\d+)/gi)];
      if (allPeriodMatches.length > 0) {
        periodId = allPeriodMatches[allPeriodMatches.length - 1][1];
      }
    }

    // 4. Detect asset (defaulting to BTC)
    let asset: AssetType = "BTC";
    if (/ETH/i.test(text)) {
      asset = "ETH";
    }

    return {
      periodId,
      asset,
      option,
      rawText: text,
    };
  }

  /**
   * Parses round result outcome (Win/Loss).
   */
  private parseResult(text: string): ResultData | null {
    const resultMatch = text.match(/Result:\s*(Win|Loss|Profit|Failed)/i);
    if (!resultMatch) return null;

    const outcome = resultMatch[1].toLowerCase();
    const isWin = outcome === "win" || outcome === "profit";

    // Extract current period ID tied to result if present
    const currentPeriodMatch = text.match(/Current period ID:\s*(\d+)/i);
    const periodId = currentPeriodMatch ? currentPeriodMatch[1] : undefined;

    return {
      periodId,
      isWin,
      rawText: text,
    };
  }
}
