import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// jsdom lacks these browser APIs used by a few components.
if (typeof window !== 'undefined') {
  if (!('ResizeObserver' in window)) {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  }
  if (!('IntersectionObserver' in window)) {
    class IO {
      constructor(private cb: (entries: { isIntersecting: boolean; target: Element }[]) => void) {}
      observe(target: Element) {
        this.cb([{ isIntersecting: true, target }]);
      }
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { IntersectionObserver: typeof IO }).IntersectionObserver = IO;
  }
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList;
  }
}
