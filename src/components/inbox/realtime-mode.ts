import { useSyncExternalStore } from "react";

/**
 * Como a caixa se atualiza agora (C4):
 * - `connecting`: o SSE ainda não abriu (ou não há quem o abra): as queries seguem no polling.
 * - `live`: SSE de pé; os eventos invalidam as queries e a lista só é relida a cada 60 s.
 * - `polling`: SSE indisponível (503, 429, rede): polling de 20 s e o aviso na tela.
 *
 * Fica fora de `use-inbox-events.ts` para `inbox-api.ts` ler sem importar o hook (e sem ciclo).
 */
export type InboxRealtimeMode = "connecting" | "live" | "polling";

let mode: InboxRealtimeMode = "connecting";
const listeners = new Set<() => void>();

export function getInboxRealtimeMode() {
  return mode;
}

export function setInboxRealtimeMode(next: InboxRealtimeMode) {
  if (next === mode) return;
  mode = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInboxRealtimeMode(): InboxRealtimeMode {
  return useSyncExternalStore(subscribe, getInboxRealtimeMode, () => "connecting");
}
