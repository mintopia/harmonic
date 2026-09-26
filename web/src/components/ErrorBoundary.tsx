import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { btnGhost, btnPrimary, card, displayTitle } from '../ui';

/** Root crash screen: catches a render-time exception that would otherwise
 * unmount the whole app to a blank page. Logs the real error to the console
 * for diagnosis but never shows it to the operator — only a plain-language
 * summary and a recovery path. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Harmonic crashed', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div role="alert" className={`${card} w-full max-w-sm p-6`}>
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <h1 className={displayTitle}>Harmonic</h1>
          </div>
          <p className="mb-5 mt-1.5 text-muted">
            Something went wrong and the console can't recover on its own. Reloading usually fixes it — your tasks
            and their Attempts are unaffected.
          </p>
          <div className="flex gap-2">
            <button type="button" className={`${btnPrimary} flex-1`} onClick={() => window.location.reload()}>
              Reload
            </button>
            <a href="/" className={`${btnGhost} flex-1 justify-center`}>
              Go to Board
            </a>
          </div>
        </div>
      </div>
    );
  }
}
