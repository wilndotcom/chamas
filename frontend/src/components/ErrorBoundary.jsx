import React from 'react';

/**
 * Catches render errors so a mistake in one component cannot leave a blank page.
 *
 * React unmounts the whole tree when a component throws, which shows the user an
 * empty window with no explanation and gives them nothing to report. This was
 * hit for real: a panel called the translator without the hook that provides it,
 * and the entire app went blank.
 *
 * The message deliberately stays technical. It is a developer-facing page, and the
 * user needs enough detail to send with a bug report - a vague "something went
 * wrong" would be useless for that.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept in state rather than only logged so it can be shown.
    this.setState({ info });
    console.error('Render error:', error, info);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash-screen">
        <div className="crash-card">
          <h1>This screen ran into a problem</h1>
          <p>
            The page could not be drawn. Nothing has been saved or changed — reload to carry
            on. If it keeps happening, send the details below in a bug report.
          </p>

          <div className="crash-detail">
            <strong>{String(error && error.message ? error.message : error)}</strong>
            {info?.componentStack && <pre>{info.componentStack.trim()}</pre>}
          </div>

          <div className="crash-actions">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                const text = `${error?.message}\n\n${info?.componentStack || ''}`;
                if (navigator.clipboard) navigator.clipboard.writeText(text);
              }}
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;