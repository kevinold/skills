Feature: Names collide once slugged

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: Open the order
    Given I have an order
    When I open it
    Then I see it

  @kind:good @dimension:legibility @route:/orders
  Scenario: open the order!
    Given I have an order
    When I open it
    Then I see it
