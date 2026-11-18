Feature: Unknown kind

  @kind:ugly @dimension:workflow-fit @route:/orders
  Scenario: Case
    Given I have an order
    When I open it
    Then I see it
