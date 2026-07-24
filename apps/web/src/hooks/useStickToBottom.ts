import { useCallback, useEffect, useRef } from "react";
import type { DependencyList } from "react";

/**
 * Follows new content to the bottom, but ONLY while the user is already
 * pinned there. The moment they scroll up to read, auto-scroll stops until
 * they return to the bottom — so reading history is never interrupted.
 *
 * Wire the returned ref to the scroll container and onScroll to its
 * onScroll; pass the content deps that should trigger a follow.
 */
export function useStickToBottom<T extends HTMLElement>(
  deps: DependencyList,
  threshold = 80
) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distance <= threshold;
  }, [threshold]);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, onScroll };
}

/**
 * Newest-first variant: keeps the view pinned to the TOP on new content,
 * but only while the user is already at the top. Scrolling down to read
 * older entries is left alone.
 */
export function useStickToTop<T extends HTMLElement>(
  deps: DependencyList,
  threshold = 80
) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) pinned.current = el.scrollTop <= threshold;
  }, [threshold]);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, onScroll };
}
