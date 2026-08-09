interface WhatsNewProps {
  onClose: () => void;
}

export function WhatsNew({ onClose }: WhatsNewProps) {
  return (
    <div className="whatsnew__overlay" onClick={onClose}>
      <div
        className="whatsnew"
        role="dialog"
        aria-label="What's new"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="whatsnew__header">
          <h2>What's new</h2>
          <span className="badge">v{__APP_VERSION__}</span>
        </header>
        <div className="whatsnew__body">
          {__CHANGELOG__.map((entry) => (
            <section key={entry.version} className="whatsnew__entry">
              <h3>
                v{entry.version} <span className="whatsnew__date">{entry.date}</span>
              </h3>
              <ul>
                {entry.highlights.map((highlight) => (
                  <li key={highlight}>{highlight}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="whatsnew__footer">
          <button className="pill pill--on" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
