Feature: Shell

  @kind:good @dimension:workflow-fit @route:/x$(y)
  Scenario: Case
    Given I have an order
    When I open it
    Then I see it
