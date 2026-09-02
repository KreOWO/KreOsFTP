import { StrictMode } from 'react'
import { t } from '../shared/i18n'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error(t('Не найден корневой элемент #root'))

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
