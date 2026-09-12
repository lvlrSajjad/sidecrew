/** A small order state machine: a total transition function and two helpers over it. */

export type OrderState = "draft" | "placed" | "paid" | "shipped" | "cancelled";
export type OrderEvent = "place" | "pay" | "ship" | "cancel";

const TRANSITIONS: Readonly<Record<OrderState, Readonly<Partial<Record<OrderEvent, OrderState>>>>> = {
  draft: { place: "placed", cancel: "cancelled" },
  placed: { pay: "paid", cancel: "cancelled" },
  paid: { ship: "shipped", cancel: "cancelled" },
  shipped: {},
  cancelled: {},
};

/** Whether `event` is accepted in `state`. */
export function canTransition(state: OrderState, event: OrderEvent): boolean {
  return TRANSITIONS[state][event] !== undefined;
}

/** The state after `event`. Total: an event the state does not accept leaves the state unchanged. */
export function nextState(state: OrderState, event: OrderEvent): OrderState {
  return TRANSITIONS[state][event] ?? state;
}

/** `nextState` folded over `events`, left to right. */
export function applyAll(state: OrderState, events: readonly OrderEvent[]): OrderState {
  let current = state;
  for (const event of events) current = nextState(current, event);
  return current;
}
