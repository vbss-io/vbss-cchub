import { useState } from "react";
import { canRunFix, checkedLine, healthRows, healthSummary, type FixPlan } from "../../health-model";
import { errorText } from "../../hub-request";
import { runFix } from "../../ops-api";
import { useHealth } from "../../use-ops";
import type { SettingsTabProps } from "./types";
import "../../routines.css";

export function HealthTab({ enabled }: SettingsTabProps) {
  const health = useHealth(enabled);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = healthRows(health.report);

  const fix = async (id: string, plan: FixPlan) => {
    if (plan.kind === "navigate") {
      window.location.hash = plan.hash;
      return;
    }
    setBusyId(id);
    setProblem(null);
    try {
      await runFix(plan);
      await health.refresh();
    } catch (err) {
      setProblem(errorText(err, "The fix did not work."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="settings__section" id="settings-health">
      <h2>Health</h2>
      <p className="hint">What the hub depends on to see and steer your sessions. A fix button runs the same action as its own settings page.</p>
      <div className="health">
        <div className="health__bar">
          <span role="status">{healthSummary(health.report)}</span>
          {health.report !== null && <span className="muted small">{checkedLine(health.report, Date.now())}</span>}
          <span className="spacer" />
          <button type="button" className="act" disabled={!enabled || health.loading || busyId !== null} onClick={() => void health.refresh()}>
            {health.loading ? "Checking..." : "Check again"}
          </button>
        </div>
        {(health.error !== null || problem !== null) && (
          <p className="callout" role="alert">
            {problem ?? health.error}
          </p>
        )}
        {rows.length > 0 && (
          <ul className="health__list">
            {rows.map((row) => (
              <li key={row.id} className="health__row">
                <span className="health__label">{row.label}</span>
                <span className={`health__state health__state--${row.state}`}>{row.stateLabel}</span>
                <span className="health__detail">{row.detail}</span>
                {row.fix !== null ? (
                  <button type="button" className="act" disabled={!canRunFix(row.fix, busyId)} onClick={() => row.fix && void fix(row.id, row.fix)}>
                    {busyId === row.id ? "Working..." : row.fix.label}
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        )}
        {!enabled && <p className="hint">The hub is not reachable, so there is nothing to check.</p>}
      </div>
    </section>
  );
}
