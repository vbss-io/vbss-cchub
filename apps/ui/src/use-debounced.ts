import { useEffect, useRef, useState } from "react";

export interface DebouncedFn<A extends unknown[]> {
  (...args: A): void;
  flush: () => void;
  cancel: () => void;
}

export function useDebouncedCallback<A extends unknown[]>(callback: (...args: A) => void, delay = 400): DebouncedFn<A> {
  const latest = useRef(callback);
  const delayRef = useRef(delay);
  latest.current = callback;
  delayRef.current = delay;

  const [debounced] = useState<DebouncedFn<A>>(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: A | null = null;

    const flush = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending !== null) {
        const args = pending;
        pending = null;
        latest.current(...args);
      }
    };

    const cancel = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    };

    const call = (...args: A) => {
      pending = args;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayRef.current);
    };

    return Object.assign(call, { flush, cancel });
  });

  useEffect(() => () => debounced.flush(), [debounced]);

  return debounced;
}
