import { useId, useState } from "react";
import { releaseDate, RELEASES_URL, type ReleaseState } from "./release";

export const COLLAPSED_COUNT = 4;

const SKELETON_ROWS = Array.from({ length: COLLAPSED_COUNT }, (_, index) => index);

export function WhatsNew({ state }: { state: ReleaseState }) {
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const listId = useId();
  const release = state.status === "ready" ? state.release : null;
  const highlights = release?.highlights ?? [];
  const date = releaseDate(release?.publishedAt ?? null);
  const visible = expanded ? highlights : highlights.slice(0, COLLAPSED_COUNT);
  const hidden = highlights.length - COLLAPSED_COUNT;

  return (
    <section className="whatsnew" aria-labelledby={headingId} aria-busy={state.status === "loading"}>
      <div className="whatsnew__head">
        {state.status === "loading" ? (
          <span className="whatsnew__badge whatsnew__badge--ghost" aria-hidden="true" />
        ) : (
          <span className="whatsnew__badge">{release ? `v${release.version}` : "Latest"}</span>
        )}
        <h2 id={headingId} className="whatsnew__title">
          What's new
        </h2>
        {date && (
          <time className="whatsnew__date" dateTime={date.iso}>
            {date.label}
          </time>
        )}
      </div>

      {state.status === "loading" && (
        <ul className="whatsnew__list" aria-hidden="true">
          {SKELETON_ROWS.map((row) => (
            <li key={row} className="whatsnew__item whatsnew__item--ghost">
              <span className="whatsnew__bar" />
              <span className="whatsnew__bar whatsnew__bar--short" />
            </li>
          ))}
        </ul>
      )}

      {visible.length > 0 ? (
        <ul id={listId} className={`whatsnew__list${expanded ? " whatsnew__list--open" : ""}`}>
          {visible.map((highlight, index) => (
            <li key={`${index}-${highlight.text}`} className="whatsnew__item">
              {highlight.title && <strong className="whatsnew__label">{highlight.title}</strong>}
              <p className={`whatsnew__text${highlight.title ? " whatsnew__text--short" : ""}`}>{highlight.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        state.status !== "loading" && (
          <div className="whatsnew__empty">
            <p className="whatsnew__empty-title">See what changed</p>
            <p>Every change in every version is listed in the release notes on GitHub.</p>
          </div>
        )
      )}

      <div className="whatsnew__foot">
        {hidden > 0 && (
          <button type="button" className="whatsnew__toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((open) => !open)}>
            {expanded ? "Show fewer" : `Show all ${highlights.length} changes`}
          </button>
        )}
        <a className="whatsnew__link" href={release?.url ?? RELEASES_URL} target="_blank" rel="noopener noreferrer">
          Full release notes
          <span aria-hidden="true"> ↗</span>
        </a>
      </div>
    </section>
  );
}
