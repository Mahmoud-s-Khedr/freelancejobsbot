export type Provider =
  | "greenhouse"
  | "ashby"
  | "lever"
  | "himalayas"
  | "remotive"
  | "remoteok"
  | "wwr"
  | "mostaql"
  | "khamsat"
  | "ureed"
  | "nafezly"
  | "indeed"
  | "linkedin"
  | "wuzzuf"
  | "forasna"
  | "bayt"
  | "wellfound";
export interface Target {
  id: string;
  provider: Provider;
  url: string;
  token?: string;
  employer: string;
  entityIds: string[];
  evidence: unknown[];
  status: string;
  pendingReason: string | null;
  attribution: string;
  intervalHours: number;
  restrictions: string;
}
export interface Job {
  externalId: string;
  title: string;
  url: string;
  applicationUrl?: string;
  description?: string;
  employer?: string;
  locations?: string[];
  workplaceModel?: string;
  geographicRestrictions?: string[];
  employmentType?: string;
  seniority?: string;
  compensationCurrency?: string;
  compensationPeriod?: string;
  budgetMin?: number;
  budgetMax?: number;
  budgetText?: string;
  publishedAt?: string;
  sourceUpdatedAt?: string;
  timestampSemantics: string;
  qualityEvidence: unknown;
  detailStatus?: string;
  category?: string;
  skills?: string[];
  status?: string;
}
export interface Inventory {
  observedCount?: number;
  jobs: Job[];
  scope: "full-board" | "rolling-feed" | "bounded-marketplace";
  complete: boolean;
  errors: string[];
}
