Feature: Outlines are not supported here

  @kind:good @dimension:workflow-fit @route:/orders
  Scenario Outline: One id cannot show every row was seen
    Given I have <n> orders
    When I open them
    Then I see <n> rows

    Examples:
      | n |
      | 1 |
