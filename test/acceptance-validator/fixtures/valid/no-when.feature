Feature: A scenario with no action step is a warning, not an error

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: The list is already there
    Given I have one order
    Then I see it listed
