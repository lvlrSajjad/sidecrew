// shape: stateful_sequence — drive a sequence of operations and assert the state after each, and
// include one step the machine rejects. framework: swift-testing
//
// The state is advanced **by hand** rather than through `Machine.nextState`, and that is not style.
// `nextState` force-unwraps `transitions[state]![event]!` behind a `canTransition` guard, so a mutant of
// `canTransition` makes `nextState` crash — and a crash is a `runtimeError`, which counts towards the
// mutation score and never towards survival (ADR-0005). Threading the sequence through it killed this
// exemplar: the process died before the failing `#expect` could be reported, and the verdict came back
// `killed 0`. A sequence test must not advance itself through a sibling the mutant can crash.
import Testing
@testable import SwiftFixture

@Suite struct CanTransitionStatefulSequenceTests {
    @Test func answersForEachStateAlongAnOrdersLifetime() {
        var state: OrderState = .draft
        #expect(Machine.canTransition(state, .place) == true)

        state = .placed
        #expect(Machine.canTransition(state, .pay) == true)

        state = .paid
        #expect(Machine.canTransition(state, .ship) == true)

        state = .shipped
        #expect(Machine.canTransition(state, .cancel) == false)
    }

    @Test func refusesEveryEventOnceTheOrderIsFinished() {
        #expect(Machine.canTransition(.cancelled, .place) == false)
        #expect(Machine.canTransition(.cancelled, .pay) == false)
    }
}
