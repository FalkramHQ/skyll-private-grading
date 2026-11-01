import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initSentry } from './lib/sentry'
import { installChunkReload } from './lib/chunkReload'
import App from './App.jsx'

initSentry();
installChunkReload();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
