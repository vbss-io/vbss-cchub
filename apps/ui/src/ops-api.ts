import { hubRequest } from "./hub-request";
import type { FixPlan } from "./health-model";
import type { HealthReport, LimitsForecast } from "./types";

export const fetchForecast = (): Promise<LimitsForecast> => hubRequest("GET", "/delegation/limits/forecast");

export const fetchHealthReport = (): Promise<HealthReport> => hubRequest("GET", "/delegation/health");

export async function runFix(plan: Extract<FixPlan, { kind: "api" }>): Promise<void> {
  await hubRequest<unknown>(plan.method, plan.path, plan.body ?? undefined);
}
