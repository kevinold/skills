Feature: Unknown dimension

  @kind:good @dimension:vibes @route:/orders
  Scenario: Case
    Given I have an order
    When I open it
    Then I see it
