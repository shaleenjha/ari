import { Component, type ErrorInfo, type ReactNode } from 'react';

/** The screen shown when the app cannot start or a screen throws. Never a blank page. */
export function Fallback() {
  return (
    <div className="shell"><main className="screen">
      <section aria-labelledby="h-err" className="signin" data-testid="app-error">
        <header className="hd"><h1 id="h-err">Ari</h1></header>
        <p className="muted">This screen did not load. Reload to try again.</p>
        <button className="btn" onClick={() => location.reload()}>Reload</button>
      </section>
    </main></div>
  );
}

/** Top level boundary: a render error shows Fallback instead of unmounting everything to a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown, info: ErrorInfo) { console.error('Ari screen error', e, info.componentStack); }
  render() { return this.state.failed ? <Fallback /> : this.props.children; }
}
