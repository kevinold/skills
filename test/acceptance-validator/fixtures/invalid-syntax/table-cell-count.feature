Feature: Table rows disagree

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario: Cell counts differ
    Given these orders:
      | id | total |
      | 1  |
    When I open them
    Then I see them
