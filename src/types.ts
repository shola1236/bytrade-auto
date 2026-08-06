export type TradeOption = "BIG" | "SMALL" | "ODD" | "EVEN";
export type AssetType = "BTC";

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
