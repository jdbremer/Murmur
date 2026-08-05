import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../theme.css'
import './bar.css'
import { Bar } from './Bar'
import { BridgeMissing } from '../components/BridgeMissing'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from bar/index.html')

createRoot(container).render(
  <StrictMode>{window.murmur ? <Bar /> : <BridgeMissing window="Bar" />}</StrictMode>,
)
