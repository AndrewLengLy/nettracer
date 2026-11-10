import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
// Inter and JetBrains Mono ship with the app (SIL Open Font License 1.1, see public/font-licenses.txt).
import '@fontsource/inter/latin-300.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './index.css';
import NetTracer from './NetTracer.jsx';

/** NetTracer needs a desktop-width screen. Smaller screens get a short note with the option to open it anyway. */
function App() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024);
  const [force, setForce] = useState(false);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (narrow && !force) {
    return (
      <div className="flex min-h-full flex-col items-start justify-center gap-5 bg-[#090A0F] px-7 py-12 text-[#F3F4F6]" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
        <div className="font-mono text-[11px] tracking-[0.14em] text-zinc-500">NETTRACER · PROTOCOL & TOPOLOGY EXPLORER</div>
        <h1 className="max-w-md text-[26px] font-medium leading-tight">Built for a desktop screen.</h1>
        <p className="max-w-md text-[15px] leading-relaxed text-zinc-400">
          NetTracer runs a 3D network diorama next to a live packet capture and a layer-by-layer inspector. Open it on a laptop or desktop for the full lab.
        </p>
        <button onClick={() => setForce(true)} className="h-10 rounded-md bg-[#F3F4F6] px-4 text-[14px] font-medium text-[#090A0F]">Open anyway</button>
        <a href="https://www.andrewlengly.com" className="font-mono text-[12px] tracking-[0.08em] text-zinc-500 underline underline-offset-4">Built by Andrew Ly</a>
      </div>
    );
  }
  return <NetTracer />;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
