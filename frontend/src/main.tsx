import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './index.css';
import App from './App';
import { ToastProvider } from './components/ui/Toast';
import { ProjectProvider } from './state/ProjectContext';

const container = document.getElementById('root');
if (!container) throw new Error('SiliconGPT: #root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <ProjectProvider>
          <App />
        </ProjectProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
