import { RevyntaTracker } from './tracker';

export * from './tracker';

export const Revynta = new RevyntaTracker();

// Expose on window if running in browser
if (typeof window !== 'undefined') {
  (window as any).Revynta = Revynta;
}

// Auto-initialize if script loaded with data-store-key attribute
if (typeof document !== 'undefined') {
  const scripts = document.querySelectorAll('script');
  const currentScript = (document.currentScript || 
    Array.from(scripts).find(s => s.src.includes('tracker'))) as HTMLScriptElement;
    
  if (currentScript) {
    const storeKey = currentScript.getAttribute('data-store-key');
    const apiEndpoint = currentScript.getAttribute('data-api-endpoint') || undefined;
    
    if (storeKey) {
      Revynta.init(storeKey, {
        apiEndpoint,
      });
    }
  }
}
