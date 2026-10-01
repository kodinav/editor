import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps a crash in one panel from taking down the whole editor. The project
 * state lives outside React, so remounting the panel is safe.
 */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null; key: number }> {
  override state = { error: null as Error | null, key: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name}] crashed`, error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="panel-crash" role="alert">
          <strong>The {this.props.name} hit a problem.</strong>
          <span className="subtle">Your project is safe. {this.state.error.message}</span>
          <button className="btn small" onClick={() => this.setState((s) => ({ error: null, key: s.key + 1 }))}>
            Reload {this.props.name}
          </button>
        </div>
      );
    }
    return <div key={this.state.key} style={{ display: 'contents' }}>{this.props.children}</div>;
  }
}
