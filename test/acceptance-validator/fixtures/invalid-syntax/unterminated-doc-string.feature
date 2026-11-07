Feature: A doc string never closes

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: The block runs off the end
    Given this note:
      """
      Never closed
    When I open it
    Then I see it
