export interface BankrollPlan {
  allocated: number;
  buffer: number;
  stages: number[];
}

export class StakeManager {
  public bankroll: number;
  private currentStageIndex: number = 0;
  private stages: number[] = [];

  // Multiplier ratios for 8-stage progression (~1.95x payout target)
  private readonly stageRatios: number[] = [
    0.002, 0.005, 0.012, 0.027, 0.06, 0.132, 0.288, 0.476,
  ];

  constructor(bankroll: number) {
    this.bankroll = bankroll;
    this.recalculateStages();
  }

  public updateBankroll(newBankroll: number): BankrollPlan {
    this.bankroll = newBankroll;
    this.currentStageIndex = 0;
    return this.recalculateStages();
  }

  public recalculateStages(): BankrollPlan {
    this.stages = this.stageRatios.map((ratio: number) =>
      Number((this.bankroll * ratio).toFixed(3))
    );

    const totalAllocated: number = Number(
      this.stages.reduce((sum: number, val: number) => sum + val, 0).toFixed(3)
    );
    const buffer: number = Number((this.bankroll - totalAllocated).toFixed(3));

    return {
      allocated: totalAllocated,
      buffer: buffer > 0 ? buffer : 0,
      stages: [...this.stages],
    };
  }

  public getCurrentStake(): number {
    return this.stages[this.currentStageIndex] || this.stages[0];
  }

  public getStageNumber(): number {
    return this.currentStageIndex + 1;
  }

  public registerResult(isWin: boolean): { nextStake: number; newStage: number } {
    if (isWin) {
      this.currentStageIndex = 0; // Reset to Stage 1 on Win
    } else {
      if (this.currentStageIndex < this.stages.length - 1) {
        this.currentStageIndex++; // Advance to next stage on Loss
      } else {
        this.currentStageIndex = 0; // Reset back to Stage 1 after Stage 8 loss
      }
    }

    return {
      nextStake: this.getCurrentStake(),
      newStage: this.getStageNumber(),
    };
  }
}
