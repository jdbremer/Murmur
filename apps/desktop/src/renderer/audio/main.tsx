import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../theme.css'
import { AudioCapture } from './AudioCapture'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from audio/index.html')

createRoot(container).render(
  <StrictMode>
    <AudioCapture />
  </StrictMode>,
)
