export interface BracketSnapshot {
  id: string;
  bracketMinutes: number;
  creditsFull: string; // Decimal serialised as string for JSON storage
  creditsHalf: string;
  freeZoneMinutes: number;
  graceZoneMinutes: number;
}

export interface HoldResult {
  creditsHeld: string; // Decimal as string
  maxAllowedMinutes: number;
  snapshot: BracketSnapshot;
}

export interface DeductionResult {
  creditsDeducted: string; // Decimal as string
  reason: string;
  newBalance: string; // Decimal as string
}

export interface CreditBalanceDTO {
  userId: string;
  purchasedCredits: string;
  earnedCredits: string;
  heldCredits: string;
  totalAvailable: string;
}

export interface CreditPackPlan {
  code: string;
  name: string;
  credits: string;
  currency: string;
  amountMajor: string;
  amountMinor: number;
  feature: "INTERVIEW_SESSION";
  /** Value-efficiency percentage shown on the billing card (0–100). */
  valuePct: number;
  /** Whether to render the "Popular" badge. */
  isPopular: boolean;
}

export interface PurchaseOrderResult {
  orderId: string;
  keyId: string;
  amountMinor: number;
  amountMajor: string;
  currency: string;
  plan: CreditPackPlan;
}
