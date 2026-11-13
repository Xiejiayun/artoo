import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../app/i18n.js";

interface Props {
  /** Changing this value (e.g. the route path) clears a previous error. */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  resetKey?: string;
}

/**
 * Contains render-time failures (including lazy chunk load errors) to the
 * route surface so navigation and connection status stay usable.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Route render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div role="alert" className="os-page-error">
        <h2>{t("errorBoundary.title")}</h2>
        <p>{this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>{t("errorBoundary.tryAgain")}</button>
        <button type="button" onClick={() => window.location.reload()}>{t("errorBoundary.reload")}</button>
      </div>
    );
  }
}
