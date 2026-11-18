Feature: No route

  @kind:good @dimension:workflow-fit
  Scenario: Case
    Given I have an order
    When I open it
    Then I see it
