import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '../App'
import '../styles.css'
class RecoveryBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <main className="startup" role="alert">
          <h1>窗口遇到问题</h1>
          <p>后台任务继续运行，已保存的草稿和编辑内容会在重新加载后恢复。</p>
          <button className="button primary" onClick={() => window.location.reload()}>
            重新加载窗口
          </button>
        </main>
      )
    return this.props.children
  }
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RecoveryBoundary>
      <App />
    </RecoveryBoundary>
  </React.StrictMode>,
)
