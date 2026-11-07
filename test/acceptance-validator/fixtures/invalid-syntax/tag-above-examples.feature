Feature: A tag sits above Examples under a Feature

  @kind:good
  Examples:

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: Fine
    Given I have an order
    When I open it
    Then I see it
