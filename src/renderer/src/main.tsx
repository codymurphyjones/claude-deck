import { createRoot } from 'react-dom/client'
import './styles.css'
import './chat/chat.css'
import { App } from './App'
import { boot } from './boot'
import * as store from './store'
import { api } from './api'
import { readLines } from './terminal/registry'

void boot().then(() => {
  createRoot(document.getElementById('root')!).render(<App />)
})

// Dev-only handle for automated UI checks.
if (import.meta.env.DEV) Object.assign(window, { __deck: { ...store, api, readLines } })
