import { Component, ReactNode } from 'react';
import { reportFrontendError } from '../utils/frontendDiagnostics';

/** Isolate this plugin's own pages, not Steam's global error handling. */
export default class PluginErrorBoundary extends Component<
  { area: string; children?: ReactNode }, { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportFrontendError(error, { kind: 'react-boundary', area: this.props.area });
    if (info.componentStack) {
      const componentError = new Error('React component stack');
      componentError.stack = info.componentStack;
      reportFrontendError(componentError, { kind: 'react-component-stack', area: this.props.area });
    }
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const italian = typeof navigator !== 'undefined' && /^it/i.test(navigator.language);
    return <div role="alert" style={{ padding: 24, color: 'white', lineHeight: 1.5 }}>
      <strong>Playhub Artworks</strong>
      <p>{italian ? 'Questa pagina ha incontrato un errore. Chiudila e riaprila; i dettagli sono stati inviati al log del plugin.'
        : 'This page encountered an error. Close it and reopen it; details were sent to the plugin log.'}</p>
    </div>;
  }
}
