Feature: Two backgrounds

  Background:
    Given one thing

  Background:
    Given another thing

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: Only one is allowed
    When I open it
    Then I see it
