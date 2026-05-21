import { Component, type ReactNode } from 'react'

// Wraps a single query block so a kernel crash doesn't take the whole
// page down. Surfaces the error inline + offers a path to fix the atom.

type Props = { children: ReactNode; source?: string }
type State = { error: Error | null }

export class QueryErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error('[vibeam plugin error]', error, info, this.props.source)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="query-error">
          <div className="query-error-head">
            plugin crashed
            <button onClick={this.reset}>retry</button>
          </div>
          <pre className="query-error-msg">{this.state.error.message}</pre>
          {this.props.source && (
            <div className="query-error-source">
              query: <code>{this.props.source}</code>
            </div>
          )}
          <div className="query-error-hint">
            edit the plugin atom to fix the config, or disable it in the
            plugin marketplace.
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
