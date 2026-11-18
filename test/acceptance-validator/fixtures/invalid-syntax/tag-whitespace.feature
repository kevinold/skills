Feature: A tag holds a space

  @kind:good @dimension:workflow-fit @route:/orders list
  Scenario: Whitespace breaks the tag
    Given I have an order
    When I open it
    Then I see it
