import { useEffect, useState } from "react";
import { checksLine, checksTone, ghVisible, noPrLine, prState, runState, runTitle, runTone, safeUrl } from "../gh-model";
import { fetchGh, type ReviewSubject } from "../review-api";
import { relativeTime } from "../time";
import type { GhStatus } from "../types";
import "../review.css";

function Link({ url, children }: { url: string | null; children: string }) {
  const href = safeUrl(url);
  if (href === null) return <span>{children}</span>;
  return (
    <a className="gh__link" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

export function GhSection({ subject }: { subject: ReviewSubject }) {
  const [status, setStatus] = useState<GhStatus | null>(null);
  const id = subject.id;
  const kind = subject.kind;

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    fetchGh({ kind, id }, controller.signal)
      .then(setStatus)
      .catch(() => {
        if (!controller.signal.aborted) setStatus(null);
      });
    return () => controller.abort();
  }, [kind, id]);

  if (!ghVisible(status)) return null;
  const pr = status.pr;

  return (
    <section className="gh" aria-label="Pull request and checks">
      <h3 className="gh__title">Pull request</h3>
      {pr === null ? (
        <p className="gh__line muted">{noPrLine(status.branch)}</p>
      ) : (
        <p className="gh__line">
          <Link url={pr.url}>{`#${pr.number} ${pr.title}`}</Link>
          <span className="muted"> · {prState(pr.state, pr.isDraft)}</span>
          <span className={`gh__state gh__state--${checksTone(pr.checks)}`}> · {checksLine(pr.checks)}</span>
        </p>
      )}
      {status.runs.length > 0 && (
        <ul className="gh__runs">
          {status.runs.map((run, index) => (
            <li key={run.id ?? `${run.title}-${index}`} className="gh__run">
              <Link url={run.url}>{runTitle(run)}</Link>
              <span className={`gh__state gh__state--${runTone(run)}`}>{runState(run)}</span>
              {Number.isFinite(Date.parse(run.createdAt ?? "")) && <span className="muted">{relativeTime(Date.parse(run.createdAt ?? ""))}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
