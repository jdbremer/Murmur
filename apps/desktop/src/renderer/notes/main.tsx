import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../theme.css'
import './notes.css'
import { Scratchpad } from './Scratchpad'
import { BridgeMissing } from '../components/BridgeMissing'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from notes/index.html')

createRoot(container).render(
  <StrictMode>{window.murmur ? <Scratchpad /> : <BridgeMissing window="Scratchpad" />}</StrictMode>,
)
