/**
 * Site-calibrated weight vector for 8-stage exponential loss recovery.
 * Derived from the site's 95% payout rate formula.
 */
const SITE_WEIGHT_VECTOR = [
  0.0029019, // Stage 1
  0.0060707, // Stage 2
  0.0128752, // Stage 3
  0.0270180, // Stage 4
  0.0567045, // Stage 5
  0.1190794, // Stage 6
  0.2501001, // Stage 7
  0.5252502, // Stage 8
];

export interface StakePlan {
  bankroll: number;
  allocated: number;
  buffer: number;
  stages: number[];
}

/**
 * Generates an exact 8-stage stake array for any bankroll amount.
 */
export function calculateDynamicStakes(bankroll: number): StakePlan {
  const buffer = 0.010;
  const targetAllocation = Number((bankroll - buffer).toFixed(3));

  // Compute stages 1-7 rounded to 3 decimal places
  const stages: number[] = SITE_WEIGHT_VECTOR.slice(0, 7).map((weight) =>
    Math.round(targetAllocation * weight * 1000) / 1000
  );

  // Stage 8 absorbs the exact remaining delta to guarantee sum === (bankroll - $0.010)
  const sumFirst7 = stages.reduce((acc, val) => acc + val, 0);
  const stage8 = Math.round((targetAllocation - sumFirst7) * 1000) / 1000;
  stages.push(stage8);

  return {
    bankroll,
    allocated: targetAllocation,
    buffer,
    stages,
  };
}

/**
 * State manager to handle live trade execution and stage tracking.
 */
export class StakeManager {
  public bankroll: number;
  private stages: number[] = [];
  private currentStageIndex: number = 0;

  constructor(bankroll: number) {
    this.bankroll = bankroll;
    this.recalculatePlan();
  }

  /** Recalculate plan based on current bankroll */
  public recalculatePlan(): StakePlan {
    const plan = calculateDynamicStakes(this.bankroll);
    this.stages = plan.stages;
    return plan;
  }

  /** Update bankroll dynamically via Telegram bot */
  public updateBankroll(newBankroll: number): StakePlan {
    this.bankroll = newBankroll;
    this.currentStageIndex = 0;
    return this.recalculatePlan();
  }

  /** Get active stake amount for UI input */
  public getCurrentStake(): number {
    return this.stages[this.currentStageIndex];
  }

  /** Current active stage (1 to 8) */
  public getStageNumber(): number {
    return this.currentStageIndex + 1;
  }

  /** Get calculated stages list */
  public getStages(): number[] {
    return [...this.stages];
  }

  /** Update state based on Telegram signal outcome */
  public registerResult(isWin: boolean): { nextStake: number; newStage: number } {
    if (isWin) {
      console.log(`[WIN] Resetting to Stage 1 ($${this.stages[0]})`);
      this.currentStageIndex = 0;
    } else {
      if (this.currentStageIndex < this.stages.length - 1) {
        this.currentStageIndex++;
        console.log(
          `[LOSS] Stepping up to Stage ${this.getStageNumber()} ($${this.getCurrentStake()})`
        );
      } else {
        console.log(`[CYCLE COMPLETE] Stage 8 completed. Resetting to Stage 1`);
        this.currentStageIndex = 0;
      }
    }

    return {
      nextStake: this.getCurrentStake(),
      newStage: this.getStageNumber(),
    };
  }
}
