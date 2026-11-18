Feature: Two dimensions

  @kind:good @dimension:legibility @dimension:workflow-fit @route:/orders
  Scenario: Case
    Given I have an order
    When I open it
    Then I see it
