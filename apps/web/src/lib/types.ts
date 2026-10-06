// Tipos de las respuestas de /api/admin (reflejan apps/api/src/db/schema.ts).

export type LotStatus = "available" | "reserved" | "sold" | "blocked";

export type Tenant = { id: string; name: string; slug: string };

export type UserRole = "admin" | "owner" | "manager" | "seller";

export type Me = {
  user: { id: string; tenantId: string | null; email: string; name: string; role: UserRole };
  tenants: Tenant[];
};

export type Development = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  amenities: string[] | null;
  status: "active" | "inactive";
};

export type DevelopmentSummary = {
  developmentId: string;
  slug: string;
  name: string;
  city: string | null;
  status: "active" | "inactive";
  total: number;
  available: number;
  reserved: number;
  sold: number;
  blocked: number;
  availableValueCents: number;
  minAvailablePriceCents: number | null;
};

export type Summary = {
  tenant: Tenant;
  developments: DevelopmentSummary[];
  prospects: { prospects: number; newLast24h: number };
};

export type Lot = {
  id: string;
  developmentId: string;
  block: string;
  number: string;
  areaM2: number;
  frontM: number | null;
  depthM: number | null;
  pricePerM2Cents: number;
  totalPriceCents: number;
  status: LotStatus;
  reservedUntil: number | null;
  features: string | null;
  updatedAt: number;
};

export type PaymentPlan = {
  id: string;
  developmentId: string | null;
  name: string;
  calculationType: "with_interest" | "on_delivery";
  listPriceType: "list_price" | "total_m2";
  discountType: "percentage" | "fixed";
  discountBp: number;
  discountFixedCents: number;
  reservationCents: number;
  openingFeeCents: number;
  downPaymentType: "percentage" | "fixed";
  downPaymentBp: number;
  downPaymentFixedCents: number;
  downPaymentInstallments: number;
  months: number;
  annualInterestBp: number;
  monthlyType: "percentage" | "fixed";
  monthlyBp: number;
  monthlyFixedCents: number;
  onDeliveryType: "percentage" | "fixed";
  onDeliveryBp: number;
  onDeliveryFixedCents: number;
  onDeliveryInstallments: number;
  roundingAbsorber: "down_payment" | "monthly" | "on_delivery" | null;
  deliveryDate: string | null;
  active: boolean;
};

export type Breakdown = {
  calculationType: PaymentPlan["calculationType"];
  listPriceCents: number;
  discountCents: number;
  discountBp: number;
  salePriceCents: number;
  adjustedPricePerM2Cents?: number;
  openingFeeCents: number;
  reservationCents: number;
  downPaymentTotalCents: number;
  downPaymentInstallments: number;
  downPaymentPerInstallmentCents: number;
  monthlyTotalCents: number;
  monthlyInstallments: number;
  monthlyPaymentCents: number;
  onDeliveryTotalCents: number;
  onDeliveryInstallments: number;
  onDeliveryPerInstallmentCents: number;
  financedCents: number;
  annualInterestBp: number;
  totalInterestCents: number;
};

export type LineType = "opening_fee" | "reservation" | "down_payment" | "down_payment_total" | "installment" | "on_delivery";

export type ScheduleLine = {
  lineType: LineType;
  period: number;
  paymentDate: string;
  paymentCents: number;
  principalCents: number;
  interestCents: number;
  balanceCents: number;
};

export type Simulation = {
  lot: Lot;
  plan: { id: string; name: string };
  breakdown: Breakdown;
  lines: ScheduleLine[];
};

export type Media = {
  id: string;
  developmentId: string;
  lotId: string | null;
  kind: "photo" | "plan" | "brochure";
  mime: string;
  caption: string | null;
  sort: number;
};

export type Prospect = {
  id: string;
  phone: string;
  name: string | null;
  profileName: string | null;
  stage: string;
  score: number;
  city: string | null;
  purpose: "vivienda" | "inversion" | "otro" | null;
  budgetCents: number | null;
  downPaymentCents: number | null;
  timeframe: string | null;
  handoffAt: number | null;
  handoffReason: string | null;
  optedOutAt: number | null;
  source: "whatsapp" | "simulator";
  createdAt: number;
  conversationId: string | null;
  aiPaused: boolean | null;
  lastInboundAt: number | null;
  messageCount: number;
};

export type Message = {
  id: string;
  wamid: string;
  direction: "in" | "out";
  author: "prospect" | "ai" | "user" | "system";
  type: string;
  body: string | null;
  status: string;
  createdAt: number;
  waTimestamp: number | null;
};

export type ImportResult = {
  dryRun: boolean;
  valid: boolean;
  created?: number;
  updated?: number;
  statusChanges?: number;
  errors?: { line: number; field?: string; message: string }[];
};

export type ToolTrace = { name: string; args: Record<string, unknown>; result: string };

export type SimulatorTurn = {
  conversationId: string;
  reply: string | null;
  skippedReason: string | null;
  model: string | null;
  tools: ToolTrace[];
  blocked: string[];
  escalation: string | null;
  fallback: boolean;
  neurons: number;
  latencyMs: number;
  prospect: Prospect & { email: string | null };
};

export type AiAudit = {
  id: string;
  model: string;
  input: string;
  toolCalls: ToolTrace[];
  draft: string | null;
  reply: string;
  blocked: string[];
  escalation: string | null;
  fallback: boolean;
  neurons: number;
  latencyMs: number;
  createdAt: number;
};

export type SimulatorHistory = {
  conversationId: string | null;
  messages: Message[];
  audit: AiAudit[];
  prospect: (Prospect & { email: string | null }) | null;
};
