Feature: Scheme relative

  @kind:good @dimension:workflow-fit @route://attacker.example/x
  Scenario: Case
    Given I have an order
    When I open it
    Then I see it
