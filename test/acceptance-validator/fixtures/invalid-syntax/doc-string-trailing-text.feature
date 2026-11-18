Feature: A doc string line that only starts with the delimiter closes the block

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: The text after the early close is not a step
    Given this note:
      """
      text
      """ not closing
      more text
      """
    When I open it
    Then I see it
