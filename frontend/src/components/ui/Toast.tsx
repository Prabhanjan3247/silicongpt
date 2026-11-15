import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { errorMessage, isAbortError } from '../../services/api';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
  /** Auto-dismiss delay in ms (0 = stay until closed). */
  duration?: number;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  duration: number;
}

export interface ToastApi {
  toast: (input: ToastInput) => number;
  success: (title: string, description?: string) => number;
  /** `detail` may be an ApiError / Error / string: its message becomes the description. */
  error: (title: string, detail?: unknown) => number;
  info: (title: string, description?: string) => number;
  warning: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_TOASTS = 5;
const DEFAULT_DURATION: Record<ToastTone, number> = { success: 4500, info: 4500, warning: 7000, error: 9000 };

const TONE_STYLE: Record<ToastTone, { icon: typeof Info; ring: string; iconClass: string }> = {
  success: { icon: CircleCheck, ring: 'border-pass/30', iconClass: 'text-pass' },
  error: { icon: CircleX, ring: 'border-fail/40', iconClass: 'text-fail' },
  info: { icon: Info, ring: 'border-blue/35', iconClass: 'text-[#60a5fa]' },
  warning: { icon: TriangleAlert, ring: 'border-warn/35', iconClass: 'text-warn' },
};

/** Provides `useToast()`; renders the toast stack (bottom-right, polite live region). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const tone = input.tone ?? 'info';
      const duration = input.duration ?? DEFAULT_DURATION[tone];
      setItems((list) => [...list, { id, tone, title: input.title, description: input.description, duration }].slice(-MAX_TOASTS));
      if (duration > 0) timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => window.clearTimeout(timer));
      map.clear();
    };
  }, []);

  const value = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ tone: 'success', title, description }),
      info: (title, description) => toast({ tone: 'info', title, description }),
      warning: (title, description) => toast({ tone: 'warning', title, description }),
      error: (title, detail) => {
        if (detail !== undefined && isAbortError(detail)) return -1;
        return toast({ tone: 'error', title, description: detail === undefined ? undefined : errorMessage(detail) });
      },
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(400px,calc(100vw-2rem))] flex-col gap-2"
      >
        {items.map((item) => {
          const style = TONE_STYLE[item.tone];
          const Icon = style.icon;
          return (
            <div
              key={item.id}
              role={item.tone === 'error' ? 'alert' : 'status'}
              className={clsx(
                'pointer-events-auto flex items-start gap-3 rounded-xl border bg-raised/95 px-3.5 py-3 shadow-pop backdrop-blur',
                style.ring,
              )}
            >
              <Icon aria-hidden="true" className={clsx('mt-0.5 size-4 shrink-0', style.iconClass)} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-text">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 line-clamp-6 whitespace-pre-wrap break-words text-xs leading-5 text-muted">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(item.id)}
                className="-mr-1 -mt-0.5 rounded-md p-1 text-subtle hover:bg-hover hover:text-text"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Toast notifications. Must be used inside <ToastProvider> (mounted in main.tsx). */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be used inside <ToastProvider>.');
  return ctx;
}
