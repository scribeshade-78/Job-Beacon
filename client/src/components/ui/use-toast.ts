import { useEffect, useState } from "react";
import type { ToastTone } from "./toast";

export interface ToastRecord {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

type Listener = (toasts: ToastRecord[]) => void;

let toasts: ToastRecord[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) {
    listener(toasts);
  }
}

export function dismissToast(id: string) {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function showToast(input: { title: string; description?: string; tone?: ToastTone }) {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, tone: "default", ...input }];
  emit();
  return id;
}

/** Subscribes a component (the <Toaster/> mount point) to the current toast queue. */
export function useToasts(): ToastRecord[] {
  const [current, setCurrent] = useState(toasts);

  useEffect(() => {
    listeners.add(setCurrent);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);

  return current;
}
