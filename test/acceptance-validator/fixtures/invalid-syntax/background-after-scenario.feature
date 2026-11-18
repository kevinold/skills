Feature: Background comes first

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: Scenario before background
    Given I have an order
    When I open it
    Then I see it

  Background:
    Given too late
