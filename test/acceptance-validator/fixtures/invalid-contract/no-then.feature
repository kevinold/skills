Feature: No outcome

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: Nothing is asserted
    Given I have an order
    When I open it
