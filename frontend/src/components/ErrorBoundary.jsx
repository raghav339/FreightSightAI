import { Component } from "react";
import { AlertTriangle } from "lucide-react";

// Without this, ANY uncaught render error anywhere in the tree (a null
// field from an API response, a bad map() over undefined, etc.) unmounts
// the entire React app and leaves nothing but the page background —
// a fully blank screen with no indication of what broke. This catches
// that instead and shows the actual error so it can be fixed, rather
// than silently blanking the page.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("Caught render error:", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-[720px] px-5 py-16 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-vermilion/10 text-vermilion">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <h2 className="font-display text-lg font-semibold text-ink">Something broke rendering this page</h2>
          <p className="mt-2 text-sm text-inksoft">{String(this.state.error?.message || this.state.error)}</p>
          <button
            type="button"
            className="mt-5 rounded-lg border border-rule/60 px-4 py-2 text-sm font-medium text-ink hover:bg-parchment"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
