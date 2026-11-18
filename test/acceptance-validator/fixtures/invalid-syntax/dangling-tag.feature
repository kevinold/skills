Feature: A tag with nothing under it

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: Fine
    Given I have an order
    When I open it
    Then I see it

  @kind:good
