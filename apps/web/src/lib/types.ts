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
  appointments: { today: number; next7Days: number };
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
  takenByUserId: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  assignedUserId: string | null;
  assignedName: string | null;
  updatedAt: number;
  messageCount: number;
  nextAppointmentAt: number | null;
};

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  receivesLeads: boolean;
  lastAssignedAt: number | null;
};

export type AssignmentSettings = { assignmentMode: "round_robin" | "manual"; reassignAfterMinutes: number };

export type ProspectStage = "new" | "qualified" | "appointment" | "visited" | "negotiation" | "ready_to_buy" | "reserved" | "won" | "lost";

export type ProspectNote = { id: string; body: string; createdAt: number; authorName: string | null };

export type HistoryItem = {
  id: string;
  actor: string;
  actorName: string;
  entity: string;
  action: string;
  data: Record<string, unknown> | null;
  createdAt: number;
};

export type ProspectDetail = {
  prospect: Prospect & {
    email: string | null;
    interestDevelopmentId: string | null;
    privacyNoticeAt: number | null;
    consentRequestedAt: number | null;
    consentAt: number | null;
    consentDeniedAt: number | null;
    consentText: string | null;
    pendingFinancial: { budgetCents?: number; downPaymentCents?: number } | null;
  };
  conversation: { id: string; aiPaused: boolean; takenByUserId: string | null; takenByName: string | null; takenAt: number | null; lastInboundAt: number | null } | null;
  messages: Message[];
  notes: ProspectNote[];
  history: HistoryItem[];
  lastAi: AiAudit | null;
  appointments: (Appointment & { sellerName: string; label: string })[];
};

export type AppointmentStatus = "scheduled" | "completed" | "no_show" | "cancelled";

export type Appointment = {
  id: string;
  prospectId: string;
  userId: string;
  developmentId: string | null;
  startsAt: number;
  endsAt: number;
  status: AppointmentStatus;
  source: "ai" | "user";
  notes: string | null;
  cancelReason: string | null;
  createdAt: number;
};

export type AgendaItem = Appointment & {
  prospectName: string;
  prospectStage: string;
  sellerName: string;
  developmentName: string | null;
  label: string;
  date: string; // YYYY-MM-DD local
  time: string; // HH:MM local
};

export type Slot = { userId: string; userName: string; startsAt: number; endsAt: number; label: string; date: string; time: string };

export type AvailabilityRule = { weekday: number; startMinute: number; endMinute: number };

export type Availability = {
  timezone: string;
  appointmentMinutes: number;
  members: { id: string; name: string; role: UserRole; rules: AvailabilityRule[] }[];
};

export type AppNotification = {
  id: string;
  kind: "handoff" | "assignment" | "appointment" | "system";
  title: string;
  body: string | null;
  prospectId: string | null;
  createdAt: number;
  readAt: number | null;
};

export type Message = {
  id: string;
  wamid: string;
  direction: "in" | "out";
  author: "prospect" | "ai" | "user" | "system";
  type: string;
  body: string | null;
  status: string;
  error?: string | null;
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

export type KbCategory = "desarrollo" | "compra" | "pagos" | "construccion" | "oficina" | "general";

export type KbArticle = {
  id: string;
  developmentId: string | null;
  developmentName: string | null;
  title: string;
  body: string;
  keywords: string | null;
  category: KbCategory;
  status: "draft" | "approved";
  approvedByName: string | null;
  approvedAt: number | null;
  updatedAt: number;
};

export type KbSearch = { query: string | null; hits: { id: string; title: string; body: string; category: KbCategory }[] };

export type PrivacySettings = { privacyNoticeUrl: string | null; privacyNoticeText: string | null };
