import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface TradeRecord {
  id?: number;
  periodId: string;
  option: string;
  stage: number;
  amount: number;
  result: "WIN" | "LOSS" | "PENDING";
  pnl: number;
  created_at?: string;
}

export interface PnLStats {
  todayPnL: number;
  todayTrades: number;
  todayWins: number;
  totalPnL: number;
  totalTrades: number;
  totalWins: number;
  winRate: number;
}

export class DatabaseService {
  private supabase: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.supabase = createClient(url, serviceKey);
  }

  /**
   * Log a new pending trade into Supabase
   */
  public async logTrade(
    periodId: string,
    option: string,
    stage: number,
    amount: number
  ): Promise<number | null> {
    const { data, error } = await this.supabase
      .from("trades")
      .insert({
        period_id: periodId,
        option,
        stage,
        amount,
        result: "PENDING",
        pnl: 0,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[SUPABASE ERROR] Failed to log trade:", error.message);
      return null;
    }
    return data.id;
  }

  /**
   * Settle the latest PENDING trade with outcome and calculated PnL
   */
  public async settleLatestTrade(isWin: boolean): Promise<TradeRecord | null> {
    // 1. Fetch latest pending order
    const { data: latestTrade, error: fetchErr } = await this.supabase
      .from("trades")
      .select("*")
      .eq("result", "PENDING")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchErr || !latestTrade) {
      console.warn("[SUPABASE] No pending trade found to settle.");
      return null;
    }

    // WIN yields +0.95x profit, LOSS yields -1.0x loss
    const pnl = isWin
      ? Number((latestTrade.amount * 0.95).toFixed(3))
      : -Number(latestTrade.amount);
    const result = isWin ? "WIN" : "LOSS";

    // 2. Update record
    const { data: updated, error: updateErr } = await this.supabase
      .from("trades")
      .update({ result, pnl })
      .eq("id", latestTrade.id)
      .select()
      .single();

    if (updateErr) {
      console.error("[SUPABASE ERROR] Failed to settle trade:", updateErr.message);
      return null;
    }

    return {
      id: updated.id,
      periodId: updated.period_id,
      option: updated.option,
      stage: updated.stage,
      amount: updated.amount,
      result: updated.result,
      pnl: updated.pnl,
    };
  }

  /**
   * Query daily and total historical performance metrics
   */
  public async getPnLStats(): Promise<PnLStats> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Fetch today's settled records
    const { data: todayTrades } = await this.supabase
      .from("trades")
      .select("pnl, result")
      .neq("result", "PENDING")
      .gte("created_at", startOfToday.toISOString());

    // Fetch all-time settled records
    const { data: allTrades } = await this.supabase
      .from("trades")
      .select("pnl, result")
      .neq("result", "PENDING");

    const tRecords = todayTrades || [];
    const aRecords = allTrades || [];

    const todayPnL = tRecords.reduce((sum, item) => sum + Number(item.pnl), 0);
    const todayWins = tRecords.filter((t) => t.result === "WIN").length;

    const totalPnL = aRecords.reduce((sum, item) => sum + Number(item.pnl), 0);
    const totalWins = aRecords.filter((t) => t.result === "WIN").length;
    const totalTrades = aRecords.length;
    const winRate = totalTrades > 0 ? Number(((totalWins / totalTrades) * 100).toFixed(1)) : 0;

    return {
      todayPnL: Number(todayPnL.toFixed(3)),
      todayTrades: tRecords.length,
      todayWins,
      totalPnL: Number(totalPnL.toFixed(3)),
      totalTrades,
      totalWins,
      winRate,
    };
  }
}
