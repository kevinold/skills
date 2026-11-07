Feature: A step wrapped onto a second line

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: The wrapped line is not a step
    Given I have an order
    When I open it
    Then the items, the delivery address and the price
      all show together
