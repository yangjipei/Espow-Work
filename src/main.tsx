import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }

  componentDidCatch(error: Error): void {
    void window.espow.diagnostic.captureRendererError({
      level: 'fatal', operation: 'react.error-boundary', errorMessage: error.message, stack: error.stack
    })
  }

  render(): React.ReactNode {
    if (this.state.failed) return <main style={{ padding: 32, fontFamily: 'system-ui' }}><h2>界面暂时无法显示</h2><p>错误已写入本地诊断日志，请重启应用后重试。</p></main>
    return this.props.children
  }
}

window.addEventListener('error', (event) => {
  void window.espow.diagnostic.captureRendererError({
    level: 'error', operation: 'window.error', errorMessage: event.message || 'Renderer error', stack: event.error instanceof Error ? event.error.stack : undefined
  })
})
window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason))
  void window.espow.diagnostic.captureRendererError({ level: 'error', operation: 'unhandledrejection', errorMessage: error.message, stack: error.stack })
})
void window.espow.diagnostic.addBreadcrumb('renderer_bootstrap', 'success')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererErrorBoundary><App /></RendererErrorBoundary>
  </React.StrictMode>
)
