import { Component } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { Sentry } from '../lib/sentry';
import { Button } from './ui/Button';

/**
 * Per-route error boundary that resets on navigation. It clears its error when
 * the path changes instead of remounting via `key`, which would rebuild the
 * whole route tree (and refetch every page's data) on each click.
 */
export function RouteErrorBoundary({ children }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  componentDidCatch(error, errorInfo) {
    Sentry.captureException(error, { contexts: { react: { componentStack: errorInfo?.componentStack } } });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }

      // Shown app-wide, including review pages, so it stays quiet: no stickers.
      return (
        <div className="flex min-h-screen items-center justify-center bg-background px-4" role="alert" aria-live="assertive">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive-soft" aria-hidden="true">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </span>
            <h2 className="mt-5 text-[21px] text-ink">Something went wrong</h2>
            <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary">
              An unexpected error occurred. Try refreshing the page, or go back to retry.
            </p>
            <div className="mt-6 flex items-center justify-center gap-3">
              <Button variant="outline" onClick={this.handleReset}>
                Try again
              </Button>
              <Button onClick={() => window.location.reload()}>
                Refresh page
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
