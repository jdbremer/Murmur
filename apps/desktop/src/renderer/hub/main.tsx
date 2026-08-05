import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../theme.css'
import { App } from './App'
import { BridgeMissing } from '../components/BridgeMissing'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from hub/index.html')

createRoot(container).render(
  <StrictMode>{window.murmur ? <App /> : <BridgeMissing window="Hub" />}</StrictMode>,
)
