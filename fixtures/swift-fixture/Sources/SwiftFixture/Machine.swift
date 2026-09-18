import Foundation

/// A small order state machine: a total transition function and two helpers over it.
public enum OrderState: String, Sendable, CaseIterable { case draft, placed, paid, shipped, cancelled }
public enum OrderEvent: String, Sendable, CaseIterable { case place, pay, ship, cancel }

public enum Machine {
    static let transitions: [OrderState: [OrderEvent: OrderState]] = [
        .draft: [.place: .placed, .cancel: .cancelled],
        .placed: [.pay: .paid, .cancel: .cancelled],
        .paid: [.ship: .shipped, .cancel: .cancelled],
        .shipped: [:],
        .cancelled: [:],
    ]

    /// Whether `event` is accepted in `state`.
    public static func canTransition(_ state: OrderState, _ event: OrderEvent) -> Bool {
        return transitions[state]?[event] != nil
    }

    /// The state after `event`. Total: an event the state does not accept leaves the state unchanged.
    public static func nextState(_ state: OrderState, _ event: OrderEvent) -> OrderState {
        return canTransition(state, event) ? transitions[state]![event]! : state
    }

    /// `nextState` folded over `events`, left to right.
    public static func applyAll(_ state: OrderState, _ events: [OrderEvent]) -> OrderState {
        var current = state
        var i = 0
        while i < events.count {
            current = nextState(current, events[i])
            i += 1
        }
        return current
    }
}
