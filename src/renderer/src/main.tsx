import React from 'react'
import ReactDOM from 'react-dom/client'
import type { OrigReadDesktopApi } from '../../shared/contracts'
import App from './App'
import './i18n'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('OrigRead renderer root element is missing')
}

const desktopApi = (window as Window & { origread?: OrigReadDesktopApi }).origread
const root = ReactDOM.createRoot(rootElement)

if (!desktopApi) {
  root.render(
    <div className="boot-error-shell">
      <div className="boot-error-card">
        <img src="./logo.png" alt="" />
        <h1>OrigRead failed to start</h1>
        <p>The desktop bridge did not load. Please restart OrigRead or reinstall the latest build.</p>
        <code>PRELOAD_BRIDGE_UNAVAILABLE</code>
      </div>
    </div>
  )
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

