Feature: No dimension

  @kind:good @route:/orders
  Scenario: Case
    Given I have an order
    When I open it
    Then I see it
